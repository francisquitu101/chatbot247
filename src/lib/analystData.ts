import type { SupabaseClient } from '@supabase/supabase-js'

export type AnalystRecord = {
  id: string
  user_id: string | null
  name: string
  ticker: string
  company_name: string | null
  is_public: boolean
  status: string
  current_thesis: string | null
  current_fair_value: number | null
  previous_fair_value: number | null
  confidence: number
  last_processed_at: string | null
  created_at: string
  updated_at: string
}

export type ThesisVersionRecord = {
  id: string
  analyst_id: string
  version: number
  summary: string
  bull_case: string | null
  base_case: string | null
  bear_case: string | null
  catalysts: string[]
  risks: string[]
  assumptions: string[]
  confidence: number
  created_at: string
}

export type ValuationVersionRecord = {
  id: string
  analyst_id: string
  date: string
  reason: string
  evidence: string | null
  old_value: number | null
  new_value: number | null
  affected_assumptions: string[]
  created_at: string
}

export type DecisionEventRecord = {
  id: string
  analyst_id: string
  event: string
  evidence: string | null
  impact: string | null
  reasoning_summary: string | null
  affected_assumptions: string[]
  old_value: string | null
  new_value: string | null
  source: string | null
  source_type: string | null
  timestamp: string
  confidence: number
  created_at: string
}

export type AnalystJobRecord = {
  id: string
  analyst_id: string
  evidence_id: string | null
  status: string
  attempts: number
  created_at: string
  updated_at: string
}

export type AnalystRunRecord = {
  id: string
  analyst_id: string
  evidence_id: string | null
  job_id: string
  status: string
  provider: string | null
  model: string | null
  started_at: string | null
  completed_at: string | null
  created_at: string
  result_json?: Record<string, unknown> | null
}

export type EvidenceRecord = {
  id: string
  ticker: string
  source_type: string
  source_url: string | null
  title: string
  published_at: string | null
  summary: string | null
  raw_metadata?: Record<string, unknown> | null
}

async function getAnalystByTicker(client: SupabaseClient, ticker: string, visibility: { public: true } | { userId: string }) {
  const normalizedTicker = ticker.trim().toUpperCase()

  let analystQuery = client
    .from('analysts')
    .select('*')
    .eq('ticker', normalizedTicker)

  analystQuery = 'public' in visibility
    ? analystQuery.eq('is_public', true)
    : analystQuery.eq('user_id', visibility.userId)

  const { data: analyst, error: analystError } = await analystQuery.maybeSingle()

  if (analystError) {
    throw analystError
  }

  if (!analyst) {
    return null
  }

  const [stateResult, thesisResult, valuationResult, decisionResult, evidenceResult, jobsResult, runsResult] = await Promise.all([
    client.from('analyst_state').select('*').eq('analyst_id', analyst.id).maybeSingle(),
    client.from('thesis_versions').select('*').eq('analyst_id', analyst.id).order('version', { ascending: false }).limit(8),
    client.from('valuation_versions').select('*').eq('analyst_id', analyst.id).order('date', { ascending: false }).limit(8),
    client.from('decision_events').select('*').eq('analyst_id', analyst.id).order('timestamp', { ascending: false }).limit(20),
    client.from('analyst_evidence')
      .select('id, evidence_items!inner(id, ticker, source_type, source_url, title, published_at, summary, raw_metadata)')
      .eq('analyst_id', analyst.id)
      .order('created_at', { ascending: false })
      .limit(20),
    client.from('analyst_jobs').select('id, analyst_id, evidence_id, status, attempts, created_at, updated_at').eq('analyst_id', analyst.id).order('updated_at', { ascending: false }).limit(10),
    client.from('analyst_runs').select('id, analyst_id, evidence_id, job_id, status, provider, model, started_at, completed_at, created_at, result_json').eq('analyst_id', analyst.id).order('created_at', { ascending: false }).limit(10),
  ])

  for (const result of [stateResult, thesisResult, valuationResult, decisionResult, evidenceResult, jobsResult, runsResult]) {
    if (result.error) throw result.error
  }

  const evidenceItems = ((evidenceResult.data ?? []) as unknown as Array<{
    evidence_items?: EvidenceRecord | EvidenceRecord[] | null
  }>).flatMap((entry) => {
    const item = entry.evidence_items
    if (!item) return []
    return Array.isArray(item) ? item.filter((candidate): candidate is EvidenceRecord => Boolean(candidate)) : [item]
  })

  return {
    analyst: analyst as AnalystRecord,
    state: (stateResult.data ?? null) as Record<string, unknown> | null,
    thesisHistory: (thesisResult.data ?? []) as ThesisVersionRecord[],
    valuationHistory: (valuationResult.data ?? []) as ValuationVersionRecord[],
    decisionEvents: (decisionResult.data ?? []) as DecisionEventRecord[],
    evidenceItems,
    jobs: (jobsResult.data ?? []) as AnalystJobRecord[],
    runs: (runsResult.data ?? []) as AnalystRunRecord[],
  }
}

export async function getPublicAnalystByTicker(client: SupabaseClient, ticker: string) {
  return getAnalystByTicker(client, ticker, { public: true })
}

export async function getPrivateAnalystByTicker(client: SupabaseClient, ticker: string, userId: string) {
  return getAnalystByTicker(client, ticker, { userId })
}
