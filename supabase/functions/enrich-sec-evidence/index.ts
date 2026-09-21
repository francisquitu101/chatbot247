import { createBackendClient, requireAuthenticatedUser } from '../_shared/supabase.ts'
import { errorResponse, handleOptions, ok, readJson } from '../_shared/response.ts'
import { enrichSecFiling, SEC_EXTRACTION_VERSION } from '../_shared/sec-enrichment.ts'

const TEST_EVIDENCE_ID = 'dff01caa-f17d-44e0-b6a9-aac9a3c66884'

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

Deno.serve(async (request) => {
  const options = handleOptions(request)
  if (options) return options
  if (request.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'Use POST', 405, request)

  let enrichmentId: string | null = null
  try {
    await requireAuthenticatedUser(request)
    const body = await readJson(request)
    const requestedEvidenceId = body?.evidence_id
    const evidenceId = requestedEvidenceId === undefined ? TEST_EVIDENCE_ID : requestedEvidenceId
    if (!isUuid(evidenceId)) return errorResponse('INVALID_EVIDENCE_REQUEST', 'evidence_id must be a valid UUID', 400, request)
    const client = createBackendClient()
    const { data: evidence, error: evidenceError } = await client.from('evidence_items').select('id, ticker, source_type, source_url, raw_metadata').eq('id', evidenceId).single()
    if (evidenceError) throw evidenceError
    if (evidence.ticker !== 'NVDA' || evidence.source_type !== 'SEC') return errorResponse('EVIDENCE_NOT_ALLOWED', 'Only the selected NVDA SEC evidence is allowed for this controlled enrichment.', 400, request)
    const { data: queuedJob, error: queuedJobError } = await client.from('analyst_jobs').select('id').eq('evidence_id', evidence.id).eq('status', 'queued').limit(1).maybeSingle()
    if (queuedJobError) throw queuedJobError
    if (!queuedJob) return errorResponse('EVIDENCE_NOT_QUEUED', 'The selected evidence must belong to a queued Analyst job.', 409, request)

    const { data: existing, error: existingError } = await client.from('evidence_enrichment').select('id, content_status, extraction_version, document_bytes, sections_count, facts_count, source_document_hash, normalized_summary').eq('evidence_id', evidence.id).eq('extraction_version', SEC_EXTRACTION_VERSION).maybeSingle()
    if (existingError) throw existingError
    if (existing?.content_status === 'completed') return ok({ enrichment: existing, reused: true, evidence_id: evidence.id }, request)

    const { data: pending, error: insertError } = await client.from('evidence_enrichment').upsert({ evidence_id: evidence.id, extraction_version: SEC_EXTRACTION_VERSION, content_status: 'processing', updated_at: new Date().toISOString() }, { onConflict: 'evidence_id,extraction_version' }).select('id').single()
    if (insertError) throw insertError
    enrichmentId = pending.id
    const startedAt = Date.now()
    const result = await enrichSecFiling({ metadata: evidence.raw_metadata as Record<string, unknown> })
    const { data: enrichment, error: updateError } = await client.from('evidence_enrichment').update({ content_status: result.sections.length > 0 || result.facts.length > 0 ? 'completed' : 'partial', normalized_summary: result.normalizedSummary, sections: result.sections, structured_facts: result.facts, source_document_hash: result.sourceDocumentHash, retrieval_ms: Date.now() - startedAt, document_bytes: result.documentBytes, sections_count: result.sections.length, facts_count: result.facts.length, extracted_at: new Date().toISOString(), error_code: null, error_message: null, updated_at: new Date().toISOString() }).eq('id', enrichmentId).select('id, evidence_id, extraction_version, content_status, normalized_summary, sections_count, facts_count, document_bytes, source_document_hash, retrieval_ms, extracted_at').single()
    if (updateError) throw updateError
    return ok({ enrichment, reused: false }, request)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'SEC enrichment failed.'
    if (enrichmentId) { try { await createBackendClient().from('evidence_enrichment').update({ content_status: 'failed', error_code: message, error_message: message, updated_at: new Date().toISOString() }).eq('id', enrichmentId) } catch { /* preserve original error */ } }
    if (message === 'AUTHORIZATION_REQUIRED' || message === 'INVALID_ACCESS_TOKEN') return errorResponse('UNAUTHORIZED', 'A valid Supabase access token is required', 401, request)
    if (message === 'SEC_USER_AGENT_MISSING') return errorResponse('SEC_CONFIG_MISSING', 'SEC_USER_AGENT is not configured', 500, request)
    if (message === 'SEC_TIMEOUT') return errorResponse('SEC_TIMEOUT', 'SEC request timed out', 504, request)
    if (message === 'SEC_METADATA_INVALID') return errorResponse('SEC_METADATA_INVALID', 'The selected SEC evidence metadata is incomplete or invalid.', 422, request)
    return errorResponse('SEC_ENRICHMENT_ERROR', message, 502, request)
  }
})
