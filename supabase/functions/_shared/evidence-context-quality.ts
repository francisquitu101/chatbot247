export type EvidenceContextQuality = 'insufficient' | 'partial' | 'sufficient'

export function assessEvidenceContextQuality(input: {
  summary: string | null
  normalizedSummary?: string | null
  sections?: unknown[] | null
  structuredFacts?: unknown[] | null
}): EvidenceContextQuality {
  const summaryLength = (input.normalizedSummary ?? input.summary ?? '').trim().length
  const sectionCount = input.sections?.length ?? 0
  const factCount = input.structuredFacts?.length ?? 0
  if (factCount > 0 && sectionCount > 0) return 'sufficient'
  if (sectionCount > 0 && summaryLength >= 80) return 'sufficient'
  if (summaryLength > 0 || factCount > 0 || sectionCount > 0) return 'partial'
  return 'insufficient'
}
