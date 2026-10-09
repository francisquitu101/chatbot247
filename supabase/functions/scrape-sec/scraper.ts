import { resolveSourceId } from '../_shared/repository.ts'
import type { ScrapedItemDraft } from '../_shared/scraper.ts'

const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json'
const SEC_SUBMISSIONS_URL = 'https://data.sec.gov/submissions/CIK'
const SEC_ARCHIVES_URL = 'https://www.sec.gov/Archives/edgar/data'
const SEC_USER_AGENT_ENV = 'SEC_USER_AGENT'
const REQUEST_TIMEOUT_MS = 8_000
const RELEVANT_FORMS = new Set([
  '8-K', '10-K', '10-Q', '20-F', '6-K', '3', '4', '5', '144',
  'SC 13D', 'SC 13G', 'SCHEDULE 13D', 'SCHEDULE 13G', 'S-1', 'S-3', 'S-4', 'S-8',
])

type TickerEntry = { cik_str?: number; ticker?: string; title?: string }
type RecentFilings = {
  form?: string[]
  filingDate?: string[]
  reportDate?: string[]
  accessionNumber?: string[]
  primaryDocument?: string[]
  isXBRL?: Array<boolean | number>
  items?: Array<string | string[]>
}
type Submissions = { name?: string; filings?: { recent?: RecentFilings } }

export type SecFiling = {
  ticker: string
  cik: string
  companyName: string
  form: string
  baseForm: string
  isAmendment: boolean
  filingDate: string | null
  reportDate: string | null
  accessionNumber: string
  primaryDocument: string | null
  filingUrl: string | null
  isXbrl: boolean | null
  items: string[]
}

export type SecScrapeResult = {
  items: ScrapedItemDraft[]
  cutoffDate: string
  historicalSkipped: number
  totalCandidates: number
}

function getHeaders(): HeadersInit {
  const userAgent = Deno.env.get(SEC_USER_AGENT_ENV)?.trim()
  if (!userAgent) throw new Error('SEC_USER_AGENT_MISSING')
  return { 'User-Agent': userAgent, Accept: 'application/json' }
}

async function fetchJson<T>(url: string, headers: HeadersInit): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      if (!response.ok) {
        const error = new Error(`SEC_HTTP_${response.status}`)
        if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
          await new Promise((resolve) => setTimeout(resolve, 250))
          continue
        }
        throw error
      }
      return await response.json() as T
    } catch (error) {
      const isTimeout = error instanceof DOMException && error.name === 'TimeoutError'
      const isNetworkFailure = error instanceof TypeError
      if (attempt === 0 && (isTimeout || isNetworkFailure)) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        continue
      }
      if (isTimeout) throw new Error('SEC_TIMEOUT')
      throw error
    }
  }
  throw new Error('SEC_REQUEST_FAILED')
}

function normalizeForm(form: string): { baseForm: string; isAmendment: boolean } {
  const normalized = form.trim().toUpperCase()
  const isAmendment = normalized.endsWith('/A')
  return { baseForm: isAmendment ? normalized.slice(0, -2) : normalized, isAmendment }
}

function normalizeItems(value: string | string[] | undefined): string[] {
  const values = Array.isArray(value) ? value : value ? value.split(',') : []
  return values.map((item) => item.trim()).filter(Boolean)
}

function filingUrl(cik: string, accessionNumber: string, primaryDocument: string | null): string | null {
  return primaryDocument
    ? `${SEC_ARCHIVES_URL}/${Number(cik)}/${accessionNumber.replaceAll('-', '')}/${primaryDocument}`
    : null
}

function digest(value: string): Promise<string> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)).then((bytes) =>
    Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join(''))
}

function toFiling(submissions: Submissions, ticker: string, cik: string, companyName: string, index: number): SecFiling | null {
  const recent = submissions.filings?.recent
  const form = recent?.form?.[index]
  const accessionNumber = recent?.accessionNumber?.[index]
  if (!form || !accessionNumber) return null
  const { baseForm, isAmendment } = normalizeForm(form)
  if (!RELEVANT_FORMS.has(baseForm)) return null
  const primaryDocument = recent?.primaryDocument?.[index] ?? null
  return {
    ticker,
    cik,
    companyName,
    form,
    baseForm,
    isAmendment,
    filingDate: recent?.filingDate?.[index] ?? null,
    reportDate: recent?.reportDate?.[index] ?? null,
    accessionNumber,
    primaryDocument,
    filingUrl: filingUrl(cik, accessionNumber, primaryDocument),
    isXbrl: recent?.isXBRL?.[index] === undefined ? null : Boolean(recent.isXBRL[index]),
    items: normalizeItems(recent?.items?.[index]),
  }
}

export async function scrapeSecFilings(ticker: string): Promise<SecScrapeResult> {
  const headers = getHeaders()
  const directory = await fetchJson<Record<string, TickerEntry>>(SEC_TICKERS_URL, headers)
  const match = Object.values(directory).find((entry) => entry.ticker?.trim().toUpperCase() === ticker)
  if (!match?.cik_str || !match.title) throw new Error('TICKER_NOT_FOUND')
  const cik = String(match.cik_str).padStart(10, '0')
  const submissions = await fetchJson<Submissions>(`${SEC_SUBMISSIONS_URL}${cik}.json`, headers)
  const companyName = submissions.name ?? match.title
  const recent = submissions.filings?.recent?.form ?? []
  const cutoff = new Date()
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1)
  const cutoffDate = cutoff.toISOString().slice(0, 10)
  const allFilings = recent.map((_, index) => toFiling(submissions, ticker, cik, companyName, index)).filter((filing): filing is SecFiling => filing !== null)
  const historicalSkipped = allFilings.filter((filing) => filing.filingDate !== null && filing.filingDate < cutoffDate).length
  const filings = allFilings.filter((filing) => filing.filingDate !== null && filing.filingDate >= cutoffDate)
  const sourceId = await resolveSourceId('sec')

  const items = await Promise.all(filings.map(async (filing) => {
    const filingKey = filing.accessionNumber
    const title = `${filing.form} — ${filing.companyName}`
    const content = JSON.stringify({ form: filing.form, filingDate: filing.filingDate, reportDate: filing.reportDate, accessionNumber: filing.accessionNumber, items: filing.items })
    return {
      source_id: sourceId,
      ticker: filing.ticker,
      item_type: 'news',
      title,
      content,
      author: null,
      url: filing.filingUrl ?? `${SEC_SUBMISSIONS_URL}${filing.cik}.json`,
      published_at: filing.filingDate,
      scraped_at: new Date().toISOString(),
      content_hash: await digest(`SEC|${filing.ticker}|${filingKey}`),
      metadata: {
        source: 'SEC', cik: filing.cik, form: filing.form, baseForm: filing.baseForm, isAmendment: filing.isAmendment,
        accessionNumber: filing.accessionNumber, reportDate: filing.reportDate, primaryDocument: filing.primaryDocument,
        isXbrl: filing.isXbrl, items: filing.items, filingKey,
      },
    }
  }))
  return { items, cutoffDate, historicalSkipped, totalCandidates: allFilings.length }
}