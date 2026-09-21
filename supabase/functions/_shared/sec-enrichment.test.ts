import { extractSections } from './sec-enrichment.ts'
import { assessEvidenceContextQuality } from './evidence-context-quality.ts'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

const tenQFixture = '<h2>Management Discussion and Analysis</h2><p>Revenue increased and liquidity remains strong across the reporting period.</p><h2>Risk Factors</h2><p>Supply and regulatory risks remain significant because demand, export controls, product transitions, and customer concentration may affect future results.</p>'
const eightKFixture = '<table><tr><td>Item 2.02 Results of Operations and Financial Condition.</td></tr><tr><td>NVIDIA issued a press release announcing quarterly results and CFO commentary. Revenue and operating cash flow increased.</td></tr><tr><td>Item 9.01 Financial Statements and Exhibits.</td></tr><tr><td>Exhibit 99.1 Press Release. Exhibit 99.2 CFO Commentary.</td></tr></table>'
const metadataOnlyFixture = '<html><body>Form 8-K filing header only. Accession number and filing date.</body></html>'

const tenQSections = extractSections(tenQFixture)
assert(tenQSections.length === 2, '10-Q section extraction failed')
assert(assessEvidenceContextQuality({ summary: 'Filing summary', normalizedSummary: 'A substantive filing summary with facts and selected sections.', sections: tenQSections, structuredFacts: [{ metric: 'revenue' }] }) === 'sufficient', '10-Q quality failed')

const eightKSections = extractSections(eightKFixture)
assert(eightKSections.length === 2, '8-K item extraction failed')
assert(eightKSections.some((section) => section.section_type === 'item_2_02'), '8-K Item 2.02 missing')
assert(assessEvidenceContextQuality({ summary: 'Administrative summary', normalizedSummary: eightKSections[0].text, sections: eightKSections, structuredFacts: [] }) === 'sufficient', 'Narrative 8-K quality failed')

const metadataOnlySections = extractSections(metadataOnlyFixture)
assert(metadataOnlySections.length === 0, 'Metadata-only 8-K should have no sections')
assert(assessEvidenceContextQuality({ summary: 'SEC 8-K filed on a date.', sections: metadataOnlySections, structuredFacts: [] }) === 'partial', 'Metadata-only 8-K quality failed')

console.log('SEC enrichment tests: PASS')