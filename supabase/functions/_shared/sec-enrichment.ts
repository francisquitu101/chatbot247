const SEC_ARCHIVES_URL = 'https://www.sec.gov/Archives/edgar/data'
const SEC_FACTS_URL = 'https://data.sec.gov/api/xbrl/companyfacts/CIK'
const REQUEST_TIMEOUT_MS = 20_000
export const SEC_EXTRACTION_VERSION = 'sec-v1.1'

type SecMetadata = {
  cik?: unknown
  accessionNumber?: unknown
  accession_number?: unknown
  primaryDocument?: unknown
  form?: unknown
  form_type?: unknown
  reportDate?: unknown
  filing_date?: unknown
  company_name?: unknown
}

type Section = { section_type: string; heading: string; text: string; order: number; source_page_or_anchor: string | null }
type StructuredFact = { metric: string; value: number | string; unit: string; period_start: string | null; period_end: string | null; instant_date: string | null; form: string | null; accession: string; source_tag: string }

type CompanyFacts = { facts?: Record<string, { label?: string; units?: Record<string, Array<Record<string, unknown>>> }> }

const metricTags: Record<string, string[]> = {
  revenue: ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet'],
  net_income: ['NetIncomeLoss'],
  operating_income: ['OperatingIncomeLoss'],
  gross_profit: ['GrossProfit'],
  operating_cash_flow: ['NetCashProvidedByUsedInOperatingActivities'],
  capital_expenditures: ['PaymentsToAcquirePropertyPlantAndEquipment'],
  cash_and_equivalents: ['CashAndCashEquivalentsAtCarryingValue'],
  total_assets: ['Assets'],
  total_liabilities: ['Liabilities'],
  shareholders_equity: ['StockholdersEquity'],
  shares_outstanding: ['EntityCommonStockSharesOutstanding'],
  diluted_eps: ['EarningsPerShareDiluted'],
}

function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null }

export function canonicalSecUrl(metadata: SecMetadata): string {
  const cik = text(metadata.cik)?.replace(/^0+/, '')
  const accession = text(metadata.accessionNumber ?? metadata.accession_number)
  const document = text(metadata.primaryDocument)
  if (!cik || !accession || !document || !/^\d{10}$/.test(text(metadata.cik) ?? '') || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) throw new Error('SEC_METADATA_INVALID')
  return `${SEC_ARCHIVES_URL}/${cik}/${accession.replaceAll('-', '')}/${document}`
}

function headers(): HeadersInit {
  const userAgent = Deno.env.get('SEC_USER_AGENT')?.trim()
  if (!userAgent) throw new Error('SEC_USER_AGENT_MISSING')
  return { 'User-Agent': userAgent, Accept: 'text/html,application/xhtml+xml,application/json' }
}

async function fetchWithTimeout(url: string, requestHeaders: HeadersInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, { headers: requestHeaders, signal: controller.signal })
    if (!response.ok) throw new Error(`SEC_HTTP_${response.status}`)
    return response
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('SEC_TIMEOUT')
    throw error
  } finally { clearTimeout(timer) }
}

async function sha256(value: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', value)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function decodeHtml(value: string): string {
  return value.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#39;/g, "'").replace(/&quot;/gi, '"')
}

export function extractSections(html: string): Section[] {
  const withoutNoise = html.replace(/<(script|style|svg|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  const headings: Array<{ heading: string; index: number }> = []
  const headingPattern = /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi
  let match: RegExpExecArray | null
  while ((match = headingPattern.exec(withoutNoise))) headings.push({ heading: decodeHtml(match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()), index: match.index })
  const targets = /management|liquidity|risk factors|financial statements|cash flow|known trends|outlook|material changes|business/i
  const sections: Section[] = []
  for (let index = 0; index < headings.length; index += 1) {
    const current = headings[index]
    if (!targets.test(current.heading)) continue
    const end = headings[index + 1]?.index ?? withoutNoise.length
    const raw = withoutNoise.slice(current.index, end).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    const cleaned = decodeHtml(raw).slice(0, 8_000)
    if (cleaned.length < 80) continue
    sections.push({ section_type: current.heading.toLowerCase().includes('risk') ? 'risk_factors' : current.heading.toLowerCase().includes('liquidity') || current.heading.toLowerCase().includes('cash') ? 'liquidity' : current.heading.toLowerCase().includes('management') ? 'md_and_a' : 'financial_context', heading: current.heading, text: cleaned, order: sections.length, source_page_or_anchor: null })
    if (sections.length >= 12) break
  }
  const plainText = decodeHtml(withoutNoise.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim()
  if (sections.length > 0) return sections

  const itemPattern = /\bItem\s+(\d+\.\d{2})\s+([^]*?)(?=\bItem\s+\d+\.\d{2}\b|\bSIGNATURE\b|$)/gi
  let itemMatch: RegExpExecArray | null
  while ((itemMatch = itemPattern.exec(plainText))) {
    const itemNumber = itemMatch[1]
    const itemText = itemMatch[2].trim()
    if (itemText.length < 80) continue
    sections.push({
      section_type: `item_${itemNumber.replace('.', '_')}`,
      heading: `Item ${itemNumber}`,
      text: itemText.slice(0, 8_000),
      order: sections.length,
      source_page_or_anchor: `item-${itemNumber}`,
    })
    if (sections.length >= 12) break
  }
  if (sections.length > 0) return sections

  const anchors = [
    { type: 'financial_context', label: 'Condensed Consolidated Statements' },
    { type: 'md_and_a', label: "Management's Discussion and Analysis" },
    { type: 'liquidity', label: 'Liquidity and Capital Resources' },
    { type: 'risk_factors', label: 'Risk Factors' },
  ]
  for (const anchor of anchors) {
    const index = plainText.toLowerCase().indexOf(anchor.label.toLowerCase())
    if (index < 0) continue
    const excerpt = plainText.slice(index, index + 8_000).trim()
    if (excerpt.length >= 80) sections.push({ section_type: anchor.type, heading: anchor.label, text: excerpt, order: sections.length, source_page_or_anchor: null })
  }
  return sections.slice(0, 12)
}

async function extractFacts(cik: string, accession: string, form: string): Promise<StructuredFact[]> {
  const response = await fetchWithTimeout(`${SEC_FACTS_URL}${cik}.json`, headers())
  const payload = await response.json() as CompanyFacts
  const facts: StructuredFact[] = []
  for (const [metric, tags] of Object.entries(metricTags)) {
    for (const tag of tags) {
      const units = payload.facts?.['us-gaap']?.[tag]?.units ?? payload.facts?.dei?.[tag]?.units
      if (!units) continue
      for (const [unit, entries] of Object.entries(units)) {
        const match = entries.filter((entry) => entry.accn === accession && (!entry.form || entry.form === form || entry.form === `${form}/A`)).sort((a, b) => String(b.filed ?? '').localeCompare(String(a.filed ?? '')))[0]
        if (!match || typeof match.val !== 'number') continue
        facts.push({ metric, value: match.val, unit, period_start: text(match.start), period_end: text(match.end), instant_date: text(match.end ?? match.filed), form: text(match.form), accession, source_tag: tag })
        break
      }
      if (facts.some((fact) => fact.metric === metric)) break
    }
  }
  return facts
}

export async function enrichSecFiling(input: { metadata: SecMetadata }): Promise<{ url: string; documentBytes: number; sourceDocumentHash: string; sections: Section[]; facts: StructuredFact[]; normalizedSummary: string }> {
  const url = canonicalSecUrl(input.metadata)
  const accession = text(input.metadata.accessionNumber ?? input.metadata.accession_number) as string
  const cik = text(input.metadata.cik) as string
  const form = text(input.metadata.form_type ?? input.metadata.form) ?? ''
  const response = await fetchWithTimeout(url, headers())
  const buffer = await response.arrayBuffer()
  const html = new TextDecoder().decode(buffer)
  const sections = extractSections(html)
  const facts = await extractFacts(cik, accession, form)
  const factSummary = facts.slice(0, 12).map((fact) => `${fact.metric}=${fact.value} ${fact.unit}`).join('; ')
  const normalizedSummary = `${form} ${accession}: ${facts.length} filing-specific XBRL facts and ${sections.length} relevant sections extracted. ${factSummary}`.slice(0, 2_000)
  return { url, documentBytes: buffer.byteLength, sourceDocumentHash: await sha256(buffer), sections, facts, normalizedSummary }
}
