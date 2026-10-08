import { createBackendClient, requireAuthenticatedUser } from '../_shared/supabase.ts'
import { errorResponse, handleOptions, ok, readJson } from '../_shared/response.ts'
import { buildDocumentChunks } from '../_shared/full-sec-document-analysis.ts'
import { AnalystContextBuilder, OpenAIResearchProvider, isAnalystAnalysisResult } from '../_shared/analyst-engine.ts'
import { retrieveSecDocument } from '../_shared/sec-document-retrieval.ts'

const TEST_EVIDENCE_ID = 'a7e156de-9655-45d8-b9aa-5dd0134bde22'

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function chunkContextForAnalysis(input: {
  analyst: { ticker: string; company_name: string | null; current_thesis: string | null; current_fair_value: number | null; previous_fair_value: number | null; confidence: number }
  evidence: { id: string; title: string; source_type: string; summary: string | null; raw_metadata: Record<string, unknown> }
  chunk: { chunkIndex: number; totalChunks: number; section: string; content: string; characterCount: number }
}) {
  return new AnalystContextBuilder().build({
    executionMode: 'production',
    analyst: {
      ticker: input.analyst.ticker,
      company_name: input.analyst.company_name,
      current_thesis: input.analyst.current_thesis,
      current_fair_value: input.analyst.current_fair_value,
      previous_fair_value: input.analyst.previous_fair_value,
      confidence: input.analyst.confidence,
    },
    assumptions: [],
    decisions: [],
    evidence: [{
      id: input.evidence.id,
      title: input.evidence.title,
      source_type: input.evidence.source_type,
      summary: input.evidence.summary,
    }],
    currentEvidence: {
      id: input.evidence.id,
      title: `${input.evidence.title} :: ${input.chunk.section}`,
      source_type: input.evidence.source_type,
      summary: input.chunk.content,
      raw_metadata: {
        ...(input.evidence.raw_metadata ?? {}),
        section: input.chunk.section,
        chunk_index: input.chunk.chunkIndex,
        total_chunks: input.chunk.totalChunks,
        document_characters: input.chunk.characterCount,
      },
      enrichment: {
        normalized_summary: input.chunk.content,
        structured_facts: [],
        sections: [{ section: input.chunk.section, content: input.chunk.content }],
      },
    },
  })
}

function asSummary(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

Deno.serve(async (request) => {
  const options = handleOptions(request)
  if (options) return options
  if (request.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'Use POST', 405, request)

  try {
    await requireAuthenticatedUser(request)
    const body = await readJson(request)
    const evidenceId = body?.evidenceId ?? TEST_EVIDENCE_ID
    if (!isUuid(evidenceId)) return errorResponse('INVALID_EVIDENCE_REQUEST', 'evidenceId must be a valid UUID', 400, request)
    if (evidenceId !== TEST_EVIDENCE_ID) return errorResponse('EVIDENCE_NOT_ALLOWED', 'Only the specified NVDA SEC evidence is allowed for this read-only harness.', 400, request)

    const client = createBackendClient()
    const { data: evidence, error: evidenceError } = await client
      .from('evidence_items')
      .select('id, ticker, source_type, title, summary, source_url, raw_metadata')
      .eq('id', evidenceId)
      .single()
    if (evidenceError) throw evidenceError
    if (evidence.ticker !== 'NVDA' || evidence.source_type !== 'SEC') {
      return errorResponse('EVIDENCE_NOT_ALLOWED', 'Only the controlled NVDA SEC evidence is allowed for this read-only harness.', 400, request)
    }

    const { data: analyst, error: analystError } = await client
      .from('analysts')
      .select('id, ticker, company_name, current_thesis, current_fair_value, previous_fair_value, confidence')
      .eq('ticker', 'NVDA')
      .limit(1)
      .maybeSingle()
    if (analystError) throw analystError
    if (!analyst) return errorResponse('ANALYST_NOT_FOUND', 'No active NVDA analyst record was found.', 404, request)

    const { data: state, error: stateError } = await client
      .from('analyst_state')
      .select('current_thesis, current_fair_value, previous_fair_value, confidence')
      .eq('analyst_id', analyst.id)
      .maybeSingle()
    if (stateError) throw stateError

    const metadata = evidence.raw_metadata && typeof evidence.raw_metadata === 'object' && !Array.isArray(evidence.raw_metadata)
      ? evidence.raw_metadata as Record<string, unknown>
      : {}

    const cik = metadata.cik ?? metadata.cik_number
    const accessionNumber = metadata.accessionNumber ?? metadata.accession_number
    const primaryDocument = metadata.primaryDocument ?? metadata.primary_document
    if (typeof cik !== 'string' || typeof accessionNumber !== 'string' || typeof primaryDocument !== 'string') {
      return errorResponse('SEC_METADATA_INCOMPLETE', 'The selected evidence does not contain real SEC filing metadata.', 422, request)
    }

    const retrievalStartedAt = Date.now()
    const retrieval = await retrieveSecDocument({
      cik,
      accessionNumber,
      primaryDocument,
    }, {
      timeoutMs: 8000,
      maxBytes: 25 * 1024 * 1024,
      userAgent: Deno.env.get('SEC_USER_AGENT') || 'InvestmentCommunity/1.0 (+https://example.invalid)',
    })
    const retrievalMs = Date.now() - retrievalStartedAt
    if (!retrieval.ok) {
      return errorResponse('SEC_RETRIEVAL_FAILED', retrieval.message ?? 'SEC retrieval failed', retrieval.status ? 502 : 500, request)
    }

    const normalizedDocumentBytes = new TextEncoder().encode(retrieval.normalizedText).length
    const totalChunksAvailable = buildDocumentChunks(retrieval.normalizedText)
    if (totalChunksAvailable.length < 2) {
      return errorResponse('INSUFFICIENT_CHUNKS', 'The document did not generate 2 chunks for the real OpenAI test.', 422, request)
    }

    const selectedChunks = totalChunksAvailable.slice(0, 2)
    const openaiCalls: Array<{ provider: string; model: string; responseId: string | null; latencyMs: number; success: boolean }> = []
    const analyzed: Array<Record<string, unknown>> = []

    for (const [chunkIndex, chunk] of selectedChunks.entries()) {
      const provider = new OpenAIResearchProvider()
      const context = chunkContextForAnalysis({
        analyst: {
          ticker: analyst.ticker,
          company_name: analyst.company_name,
          current_thesis: state?.current_thesis ?? analyst.current_thesis,
          current_fair_value: state?.current_fair_value ?? analyst.current_fair_value,
          previous_fair_value: state?.previous_fair_value ?? analyst.previous_fair_value,
          confidence: state?.confidence ?? analyst.confidence,
        },
        evidence: {
          id: evidence.id,
          title: evidence.title,
          source_type: evidence.source_type,
          summary: evidence.summary,
          raw_metadata: metadata,
        },
        chunk: { ...chunk, chunkIndex, characterCount: chunk.characterCount },
      })

      const result = await provider.analyzeEvidence(context)
      const valid = isAnalystAnalysisResult(result)
      const runMetadata = provider.lastRunMetadata
      if (!runMetadata || runMetadata.provider !== 'openai') throw new Error('OPENAI_RUN_METADATA_MISSING')

      openaiCalls.push({
        provider: runMetadata.provider,
        model: runMetadata.model,
        responseId: runMetadata.responseId,
        latencyMs: runMetadata.latencyMs,
        success: valid,
      })

      analyzed.push({
        chunkIndex,
        section: chunk.section,
        characterCount: chunk.characterCount,
        result: valid ? result : null,
        success: valid,
      })

      if (!valid) {
        return errorResponse('CHUNK_ANALYSIS_FAILED', `Chunk ${chunkIndex} did not return a valid AnalystAnalysisResult.`, 502, request)
      }
    }

    const summaryPrompt = `Synthesize the following two real chunk-level research outputs into a single final equity research assessment. Return only a valid AnalystAnalysisResult JSON object.\n\nChunk 0: ${asSummary(analyzed[0].result)}\n\nChunk 1: ${asSummary(analyzed[1].result)}\n\nCurrent analyst state: ticker=${analyst.ticker}, company=${analyst.company_name ?? 'unknown'}, thesis=${state?.current_thesis ?? analyst.current_thesis ?? ''}, currentFairValue=${state?.current_fair_value ?? analyst.current_fair_value ?? null}, previousFairValue=${state?.previous_fair_value ?? analyst.previous_fair_value ?? null}, confidence=${state?.confidence ?? analyst.confidence ?? 0}.`
    const synthesisProvider = new OpenAIResearchProvider()
    const synthesisContext = chunkContextForAnalysis({
      analyst: {
        ticker: analyst.ticker,
        company_name: analyst.company_name,
        current_thesis: state?.current_thesis ?? analyst.current_thesis,
        current_fair_value: state?.current_fair_value ?? analyst.current_fair_value,
        previous_fair_value: state?.previous_fair_value ?? analyst.previous_fair_value,
        confidence: state?.confidence ?? analyst.confidence,
      },
      evidence: {
        id: evidence.id,
        title: evidence.title,
        source_type: evidence.source_type,
        summary: summaryPrompt,
        raw_metadata: { ...(metadata ?? {}), synthesis_mode: 'two_chunk_real_openai' },
      },
      chunk: {
        chunkIndex: 0,
        totalChunks: 2,
        section: 'synthesis',
        content: summaryPrompt,
        characterCount: summaryPrompt.length,
      },
    })
    const synthesisResult = await synthesisProvider.analyzeEvidence(synthesisContext)
    const synthesisValid = isAnalystAnalysisResult(synthesisResult)
    const synthesisMetadata = synthesisProvider.lastRunMetadata
    if (!synthesisMetadata || synthesisMetadata.provider !== 'openai') throw new Error('OPENAI_RUN_METADATA_MISSING')

    if (!synthesisValid) {
      return errorResponse('SYNTHESIS_FAILED', 'The synthesis OpenAI call did not return a valid AnalystAnalysisResult.', 502, request)
    }

    const synthesisCall = {
      provider: synthesisMetadata.provider,
      model: synthesisMetadata.model,
      responseId: synthesisMetadata.responseId,
      latencyMs: synthesisMetadata.latencyMs,
      success: synthesisValid,
    }
    const totalMs = Date.now() - retrievalStartedAt
    const response = {
      ok: true,
      realOpenAITest: 'SUCCESS',
      retrieval: {
        rawDocumentBytes: retrieval.documentBytes,
        normalizedDocumentBytes,
        normalizedCharacterCount: retrieval.normalizedText.length,
        retrievalMs,
      },
      totalChunksAvailable: totalChunksAvailable.length,
      chunksSentToOpenAI: selectedChunks.length,
      chunks: selectedChunks.map((chunk, chunkIndex) => ({
        chunkIndex,
        section: chunk.section,
        characters: chunk.characterCount,
        ...openaiCalls[chunkIndex],
      })),
      synthesis: synthesisCall,
      metrics: {
        realOpenAICalls: openaiCalls.length + 1,
        failedCalls: 0,
        totalMs,
      },
      supabaseWrites: 0,
      finalResult: {
        materiality: synthesisResult.materiality,
        thesisChanged: synthesisResult.thesisChanged,
        valuationChanged: synthesisResult.valuationChanged,
        confidence: synthesisResult.confidence,
        impact: synthesisResult.impact,
        decisionSummary: synthesisResult.decisionSummary,
      },
      isAnalystAnalysisResult: synthesisValid,
    }

    return ok(response, request)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error.'
    return errorResponse('REAL_OPENAI_TEST_FAILED', message, 500, request)
  }
})
