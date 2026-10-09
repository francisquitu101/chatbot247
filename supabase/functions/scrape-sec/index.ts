import { scrapeSecFilings } from './scraper.ts'
import { fetchFinvizLatestFilings } from './finviz-fallback.ts'
import { assertTrackedTicker, resolveSourceId, saveSecScrapedItems } from '../_shared/repository.ts'
import { errorResponse, handleOptions, ok, readJson } from '../_shared/response.ts'
import { normalizeTicker } from '../_shared/scraper.ts'
import { requireAuthenticatedUser } from '../_shared/supabase.ts'

async function authorizeRequest(request: Request): Promise<void> {
  const expectedCronKey = Deno.env.get('SEC_INGESTION_KEY')?.trim()
  const providedCronKey = request.headers.get('x-sec-ingestion-key')?.trim()
  if (expectedCronKey && providedCronKey && expectedCronKey === providedCronKey) return
  await requireAuthenticatedUser(request)
}

Deno.serve(async (request) => {
  const options = handleOptions(request)
  if (options) return options
  const startedAt = Date.now()
  let ticker = ''
  try {
    if (request.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'Use POST', 405, request)
    await authorizeRequest(request)
    const body = await readJson(request)
    if (!body) return errorResponse('INVALID_JSON', 'Request body must be a JSON object', 400, request)
    ticker = normalizeTicker(body.ticker) ?? ''
    if (!ticker) return errorResponse('INVALID_TICKER', 'ticker must be a valid symbol such as NVDA', 400, request)
    await assertTrackedTicker(ticker)
    console.info(JSON.stringify({ event: 'sec_started', ticker }))
    const scrape = await scrapeSecFilings(ticker)
    const sourceId = await resolveSourceId('sec')
    const finvizFilings = await fetchFinvizLatestFilings(
      ticker,
      sourceId,
      scrape.cutoffDate,
      new Date().toISOString().slice(0, 10),
    )
    const knownAccessions = new Set(
      scrape.items
        .map((item) => item.metadata.accessionNumber)
        .filter((accession): accession is string => typeof accession === 'string'),
    )
    const uniqueFallbackFilings = finvizFilings.filter((item) => {
      const accession = item.metadata.accessionNumber
      if (typeof accession !== 'string' || knownAccessions.has(accession)) return false
      knownAccessions.add(accession)
      return true
    })
    scrape.items.push(...uniqueFallbackFilings)
    scrape.totalCandidates += uniqueFallbackFilings.length
    if (uniqueFallbackFilings.length) {
      console.info(JSON.stringify({
        event: 'sec_finviz_filings_fallback_added',
        ticker,
        count: uniqueFallbackFilings.length,
      }))
    }
    const persistence = await saveSecScrapedItems(scrape.items)
    const result = {
      source: 'SEC', ticker, found: scrape.items.length, cutoffDate: scrape.cutoffDate,
      historicalSkipped: scrape.historicalSkipped, totalCandidates: scrape.totalCandidates,
      ...persistence, duration_ms: Date.now() - startedAt,
    }
    console.info(JSON.stringify({ event: 'sec_finished', ...result }))
    return ok(result, request)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error'
    const result = { source: 'SEC', ticker, found: 0, new: 0, duplicate: 0, newInserted: 0, existingSkipped: 0, historicalSkipped: 0, totalCandidates: 0, duration_ms: Date.now() - startedAt, error: message }
    console.error(JSON.stringify({ event: 'sec_error', ...result }))
    if (message === 'AUTHORIZATION_REQUIRED' || message === 'INVALID_ACCESS_TOKEN') return errorResponse('UNAUTHORIZED', 'A valid Supabase access token is required', 401, request)
    if (message === 'BACKEND_CONFIG_MISSING') return errorResponse('BACKEND_CONFIG_MISSING', 'Supabase backend configuration is missing', 500, request)
    if (message === 'TICKER_NOT_TRACKED') return errorResponse('TICKER_NOT_TRACKED', 'Ticker is not enabled in tracked_stocks', 404, request)
    if (message === 'SEC_USER_AGENT_MISSING') return errorResponse('SEC_CONFIG_MISSING', 'SEC_USER_AGENT is not configured', 500, request)
    if (message === 'SEC_TIMEOUT') return errorResponse('SEC_TIMEOUT', 'SEC request timed out', 504, request)
    return errorResponse('SEC_SCRAPER_ERROR', 'SEC scraper failed', 502, request)
  }
})