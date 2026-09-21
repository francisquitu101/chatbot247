export type AnalysisMode = 'NO_CHANGE' | 'THESIS_CHANGE' | 'VALUATION_CHANGE'
export type AnalysisMateriality = 'informational' | 'minor' | 'material' | 'critical'
export type AnalysisImpact = 'positive' | 'neutral' | 'negative'
export type ProviderRunMetadata = {
  provider: string
  model: string
  inputTokens: number | null
  outputTokens: number | null
  responseId: string | null
  latencyMs: number
}

export type AffectedAssumption = {
  name: string
  category?: string
  previousValue?: number
  newValue?: number
  newValueText?: string
  unit?: string
  changeSummary: string
}

export type AnalystAnalysisResult = {
  materiality: AnalysisMateriality
  thesisChanged: boolean
  thesisSummary?: string
  valuationChanged: boolean
  previousFairValue?: number
  newFairValue?: number
  confidence?: number
  impact: AnalysisImpact
  affectedAssumptions: AffectedAssumption[]
  risksAdded: string[]
  risksRemoved: string[]
  catalystsAdded: string[]
  catalystsRemoved: string[]
  decisionSummary: string
}

export type AnalystContext = {
  executionMode: 'production' | 'development_test'
  ticker: string
  company: string | null
  currentThesis: string | null
  currentFairValue: number | null
  previousFairValue: number | null
  confidence: number
  currentAssumptions: Array<{ name: string; category: string; valueNumeric: number | null; valueText: string | null; unit: string | null }>
  activeRisks: string[]
  activeCatalysts: string[]
  recentDecisionEvents: Array<{ event: string; summary: string | null; timestamp: string }>
  relevantEvidence: Array<{ id: string; title: string; sourceType: string; summary: string | null }>
  evidenceBeingAnalyzed: { id: string; title: string; sourceType: string; summary: string | null; metadata: Record<string, unknown>; normalizedSummary: string | null; structuredFacts: unknown[]; sections: unknown[] }
}

export interface AIResearchProvider {
  analyzeEvidence(context: AnalystContext): Promise<AnalystAnalysisResult>
  readonly lastRunMetadata: ProviderRunMetadata | null
}

export class MockResearchProvider implements AIResearchProvider {
  private readonly mode: AnalysisMode
  readonly lastRunMetadata: ProviderRunMetadata | null = null

  constructor(mode: AnalysisMode = 'NO_CHANGE') {
    this.mode = mode
  }

  async analyzeEvidence(context: AnalystContext): Promise<AnalystAnalysisResult> {
    const base = {
      confidence: Math.min(100, context.confidence + 1),
      impact: 'neutral' as const,
      affectedAssumptions: [],
      risksAdded: [],
      risksRemoved: [],
      catalystsAdded: [],
      catalystsRemoved: [],
      decisionSummary: `[MOCK] Reviewed evidence: ${context.evidenceBeingAnalyzed.title}`,
    }

    if (this.mode === 'THESIS_CHANGE') {
      return {
        ...base,
        materiality: 'material',
        thesisChanged: true,
        thesisSummary: `${context.currentThesis ?? 'Current thesis'} Updated after deterministic mock evidence review.`,
        valuationChanged: false,
        impact: 'positive',
        catalystsAdded: ['[MOCK] Evidence-supported catalyst'],
        decisionSummary: '[MOCK] Thesis changed after evidence review.',
      }
    }

    if (this.mode === 'VALUATION_CHANGE') {
      const previousFairValue = context.currentFairValue ?? 0
      return {
        ...base,
        materiality: 'material',
        thesisChanged: false,
        valuationChanged: true,
        previousFairValue,
        newFairValue: Number((previousFairValue * 1.05).toFixed(2)),
        impact: 'positive',
        affectedAssumptions: [{
          name: 'mock_growth_rate',
          category: 'valuation',
          previousValue: 0,
          newValue: 5,
          unit: '%',
          changeSummary: '[MOCK] Deterministic valuation assumption changed.',
        }],
        decisionSummary: '[MOCK] Fair value changed after evidence review.',
      }
    }

    return { ...base, materiality: 'informational', thesisChanged: false, valuationChanged: false }
  }
}

export class OpenAIProviderError extends Error {
  readonly code: 'OPENAI_API_KEY_NOT_CONFIGURED' | 'OPENAI_UNAUTHORIZED' | 'OPENAI_RATE_LIMITED' | 'OPENAI_PROVIDER_ERROR' | 'OPENAI_TIMEOUT' | 'OPENAI_INVALID_RESPONSE'
  readonly status: number | null

  constructor(code: OpenAIProviderError['code'], message: string, status: number | null = null) {
    super(message)
    this.name = 'OpenAIProviderError'
    this.code = code
    this.status = status
  }
}

const analystResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    materiality: { type: 'string', enum: ['informational', 'minor', 'material', 'critical'] },
    thesisChanged: { type: 'boolean' },
    thesisSummary: { type: ['string', 'null'] },
    valuationChanged: { type: 'boolean' },
    previousFairValue: { type: ['number', 'null'] },
    newFairValue: { type: ['number', 'null'] },
    confidence: { type: 'number', minimum: 0, maximum: 100 },
    impact: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
    affectedAssumptions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          category: { type: ['string', 'null'] },
          previousValue: { type: ['number', 'null'] },
          newValue: { type: ['number', 'null'] },
          newValueText: { type: ['string', 'null'] },
          unit: { type: ['string', 'null'] },
          changeSummary: { type: 'string' },
        },
        required: ['name', 'category', 'previousValue', 'newValue', 'newValueText', 'unit', 'changeSummary'],
      },
    },
    risksAdded: { type: 'array', items: { type: 'string' } },
    risksRemoved: { type: 'array', items: { type: 'string' } },
    catalystsAdded: { type: 'array', items: { type: 'string' } },
    catalystsRemoved: { type: 'array', items: { type: 'string' } },
    decisionSummary: { type: 'string' },
  },
  required: ['materiality', 'thesisChanged', 'thesisSummary', 'valuationChanged', 'previousFairValue', 'newFairValue', 'confidence', 'impact', 'affectedAssumptions', 'risksAdded', 'risksRemoved', 'catalystsAdded', 'catalystsRemoved', 'decisionSummary'],
} as const

const analystSystemPrompt = `You are an equity research analyst, not a chatbot. Evaluate only the supplied current state and new evidence.

Rules:
- Do not invent facts, numbers, URLs, citations, or external research.
- Separate evidence from inference.
- Use NO_CHANGE behavior when the evidence does not materially change the thesis or valuation.
- Change fair value only when a current fair value exists, an affected assumption exists, the evidence justifies the change, and the change is quantitatively supported by the supplied context.
- Otherwise set valuationChanged to false and use null for unavailable fair-value fields.
- Confidence is 0 to 100 and reflects evidence strength, directness, source quality, and uncertainty. It is not expected return.
- Never produce personalized buy/sell instructions.
- decisionSummary must be brief, auditable, and state what changed, why, affected assumptions, and impact.
- When executionMode is development_test and evidence source_type is synthetic_test, treat the supplied structured fixture values as authoritative test inputs, evaluate materiality normally, and do not dismiss them merely because they are synthetic. Never present them as real market information.
- In production mode, synthetic_test evidence is invalid and must not be analyzed.
- Do not provide or store private chain-of-thought. Return only the required JSON object.`

function getString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function extractResponseText(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const response = payload as Record<string, unknown>
  const direct = getString(response.output_text)
  if (direct) return direct
  const output = response.output
  if (!Array.isArray(output)) return null
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    const content = (item as Record<string, unknown>).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const text = getString((part as Record<string, unknown>).text)
      if (text) return text
    }
  }
  return null
}

export class OpenAIResearchProvider implements AIResearchProvider {
  lastRunMetadata: ProviderRunMetadata | null = null
  private readonly apiKey: string | undefined
  private readonly model: string
  private readonly reasoningEffort: string | undefined

  constructor() {
    this.apiKey = Deno.env.get('OPENAI_API_KEY')
    this.model = Deno.env.get('AI_MODEL') || 'gpt-5.6-terra'
    this.reasoningEffort = Deno.env.get('AI_REASONING_EFFORT') || undefined
  }

  async analyzeEvidence(context: AnalystContext): Promise<AnalystAnalysisResult> {
    if (!this.apiKey) throw new OpenAIProviderError('OPENAI_API_KEY_NOT_CONFIGURED', 'OPENAI_API_KEY is not configured as an Edge Function secret.')
    const startedAt = Date.now()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 45000)
    const input = `${analystSystemPrompt}\n\nEXECUTION MODE\n${context.executionMode}\n\nCURRENT STATE\n${JSON.stringify({ ticker: context.ticker, company: context.company, currentThesis: context.currentThesis, currentFairValue: context.currentFairValue, previousFairValue: context.previousFairValue, confidence: context.confidence, currentAssumptions: context.currentAssumptions, activeRisks: context.activeRisks, activeCatalysts: context.activeCatalysts, recentDecisionEvents: context.recentDecisionEvents })}\n\nNEW EVIDENCE\n${JSON.stringify({ evidenceBeingAnalyzed: context.evidenceBeingAnalyzed, relevantEvidence: context.relevantEvidence })}`

    try {
      const body: Record<string, unknown> = {
        model: this.model,
        input,
        text: {
          format: {
            type: 'json_schema',
            name: 'analyst_analysis_result',
            strict: true,
            schema: analystResultSchema,
          },
        },
      }
      if (this.reasoningEffort) body.reasoning = { effort: this.reasoningEffort }
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const payload: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        if (response.status === 401) throw new OpenAIProviderError('OPENAI_UNAUTHORIZED', 'OpenAI rejected the configured API key.', response.status)
        if (response.status === 429) throw new OpenAIProviderError('OPENAI_RATE_LIMITED', 'OpenAI rate limit reached; retry the analyst job.', response.status)
        throw new OpenAIProviderError('OPENAI_PROVIDER_ERROR', `OpenAI Responses API returned HTTP ${response.status}.`, response.status)
      }
      const outputText = extractResponseText(payload)
      if (!outputText) throw new OpenAIProviderError('OPENAI_INVALID_RESPONSE', 'OpenAI returned no structured output.', response.status)
      let parsed: unknown
      try {
        parsed = JSON.parse(outputText) as unknown
      } catch {
        throw new OpenAIProviderError('OPENAI_INVALID_RESPONSE', 'OpenAI structured output was not valid JSON.', response.status)
      }
      if (!isAnalystAnalysisResult(parsed)) throw new OpenAIProviderError('OPENAI_INVALID_RESPONSE', 'OpenAI structured output did not match AnalystAnalysisResult.', response.status)
      const usage = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).usage : null
      const usageRecord = usage && typeof usage === 'object' ? usage as Record<string, unknown> : {}
      this.lastRunMetadata = {
        provider: 'openai', model: this.model,
        inputTokens: typeof usageRecord.input_tokens === 'number' ? usageRecord.input_tokens : null,
        outputTokens: typeof usageRecord.output_tokens === 'number' ? usageRecord.output_tokens : null,
        responseId: payload && typeof payload === 'object' && typeof (payload as Record<string, unknown>).id === 'string' ? (payload as Record<string, unknown>).id as string : null,
        latencyMs: Date.now() - startedAt,
      }
      return parsed
    } catch (error) {
      if (error instanceof OpenAIProviderError) throw error
      if (error instanceof DOMException && error.name === 'AbortError') throw new OpenAIProviderError('OPENAI_TIMEOUT', 'OpenAI request timed out.')
      throw new OpenAIProviderError('OPENAI_PROVIDER_ERROR', error instanceof Error ? error.message : 'OpenAI request failed.')
    } finally {
      clearTimeout(timeout)
    }
  }
}

export function isAnalystAnalysisResult(value: unknown): value is AnalystAnalysisResult {
  if (!value || typeof value !== 'object') return false
  const result = value as Record<string, unknown>
  const materials = ['informational', 'minor', 'material', 'critical']
  const impacts = ['positive', 'neutral', 'negative']
  const assumptions = result.affectedAssumptions
  const validAssumptions = Array.isArray(assumptions) && assumptions.every((item) => {
    if (!item || typeof item !== 'object') return false
    const assumption = item as Record<string, unknown>
    return typeof assumption.name === 'string' && typeof assumption.changeSummary === 'string'
  })
  return materials.includes(String(result.materiality))
    && typeof result.thesisChanged === 'boolean'
    && typeof result.valuationChanged === 'boolean'
    && impacts.includes(String(result.impact))
    && typeof result.confidence === 'number'
    && Number.isFinite(result.confidence)
    && result.confidence >= 0
    && result.confidence <= 100
    && typeof result.decisionSummary === 'string'
    && validAssumptions
    && Array.isArray(result.risksAdded)
    && Array.isArray(result.risksRemoved)
    && Array.isArray(result.catalystsAdded)
    && Array.isArray(result.catalystsRemoved)
}

export function isAnalysisResultApplicable(result: AnalystAnalysisResult, context: AnalystContext): boolean {
  if (!result.valuationChanged) return true
  if (context.currentFairValue === null || context.currentFairValue === undefined) return false
  if (result.previousFairValue !== context.currentFairValue) return false
  if (!Number.isFinite(result.previousFairValue) || !Number.isFinite(result.newFairValue)) return false
  return result.affectedAssumptions.length > 0
}

export class AnalystContextBuilder {
  build(input: {
    executionMode?: 'production' | 'development_test'
    analyst: { ticker: string; company_name: string | null; current_thesis: string | null; current_fair_value: number | null; previous_fair_value: number | null; confidence: number }
    assumptions: Array<{ name: string; category: string; value_numeric: number | null; value_text: string | null; unit: string | null }>
    decisions: Array<{ event: string; reasoning_summary: string | null; timestamp: string }>
    evidence: Array<{ id: string; title: string; source_type: string; summary: string | null }>
    currentEvidence: { id: string; title: string; source_type: string; summary: string | null; raw_metadata?: Record<string, unknown>; enrichment?: { normalized_summary: string | null; structured_facts: unknown[]; sections: unknown[] } | null }
  }): AnalystContext {
    return {
      executionMode: input.executionMode ?? 'production',
      ticker: input.analyst.ticker,
      company: input.analyst.company_name,
      currentThesis: input.analyst.current_thesis,
      currentFairValue: input.analyst.current_fair_value,
      previousFairValue: input.analyst.previous_fair_value,
      confidence: input.analyst.confidence,
      currentAssumptions: input.assumptions.slice(0, 50).map((item) => ({ name: item.name, category: item.category, valueNumeric: item.value_numeric, valueText: item.value_text, unit: item.unit })),
      activeRisks: [],
      activeCatalysts: [],
      recentDecisionEvents: input.decisions.slice(0, 20).map((item) => ({ event: item.event, summary: item.reasoning_summary, timestamp: item.timestamp })),
      relevantEvidence: input.evidence.slice(0, 20).map((item) => ({ id: item.id, title: item.title, sourceType: item.source_type, summary: item.summary })),
      evidenceBeingAnalyzed: {
        id: input.currentEvidence.id,
        title: input.currentEvidence.title,
        sourceType: input.currentEvidence.source_type,
        summary: input.currentEvidence.summary,
        metadata: input.currentEvidence.raw_metadata ?? {},
        normalizedSummary: input.currentEvidence.enrichment?.normalized_summary ?? null,
        structuredFacts: input.currentEvidence.enrichment?.structured_facts ?? [],
        sections: input.currentEvidence.enrichment?.sections ?? [],
      },
    }
  }
}
