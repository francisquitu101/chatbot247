export type EvidencePriority = 'ignored' | 'low' | 'normal' | 'high' | 'critical'

export type EvidenceRelevance = {
  priority: EvidencePriority
  score: number
  reason: string
}

function numberFromMetadata(metadata: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = metadata[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
      const parsed = Number(value.replaceAll(',', '').replace(/[$\s]/g, ''))
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return null
}

export function classifySecEvidence(metadata: Record<string, unknown>): EvidenceRelevance {
  const form = typeof metadata.form_type === 'string'
    ? metadata.form_type.toUpperCase()
    : typeof metadata.form === 'string' ? metadata.form.toUpperCase() : ''
  const baseForm = form.endsWith('/A') ? form.slice(0, -2) : form
  if (['10-K', '10-Q'].includes(baseForm)) return { priority: 'critical', score: 95, reason: `SEC ${baseForm} is a primary periodic filing.` }
  if (['8-K', 'SC 13D', 'SC 13G', 'S-1', 'S-3', 'S-4', 'S-8'].includes(baseForm)) return { priority: 'high', score: 90, reason: `SEC ${baseForm} may materially affect thesis or ownership.` }
  if (['6-K', '20-F'].includes(baseForm)) return { priority: 'normal', score: 70, reason: `SEC ${baseForm} is relevant foreign-issuer disclosure.` }
  if (['3', '5'].includes(baseForm)) return { priority: 'low', score: 35, reason: `SEC Form ${baseForm} is an insider transaction disclosure with no escalation signal.` }
  if (baseForm === '4') {
    const transactionValue = numberFromMetadata(metadata, ['transactionValue', 'transaction_value', 'value'])
    const role = [metadata.insiderRole, metadata.relationship, metadata.role].filter((value): value is string => typeof value === 'string').join(' ').toUpperCase()
    if (transactionValue !== null && transactionValue >= 1_000_000) return { priority: 'high', score: 85, reason: 'SEC Form 4 has a large transaction value.' }
    if (/(CEO|CFO|DIRECTOR|CHIEF)/.test(role)) return { priority: 'normal', score: 65, reason: 'SEC Form 4 identifies a senior insider.' }
    return { priority: 'low', score: 35, reason: 'SEC Form 4 has no large-value or senior-insider escalation signal.' }
  }
  if (!baseForm) return { priority: 'normal', score: 50, reason: 'SEC evidence has no recognized form metadata.' }
  return { priority: 'normal', score: 50, reason: `SEC ${baseForm} is not in the specialized relevance rules.` }
}

export function classifyEvidence(sourceType: string, metadata: Record<string, unknown>): EvidenceRelevance {
  if (sourceType === 'SEC') return classifySecEvidence(metadata)
  return { priority: 'normal', score: 50, reason: `${sourceType} has no source-specific relevance rules yet.` }
}

export function shouldCreateAnalystJob(priority: EvidencePriority): boolean {
  return priority !== 'ignored'
}
