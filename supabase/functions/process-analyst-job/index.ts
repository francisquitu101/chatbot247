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
} from '../_shared/analyst-engine.ts'
import { enrichSecFiling, SEC_EXTRACTION_VERSION } from '../_shared/sec-enrichment.ts'
import { assessEvidenceContextQuality } from '../_shared/evidence-context-quality.ts'

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function getMockMode(metadata: unknown): AnalysisMode {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return 'NO_CHANGE'
  const mode = (metadata as Record<string, unknown>).mock_mode
  return mode === 'THESIS_CHANGE' || mode === 'VALUATION_CHANGE' ? mode : 'NO_CHANGE'
}

Deno.serve(async (request) => {
  const options = handleOptions(request)
  if (options) return options
  if (request.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'Use POST', 405, request)

  let jobId: string | null = null
  let claimed = false
  let runId: string | null = null

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
    runId = crypto.randomUUID()

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

    let usableEnrichment = enrichment?.content_status === 'completed' ? enrichment : null
    if (!usableEnrichment && evidence.source_type === 'SEC') {
      const extracted = await enrichSecFiling({ metadata: evidence.raw_metadata as Record<string, unknown> })
      const quality = assessEvidenceContextQuality({ summary: evidence.summary, normalizedSummary: extracted.normalizedSummary, sections: extracted.sections, structuredFacts: extracted.facts })
      const { data: persisted, error: persistError } = await client.from('evidence_enrichment').upsert({ evidence_id: evidence.id, extraction_version: SEC_EXTRACTION_VERSION, content_status: extracted.sections.length > 0 || extracted.facts.length > 0 ? 'completed' : 'partial', normalized_summary: extracted.normalizedSummary, sections: extracted.sections, structured_facts: extracted.facts, source_document_hash: extracted.sourceDocumentHash, retrieval_ms: 0, document_bytes: extracted.documentBytes, sections_count: extracted.sections.length, facts_count: extracted.facts.length, extracted_at: new Date().toISOString(), error_code: null, error_message: quality === 'sufficient' ? null : 'QUALITY_GATE_BLOCKED' }, { onConflict: 'evidence_id,extraction_version' }).select('normalized_summary, structured_facts, sections').single()
      if (persistError) throw persistError
      usableEnrichment = quality === 'sufficient' ? persisted : null
      if (!usableEnrichment) {
        const transient = result.documentBytes > 0
        if (transient) {
          await client.rpc('retry_analyst_job', { p_job_id: job.id, p_reason: 'QUALITY_GATE_RETRY', p_delay_seconds: Math.min(900, 300 * Math.max(job.attempts, 1)) })
          return errorResponse('QUALITY_GATE_RETRY', 'Evidence enrichment is partial and will be retried with bounded backoff.', 409, request)
        }
        await client.rpc('block_analyst_job', { p_job_id: job.id, p_reason: 'QUALITY_GATE_BLOCKED' })
        return errorResponse('QUALITY_GATE_BLOCKED', 'Evidence enrichment did not reach sufficient context quality.', 409, request)
      }
    }

    const executionMode = evidence.source_type === 'synthetic_test' && evidence.raw_metadata && typeof evidence.raw_metadata === 'object' && evidence.raw_metadata.execution_mode === 'development_test'
      ? 'development_test' as const
      : 'production' as const
    if (evidence.source_type === 'synthetic_test' && executionMode !== 'development_test') throw new Error('SYNTHETIC_EVIDENCE_NOT_ALLOWED')

    const context = new AnalystContextBuilder().build({
      executionMode,
      analyst: { ...analyst, current_thesis: state?.current_thesis ?? analyst.current_thesis, current_fair_value: state?.current_fair_value ?? analyst.current_fair_value, previous_fair_value: state?.previous_fair_value ?? analyst.previous_fair_value, confidence: state?.confidence ?? analyst.confidence },
      assumptions: assumptions ?? [],
      decisions: decisions ?? [],
      evidence: [evidence],
      currentEvidence: { ...evidence, enrichment: usableEnrichment ?? null },
    })
    const providerName = Deno.env.get('AI_PROVIDER') || 'openai'
    const provider = providerName === 'mock'
      ? new MockResearchProvider(getMockMode(evidence.raw_metadata))
      : new OpenAIResearchProvider()
    const result = await provider.analyzeEvidence(context)
    if (!isAnalystAnalysisResult(result) || !isAnalysisResultApplicable(result, context)) throw new Error('INVALID_ANALYSIS_RESULT')

    const { data: completedJob, error: completeError } = await client.rpc('complete_analyst_job', {
      p_job_id: job.id,
      p_run_id: runId,
      p_result: result,
      p_provider: provider.lastRunMetadata?.provider ?? 'mock',
      p_model: provider.lastRunMetadata?.model ?? 'deterministic-v1',
    }).single()
    if (completeError) throw completeError
    if (provider.lastRunMetadata) {
      const { error: metadataError } = await client.from('analyst_runs').update({
        input_tokens: provider.lastRunMetadata.inputTokens,
        output_tokens: provider.lastRunMetadata.outputTokens,
        response_id: provider.lastRunMetadata.responseId,
        latency_ms: provider.lastRunMetadata.latencyMs,
      }).eq('id', runId)
      if (metadataError) throw metadataError
    }
    return ok({ job: completedJob, run_id: runId, result }, request)
  } catch (error) {
    const providerCode = error instanceof OpenAIProviderError ? error.code : null
    const message = providerCode ? `${providerCode}: ${error.message}` : error instanceof Error ? error.message : 'Unable to process analyst job.'
    if (claimed && jobId && runId) {
      try {
        await createBackendClient().rpc('complete_analyst_job', {
          p_job_id: jobId,
          p_run_id: runId,
          p_result: {},
          p_provider: 'mock',
          p_model: 'deterministic-v1',
          p_error_message: message,
        })
      } catch {
        // Preserve the original processor error response.
      }
    }
    if (message === 'AUTHORIZATION_REQUIRED' || message === 'INVALID_ACCESS_TOKEN') return errorResponse('UNAUTHORIZED', 'A valid Supabase access token is required', 401, request)
    if (message === 'BACKEND_CONFIG_MISSING') return errorResponse('BACKEND_CONFIG_MISSING', 'Supabase backend configuration is missing', 500, request)
    return errorResponse(providerCode ?? 'ANALYST_JOB_ERROR', message, providerCode === 'OPENAI_RATE_LIMITED' ? 429 : 500, request)
  }
})
