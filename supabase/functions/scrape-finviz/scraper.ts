import { load } from 'https://esm.sh/cheerio@1.0.0'
import { generateContentHash, generateIdentityHash } from '../_shared/hash.ts'
import { resolveSourceId } from '../_shared/repository.ts'
import { normalizeTicker } from '../_shared/scraper.ts'
import type { Scraper, ScrapedItemDraft } from '../_shared/scraper.ts'

const FINVIZ_URL = 'https://finviz.com/quote.ashx?t='
const FINVIZ_FILINGS_URL = 'https://finviz.com/stock?t='
const FINVIZ_TIME_ZONE = 'America/New_York'
const KURA_DIRECT_FETCH_TIMEOUT_MS = 8_000
const GOOGLE_NEWS_RSS_TIMEOUT_MS = 12_000
const GOOGLE_NEWS_RSS_MAX_BYTES = 1_000_000
const FINVIZ_FILINGS_TIMEOUT_MS = 8_000

export type FinvizAnalystRatingDraft = {
  ticker: string
  source_id: string
  rating_date: string
  action: string
  analyst: string
  rating_change: string
  price_target_change: string
  scraped_at: string
  content_hash: string
}

export type FinvizInsiderTradeDraft = {
  ticker: string
  source_id: string
  insider_name: string
  relationship: string
  transaction_date: string
  transaction: string
  cost: string
  shares: string
  value: string
  shares_total: string
  sec_form4_url: string
  form4_display_timestamp?: string | null
  scraped_at: string
  content_hash: string
}

export type FinvizMarketSnapshotDraft = {
  ticker: string
  price: number | null
  change_value: number | null
  change_pct: number | null
  volume: number | null
  avg_volume: number | null
  market_cap: number | null
  pe: number | null
  forward_pe: number | null
  eps_growth: number | null
  sales_growth: number | null
  beta: number | null
  high_52w: number | null
  low_52w: number | null
  insider_ownership: number | null
  institutional_ownership: number | null
  source: string
  updated_at: string
}

export type FinvizScrapeResult = {
  news: ScrapedItemDraft[]
  newsSource: 'yahoo_finance_rss' | 'bing_news_rss' | 'google_news_rss' | 'finviz_direct' | 'none'
  newsSourceError: string | null
  analystRatings: FinvizAnalystRatingDraft[]
  insiderTrades: FinvizInsiderTradeDraft[]
  filings: FinvizFilingDraft[]
  marketData: FinvizMarketSnapshotDraft | null
}

export type FinvizFilingDraft = {
  ticker: string
  filing_date: string
  form: string
  description: string
  accession_number: string | null
  source_url: string
  primary_document_url: string
}

function normalizeArticleText(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKC').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
}

function canonicalizeUrlForIdentity(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  try {
    const url = new URL(trimmed)
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|ref$|source$|campaign$|mc_)/i.test(key)) url.searchParams.delete(key)
    return url.toString().replace(/\/$/, '')
  } catch {
    return trimmed.replace(/\/$/, '')
  }
}

function extractYahooStableId(value: string): string | null {
  try {
    const url = new URL(value)
    const hostname = url.hostname.toLowerCase()
    if (hostname !== 'finance.yahoo.com' && hostname !== 'www.finance.yahoo.com') return null

    const path = url.pathname.replace(/\/$/, '')
    const healthcareMatch = path.match(/\/healthcare\/articles\/(?:.*-)?(\d+)\.html$/i)
    if (healthcareMatch?.[1]) {
      const slug = url.pathname.split('/').filter(Boolean).slice(-1)[0]
      return slug && slug.toLowerCase().includes('kura') ? null : `yahoo:healthcare:${healthcareMatch[1]}`
    }

    const mMatch = path.match(/^\/m\/([^/]+)$/i)
    if (mMatch?.[1]) return null
  } catch {
    return null
  }
  return null
}

function buildFinvizArticleIdentity(item: Pick<ScrapedItemDraft, 'ticker' | 'title' | 'published_at' | 'url' | 'metadata'>): string {
  const stableId = extractYahooStableId(item.url)
  if (stableId) return `finviz:${stableId}`

  const canonicalUrl = canonicalizeUrlForIdentity(item.url)
  if (canonicalUrl && !canonicalUrl.includes('finance.yahoo.com')) return `finviz:url:${canonicalUrl}`

  const ticker = normalizeArticleText(item.ticker)
  const title = normalizeArticleText(item.title)
  const publishedAt = item.published_at ? item.published_at.replace(/\.[0-9]+Z$/, 'Z').replace(/\+00$/, 'Z') : ''
  const provider = normalizeArticleText(typeof item.metadata.provider === 'string' ? item.metadata.provider : null)

  const fallback = [ticker, title, publishedAt, provider].join('|')
  return fallback.length > 0 ? `finviz:fallback:${fallback}` : `finviz:url:${canonicalUrl || item.url}`
}

function dedupeFinvizItems(items: ScrapedItemDraft[]): ScrapedItemDraft[] {
  const seen = new Map<string, ScrapedItemDraft>()
  for (const item of items) {
    const key = buildFinvizArticleIdentity(item)
    if (!seen.has(key)) seen.set(key, item)
  }
  return [...seen.values()]
}

function normalizeText(value: string | null | undefined): string | null {
  if (!value) return null
  const cleaned = value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > 0 ? cleaned : null
}

function normalizeCellText(value: string): string {
  return normalizeText(decodeHtmlEntities(value)) ?? ''
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&rarr;|&#8594;/gi, '→')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
}

function getFinvizToday(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: FINVIZ_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function parseDateContext(rawDate: string): { year: number; month: number; day: number; value: string } | null {
  const match = rawDate.match(/^([A-Za-z]{3})-(\d{2})-(\d{2})$/i)
  if (!match) return null
  const [, monthName, dayText, yearText] = match
  const monthIndex = new Date(`${monthName} 1, 2000`).getMonth()
  const day = Number(dayText)
  const yearShort = Number(yearText)
  const year = yearShort >= 50 ? 1900 + yearShort : 2000 + yearShort
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
  if (monthIndex < 0 || day < 1 || day > daysInMonth) return null
  return { year, month: monthIndex + 1, day, value: `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}` }
}

function toIsoInFinvizTimeZone(dateContext: string, hour: number, minute: number): string | null {
  const dateMatch = dateContext.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!dateMatch || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  const [, yearText, monthText, dayText] = dateMatch
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return null
  const wallClockUtc = Date.UTC(year, month - 1, day, hour, minute)
  const offsetParts = new Intl.DateTimeFormat('en-US', { timeZone: FINVIZ_TIME_ZONE, timeZoneName: 'shortOffset' }).formatToParts(new Date(wallClockUtc))
  const offset = offsetParts.find((part) => part.type === 'timeZoneName')?.value.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?$/)
  if (!offset) return null
  const offsetMinutes = (Number(offset[2]) * 60 + Number(offset[3] ?? 0)) * (offset[1] === '-' ? -1 : 1)
  return new Date(wallClockUtc - offsetMinutes * 60_000).toISOString()
}

export function parseFinvizTimestamp(rawValue: string | null, currentNewsDate: string | null): { published_at: string | null; rawTimestamp: string | null; currentNewsDate: string | null } {
  const normalized = normalizeText(rawValue)
  if (!normalized) return { published_at: null, rawTimestamp: null, currentNewsDate }
  const dateTimeMatch = normalized.match(/^([A-Za-z]{3}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})(AM|PM)$/i)
  if (dateTimeMatch) {
    const [, dateText, hoursText, minutesText, meridiem] = dateTimeMatch
    const dateContext = parseDateContext(dateText)
    const hours = Number(hoursText) % 12 + (meridiem.toUpperCase() === 'PM' ? 12 : 0)
    const minutes = Number(minutesText)
    return { published_at: dateContext ? toIsoInFinvizTimeZone(dateContext.value, hours, minutes) : null, rawTimestamp: normalized, currentNewsDate: dateContext?.value ?? currentNewsDate }
  }
  const todayTimeMatch = normalized.match(/^Today\s+(\d{1,2}):(\d{2})(AM|PM)$/i)
  const timeOnlyMatch = normalized.match(/^(\d{1,2}):(\d{2})(AM|PM)$/i)
  const timeMatch = todayTimeMatch ?? timeOnlyMatch
  if (timeMatch) {
    const [, hoursText, minutesText, meridiem] = timeMatch
    const nextDate = todayTimeMatch ? currentNewsDate ?? getFinvizToday() : currentNewsDate
    if (!nextDate) return { published_at: null, rawTimestamp: normalized, currentNewsDate: null }
    const hours = Number(hoursText) % 12 + (meridiem.toUpperCase() === 'PM' ? 12 : 0)
    const minutes = Number(minutesText)
    return { published_at: toIsoInFinvizTimeZone(nextDate, hours, minutes), rawTimestamp: normalized, currentNewsDate: nextDate }
  }
  return { published_at: null, rawTimestamp: normalized, currentNewsDate }
}

function extractNewsRows(tableHtml: string): string[] {
  return [...tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => match[1] ?? '').filter((rowHtml) => rowHtml.trim().length > 0)
}

function extractFinvizNewsTable(html: string): string | null {
  for (const match of html.matchAll(/<table\b([^>]*)>[\s\S]*?<\/table>/gi)) {
    const attributes = match[1] ?? ''
    const tableIdentity = [...attributes.matchAll(/\b(?:id|class)\s*=\s*["']([^"']*)["']/gi)]
      .flatMap((attribute) => (attribute[1] ?? '').split(/\s+/))
    if (tableIdentity.some((value) => value.toLowerCase() === 'news-table')) return match[0]
  }
  return null
}

function extractTableCells(rowHtml: string): string[] {
  return [...rowHtml.matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)].map((match) => match[1] ?? '')
}

function extractTableByClass(html: string, classPattern: RegExp): string | null {
  for (const match of html.matchAll(/<table\b([^>]*)>[\s\S]*?<\/table>/gi)) {
    const attributes = match[1] ?? ''
    const className = attributes.match(/\bclass\s*=\s*["']([^"']*)["']/i)?.[1] ?? ''
    if (classPattern.test(className)) return match[0]
  }
  return null
}

function parseFinvizCalendarDate(value: string): string | null {
  return parseDateContext(value)?.value ?? null
}

function normalizeAccessionNumber(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(/-/g, '').trim()
  if (!/^\d{1,18}$/.test(digits)) return null
  const padded = digits.padStart(18, '0')
  return `${padded.slice(0, 10)}-${padded.slice(10, 12)}-${padded.slice(12)}`
}

function parseCompactNumber(value: string | null | undefined): number | null {
  const normalized = (value ?? '').trim().replace(/[$,%\s]/g, '')
  if (!normalized || normalized === '—' || normalized === 'N/A') return null
  const match = normalized.match(/^([+-]?(?:\d+\.?\d*|\d*\.\d+))([KMBT])?$/i)
  if (!match) {
    const plain = Number.parseFloat(normalized)
    return Number.isFinite(plain) ? plain : null
  }
  const numeric = Number.parseFloat(match[1])
  const suffix = match[2]?.toUpperCase() ?? ''
  const multiplier = suffix === 'K' ? 1_000 : suffix === 'M' ? 1_000_000 : suffix === 'B' ? 1_000_000_000 : suffix === 'T' ? 1_000_000_000_000 : 1
  return numeric * multiplier
}

function parsePercentValue(value: string | null | undefined): number | null {
  const normalized = (value ?? '').trim().replace(/[$,%\s]/g, '')
  if (!normalized || normalized === '—' || normalized === 'N/A') return null
  const numeric = Number.parseFloat(normalized)
  return Number.isFinite(numeric) ? numeric : null
}

function parseSignedFloat(value: string | null | undefined): number | null {
  const normalized = (value ?? '').trim().replace(/[^0-9.+-]/g, '')
  if (!normalized || normalized === '—' || normalized === 'N/A' || normalized === '+') return null
  const numeric = Number.parseFloat(normalized)
  return Number.isFinite(numeric) ? numeric : null
}

export function extractMarketSnapshot(html: string, ticker: string): FinvizMarketSnapshotDraft | null {
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => match[1] ?? '').filter(Boolean)
  const values: Record<string, string> = {}
  for (const row of rows) {
    const cells = [...row.matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)].map((match) => normalizeText(decodeHtmlEntities(match[1] ?? '')) ?? '')
    if (cells.length < 2) continue
    const label = cells[0].trim()
    const cellValue = cells[1].trim()
    if (!label || !cellValue) continue
    values[label.toLowerCase()] = cellValue
  }

  const requestedTicker = normalizeTicker(ticker) ?? ticker.toUpperCase()
  const snapshot: Partial<FinvizMarketSnapshotDraft> = {
    ticker: requestedTicker,
    source: 'FINVIZ',
    updated_at: new Date().toISOString(),
  }

  for (const [label, value] of Object.entries(values)) {
    if (label.includes('price') && snapshot.price === undefined && value) snapshot.price = parseSignedFloat(value)
    if (label.includes('change') && !label.includes('percent') && !label.includes('%') && snapshot.change_value === undefined && value) snapshot.change_value = parseSignedFloat(value)
    if ((label.includes('change %') || label.includes('change%')) && snapshot.change_pct === undefined && value) snapshot.change_pct = parsePercentValue(value)
    if (label.includes('volume') && !label.includes('avg') && snapshot.volume === undefined && value) snapshot.volume = parseCompactNumber(value)
    if (label.includes('avg volume') && snapshot.avg_volume === undefined && value) snapshot.avg_volume = parseCompactNumber(value)
    if (label.includes('market cap') && snapshot.market_cap === undefined && value) snapshot.market_cap = parseCompactNumber(value)
    if ((label.includes('p/e') || label.includes('pe')) && !label.includes('forward') && snapshot.pe === undefined && value) snapshot.pe = parseSignedFloat(value)
    if ((label.includes('forward p/e') || label.includes('forward pe') || label.includes('fwd p/e')) && snapshot.forward_pe === undefined && value) snapshot.forward_pe = parseSignedFloat(value)
    if (label.includes('eps growth') && snapshot.eps_growth === undefined && value) snapshot.eps_growth = parsePercentValue(value)
    if (label.includes('sales growth') && snapshot.sales_growth === undefined && value) snapshot.sales_growth = parsePercentValue(value)
    if (label.includes('beta') && snapshot.beta === undefined && value) snapshot.beta = parseSignedFloat(value)
    if (label.includes('52w high') && snapshot.high_52w === undefined && value) snapshot.high_52w = parseSignedFloat(value)
    if (label.includes('52w low') && snapshot.low_52w === undefined && value) snapshot.low_52w = parseSignedFloat(value)
    if (label.includes('insider ownership') && snapshot.insider_ownership === undefined && value) snapshot.insider_ownership = parsePercentValue(value)
    if (label.includes('institutional ownership') && snapshot.institutional_ownership === undefined && value) snapshot.institutional_ownership = parsePercentValue(value)
  }

  const hasMetrics = [snapshot.price, snapshot.change_value, snapshot.change_pct, snapshot.volume, snapshot.avg_volume, snapshot.market_cap, snapshot.pe, snapshot.forward_pe, snapshot.eps_growth, snapshot.sales_growth, snapshot.beta, snapshot.high_52w, snapshot.low_52w, snapshot.insider_ownership, snapshot.institutional_ownership].some((value) => value !== null && value !== undefined)
  if (!hasMetrics) return null

  return {
    ticker: snapshot.ticker ?? requestedTicker,
    price: snapshot.price ?? null,
    change_value: snapshot.change_value ?? null,
    change_pct: snapshot.change_pct ?? null,
    volume: snapshot.volume ?? null,
    avg_volume: snapshot.avg_volume ?? null,
    market_cap: snapshot.market_cap ?? null,
    pe: snapshot.pe ?? null,
    forward_pe: snapshot.forward_pe ?? null,
    eps_growth: snapshot.eps_growth ?? null,
    sales_growth: snapshot.sales_growth ?? null,
    beta: snapshot.beta ?? null,
    high_52w: snapshot.high_52w ?? null,
    low_52w: snapshot.low_52w ?? null,
    insider_ownership: snapshot.insider_ownership ?? null,
    institutional_ownership: snapshot.institutional_ownership ?? null,
    source: snapshot.source ?? 'FINVIZ',
    updated_at: snapshot.updated_at ?? new Date().toISOString(),
  }
}

function normalizeSecUrl(value: string): string {
  if (/^https?:\/\//i.test(value)) return value
  return `https://www.sec.gov/Archives/edgar/data/${value.replace(/^\/+/, '')}`
}

export function extractFinvizFilings(html: string, ticker: string): FinvizFilingDraft[] {
  const routeData = html.match(/<script\s+id=["']route-init-data["'][^>]*>([\s\S]*?)<\/script>/i)?.[1]
  if (!routeData) return []

  try {
    const parsed = JSON.parse(routeData) as { entries?: Array<{ items?: Array<Record<string, unknown>> }> }
    const entries = parsed.entries?.[0]?.items ?? []
    return entries.flatMap((entry) => {
      const filingDate = typeof entry.filingDate === 'string' ? entry.filingDate.slice(0, 10) : ''
      const form = typeof entry.form === 'string' ? entry.form : ''
      const primaryDocumentUrl = typeof entry.primaryDocumentUrl === 'string' ? normalizeSecUrl(entry.primaryDocumentUrl) : ''
      const sourceUrl = typeof entry.filing === 'string' ? normalizeSecUrl(entry.filing) : primaryDocumentUrl
      if (!/^\d{4}-\d{2}-\d{2}$/.test(filingDate) || !form || !sourceUrl || !primaryDocumentUrl) return []
      return [{
        ticker,
        filing_date: filingDate,
        form,
        description: typeof entry.description === 'string' ? entry.description : '',
        accession_number: normalizeAccessionNumber(typeof entry.accessionNumber === 'string' ? entry.accessionNumber : null),
        source_url: sourceUrl,
        primary_document_url: primaryDocumentUrl,
      }]
    })
  } catch {
    return []
  }
}

export function extractAnalystRatings(html: string, ticker: string, sourceId: string, scrapedAt: string): FinvizAnalystRatingDraft[] {
  const tableHtml = html.match(/<table\b[^>]*\bclass\s*=\s*["'][^"']*\bjs-table-ratings\b[^"']*["'][^>]*>[\s\S]*?<\/table>/i)?.[0] ?? null
  if (!tableHtml) return []

  const ratings: FinvizAnalystRatingDraft[] = []
  for (const row of extractNewsRows(tableHtml)) {
    const cells = extractTableCells(row).map(normalizeCellText)
    if (cells.length < 5 || cells[0].toLowerCase() === 'date') continue
    const ratingDate = parseFinvizCalendarDate(cells[0])
    if (!ratingDate) continue
    ratings.push({ ticker, source_id: sourceId, rating_date: ratingDate, action: cells[1], analyst: cells[2], rating_change: cells[3], price_target_change: cells[4], scraped_at: scrapedAt, content_hash: '' })
  }
  return ratings
}

function toAbsoluteFinvizUrl(value: string, baseUrl: string): string {
  try { return new URL(value, baseUrl).toString() } catch { return value }
}

function parseInsiderCalendarDate(value: string): string | null {
  const match = value.match(/^([A-Za-z]{3})\s+(\d{1,2})\s+'(\d{2})$/i)
  if (!match) return null
  return parseDateContext(`${match[1]}-${String(match[2]).padStart(2, '0')}-${match[3]}`)?.value ?? null
}

export function extractInsiderTrades(html: string, ticker: string, sourceId: string, scrapedAt: string, baseUrl: string): FinvizInsiderTradeDraft[] {
  const tableHtml = extractTableByClass(html, /(?:^|\s)body-table(?:\s|$)/)
  if (!tableHtml || !/Insider Trading/i.test(tableHtml)) return []

  const trades: FinvizInsiderTradeDraft[] = []
  for (const row of extractNewsRows(tableHtml)) {
    const cells = extractTableCells(row)
    const values = cells.map(normalizeCellText)
    if (values.length < 9 || values[0].toLowerCase() === 'insider trading') continue
    const transactionDate = parseInsiderCalendarDate(values[2])
    if (!transactionDate) continue
    trades.push({
      ticker,
      source_id: sourceId,
      insider_name: values[0],
      relationship: values[1],
      transaction_date: transactionDate,
      transaction: values[3],
      cost: values[4],
      shares: values[5],
      value: values[6],
      shares_total: values[7],
      sec_form4_url: extractSecForm4Url(cells[8], baseUrl),
      form4_display_timestamp: values[8] || null,
      scraped_at: scrapedAt,
      content_hash: '',
    })
  }
  return trades.filter((trade) => trade.insider_name.length > 0 && trade.transaction_date.length > 0)
}

function dedupeAnalystRatings(items: FinvizAnalystRatingDraft[]): FinvizAnalystRatingDraft[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = [item.ticker, item.rating_date, item.action, item.analyst, item.rating_change, item.price_target_change].join('|')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function dedupeInsiderTrades(items: FinvizInsiderTradeDraft[]): FinvizInsiderTradeDraft[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = [item.ticker, item.insider_name, item.relationship, item.transaction_date, item.transaction, item.cost, item.shares, item.value, item.shares_total, item.sec_form4_url].join('|')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function resolveDirectNewsUrls(html: string, baseUrl: string): string {
  const tableHtml = extractFinvizNewsTable(html)
  if (!tableHtml) return html
  const normalizedTable = tableHtml.replace(/(\bhref\s*=\s*["'])([^"']+)(["'])/gi, (_match, prefix: string, href: string, suffix: string) => {
    try {
      return `${prefix}${new URL(href, baseUrl).toString()}${suffix}`
    } catch {
      return `${prefix}${href}${suffix}`
    }
  })
  return html.replace(tableHtml, normalizedTable)
}

const KNOWN_UI_TITLES = new Set([
  'overview',
  'short interest',
  'financials',
  'filings',
  'filingslatest filings',
  'set alert',
  'add to portfolio',
  'scroll to statements',
  'dividend est.',
  'technology',
  'nvda logo',
  'nvidia corp',
  'try elite free for 7 days',
])

function looksLikeNumericTitle(titleText: string | null): boolean {
  const value = normalizeText(titleText)
  if (!value) return false
  return /^\d+(?:[.,]\d+)?$/.test(value.trim())
}

function isKnownUiTitle(titleText: string | null): boolean {
  const normalized = normalizeText(titleText)
  if (!normalized) return false
  return KNOWN_UI_TITLES.has(normalized.toLowerCase())
}

function isNavigationUrl(url: string): boolean {
  const value = url.trim()
  if (!value) return true

  const lower = value.toLowerCase()
  if (lower.includes('finviz.com/stock') || lower.includes('finviz.com/quote.ashx') || lower.includes('finviz.com/register') || lower.includes('finviz.com/elite') || lower.includes('finviz.com/save_to_portfolio') || lower.includes('finviz.com/screener') || lower.includes('logo.finviz.com') || lower.includes('nvidia.com/') || lower.includes('nvidia.com')) {
    return true
  }

  try {
    const parsed = new URL(value)
    const pathname = parsed.pathname.toLowerCase()
    if (parsed.hostname.toLowerCase().includes('logo.finviz.com')) return true
    if (parsed.hostname.toLowerCase() === 'finviz.com' || parsed.hostname.toLowerCase().endsWith('.finviz.com')) {
      return !pathname.startsWith('/news/')
    }
    if (parsed.hostname.toLowerCase().includes('nvidia.com')) return true
    if (parsed.hostname.toLowerCase().includes('finviz.com') && pathname.includes('/stock')) return true
  } catch {
    if (lower.startsWith('/stock') || lower.startsWith('/quote.ashx') || lower.startsWith('/register') || lower.startsWith('/elite') || lower.startsWith('/save_to_portfolio') || lower.startsWith('/screener') || lower.startsWith('/portfolio')) {
      return true
    }
  }

  return false
}

function extractLinksFromCell(cellHtml: string): Array<{ href: string; text: string | null }> {
  return [...cellHtml.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => ({
      href: decodeHtmlEntities(match[1] ?? '').trim(),
      text: normalizeText(decodeHtmlEntities(match[2] ?? '')),
    }))
    .filter((link) => link.href.length > 0)
}

function extractSecForm4Url(cellHtml: string, baseUrl: string): string {
  const hrefs = [...cellHtml.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1] ?? '')
  const href = hrefs.find((value) => /(?:^|\/)sec\.gov\//i.test(value)) ?? hrefs.at(-1) ?? ''
  return toAbsoluteFinvizUrl(href, baseUrl)
}

function extractProviderFromTitle(titleText: string | null): string | null {
  const normalized = normalizeText(titleText)
  if (!normalized) return null

  const parentheticalMatch = normalized.match(/^(.*)\s+\(([^()]+)\)\s*$/)
  if (parentheticalMatch?.[2]) return parentheticalMatch[2].trim() || null

  return null
}

function extractProviderFromCell(cellHtml: string): string | null {
  const providerText = normalizeText(decodeHtmlEntities(cellHtml.replace(/<[^>]+>/g, ' ')))
  if (!providerText) return null

  const parentheticalMatch = providerText.match(/\(([^()]+)\)\s*$/)
  if (parentheticalMatch?.[1]) return parentheticalMatch[1].trim() || null

  const trimmed = providerText.trim()
  if (/^(?:Reuters|Stocktwits|Moby|Moneywise|DigiTimes|Bloomberg|Pitchbook|Investor's Business Daily|Associated Press|Barrons\.com)$/i.test(trimmed)) {
    return trimmed
  }

  return null
}

function extractNews(document: { html?: string | null; markdown?: string | null }, ticker: string, sourceId: string, baseUrl: string): ScrapedItemDraft[] {
  const html = document.html ?? document.markdown ?? ''
  if (!html || html.trim().length === 0) return []

  const tableHtml = extractFinvizNewsTable(html)
  if (!tableHtml) return []
  const tableTickerMatch = tableHtml.match(/data-ticker\s*=\s*["']([^"']+)["']/i)
  const tableTicker = tableTickerMatch ? normalizeTicker(tableTickerMatch[1]) : null
  const rows = extractNewsRows(tableHtml)

  if (tableTicker && tableTicker !== ticker) {
    return []
  }

  const items: ScrapedItemDraft[] = []
  const seenUrls = new Set<string>()
  let currentNewsDate: string | null = getFinvizToday()
  for (const row of rows) {
    const cells = extractTableCells(row)
    if (cells.length === 0) continue
    const firstCellText = normalizeText(decodeHtmlEntities((cells[0] ?? '').replace(/<[^>]+>/g, ' ')))
    const secondCellText = normalizeText(decodeHtmlEntities((cells[1] ?? '').replace(/<[^>]+>/g, ' ')))
    const timestampInFirstCell = Boolean(firstCellText && (/^[A-Za-z]{3}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?:AM|PM)$/i.test(firstCellText) || /^(?:Today\s+)?\d{1,2}:\d{2}(?:AM|PM)$/i.test(firstCellText)))
    const timestampInFirstTwoCells = !timestampInFirstCell && Boolean(
      firstCellText && secondCellText && /^[A-Za-z]{3}-\d{2}-\d{2}$/i.test(firstCellText) && /^\d{1,2}:\d{2}(?:AM|PM)$/i.test(secondCellText),
    )
    const timestamp = timestampInFirstCell
      ? firstCellText
      : timestampInFirstTwoCells
        ? `${firstCellText} ${secondCellText}`
        : null
    const timestampCellCount = timestampInFirstTwoCells ? 2 : timestampInFirstCell ? 1 : 0
    const parsedTimestamp = parseFinvizTimestamp(timestamp, currentNewsDate)
    const articleCells = cells.slice(timestampCellCount)
    const providerCell = cells.length > 2 ? cells.at(-1) ?? '' : ''
    const candidateLinks = articleCells.flatMap(extractLinksFromCell)
    currentNewsDate = parsedTimestamp.currentNewsDate ?? currentNewsDate
    const { published_at, rawTimestamp } = parsedTimestamp

    for (const articleLink of candidateLinks) {
      const title = articleLink.text
      if (!title || isKnownUiTitle(title) || looksLikeNumericTitle(title)) continue

      const publisher = extractProviderFromCell(providerCell)
      if (publisher && title.toLowerCase() === publisher.toLowerCase()) continue

      const url = toAbsoluteFinvizUrl(articleLink.href, baseUrl)
      if (isNavigationUrl(url)) continue

      try {
        const parsedUrl = new URL(url)
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') continue
      } catch {
        continue
      }

      if (seenUrls.has(url)) continue
      const provider = publisher ?? extractProviderFromTitle(title)
      seenUrls.add(url)
      items.push({
        source_id: sourceId,
        ticker,
        item_type: 'news',
        title,
        content: null,
        author: null,
        url,
        published_at,
        scraped_at: new Date().toISOString(),
        content_hash: '',
        metadata: {
          extractor: 'finviz-news-table',
          provider: provider ?? null,
          raw_timestamp: rawTimestamp ?? timestamp ?? null,
          display_timezone: FINVIZ_TIME_ZONE,
        },
      })
    }
  }

  return items
}

async function scrapeRssFeed(
  feed: { source: 'yahoo_finance_rss' | 'bing_news_rss' | 'google_news_rss'; provider: string; url: URL },
  ticker: string,
  sourceId: string,
): Promise<{ items: ScrapedItemDraft[]; error: string | null }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), GOOGLE_NEWS_RSS_TIMEOUT_MS)

  try {
    const response = await fetch(feed.url, {
      headers: {
        Accept: 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',
        'User-Agent': 'MarketMoleNewsIngestion/1.0',
      },
      signal: controller.signal,
    })
    if (!response.ok) return { items: [], error: `http_${response.status}` }
    const contentLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(contentLength) && contentLength > GOOGLE_NEWS_RSS_MAX_BYTES) {
      return { items: [], error: 'rss_response_too_large' }
    }

    const reader = response.body?.getReader()
    if (!reader) return { items: [], error: 'empty_rss_response' }
    const chunks: Uint8Array[] = []
    let byteLength = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > GOOGLE_NEWS_RSS_MAX_BYTES) {
        await reader.cancel()
        return { items: [], error: 'rss_response_too_large' }
      }
      chunks.push(value)
    }

    const bytes = new Uint8Array(byteLength)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    const $ = load(new TextDecoder().decode(bytes), { xmlMode: true })
    const scrapedAt = new Date().toISOString()
    const items: ScrapedItemDraft[] = []
    for (const entry of $('item').toArray().slice(0, 30)) {
      const rssItem = $(entry)
      const title = rssItem.find('title').first().text().replace(/\s+/g, ' ').trim()
      const link = rssItem.find('link').first().text().trim()
      const descriptionHtml = rssItem.find('description').first().text()
      const content = load(descriptionHtml).text().replace(/\s+/g, ' ').trim().slice(0, 2_000)
      const publisher = rssItem.find('source').first().text().replace(/\s+/g, ' ').trim() || feed.provider
      if (!title || !link) continue

      let url: URL
      try {
        url = new URL(link)
      } catch {
        continue
      }
      if (url.protocol !== 'https:') continue

      const publishedAtText = rssItem.find('pubDate').first().text().trim()
      const publishedAtDate = publishedAtText ? new Date(publishedAtText) : null
      const publishedAt = publishedAtDate && Number.isFinite(publishedAtDate.getTime())
        ? publishedAtDate.toISOString()
        : null
      const item: ScrapedItemDraft = {
        source_id: sourceId,
        ticker,
        item_type: 'news',
        title,
        content: content || null,
        author: publisher || null,
        url: url.toString(),
        published_at: publishedAt,
        scraped_at: scrapedAt,
        content_hash: '',
        metadata: {
          extractor: feed.source,
          provider: publisher,
          raw_timestamp: publishedAtText || null,
        },
      }
      item.content_hash = await generateContentHash({
        source: 'finviz',
        ticker: item.ticker,
        title: item.title,
        content: item.content,
        url: item.url,
      })
      items.push(item)
    }
    return { items, error: items.length > 0 ? null : 'no_rss_items' }
  } catch (error) {
    return {
      items: [],
      error: error instanceof DOMException && error.name === 'AbortError' ? 'rss_timeout' : 'rss_fetch_failed',
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function scrapeRssNews(ticker: string, sourceId: string): Promise<{
  items: ScrapedItemDraft[]
  source: FinvizScrapeResult['newsSource']
  error: string | null
}> {
  const yahooUrl = new URL('https://finance.yahoo.com/rss/headline')
  yahooUrl.searchParams.set('s', ticker)
  const bingUrl = new URL('https://www.bing.com/news/search')
  bingUrl.searchParams.set('q', `${ticker} stock`)
  bingUrl.searchParams.set('format', 'RSS')
  const googleUrl = new URL('https://news.google.com/rss/search')
  googleUrl.searchParams.set('q', `${ticker} stock`)
  googleUrl.searchParams.set('hl', 'en-US')
  googleUrl.searchParams.set('gl', 'US')
  googleUrl.searchParams.set('ceid', 'US:en')
  const feeds = [
    { source: 'yahoo_finance_rss', provider: 'Yahoo Finance', url: yahooUrl },
    { source: 'bing_news_rss', provider: 'Bing News', url: bingUrl },
    { source: 'google_news_rss', provider: 'Google News', url: googleUrl },
  ] as const
  const results = await Promise.all(feeds.map(async (feed) => ({
    feed,
    result: await scrapeRssFeed(feed, ticker, sourceId),
  })))
  const successful = results.find(({ result }) => result.items.length > 0)
  if (successful) {
    return { items: successful.result.items, source: successful.feed.source, error: null }
  }
  const errors = results.map(({ feed, result }) => `${feed.provider}:${result.error ?? 'no_items'}`)
  return { items: [], source: 'none', error: errors.join(',') }
}

async function scrapeFinvizDetailed({ ticker }: { ticker: string }): Promise<FinvizScrapeResult> {
    const sourceId = await resolveSourceId('finviz')
    const requestedTicker = normalizeTicker(ticker) ?? ticker.toUpperCase()
    const finvizUrl = `${FINVIZ_URL}${encodeURIComponent(requestedTicker)}`
    const startedAt = Date.now()
    let items: ScrapedItemDraft[] = []
    let pageHtml = ''
    let pageBaseUrl = finvizUrl
    let directStatus: number | null = null
    let directRows = 0
    let directSucceeded = false
    let directFetchError: string | null = null

    try {
      const response = await fetch(finvizUrl, {
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(KURA_DIRECT_FETCH_TIMEOUT_MS),
      })
      directStatus = response.status
      const contentType = response.headers.get('content-type')
      const html = await response.text()
      pageHtml = html
      pageBaseUrl = response.url
      const newsTable = extractFinvizNewsTable(html)
      const newsTableDetected = newsTable !== null
      if (response.ok && contentType && /(?:text\/html|application\/xhtml\+xml)/i.test(contentType) && newsTableDetected) {
        const normalizedHtml = resolveDirectNewsUrls(html, response.url)
        pageHtml = normalizedHtml
        const tableHtml = extractFinvizNewsTable(normalizedHtml)
        directRows = tableHtml ? extractNewsRows(tableHtml).length : 0
        items = extractNews({ html: normalizedHtml }, requestedTicker, sourceId, response.url)
        directSucceeded = items.length > 0
      }
    } catch (error) {
      directSucceeded = false
      directFetchError = error instanceof Error ? error.message : 'unknown error'
    }

    const directNews = directSucceeded ? items : extractNews({ html: pageHtml }, requestedTicker, sourceId, pageBaseUrl)
    const rssNews = await scrapeRssNews(requestedTicker, sourceId)
    items = rssNews.items.length > 0 ? rssNews.items : directNews
    console.info(JSON.stringify({
      event: 'news_transport',
      ticker: requestedTicker,
      method: rssNews.items.length > 0 ? 'google_news_rss' : directNews.length > 0 ? 'finviz_direct' : 'none',
      rssItems: rssNews.items.length,
      rssError: rssNews.error,
      finvizStatus: directStatus,
      finvizError: directFetchError,
      finvizRows: directRows,
      items: items.length,
      durationMs: Date.now() - startedAt,
    }))

    const dedupedItems = dedupeFinvizItems(items)
    for (const item of dedupedItems) {
      const articleIdentity = buildFinvizArticleIdentity(item)
      item.content_hash = await generateContentHash({
        source: 'finviz',
        ticker: item.ticker,
        title: item.title,
        content: item.content,
        url: item.url,
        articleIdentity,
      })
    }

    const scrapedAt = new Date().toISOString()
    const analystRatings = dedupeAnalystRatings(extractAnalystRatings(pageHtml, requestedTicker, sourceId, scrapedAt))
    for (const rating of analystRatings) {
      rating.content_hash = await generateIdentityHash('finviz:analyst-rating', [rating.ticker, rating.rating_date, rating.action, rating.analyst, rating.rating_change, rating.price_target_change])
    }
    const insiderTrades = dedupeInsiderTrades(extractInsiderTrades(pageHtml, requestedTicker, sourceId, scrapedAt, pageBaseUrl))
    for (const trade of insiderTrades) {
      trade.content_hash = await generateIdentityHash('finviz:insider-trade', [trade.ticker, trade.insider_name, trade.relationship, trade.transaction_date, trade.transaction, trade.cost, trade.shares, trade.value, trade.shares_total, trade.sec_form4_url])
    }
    const marketData = extractMarketSnapshot(pageHtml, requestedTicker)

    let filings: FinvizFilingDraft[] = []
    try {
      const filingsResponse = await fetch(`${FINVIZ_FILINGS_URL}${encodeURIComponent(requestedTicker)}&p=d&ty=lf`, {
        headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36' },
        signal: AbortSignal.timeout(FINVIZ_FILINGS_TIMEOUT_MS),
      })
      if (filingsResponse.ok) filings = extractFinvizFilings(await filingsResponse.text(), requestedTicker)
    } catch (error) {
      filings = []
      console.warn(JSON.stringify({
        event: 'finviz_filings_fetch_failed',
        ticker: requestedTicker,
        code: error instanceof Error ? error.message : 'FINVIZ_FILINGS_FETCH_FAILED',
      }))
    }

    return {
      news: dedupedItems,
      newsSource: rssNews.items.length > 0 ? rssNews.source : directNews.length > 0 ? 'finviz_direct' : 'none',
      newsSourceError: rssNews.error,
      analystRatings,
      insiderTrades,
      filings,
      marketData,
    }
}

export const finvizScraper: Scraper & { scrapeDetailed(input: { ticker: string }): Promise<FinvizScrapeResult> } = {
  source: 'finviz',
  async scrape(input) {
    return (await scrapeFinvizDetailed(input)).news
  },
  scrapeDetailed: scrapeFinvizDetailed,
}
