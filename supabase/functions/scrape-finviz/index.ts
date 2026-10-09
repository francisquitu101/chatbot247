import { finvizScraper } from './scraper.ts'
import { assertTrackedTicker, saveFinvizAnalystRatings, saveFinvizInsiderTrades, saveFinvizScrapedItems } from '../_shared/repository.ts'
import { errorResponse, handleOptions, ok, readJson } from '../_shared/response.ts'
import { normalizeTicker } from '../_shared/scraper.ts'
import { createBackendClient, requireAuthenticatedUser } from '../_shared/supabase.ts'

Deno.serve(async (request) => {
  const optionsResponse = handleOptions(request)
  if (optionsResponse) return optionsResponse
  const startedAt = Date.now()
  try {
    if (request.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'Use POST', 405, request)
    try {
      await requireAuthenticatedUser(request)
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (message === 'BACKEND_CONFIG_MISSING') {
        return errorResponse('BACKEND_CONFIG_MISSING', 'Supabase backend configuration is missing', 500, request)
      }
      return errorResponse('UNAUTHORIZED', 'A valid Supabase access token is required', 401, request)
    }
    const body = await readJson(request)
    if (!body) return errorResponse('INVALID_JSON', 'Request body must be a JSON object', 400, request)
    const ticker = normalizeTicker(body.ticker)
    if (!ticker) return errorResponse('INVALID_TICKER', 'ticker must be a valid symbol such as NVDA', 400, request)
    await assertTrackedTicker(ticker)
    console.info(JSON.stringify({ event: 'scrape_started', source: 'finviz', ticker }))
    const scrape = await finvizScraper.scrapeDetailed({ ticker }); const persistence = await saveFinvizScrapedItems(scrape.news); const ratingsPersistence = await saveFinvizAnalystRatings(scrape.analystRatings); const insiderPersistence = await saveFinvizInsiderTrades(scrape.insiderTrades)
    const accessionNumbers = scrape.filings.map((filing) => filing.accession_number).filter((accession): accession is string => Boolean(accession))
    const existing = accessionNumbers.length > 0
      ? await createBackendClient().from('scraped_items').select('metadata').eq('ticker', ticker).eq('metadata->>source', 'SEC').in('metadata->>accessionNumber', accessionNumbers)
      : { data: [], error: null }
    if (existing.error) throw new Error(`Could not cross-check Finviz filings: ${existing.error.message}`)
    const existingAccessions = new Set((existing.data ?? []).map((row) => row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) && typeof row.metadata.accessionNumber === 'string' ? row.metadata.accessionNumber : '').filter(Boolean))
    const filingsCrossCheck = {
      found: scrape.filings.length,
      duplicates: scrape.filings.filter((filing) => filing.accession_number && existingAccessions.has(filing.accession_number)).length,
      missingCandidates: scrape.filings.filter((filing) => filing.accession_number && !existingAccessions.has(filing.accession_number)),
    }
    const result = { source: 'finviz', ticker, found: scrape.news.length, new: persistence.new, duplicates: persistence.duplicate, updated: persistence.updated, newsFound: scrape.news.length, ratingsFound: scrape.analystRatings.length, insiderTradesFound: scrape.insiderTrades.length, newsNew: persistence.new, ratingsNew: ratingsPersistence.new, insiderTradesNew: insiderPersistence.new, ratingsDuplicate: ratingsPersistence.duplicate, insiderTradesDuplicate: insiderPersistence.duplicate, filingsCrossCheck, durationMs: Date.now() - startedAt }
    console.info(JSON.stringify({ event: 'scrape_finished', ...result })); return ok(result, request)
  } catch (error) { const message = error instanceof Error ? error.message : ''; console.error(JSON.stringify({ event: 'scrape_failed', source: 'finviz', durationMs: Date.now() - startedAt, error: message || 'unknown error' })); if (message === 'TICKER_NOT_TRACKED') return errorResponse('TICKER_NOT_TRACKED', 'Ticker is not enabled in tracked_stocks', 404, request); if (message.includes('timed out')) return errorResponse('FIRECRAWL_TIMEOUT', 'The scraping provider timed out', 504, request); if (message.startsWith('Firecrawl')) return errorResponse('FIRECRAWL_ERROR', 'The scraping provider failed', 502, request); return errorResponse('SCRAPER_ERROR', 'Finviz scraper failed', 500, request) }
})
