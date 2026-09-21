import { finvizScraper } from '../scrape-finviz/scraper.ts'
import { stockTwitsScraper } from '../scrape-stocktwits/scraper.ts'
import { scrapeSecFilings } from '../scrape-sec/scraper.ts'
import { createBackendClient } from '../_shared/supabase.ts'
import { saveFinvizAnalystRatings, saveFinvizInsiderTrades, saveFinvizMarketSnapshots, saveFinvizScrapedItems, saveScrapedItem, saveSecScrapedItems } from '../_shared/repository.ts'
import { errorResponse, handleOptions, ok } from '../_shared/response.ts'

const MAX_CONCURRENCY = 3
const FIVE_MINUTES_MS = 5 * 60 * 1000
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000
let cycleRunning = false

/**
 * Calls register-notification Edge Function to create pending notifications
 * This is best-effort and failures should not block scraping
 */
function getNativeNotificationServiceKey(): string | null {
  const raw = Deno.env.get('SUPABASE_SECRET_KEYS')
  if (!raw) return null

  try {
    const keys = JSON.parse(raw) as Record<string, unknown>
    const value = keys.notificationservice
    return typeof value === 'string' && value.length > 0 ? value : null
  } catch {
    return null
  }
}

async function registerNotifications(events: Array<{
  ticker: string
  event_type: 'news' | 'sec' | 'rating' | 'insider'
  event_id: string
  title: string
  url?: string | null
  published_at?: string | null
}>): Promise<void> {
  if (events.length === 0) return

  try {
    const apiKey = getNativeNotificationServiceKey()
    if (!apiKey) {
      console.warn(JSON.stringify({ event: 'notification_service_key_missing' }))
      return
    }

    for (const event of events) {
      try {
        const response = await fetch(
          `${Deno.env.get('SUPABASE_URL')}/functions/v1/register-notification`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              apikey: apiKey,
            },
            body: JSON.stringify(event),
          }
        )

        if (!response.ok) {
          console.warn(JSON.stringify({
            event: 'register_notification_failed',
            ticker: event.ticker,
            event_type: event.event_type,
            status: response.status,
          }))
        }
      } catch (error) {
        console.warn(JSON.stringify({
          event: 'register_notification_error',
          ticker: event.ticker,
          error: error instanceof Error ? error.message : 'unknown',
        }))
      }
    }
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'notification_registration_error',
      error: error instanceof Error ? error.message : 'unknown',
    }))
  }
}

function getFinvizIngestionKey(): string | null {
  const raw = Deno.env.get('FINVIZ_INGESTION_KEY')
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

function isAuthorized(request: Request): boolean {
  const expected = getFinvizIngestionKey()
  if (!expected) return false
  const provided = request.headers.get('x-finviz-ingestion-key') ?? ''
  return provided === expected
}

async function runFinviz(ticker: string) {
  try {
    const scrape = await finvizScraper.scrapeDetailed({ ticker })
    let newsPersistence = { new: 0, duplicate: 0, updated: 0 }
    let ratingsPersistence = { new: 0, duplicate: 0 }
    let insiderPersistence = { new: 0, duplicate: 0 }
    let marketSnapshotPersistence = { new: 0 }
    let newsError: string | null = null
    let ratingsError: string | null = null
    let insiderTradesError: string | null = null
    let marketSnapshotError: string | null = null
    const notificationEvents: Array<{
      ticker: string
      event_type: 'news' | 'sec' | 'rating' | 'insider'
      event_id: string
      title: string
      url?: string
      published_at?: string | null
      source?: string
    }> = []

    try {
      newsPersistence = await saveFinvizScrapedItems(scrape.news)
      // Register notifications for new news items
      if (newsPersistence.new > 0) {
        const newItems = scrape.news.slice(0, newsPersistence.new)
        for (const item of newItems) {
          notificationEvents.push({
            ticker,
            event_type: 'news',
            event_id: item.content_hash,
            title: item.title || 'Market News',
            url: item.url,
            published_at: item.published_at,
            source: typeof item.metadata?.provider === 'string' ? item.metadata.provider : 'Finviz',
          })
        }
      }
    } catch (error) {
      newsError = error instanceof Error ? error.message : 'unknown error'
      console.error(JSON.stringify({ event: 'finviz_news_persistence_error', ticker, error: newsError }))
    }

    try {
      ratingsPersistence = await saveFinvizAnalystRatings(scrape.analystRatings)
      // Register notifications for new analyst ratings
      if (ratingsPersistence.new > 0) {
        const newItems = scrape.analystRatings.slice(0, ratingsPersistence.new)
        for (const item of newItems) {
          notificationEvents.push({
            ticker,
            event_type: 'rating',
            event_id: item.content_hash,
            title: `Rating from ${item.analyst}: ${item.action}`,
            published_at: item.rating_date,
          })
        }
      }
    } catch (error) {
      ratingsError = error instanceof Error ? error.message : 'unknown error'
      console.error(JSON.stringify({ event: 'finviz_ratings_persistence_error', ticker, error: ratingsError }))
    }

    try {
      insiderPersistence = await saveFinvizInsiderTrades(scrape.insiderTrades)
      // Register notifications for new insider trades
      if (insiderPersistence.new > 0) {
        const newItems = scrape.insiderTrades.slice(0, insiderPersistence.new)
        for (const item of newItems) {
          notificationEvents.push({
            ticker,
            event_type: 'insider',
            event_id: item.content_hash,
            title: `Insider Trade: ${item.insider_name} - ${item.transaction}`,
            published_at: item.transaction_date,
            url: item.sec_form4_url || undefined,
          })
        }
      }
    } catch (error) {
      insiderTradesError = error instanceof Error ? error.message : 'unknown error'
      console.error(JSON.stringify({ event: 'finviz_insider_persistence_error', ticker, error: insiderTradesError }))
    }

    try {
      if (scrape.marketData) {
        marketSnapshotPersistence = await saveFinvizMarketSnapshots([scrape.marketData])
      }
    } catch (error) {
      marketSnapshotError = error instanceof Error ? error.message : 'unknown error'
      console.error(JSON.stringify({ event: 'finviz_market_snapshot_persistence_error', ticker, error: marketSnapshotError }))
    }

    // Register notifications (best effort, don't block scraping)
    await registerNotifications(notificationEvents)

    const errors = [newsError, ratingsError, insiderTradesError, marketSnapshotError].filter(Boolean)
    const status = errors.length === 0 ? 'ok' : errors.length === 4 ? 'error' : 'partial'
    return { ok: errors.length === 0, status, found: scrape.news.length, ...newsPersistence, newsFound: scrape.news.length, ratingsFound: scrape.analystRatings.length, insiderTradesFound: scrape.insiderTrades.length, marketSnapshotNew: marketSnapshotPersistence.new, newsNew: newsPersistence.new, ratingsNew: ratingsPersistence.new, insiderTradesNew: insiderPersistence.new, ratingsDuplicate: ratingsPersistence.duplicate, insiderTradesDuplicate: insiderPersistence.duplicate, newsError, ratingsError, insiderTradesError, marketSnapshotError }
  } catch (error) {
    return { ok: false, status: 'error', error: error instanceof Error ? error.message : 'unknown error' }
  }
}

async function runStockTwitsForTicker(ticker: string) {
  const startedAt = Date.now()
  try {
    const items = await stockTwitsScraper.scrape({ ticker })
    let newItems = 0
    let duplicates = 0
    for (const item of items) {
      if (await saveScrapedItem(item) === 'new') newItems += 1
      else duplicates += 1
    }
    const result = { ok: true, firecrawl_status: 'success', found: items.length, new: newItems, duplicate: duplicates, duplicates, duration_ms: Date.now() - startedAt }
    console.info(JSON.stringify({ event: 'stocktwits_transport', ticker, ...result }))
    return result
  } catch (error) {
    const result = { ok: false, firecrawl_status: 'error', found: 0, new: 0, duplicate: 0, duplicates: 0, duration_ms: Date.now() - startedAt, error: error instanceof Error ? error.message : 'unknown error' }
    console.info(JSON.stringify({ event: 'stocktwits_transport', ticker, ...result }))
    return result
  }
}

async function runSecForTicker(ticker: string, rotationIndex: number, watchlistSize: number) {
  const startedAt = Date.now()
  console.info(JSON.stringify({ event: 'sec_started', ticker, cik: null, selected: true, rotationIndex, watchlistSize }))
  try {
    const scrape = await scrapeSecFilings(ticker)
    const persistence = await saveSecScrapedItems(scrape.items)

    // Register notifications for new SEC filings
    if (persistence.new > 0) {
      interface SecFilingItem {
        content_hash: string
        title?: string | null
        url: string
        published_at: string | null
      }
      const notificationEvents = scrape.items.slice(0, persistence.new).map((item: SecFilingItem) => ({
        ticker,
        event_type: 'sec' as const,
        event_id: item.content_hash,
        title: item.title || 'SEC Filing',
        url: item.url,
        published_at: item.published_at,
        source: 'SEC EDGAR',
      }))
      await registerNotifications(notificationEvents)
    }

    const result = {
      ok: true,
      found: scrape.items.length,
      cutoffDate: scrape.cutoffDate,
      historicalSkipped: scrape.historicalSkipped,
      totalCandidates: scrape.totalCandidates,
      ...persistence,
      rotationIndex,
      watchlistSize,
      duration_ms: Date.now() - startedAt,
    }
    console.info(JSON.stringify({ event: 'sec_finished', ticker, cik: scrape.items[0]?.metadata.cik ?? null, selected: true, ...result }))
    return result
  } catch (error) {
    const result = { ok: false, found: 0, new: 0, duplicate: 0, rotationIndex, watchlistSize, duration_ms: Date.now() - startedAt, error: error instanceof Error ? error.message : 'unknown error' }
    console.error(JSON.stringify({ event: 'sec_error', ticker, cik: null, selected: true, ...result }))
    return result
  }
}

async function scrapeTicker(ticker: string, runStockTwits: boolean, selectedStockTwitsTicker: string | null, runSec: boolean, selectedSecTicker: string | null, rotationIndex: number, watchlistSize: number) {
  const startedAt = Date.now()
  const finviz = await runFinviz(ticker)
  const stocktwits = runStockTwits
    ? await runStockTwitsForTicker(ticker)
    : { ok: true, skipped: true, reason: '15m_interval', firecrawl_status: 'skipped', found: 0, new: 0, duplicate: 0, duration_ms: 0 }
  const sec = runSec ? await runSecForTicker(ticker, rotationIndex, watchlistSize) : { ok: true, skipped: true, reason: '15m_interval', found: 0, new: 0, duplicate: 0, duration_ms: 0 }
  const result = { ticker, finviz, stocktwits, sec, runStockTwits, selectedStockTwitsTicker, runSec, selectedSecTicker, rotationIndex, watchlistSize, durationMs: Date.now() - startedAt }
  console.info(JSON.stringify({ event: 'watchlist_ticker_finished', ...result }))
  return result
}

Deno.serve(async (request) => {
  const options = handleOptions(request)
  if (options) return options
  if (request.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'Use POST', 405, request)
  if (!isAuthorized(request)) return errorResponse('UNAUTHORIZED', 'Internal Finviz ingestion authorization required', 401, request)
  if (cycleRunning) return errorResponse('CYCLE_IN_PROGRESS', 'A watchlist cycle is already running', 409, request)

  const startedAt = Date.now()
  cycleRunning = true
  try {
    const cycleSlot = Math.floor(Date.now() / FIVE_MINUTES_MS)
    const shouldRunStockTwits = cycleSlot % 3 === 0
    const { data, error } = await createBackendClient()
      .from('tracked_stocks')
      .select('ticker')
      .eq('enabled', true)
      .order('ticker', { ascending: true })
    if (error) throw error

    const tickers = (data ?? []).map((row) => row.ticker)
    const stockTwitsSlot = Math.floor(Date.now() / FIFTEEN_MINUTES_MS)
    const rotationIndex = tickers.length > 0 ? stockTwitsSlot % tickers.length : -1
    const selectedStockTwitsTicker = shouldRunStockTwits ? tickers[rotationIndex] ?? null : null
    const selectedSecTicker = shouldRunStockTwits ? tickers[rotationIndex] ?? null : null
    const results: Awaited<ReturnType<typeof scrapeTicker>>[] = []
    let nextIndex = 0

    async function worker() {
      while (nextIndex < tickers.length) {
        const index = nextIndex
        nextIndex += 1
        results.push(await scrapeTicker(tickers[index], tickers[index] === selectedStockTwitsTicker, selectedStockTwitsTicker, tickers[index] === selectedSecTicker, selectedSecTicker, rotationIndex, tickers.length))
      }
    }

    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, tickers.length) }, () => worker()))
    const result = { source: 'watchlist', tickers: tickers.length, runStockTwits: shouldRunStockTwits, selectedStockTwitsTicker, selectedSecTicker, rotationIndex, watchlistSize: tickers.length, results, durationMs: Date.now() - startedAt }
    console.info(JSON.stringify({ event: 'watchlist_scrape_finished', ...result }))
    return ok(result, request)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error'
    console.error(JSON.stringify({ event: 'watchlist_scrape_failed', durationMs: Date.now() - startedAt, error: message }))
    return errorResponse('WATCHLIST_SCRAPER_ERROR', 'Watchlist scraping cycle failed', 500, request)
  } finally {
    cycleRunning = false
  }
})
