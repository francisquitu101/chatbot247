import { createBackendClient, requireAuthenticatedUser } from '../_shared/supabase.ts'
import { errorResponse, handleOptions, ok, readJson } from '../_shared/response.ts'
import {
  AnalystContextBuilder,
  isAnalysisResultApplicable,
  OpenAIProviderError,
  OpenAIResearchProvider,
  MockResearchProvider,
  isAnalystAnalysisResult,
  type AnalysisMode,
  type AnalystAnalysisResult,
  type ProviderRunMetadata,
} from '../_shared/analyst-engine.ts'
import { buildDocumentChunks, computeChunkCoverage } from '../_shared/full-sec-document-analysis.ts'
import { retrieveSecDocument } from '../_shared/sec-document-retrieval.ts'

const MAX_CHUNKS_PER_INVOCATION = 3
const SEC_DOCUMENT_MAX_BYTES = 25 * 1024 * 1024

type JsonRecord = Record<string, unknown>
type ChunkResultRow = {
  chunk_index: number
  result_text: string
  section: string
  provider: string
  model: string
  response_id: string | null
  latency_ms: number | null
  input_tokens: number | null
  output_tokens: number | null
  success: boolean
  error_message: string | null
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function getMockMode(metadata: unknown): AnalysisMode {
  if (!isRecord(metadata)) return 'NO_CHANGE'
  const mode = metadata.mock_mode
  return mode === 'THESIS_CHANGE' || mode === 'VALUATION_CHANGE' ? mode : 'NO_CHANGE'
}

function getProviderMetadata(provider: OpenAIResearchProvider | MockResearchProvider, providerName: string): ProviderRunMetadata {
  if (provider.lastRunMetadata) return provider.lastRunMetadata
  return {
    provider: providerName,
    model: providerName === 'mock' ? 'deterministic-v1' : Deno.env.get('AI_MODEL') || 'gpt-5.6-terra',
    responseId: null,
    inputTokens: null,
    outputTokens: null,
    latencyMs: 0,
  }
}

function buildChunkContext(input: {
  analyst: { ticker: string; company_name: string | null; current_thesis: string | null; current_fair_value: number | null; previous_fair_value: number | null; confidence: number }
  assumptions: Array<{ name: string; category: string; value_numeric: number | null; value_text: string | null; unit: string | null }>
  decisions: Array<{ event: string; reasoning_summary: string | null; timestamp: string }>
  evidence: { id: string; title: string; source_type: string; summary: string | null; raw_metadata: JsonRecord }
  section: string
  content: string
  chunkIndex: number
  totalChunks: number
}) {
  const chunkEvidence = {
    ...input.evidence,
    title: `${input.evidence.title} :: ${input.section}`,
    summary: input.content,
    raw_metadata: {
      ...input.evidence.raw_metadata,
      section: input.section,
      chunk_index: input.chunkIndex,
      total_chunks: input.totalChunks,
    },
    enrichment: {
      normalized_summary: input.content,
      structured_facts: [],
      sections: [{ section: input.section, content: input.content }],
    },
  }
  return new AnalystContextBuilder().build({
    executionMode: 'production',
    analyst: input.analyst,
    assumptions: input.assumptions,
    decisions: input.decisions,
    evidence: [input.evidence],
    currentEvidence: chunkEvidence,
  })
}

function digestText(value: string): Promise<string> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)).then((digest) =>
    Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  )
}

function compactChunkResult(row: ChunkResultRow): JsonRecord {
  const result = JSON.parse(row.result_text) as AnalystAnalysisResult
  return {
    chunkIndex: row.chunk_index,
    section: row.section.slice(0, 70),
    materiality: result.materiality,
    thesisChanged: result.thesisChanged,
    thesisSummary: result.thesisSummary?.slice(0, 120) ?? null,
    valuationChanged: result.valuationChanged,
    previousFairValue: result.previousFairValue ?? null,
    newFairValue: result.newFairValue ?? null,
    impact: result.impact,
    affectedAssumptions: result.affectedAssumptions.slice(0, 2).map((item) => ({
      name: item.name.slice(0, 50),
      newValue: item.newValue ?? null,
      newValueText: item.newValueText?.slice(0, 80) ?? null,
      changeSummary: item.changeSummary.slice(0, 100),
    })),
    risksAdded: result.risksAdded.slice(0, 1).map((item) => item.slice(0, 80)),
    risksRemoved: result.risksRemoved.slice(0, 1).map((item) => item.slice(0, 80)),
    catalystsAdded: result.catalystsAdded.slice(0, 1).map((item) => item.slice(0, 80)),
    catalystsRemoved: result.catalystsRemoved.slice(0, 1).map((item) => item.slice(0, 80)),
    decisionSummary: result.decisionSummary.slice(0, 140),
  }
}

Deno.serve(async (request) => {
  const options = handleOptions(request)
  if (options) return options
  if (request.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'Use POST', 405, request)

  const requestStartedAt = Date.now()
  let jobId: string | null = null
  let leaseToken: string | null = null
  let claimed = false
  let runId: string | null = null
  let activeChunk: { index: number; section: string; provider: string; model: string; startedAt: number } | null = null

  try {
    const body = await readJson(request)
    if (!body || !isUuid(body.job_id)) return errorResponse('INVALID_JOB_REQUEST', 'job_id must be a valid UUID', 400, request)
    jobId = body.job_id

    const client = createBackendClient()
    const workerKey = Deno.env.get('ANALYST_WORKER_KEY')
    const isWorker = Boolean(workerKey && request.headers.get('x-analyst-worker-key') === workerKey)
    const user = isWorker ? null : await requireAuthenticatedUser(request)
    let claimUserId = user?.id ?? '00000000-0000-0000-0000-000000000000'
    if (isWorker) {
      const { data: jobOwner, error: ownerError } = await client.from('analyst_jobs').select('analyst_id, analysts(user_id)').eq('id', jobId).maybeSingle()
      if (ownerError) throw ownerError
      const owner = jobOwner?.analysts as { user_id: string | null } | null
      claimUserId = owner?.user_id ?? claimUserId
    }

    const { data: job, error: claimError } = await client
      .rpc('claim_analyst_job', { p_job_id: jobId, p_user_id: claimUserId })
      .maybeSingle()
    if (claimError) throw claimError
    if (!job) return errorResponse('JOB_NOT_AVAILABLE', 'The job is not queued, scheduled, or authorized for this user.', 409, request)
    claimed = true
    leaseToken = job.lease_token
    if (!isUuid(leaseToken)) throw new Error('JOB_LEASE_TOKEN_MISSING')

    const existingProgress = isRecord(job.progress_state) ? job.progress_state : {}
    runId = isUuid(existingProgress.runId) ? existingProgress.runId : crypto.randomUUID()

    const [{ data: analyst, error: analystError }, { data: evidence, error: evidenceError }, { data: enrichment, error: enrichmentError }, { data: state, error: stateError }, { data: assumptions, error: assumptionsError }, { data: decisions, error: decisionsError }] = await Promise.all([
      client.from('analysts').select('ticker, company_name, current_thesis, current_fair_value, previous_fair_value, confidence').eq('id', job.analyst_id).single(),
      client.from('evidence_items').select('id, title, source_type, summary, raw_metadata').eq('id', job.evidence_id).single(),
      client.from('evidence_enrichment').select('normalized_summary, structured_facts, sections, content_status, document_bytes').eq('evidence_id', job.evidence_id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      client.from('analyst_state').select('current_thesis, current_fair_value, previous_fair_value, confidence').eq('analyst_id', job.analyst_id).maybeSingle(),
      client.from('analyst_assumptions').select('name, category, value_numeric, value_text, unit').eq('analyst_id', job.analyst_id).eq('is_active', true).limit(50),
      client.from('decision_events').select('event, reasoning_summary, timestamp').eq('analyst_id', job.analyst_id).order('timestamp', { ascending: false }).limit(20),
    ])
    for (const error of [analystError, evidenceError, enrichmentError, stateError, assumptionsError, decisionsError]) if (error) throw error
    if (!analyst || !evidence) throw new Error('ANALYST_CONTEXT_INCOMPLETE')

    const analystContext = {
      ...analyst,
      current_thesis: state?.current_thesis ?? analyst.current_thesis,
      current_fair_value: state?.current_fair_value ?? analyst.current_fair_value,
      previous_fair_value: state?.previous_fair_value ?? analyst.previous_fair_value,
      confidence: state?.confidence ?? analyst.confidence,
    }
    const metadata = isRecord(evidence.raw_metadata) ? evidence.raw_metadata : {}
    const providerName = Deno.env.get('AI_PROVIDER') || 'openai'
    const providerFactory = () => providerName === 'mock'
      ? new MockResearchProvider(getMockMode(metadata))
      : new OpenAIResearchProvider()

    if (evidence.source_type !== 'SEC') {
      const context = new AnalystContextBuilder().build({
        executionMode: evidence.source_type === 'synthetic_test' && metadata.execution_mode === 'development_test' ? 'development_test' : 'production',
        analyst: analystContext,
        assumptions: assumptions ?? [],
        decisions: decisions ?? [],
        evidence: [evidence],
        currentEvidence: { ...evidence, enrichment: enrichment?.content_status === 'completed' ? enrichment : null },
      })
      if (evidence.source_type === 'synthetic_test' && context.executionMode !== 'development_test') throw new Error('SYNTHETIC_EVIDENCE_NOT_ALLOWED')
      const provider = providerFactory()
      const result = await provider.analyzeEvidence(context)
      if (!isAnalystAnalysisResult(result) || !isAnalysisResultApplicable(result, context)) throw new Error('INVALID_ANALYSIS_RESULT')
      const metadata = getProviderMetadata(provider, providerName)
      const { data: completedJob, error: completeError } = await client.rpc('complete_analyst_job', {
        p_job_id: job.id,
        p_run_id: runId,
        p_result: result,
        p_provider: metadata.provider,
        p_model: metadata.model,
      }).single()
      if (completeError) throw completeError
      claimed = false
      const { error: runMetadataError } = await client.from('analyst_runs').update({
        input_tokens: metadata.inputTokens,
        output_tokens: metadata.outputTokens,
        response_id: metadata.responseId,
        latency_ms: metadata.latencyMs,
      }).eq('id', runId)
      if (runMetadataError) throw runMetadataError
      return ok({ outcome: 'COMPLETED', job: completedJob, run_id: runId, result }, request)
    }

    const secMetadata = {
      cik: metadata.cik ?? metadata.cik_number,
      accessionNumber: metadata.accessionNumber ?? metadata.accession_number,
      primaryDocument: metadata.primaryDocument ?? metadata.primary_document,
    }
    const secUserAgent = Deno.env.get('SEC_USER_AGENT')
    if (!secUserAgent) throw new Error('SEC_USER_AGENT_MISSING')
    const retrieval = await retrieveSecDocument(secMetadata, {
      timeoutMs: 8_000,
      maxBytes: SEC_DOCUMENT_MAX_BYTES,
      userAgent: secUserAgent,
    })
    if (!retrieval.ok) throw new Error(`SEC_RETRIEVAL_FAILED:${retrieval.code}:${retrieval.message}`)
    const chunks = buildDocumentChunks(retrieval.normalizedText)
    const coverage = computeChunkCoverage(chunks, retrieval.normalizedText)
    if (chunks.length === 0 || coverage.coverageRatio < 0.95 || coverage.coverageRatio > 1.05) throw new Error('SEC_DOCUMENT_COVERAGE_INVALID')
    const documentHash = await digestText(retrieval.normalizedText)
    const savedHash = existingProgress.documentHash
    if (typeof savedHash === 'string' && savedHash !== documentHash) throw new Error('SEC_DOCUMENT_CHANGED_DURING_ANALYSIS')
    if (typeof existingProgress.totalChunks === 'number' && existingProgress.totalChunks !== chunks.length) throw new Error('SEC_CHUNK_MANIFEST_CHANGED')

    const progress = {
      stage: 'chunks',
      runId,
      documentHash,
      totalChunks: chunks.length,
      documentBytes: retrieval.documentBytes,
      normalizedBytes: retrieval.normalizedBytes,
      nextChunkIndex: typeof existingProgress.nextChunkIndex === 'number' ? existingProgress.nextChunkIndex : 0,
    }
    const { data: storedRows, error: rowsError } = await client
      .from('analyst_job_chunk_results')
      .select('chunk_index, result_text, section, provider, model, response_id, latency_ms, input_tokens, output_tokens, success, error_message')
      .eq('job_id', job.id)
      .eq('success', true)
      .order('chunk_index', { ascending: true })
    if (rowsError) throw rowsError
    const completedIndices = new Set((storedRows ?? []).map((row) => row.chunk_index as number))
    const pendingChunks = chunks.filter((chunk) => !completedIndices.has(chunk.chunkIndex - 1))

    if (pendingChunks.length > 0) {
      let processedThisInvocation = 0
      for (const chunk of pendingChunks) {
        if (processedThisInvocation >= MAX_CHUNKS_PER_INVOCATION) break
        if (Date.now() - requestStartedAt > 100_000 && processedThisInvocation > 0) break
        const context = buildChunkContext({
          analyst: analystContext,
          assumptions: assumptions ?? [],
          decisions: decisions ?? [],
          evidence,
          section: chunk.section,
          content: chunk.content,
          chunkIndex: chunk.chunkIndex - 1,
          totalChunks: chunks.length,
        })
        const provider = providerFactory()
        const startedAt = Date.now()
        activeChunk = { index: chunk.chunkIndex - 1, section: chunk.section, provider: providerName, model: Deno.env.get('AI_MODEL') || 'gpt-5.6-terra', startedAt }
        const result = await provider.analyzeEvidence(context)
        if (!isAnalystAnalysisResult(result)) throw new Error('INVALID_CHUNK_ANALYSIS_RESULT')
        const runMetadata = getProviderMetadata(provider, providerName)
        const chunkProgress = {
          ...progress,
          processedChunks: completedIndices.size + 1,
          nextChunkIndex: chunk.chunkIndex,
        }
        const chunkResult = {
          chunk_index: chunk.chunkIndex - 1,
          result_text: JSON.stringify(result),
          section: chunk.section,
          provider: runMetadata.provider,
          model: runMetadata.model,
          response_id: runMetadata.responseId,
          latency_ms: runMetadata.latencyMs || Date.now() - startedAt,
          input_tokens: runMetadata.inputTokens,
          output_tokens: runMetadata.outputTokens,
          success: true,
          error_message: null,
        }
        const { error: saveError } = await client.rpc('save_analyst_job_chunk', {
          p_job_id: job.id,
          p_lease_token: leaseToken,
          p_progress_state: chunkProgress,
          p_chunk_result: chunkResult,
        })
        if (saveError) throw saveError
        completedIndices.add(chunk.chunkIndex - 1)
        processedThisInvocation += 1
        activeChunk = null
      }

      const { error: releaseError } = await client.rpc('release_analyst_job_batch', {
        p_job_id: job.id,
        p_lease_token: leaseToken,
      })
      if (releaseError) throw releaseError
      claimed = false
      return ok({
        outcome: 'CONTINUED',
        job_id: job.id,
        run_id: runId,
        processed_this_invocation: processedThisInvocation,
        processed_chunks: completedIndices.size,
        total_chunks: chunks.length,
        remaining_chunks: chunks.length - completedIndices.size,
        max_chunks_per_invocation: MAX_CHUNKS_PER_INVOCATION,
      }, request)
    }

    if (completedIndices.size !== chunks.length) throw new Error('SEC_CHUNK_COVERAGE_INCOMPLETE')
    const allRows = storedRows as ChunkResultRow[]
    if (allRows.some((row, index) => row.chunk_index !== index || !row.success)) throw new Error('SEC_CHUNK_RESULTS_INVALID')
    const compactResults = allRows.map(compactChunkResult)
    const summaryPrompt = [
      'Synthesize the complete set of SEC filing chunk analyses into one final equity research assessment. Every chunk index listed is from the same complete filing. Resolve contradictions conservatively, do not overstate evidence, and return only a valid AnalystAnalysisResult JSON object.',
      `Filing chunks (${chunks.length} total): ${JSON.stringify(compactResults)}`,
      `Current analyst state: ticker=${analyst.ticker}, company=${analyst.company_name ?? 'unknown'}, thesis=${analystContext.current_thesis ?? ''}, currentFairValue=${analystContext.current_fair_value ?? null}, previousFairValue=${analystContext.previous_fair_value ?? null}, confidence=${analystContext.confidence}.`,
    ].join('\n\n')
    const synthesisContext = new AnalystContextBuilder().build({
      executionMode: 'production',
      analyst: analystContext,
      assumptions: assumptions ?? [],
      decisions: decisions ?? [],
      evidence: [evidence],
      currentEvidence: {
        ...evidence,
        title: `${evidence.title} :: full filing synthesis`,
        summary: summaryPrompt,
        raw_metadata: { ...metadata, synthesis_mode: 'full_sec_filing', total_chunks: chunks.length, source_document_hash: documentHash },
        enrichment: { normalized_summary: summaryPrompt, structured_facts: [], sections: [] },
      },
    })
    const synthesisProvider = providerFactory()
    const finalResult = await synthesisProvider.analyzeEvidence(synthesisContext)
    if (!isAnalystAnalysisResult(finalResult) || !isAnalysisResultApplicable(finalResult, synthesisContext)) throw new Error('INVALID_SYNTHESIS_RESULT')
    const synthesisMetadata = getProviderMetadata(synthesisProvider, providerName)
    const openaiCalls = allRows.map((row) => ({
      chunkIndex: row.chunk_index,
      section: row.section,
      provider: row.provider,
      model: row.model,
      responseId: row.response_id,
      latencyMs: row.latency_ms,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      success: row.success,
    }))
    const finalResultWithTelemetry = {
      ...finalResult,
      analysisMode: 'full_sec_filing',
      chunkCoverage: { totalChunks: chunks.length, processedChunks: allRows.length, documentHash },
      openaiCalls,
      synthesisCall: {
        provider: synthesisMetadata.provider,
        model: synthesisMetadata.model,
        responseId: synthesisMetadata.responseId,
        latencyMs: synthesisMetadata.latencyMs,
        inputTokens: synthesisMetadata.inputTokens,
        outputTokens: synthesisMetadata.outputTokens,
        success: true,
      },
    }
    const { data: completedJob, error: completeError } = await client.rpc('complete_analyst_job', {
      p_job_id: job.id,
      p_run_id: runId,
      p_result: finalResultWithTelemetry,
      p_provider: synthesisMetadata.provider,
      p_model: synthesisMetadata.model,
    }).single()
    if (completeError) throw completeError
    claimed = false
    const { error: runMetadataError } = await client.from('analyst_runs').update({
      input_tokens: synthesisMetadata.inputTokens,
      output_tokens: synthesisMetadata.outputTokens,
      response_id: synthesisMetadata.responseId,
      latency_ms: synthesisMetadata.latencyMs,
    }).eq('id', runId)
    if (runMetadataError) throw runMetadataError
    return ok({
      outcome: 'COMPLETED',
      job: completedJob,
      run_id: runId,
      result: finalResultWithTelemetry,
      total_chunks: chunks.length,
      openai_calls: openaiCalls.length + 1,
    }, request)
  } catch (error) {
    const providerCode = error instanceof OpenAIProviderError ? error.code : null
    const message = providerCode ? `${providerCode}: ${error.message}` : error instanceof Error ? error.message : 'Unable to process analyst job.'
    if (claimed && jobId && leaseToken) {
      const failedChunk = activeChunk ? {
        chunk_index: activeChunk.index,
        result_text: '',
        section: activeChunk.section,
        provider: activeChunk.provider,
        model: activeChunk.model,
        response_id: null,
        latency_ms: Date.now() - activeChunk.startedAt,
        input_tokens: null,
        output_tokens: null,
        success: false,
        error_message: message,
      } : null
      const { error: failureError } = await createBackendClient().rpc('fail_analyst_job', {
        p_job_id: jobId,
        p_lease_token: leaseToken,
        p_reason: message,
        p_delay_seconds: 60,
        p_chunk_result: failedChunk,
      })
      if (failureError) {
        console.error('Failed to persist analyst job failure:', failureError.message)
        return errorResponse('JOB_FAILURE_PERSISTENCE_FAILED', `${message}; additionally unable to persist job failure.`, 500, request)
      }
    }
    if (message === 'AUTHORIZATION_REQUIRED' || message === 'INVALID_ACCESS_TOKEN') return errorResponse('UNAUTHORIZED', 'A valid Supabase access token is required', 401, request)
    if (message === 'BACKEND_CONFIG_MISSING') return errorResponse('BACKEND_CONFIG_MISSING', 'Supabase backend configuration is missing', 500, request)
    return errorResponse(providerCode ?? 'ANALYST_JOB_ERROR', message, providerCode === 'OPENAI_RATE_LIMITED' ? 429 : 500, request)
  }
})
