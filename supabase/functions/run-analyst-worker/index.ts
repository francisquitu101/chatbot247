import { createBackendClient } from '../_shared/supabase.ts'
import { errorResponse, handleOptions, ok } from '../_shared/response.ts'

const MAX_JOBS_PER_INVOCATION = 1
const WORKER_KEY_ENV = 'ANALYST_WORKER_KEY'

Deno.serve(async (request) => {
  const options = handleOptions(request)
  if (options) return options
  if (request.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'Use POST', 405, request)
  const workerKey = Deno.env.get(WORKER_KEY_ENV)
  if (!workerKey || request.headers.get('x-analyst-worker-key') !== workerKey) return errorResponse('UNAUTHORIZED', 'Worker authorization required.', 401, request)

  const client = createBackendClient()
  const startedAt = Date.now()
  const stats = { jobs_discovered: 0, jobs_claimed: 0, jobs_analyzed: 0, jobs_completed: 0, jobs_blocked: 0, jobs_failed: 0, openai_calls: 0, latency_ms: 0 }
  const results: Array<Record<string, unknown>> = []
  try {
    const { data: queued, error: queueError } = await client
      .from('analyst_jobs')
      .select('id, analyst_id, evidence_id, priority, scheduled_for')
      .eq('status', 'queued')
      .lte('scheduled_for', new Date().toISOString())
      .order('priority', { ascending: false })
      .order('scheduled_for', { ascending: true })
      .limit(MAX_JOBS_PER_INVOCATION)
    if (queueError) throw queueError
    stats.jobs_discovered = queued?.length ?? 0

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    if (!supabaseUrl) throw new Error('BACKEND_CONFIG_MISSING')
    for (const job of queued ?? []) {
      const response = await fetch(`${supabaseUrl}/functions/v1/process-analyst-job`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${workerKey}`, apikey: workerKey, 'x-analyst-worker-key': workerKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: job.id }),
      })
      const payload: unknown = await response.json().catch(() => null)
      const errorPayload = payload && typeof payload === 'object' && 'error' in payload ? (payload as Record<string, unknown>).error : null
      const errorCode = errorPayload && typeof errorPayload === 'object' && 'code' in errorPayload ? String((errorPayload as Record<string, unknown>).code) : ''
      if (errorCode !== 'JOB_NOT_AVAILABLE') stats.jobs_claimed += 1
      if (response.ok) {
        const data = payload && typeof payload === 'object' && 'data' in payload ? payload.data as Record<string, unknown> : {}
        const result = data.result && typeof data.result === 'object' ? data.result as Record<string, unknown> : {}
        const outcome = data.outcome === 'CONTINUED' ? 'CONTINUED' : 'ANALYZED'
        stats.jobs_analyzed += 1
        stats.jobs_completed += outcome === 'ANALYZED' ? 1 : 0
        stats.openai_calls += typeof data.openai_calls === 'number'
          ? data.openai_calls
          : outcome === 'CONTINUED' && typeof data.processed_this_invocation === 'number'
            ? data.processed_this_invocation
            : 1
        results.push({
          job_id: job.id,
          evidence_id: job.evidence_id,
          outcome,
          run_id: data.run_id ?? null,
          processed_this_invocation: data.processed_this_invocation ?? null,
          processed_chunks: data.processed_chunks ?? null,
          total_chunks: data.total_chunks ?? null,
          materiality: result.materiality,
          thesisChanged: result.thesisChanged,
          valuationChanged: result.valuationChanged,
        })
      } else if (response.status === 409 && payload && typeof payload === 'object' && 'error' in payload && String((payload as Record<string, unknown>).error).includes('QUALITY')) {
        if (errorCode === 'QUALITY_GATE_BLOCKED') {
          stats.jobs_blocked += 1
          results.push({ job_id: job.id, evidence_id: job.evidence_id, outcome: 'BLOCKED', run_id: null, reason: errorCode })
        } else {
          stats.jobs_failed += 1
          results.push({ job_id: job.id, evidence_id: job.evidence_id, outcome: 'FAILED', run_id: null, reason: errorCode || 'PROCESSOR_CONFLICT' })
        }
      } else {
        stats.jobs_failed += 1
        results.push({ job_id: job.id, evidence_id: job.evidence_id, outcome: 'FAILED', run_id: null, http_status: response.status, reason: errorCode || 'PROCESSOR_ERROR' })
      }
    }
    stats.latency_ms = Date.now() - startedAt
    return ok({ worker_status: stats.jobs_discovered === 0 ? 'idle' : 'completed', max_jobs_per_invocation: MAX_JOBS_PER_INVOCATION, stats, results }, request)
  } catch (error) {
    stats.latency_ms = Date.now() - startedAt
    const message = error instanceof Error ? error.message : 'Worker failed.'
    return errorResponse(message === 'BACKEND_CONFIG_MISSING' ? message : 'WORKER_ERROR', message, 500, request)
  }
})
