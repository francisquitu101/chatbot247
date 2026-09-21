export type ThesisBias = 'Bullish' | 'Cautiously Bullish' | 'Neutral' | 'Cautiously Bearish' | 'Bearish'
export type DecisionImpact = 'Positive' | 'Neutral' | 'Negative'
export type SourceType = 'SEC' | 'NEWS' | 'INSIDER' | 'ANALYST_RATING' | 'EARNINGS' | 'COMPANY_RELEASE' | 'FINANCIAL_DATA'

export type AnalystDecisionEvent = {
  id: string
  timestamp: string
  eventType: string
  explanation: string
  impact: DecisionImpact
  source: string
  confidence: number
  sourceType: SourceType
  oldValue?: string
  newValue?: string
}

export type ThesisVersion = {
  id: string
  version: number
  createdAt: string
  summary: string
  bullCase: string
  baseCase: string
  bearCase: string
  catalysts: string[]
  risks: string[]
  assumptions: string[]
  confidence: number
}

export type ValuationVersion = {
  id: string
  date: string
  reason: string
  evidence: string
  oldValue: number
  newValue: number
  affectedAssumptions: string[]
}

export type EvidenceItem = {
  id: string
  title: string
  sourceType: SourceType
  sourceUrl: string
  publishedAt: string
  summary: string
}

export const demoAnalyst = {
  ticker: 'NVDA',
  companyName: 'NVIDIA Corporation',
  analystName: 'Astra Research',
  status: 'LIVE',
  thesis: 'Cautiously Bullish',
  confidence: 82,
  fairValue: 28.4,
  previousFairValue: 25.1,
  bullCaseValue: 32.6,
  baseCaseValue: 28.4,
  bearCaseValue: 21.7,
  lastUpdated: '2026-09-17T09:40:00Z',
  currentThesisSummary:
    'AI infrastructure demand remains the primary demand engine; the model now assumes a more disciplined spend profile and a slower margin expansion path than the prior cycle.',
  bullCase: 'Continued hyperscaler capex acceleration sustains GPU demand and pricing power throughout the next two product cycles.',
  baseCase: 'Demand stays elevated, but slower enterprise conversion and normalization in pricing reduce near-term operating leverage.',
  bearCase: 'Supply chain normalization and competitive pressure compress margin expansion faster than expected, slowing earnings conversion.',
  catalysts: ['Hyperscaler capex guidance', 'Next-gen GPU ramp', 'Software and networking attach rates'],
  risks: ['Pricing normalization', 'Competition in inference acceleration', 'Consumer mix exposure'],
  keyAssumptions: ['Gross margin remains above 60%', 'AI data center revenue remains the primary growth engine', 'Operating expenses expand more gradually than revenue'],
  decisionLog: [
    'SEC filing detected',
    'Cash runway assumption updated',
    'Fair value recalculated',
    'Margin sensitivity reassessed',
  ],
}

export const demoDecisionEvents: AnalystDecisionEvent[] = [
  {
    id: 'evt-1',
    timestamp: '2026-09-17T09:40:00Z',
    eventType: 'Fair Value Changed',
    explanation: 'New cost structure implies slower margin expansion than earlier assumptions.',
    impact: 'Negative',
    source: 'Q2 10-Q',
    confidence: 82,
    sourceType: 'SEC',
    oldValue: '$25.10',
    newValue: '$28.40',
  },
  {
    id: 'evt-2',
    timestamp: '2026-09-16T14:10:00Z',
    eventType: 'Cash runway assumption updated',
    explanation: 'Capital intensity is higher, reducing flexibility for incremental operating spend.',
    impact: 'Neutral',
    source: 'Earnings call transcript',
    confidence: 76,
    sourceType: 'EARNINGS',
  },
  {
    id: 'evt-3',
    timestamp: '2026-09-15T18:30:00Z',
    eventType: 'Pricing power reassessed',
    explanation: 'New data suggests the mix shift toward inference workloads is offsetting some margin momentum.',
    impact: 'Negative',
    source: 'Analyst briefing note',
    confidence: 71,
    sourceType: 'ANALYST_RATING',
  },
  {
    id: 'evt-4',
    timestamp: '2026-09-14T10:15:00Z',
    eventType: 'Demand durability confirmed',
    explanation: 'Hyperscaler capex plans remain elevated, supporting the base demand outlook.',
    impact: 'Positive',
    source: 'Company release',
    confidence: 88,
    sourceType: 'COMPANY_RELEASE',
  },
]

export const thesisHistory: ThesisVersion[] = [
  {
    id: 'thesis-v3',
    version: 3,
    createdAt: '2026-09-17T09:40:00Z',
    summary: 'The thesis stays constructive, but expects a slower margin expansion path as pricing normalizes and capex stays elevated.',
    bullCase: 'AI infrastructure capex remains elevated across hyperscalers and sovereign demand.',
    baseCase: 'The company maintains volume leadership while defending strong gross margins through supply mix management.',
    bearCase: 'Competitive pricing and additional capital spending pressure reduce the valuation premium.',
    catalysts: ['Higher inference workload usage', 'Stronger enterprise AI adoption', 'Supply chain mitigation'],
    risks: ['Margin normalization', 'Rising competition', 'Customer concentration'],
    assumptions: ['Stable awareness of demand outlook', 'Operating leverage remains positive', 'Gross margin lands around 60%'],
    confidence: 82,
  },
  {
    id: 'thesis-v2',
    version: 2,
    createdAt: '2026-09-10T08:15:00Z',
    summary: 'The prior thesis emphasized a strong AI demand outlook while underweighting the pace of margin normalization.',
    bullCase: 'AI demand remains structurally superior and supports another step-up in revenue growth.',
    baseCase: 'Revenue growth remains strong as capacity expands into enterprise workloads.',
    bearCase: 'A sharper than expected margin reset could compress earnings conversion.',
    catalysts: ['Server-side demand expansion', 'Next-generation chips', 'Software attach rates'],
    risks: ['Execution risk', 'Macro sensitivity', 'Late-cycle normalization'],
    assumptions: ['Strong capex stays in place', 'Hardware leadership remains intact', 'Supply ramp remains stable'],
    confidence: 79,
  },
]

export const valuationHistory: ValuationVersion[] = [
  {
    id: 'val-3',
    date: '2026-09-17T09:40:00Z',
    reason: 'Updated gross margin and capex assumptions after Q2 filing review.',
    evidence: 'Q2 10-Q + earnings transcript',
    oldValue: 25.1,
    newValue: 28.4,
    affectedAssumptions: ['Gross Margin', 'Operating leverage', 'Capex intensity'],
  },
  {
    id: 'val-2',
    date: '2026-09-10T08:15:00Z',
    reason: 'Higher confidence in AI-infrastructure demand and stronger software monetization.',
    evidence: 'Management commentary and product roadmap',
    oldValue: 19.0,
    newValue: 25.1,
    affectedAssumptions: ['Data center demand', 'Software attach', 'Pricing power'],
  },
  {
    id: 'val-1',
    date: '2026-09-02T12:05:00Z',
    reason: 'Initial benchmarked fair value after establishing baseline operating assumptions.',
    evidence: 'Baseline model setup',
    oldValue: 0,
    newValue: 19.0,
    affectedAssumptions: ['Revenue growth', 'Operating margin', 'Discount rate'],
  },
]

export const evidenceItems: EvidenceItem[] = [
  {
    id: 'ev-1',
    title: 'Q2 10-Q - Segment Margin and cost structure commentary',
    sourceType: 'SEC',
    sourceUrl: 'https://www.sec.gov',
    publishedAt: '2026-09-17T00:00:00Z',
    summary: 'Revenue mix and cost structure confirm a slower path to operating leverage than previously modeled.',
  },
  {
    id: 'ev-2',
    title: 'AI infrastructure capex guidance update',
    sourceType: 'COMPANY_RELEASE',
    sourceUrl: 'https://example.com/releases/capex',
    publishedAt: '2026-09-15T16:00:00Z',
    summary: 'Hyperscaler spending remains elevated, supporting continued demand for next-generation GPU compute.',
  },
  {
    id: 'ev-3',
    title: 'Analyst note on inference workload mix',
    sourceType: 'ANALYST_RATING',
    sourceUrl: 'https://example.com/research/inference-mix',
    publishedAt: '2026-09-14T12:00:00Z',
    summary: 'Inference workload expansion supports revenue durability while compressing near-term margin leverage.',
  },
]
