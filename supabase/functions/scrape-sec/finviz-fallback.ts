import type { ScrapedItemDraft } from '../_shared/scraper.ts'

type FinvizFilingRecord = {
  document?: string
  filing?: string
  filingDate?: string
  form?: string
  reportDate?: string
}

const RELEVANT_FORMS = new Set(['4', '8-K', '10-Q', '10-K', 'S-1', '144'])

function isSecUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && (url.hostname === 'www.sec.gov' || url.hostname === 'sec.gov')
  } catch {
    return false
  }
}

function normalizeForm(form: string): string {
  return form.trim().toUpperCase().replace(/\/A$/, '')
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function fetchFinvizLatestFilings(
  ticker: string,
  sourceId: string,
  fromDate: string,
  toDate: string,
): Promise<ScrapedItemDraft[]> {
  try {
    const response = await fetch(`https://finviz.com/stock?t=${encodeURIComponent(ticker)}&p=d&ty=lf`, {
      headers: { 'User-Agent': 'MarketMole SEC filings fallback', Accept: 'text/html' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`FINVIZ_FILINGS_HTTP_${response.status}`)
    const html = await response.text()
    const routeData = html.match(/<script[^>]+id="route-init-data"[^>]*>([\s\S]*?)<\/script>/i)?.[1]
    if (!routeData) throw new Error('FINVIZ_FILINGS_DATA_MISSING')
    const parsed: unknown = JSON.parse(routeData)
    if (!parsed || typeof parsed !== 'object' || !('entries' in parsed)) throw new Error('FINVIZ_FILINGS_DATA_INVALID')
    const entries = (parsed as { entries?: { items?: unknown } }).entries?.items
    if (!Array.isArray(entries)) throw new Error('FINVIZ_FILINGS_DATA_INVALID')

    const scrapedAt = new Date().toISOString()
    const filings: ScrapedItemDraft[] = []
    for (const value of entries) {
      if (!value || typeof value !== 'object') continue
      const item = value as FinvizFilingRecord
      const form = typeof item.form === 'string' ? item.form.trim() : ''
      const filingDate = typeof item.filingDate === 'string' ? item.filingDate.slice(0, 10) : ''
      if (!RELEVANT_FORMS.has(normalizeForm(form)) || filingDate < fromDate || filingDate > toDate) continue
      if (!isSecUrl(item.filing) || !isSecUrl(item.document)) continue
      const filingUrl = new URL(item.filing)
      const accession = filingUrl.pathname.match(/\/(\d{10}-\d{2}-\d{6})-index\.html$/i)?.[1]
      const cik = filingUrl.pathname.match(/\/Archives\/edgar\/data\/(\d+)\//i)?.[1]
      if (!accession || !cik) continue
      const metadata = {
        source: 'sec',
        ingestionFallback: 'finviz_recent_filings',
        form,
        baseForm: normalizeForm(form),
        accessionNumber: accession,
        cik,
        filingDate,
        reportDate: typeof item.reportDate === 'string' ? item.reportDate.slice(0, 10) : null,
        documentUrl: item.document,
      }
      const content = JSON.stringify(metadata)
      filings.push({
        source_id: sourceId,
        ticker,
        item_type: 'news',
        title: `${ticker} ${form} filing (${filingDate})`,
        content,
        author: null,
        url: item.filing,
        published_at: `${filingDate}T00:00:00.000Z`,
        scraped_at: scrapedAt,
        content_hash: await digest(`SEC|${ticker}|${accession}`),
        metadata,
      })
    }
    return filings
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'sec_finviz_filings_fallback_failed',
      ticker,
      code: error instanceof Error ? error.message : 'FINVIZ_FILINGS_FALLBACK_FAILED',
    }))
    return []
  }
}
