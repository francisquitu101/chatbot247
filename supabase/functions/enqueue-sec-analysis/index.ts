import { createBackendClient, requireAuthenticatedUser } from '../_shared/supabase.ts'
import { errorResponse, handleOptions, ok, readJson } from '../_shared/response.ts'

const MANUAL_ENQUEUE_COOLDOWN_MS = 60 * 60 * 1000

Deno.serve(async (request) => {
  const options = handleOptions(request)
  if (options) return options
  if (request.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'Use POST', 405, request)

  try {
    await requireAuthenticatedUser(request)
    const body = await readJson(request)
    const ticker = typeof body?.ticker === 'string' ? body.ticker.trim().toUpperCase() : ''
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker)) {
      return errorResponse('INVALID_TICKER', 'ticker must be a valid stock symbol.', 400, request)
    }

    const client = createBackendClient()
    const { data: analyst, error: analystError } = await client
      .from('analysts')
      .select('id')
      .eq('ticker', ticker)
      .eq('is_public', true)
      .neq('status', 'inactive')
      .maybeSingle()
    if (analystError) throw analystError
    if (!analyst) return errorResponse('ANALYST_NOT_FOUND', 'No active public analyst was found for this ticker.', 404, request)

    const { data: evidence, error: evidenceError } = await client
      .from('evidence_items')
      .select('id, title, published_at')
      .eq('ticker', ticker)
      .eq('source_type', 'SEC')
      .order('published_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (evidenceError) throw evidenceError
    if (!evidence) return errorResponse('SEC_EVIDENCE_NOT_FOUND', 'There is no SEC filing available to analyze yet.', 404, request)

    const { data: previousJobs, error: jobsError } = await client
      .from('analyst_jobs')
      .select('id, status, trigger_type, updated_at')
      .eq('analyst_id', analyst.id)
      .eq('evidence_id', evidence.id)
      .order('updated_at', { ascending: false })
      .limit(10)
    if (jobsError) throw jobsError

    const activeJob = previousJobs?.find((job) => job.status === 'queued' || job.status === 'processing')
    if (activeJob) return ok({ outcome: 'ALREADY_QUEUED', job_id: activeJob.id, evidence_id: evidence.id }, request)

    const recentManualJob = previousJobs?.find((job) =>
      (job.trigger_type === 'manual' || job.trigger_type === 'reprocess')
      && Date.now() - new Date(job.updated_at).getTime() < MANUAL_ENQUEUE_COOLDOWN_MS
    )
    if (recentManualJob) {
      return errorResponse('ENQUEUE_COOLDOWN', 'A manual SEC analysis for this filing was recently requested. Please wait before requesting it again.', 429, request)
    }

    const triggerType = previousJobs?.length ? 'reprocess' : 'manual'
    const { data: job, error: insertError } = await client
      .from('analyst_jobs')
      .insert({
        analyst_id: analyst.id,
        evidence_id: evidence.id,
        trigger_type: triggerType,
        priority: 1000,
        job_reason: `User requested ${ticker} SEC analysis.`,
      })
      .select('id, status, evidence_id')
      .single()
    if (insertError) {
      if (insertError.code === '23505') {
        const { data: duplicateJob, error: duplicateError } = await client
          .from('analyst_jobs')
          .select('id, status, evidence_id')
          .eq('analyst_id', analyst.id)
          .eq('evidence_id', evidence.id)
          .in('status', ['queued', 'processing'])
          .limit(1)
          .maybeSingle()
        if (duplicateError) throw duplicateError
        if (duplicateJob) return ok({ outcome: 'ALREADY_QUEUED', job_id: duplicateJob.id, evidence_id: evidence.id }, request)
      }
      throw insertError
    }

    return ok({ outcome: 'QUEUED', job_id: job.id, evidence_id: evidence.id, filing: evidence.title }, request)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to enqueue SEC analysis.'
    if (message === 'AUTHORIZATION_REQUIRED' || message === 'INVALID_ACCESS_TOKEN') {
      return errorResponse('UNAUTHORIZED', 'Sign in before requesting an analysis.', 401, request)
    }
    if (message === 'BACKEND_CONFIG_MISSING') {
      return errorResponse('BACKEND_CONFIG_MISSING', 'Supabase backend configuration is missing.', 500, request)
    }
    console.error('SEC analysis enqueue failed:', message)
    return errorResponse('ENQUEUE_FAILED', 'Unable to queue SEC analysis right now.', 500, request)
  }
})
