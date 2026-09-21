import { createBackendClient, requireAuthenticatedUser } from '../_shared/supabase.ts'
import { errorResponse, handleOptions, ok } from '../_shared/response.ts'
import { classifyEvidence, shouldCreateAnalystJob, type EvidencePriority } from '../_shared/evidence-relevance.ts'

Deno.serve(async (request) => {
  const options = handleOptions(request)
  if (options) return options
  if (request.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'Use POST', 405, request)

  try {
    await requireAuthenticatedUser(request)
    const client = createBackendClient()
    const { data: evidenceItems, error: evidenceError } = await client
      .from('evidence_items')
      .select('id, source_type, raw_metadata')
      .eq('ticker', 'NVDA')
    if (evidenceError) throw evidenceError

    const counts: Record<EvidencePriority, number> = { critical: 0, high: 0, normal: 0, low: 0, ignored: 0 }
    let cancelledJobs = 0
    let queuedJobs = 0
    for (const item of evidenceItems ?? []) {
      const metadata = item.raw_metadata && typeof item.raw_metadata === 'object' && !Array.isArray(item.raw_metadata) ? item.raw_metadata as Record<string, unknown> : {}
      const relevance = classifyEvidence(item.source_type, metadata)
      counts[relevance.priority] += 1
      const { error: updateError } = await client.from('evidence_items').update({ relevance_priority: relevance.priority, relevance_score: relevance.score, relevance_reason: relevance.reason, relevance_classified_at: new Date().toISOString() }).eq('id', item.id)
      if (updateError) throw updateError

      const { data: jobs, error: jobsError } = await client.from('analyst_jobs').select('id, status').eq('evidence_id', item.id).eq('trigger_type', 'evidence')
      if (jobsError) throw jobsError
      for (const job of jobs ?? []) {
        if (shouldCreateAnalystJob(relevance.priority)) {
          if (job.status === 'queued') {
            const { error: reasonError } = await client.from('analyst_jobs').update({ priority: relevance.score, job_reason: `${item.source_type} ${relevance.priority}: ${relevance.reason}`, cancel_reason: null, updated_at: new Date().toISOString() }).eq('id', job.id).eq('status', 'queued')
            if (reasonError) throw reasonError
            queuedJobs += 1
          }
          continue
        }
        if (job.status === 'queued') {
          const { error: cancelError } = await client.from('analyst_jobs').update({ status: 'cancelled', cancel_reason: 'relevance_gate', job_reason: `${item.source_type} ${relevance.priority}: ${relevance.reason}`, updated_at: new Date().toISOString() }).eq('id', job.id).eq('status', 'queued')
          if (cancelError) throw cancelError
          cancelledJobs += 1
        }
      }
    }

    return ok({ ticker: 'NVDA', total: evidenceItems?.length ?? 0, counts, cancelled_jobs: cancelledJobs, queued_jobs: queuedJobs }, request)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Evidence relevance reclassification failed.'
    if (message === 'AUTHORIZATION_REQUIRED' || message === 'INVALID_ACCESS_TOKEN') return errorResponse('UNAUTHORIZED', 'A valid Supabase access token is required', 401, request)
    return errorResponse('RELEVANCE_GATE_ERROR', message, 500, request)
  }
})
