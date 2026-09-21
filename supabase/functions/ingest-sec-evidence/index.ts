import { createBackendClient, requireAuthenticatedUser } from '../_shared/supabase.ts'
import { errorResponse, handleOptions, ok, readJson } from '../_shared/response.ts'
import { SecEvidenceAdapter } from '../_shared/evidence-ingestion.ts'
import { classifyEvidence, shouldCreateAnalystJob } from '../_shared/evidence-relevance.ts'

const TEST_TICKER = 'NVDA'

Deno.serve(async (request) => {
  const options = handleOptions(request)
  if (options) return options
  if (request.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'Use POST', 405, request)

  let ingestionJobId: string | null = null
  try {
    await requireAuthenticatedUser(request)
    const body = await readJson(request)
    const ticker = typeof body?.ticker === 'string' ? body.ticker.trim().toUpperCase() : TEST_TICKER
    if (ticker !== TEST_TICKER) return errorResponse('TICKER_NOT_ALLOWED', 'The controlled SEC test currently supports NVDA only.', 400, request)

    const client = createBackendClient()
    const { data: ingestionJob, error: ingestionError } = await client
      .from('evidence_ingestion_jobs')
      .insert({ source_type: 'SEC', ticker, status: 'processing', started_at: new Date().toISOString() })
      .select('id, source_type, ticker, status, started_at')
      .single()
    if (ingestionError) throw ingestionError
    ingestionJobId = ingestionJob.id

    const adapter = new SecEvidenceAdapter()
    const rawItems = await adapter.fetch(ticker)
    const items = rawItems.map((item) => adapter.normalize(item))
    const existingIds = new Set<string>()
    if (items.length > 0) {
      const { data: existing, error: existingError } = await client
        .from('evidence_items')
        .select('external_id')
        .eq('source_type', 'SEC')
        .eq('ticker', ticker)
        .in('external_id', [...new Set(items.map((item) => item.externalId))])
      if (existingError) throw existingError
      for (const row of existing ?? []) if (row.external_id) existingIds.add(row.external_id)
    }

    let newEvidenceCount = 0
    let duplicateCount = 0
    let failedCount = 0
    let analystJobsCreated = 0
    for (const item of items) {
      if (existingIds.has(item.externalId)) {
        duplicateCount += 1
        continue
      }
      const { data: evidence, error: insertError } = await client
        .from('evidence_items')
        .insert({ ...(() => { const relevance = classifyEvidence(item.sourceType, item.metadata); return { ticker: item.ticker, source_type: item.sourceType, external_id: item.externalId, source_url: item.sourceUrl, title: item.title, summary: item.summary, published_at: item.publishedAt, content_hash: item.contentHash, raw_metadata: item.metadata, relevance_priority: relevance.priority, relevance_score: relevance.score, relevance_reason: relevance.reason, relevance_classified_at: new Date().toISOString() } })() })
        .select('id')
        .single()
      if (insertError) {
        if (insertError.code === '23505') {
          duplicateCount += 1
          continue
        }
        failedCount += 1
        continue
      }
      newEvidenceCount += 1

      const { data: analysts, error: analystError } = await client
        .from('analysts')
        .select('id')
        .eq('ticker', ticker)
        .neq('status', 'inactive')
      if (analystError) throw analystError
      for (const analyst of analysts ?? []) {
        const { error: linkError } = await client.from('analyst_evidence').upsert({ analyst_id: analyst.id, evidence_id: evidence.id, classification: 'sec_ingestion', relevance_score: 50 }, { onConflict: 'analyst_id,evidence_id' })
        if (linkError) throw linkError
        const relevance = classifyEvidence(item.sourceType, item.metadata)
        if (!shouldCreateAnalystJob(relevance.priority)) continue
        const { data: existingJobs, error: jobLookupError } = await client
          .from('analyst_jobs')
          .select('id')
          .eq('analyst_id', analyst.id)
          .eq('evidence_id', evidence.id)
          .limit(1)
        if (jobLookupError) throw jobLookupError
        if ((existingJobs ?? []).length > 0) continue
        const { error: jobError } = await client.from('analyst_jobs').insert({ analyst_id: analyst.id, evidence_id: evidence.id, trigger_type: 'evidence', priority: relevance.score, job_reason: `${item.sourceType} ${relevance.priority}: ${relevance.reason}` })
        if (jobError) {
          if (jobError.code === '23505') continue
          throw jobError
        }
        analystJobsCreated += 1
      }
    }

    const result = { ticker, source_type: 'SEC', fetched_count: items.length, new_evidence_count: newEvidenceCount, duplicate_count: duplicateCount, failed_count: failedCount, analyst_jobs_created: analystJobsCreated, watermark: { last_seen_external_id: items[0]?.externalId ?? null } }
    const { data: completedJob, error: updateError } = await client
      .from('evidence_ingestion_jobs')
      .update({ status: 'completed', completed_at: new Date().toISOString(), fetched_count: result.fetched_count, new_evidence_count: newEvidenceCount, duplicate_count: duplicateCount, failed_count: failedCount, watermark: result.watermark, updated_at: new Date().toISOString() })
      .eq('id', ingestionJobId)
      .select('id, status, fetched_count, new_evidence_count, duplicate_count, failed_count, watermark, started_at, completed_at')
      .single()
    if (updateError) throw updateError
    return ok({ ingestion_job: completedJob, ...result }, request)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'SEC ingestion failed.'
    if (ingestionJobId) {
      try { await createBackendClient().from('evidence_ingestion_jobs').update({ status: 'failed', error_code: message, error_message: message, completed_at: new Date().toISOString() }).eq('id', ingestionJobId) } catch { /* preserve original error */ }
    }
    if (message === 'AUTHORIZATION_REQUIRED' || message === 'INVALID_ACCESS_TOKEN') return errorResponse('UNAUTHORIZED', 'A valid Supabase access token is required', 401, request)
    if (message === 'SEC_USER_AGENT_MISSING') return errorResponse('SEC_CONFIG_MISSING', 'SEC_USER_AGENT is not configured', 500, request)
    if (message === 'SEC_TIMEOUT') return errorResponse('SEC_TIMEOUT', 'SEC request timed out', 504, request)
    if (message === 'TICKER_NOT_FOUND') return errorResponse('TICKER_NOT_FOUND', 'Ticker was not found in SEC company submissions.', 404, request)
    return errorResponse('SEC_INGESTION_ERROR', message, 502, request)
  }
})
