import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { AnalystContextBuilder, MockResearchProvider, isAnalystAnalysisResult } from './analyst-engine.ts'

const context = new AnalystContextBuilder().build({
  analyst: {
    ticker: 'NVDA',
    company_name: 'NVIDIA Corporation',
    current_thesis: 'Demand remains durable.',
    current_fair_value: 184,
    previous_fair_value: 171.5,
    confidence: 78,
  },
  assumptions: [],
  decisions: [],
  evidence: [],
  currentEvidence: { id: 'evidence-1', title: '[DEMO SEEDED] Test evidence', source_type: 'demo_seed', summary: 'Deterministic test evidence.' },
})

Deno.test('mock provider returns no-change result', async () => {
  const result = await new MockResearchProvider('NO_CHANGE').analyzeEvidence(context)
  assert(isAnalystAnalysisResult(result))
  assertEquals(result.thesisChanged, false)
  assertEquals(result.valuationChanged, false)
})

Deno.test('mock provider returns valuation-change result', async () => {
  const result = await new MockResearchProvider('VALUATION_CHANGE').analyzeEvidence(context)
  assert(isAnalystAnalysisResult(result))
  assertEquals(result.valuationChanged, true)
  assertEquals(result.newFairValue, 193.2)
})

Deno.test('mock provider returns thesis-change result', async () => {
  const result = await new MockResearchProvider('THESIS_CHANGE').analyzeEvidence(context)
  assert(isAnalystAnalysisResult(result))
  assertEquals(result.thesisChanged, true)
  assertEquals(result.valuationChanged, false)
})
