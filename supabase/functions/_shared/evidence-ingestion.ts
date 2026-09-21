import { scrapeSecFilings } from '../scrape-sec/scraper.ts'

export type RawEvidenceItem = {
  ticker: string
  sourceType: 'SEC'
  externalId: string
  sourceUrl: string | null
  title: string
  summary: string
  publishedAt: string | null
  contentHash: string
  metadata: Record<string, unknown>
}

export type NormalizedEvidence = RawEvidenceItem

export interface EvidenceSourceAdapter {
  readonly sourceType: 'SEC'
  fetch(ticker: string): Promise<RawEvidenceItem[]>
  normalize(item: RawEvidenceItem): NormalizedEvidence
}

export class SecEvidenceAdapter implements EvidenceSourceAdapter {
  readonly sourceType = 'SEC' as const

  async fetch(ticker: string): Promise<RawEvidenceItem[]> {
    const result = await scrapeSecFilings(ticker)
    return result.items.flatMap((item) => {
      const metadata = item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata) ? item.metadata as Record<string, unknown> : {}
      const externalId = typeof metadata.accessionNumber === 'string' ? metadata.accessionNumber : null
      if (!externalId) return []
      return [{
        ticker,
        sourceType: 'SEC' as const,
        externalId,
        sourceUrl: item.url,
        title: item.title ?? `SEC filing ${externalId}`,
        summary: `SEC ${typeof metadata.form === 'string' ? metadata.form : item.item_type} filed on ${item.published_at ?? 'unknown date'} for ${ticker}.`,
        publishedAt: item.published_at,
        contentHash: item.content_hash,
        metadata: {
          ...metadata,
          form_type: metadata.form,
          accession_number: externalId,
          filing_date: item.published_at,
          company_name: item.title,
        },
      }]
    })
  }

  normalize(item: RawEvidenceItem): NormalizedEvidence {
    return {
      ...item,
      sourceType: this.sourceType,
      externalId: item.externalId.trim(),
      ticker: item.ticker.trim().toUpperCase(),
      title: item.title.trim(),
      summary: item.summary.trim(),
    }
  }
}
