import { type AnalystAnalysisResult, isAnalystAnalysisResult } from './analyst-engine.ts'

export const FULL_SEC_TARGET_CHUNK_CHARS = 18_000
export const FULL_SEC_MAX_CHUNK_CHARS = 24_000
export const FULL_SEC_MIN_SECTION_CHARS = 220

export type AnalysisStatus = 'ok' | 'informational' | 'failed'

export type FullSecDocumentChunk = {
  chunkIndex: number
  totalChunks: number
  section: string
  characterCount: number
  status: AnalysisStatus
  content: string
}

export type FullSecChunkAnalysis = {
  chunkIndex: number
  section: string
  characterCount: number
  status: AnalysisStatus
  materiality: 'informational' | 'minor' | 'material' | 'critical'
  findings: string[]
  notes: string[]
}

export type FullSecDocumentAnalysisInput = {
  ticker: string
  formType?: string | null
  accession?: string | null
  normalizedText: string
  currentThesis?: string | null
  currentFairValue?: number | null
  previousFairValue?: number | null
  confidence?: number | null
  existingEnrichment?: { normalized_summary?: string | null } | null
}

export type FullSecDocumentAnalysisMetrics = {
  documentBytes: number
  normalizedBytes: number
  normalizedCharacters: number
  chunkCount: number
  chunksAnalyzed: number
  totalChunkCharacters: number
  coverageRatio: number
  chunkAnalysisCalls: number
  synthesisCalls: number
  failedChunks: number
  failedStage: string | null
  elapsedMs: number
  fullDocumentAnalyzed: boolean
}

export type FullSecDocumentAnalysisSuccess = {
  ok: true
  result: AnalystAnalysisResult
  chunks: FullSecDocumentChunk[]
  chunkResults: FullSecChunkAnalysis[]
  metrics: FullSecDocumentAnalysisMetrics
}

export type FullSecDocumentAnalysisFailure = {
  ok: false
  code: 'EMPTY_DOCUMENT' | 'COVERAGE_INCOMPLETE' | 'CHUNK_ANALYSIS_INCOMPLETE' | 'SYNTHESIS_BLOCKED'
  message: string
  metrics: FullSecDocumentAnalysisMetrics
}

const headingKeywords = [
  'ITEM 1.',
  'ITEM 1A.',
  'ITEM 1B.',
  'ITEM 2.',
  'ITEM 3.',
  'ITEM 4.',
  'ITEM 5.',
  'ITEM 6.',
  'ITEM 7.',
  'ITEM 7A.',
  'ITEM 8.',
  'ITEM 9.',
  'ITEM 9A.',
  'ITEM 9B.',
  'PART I',
  'PART II',
  'PART III',
  'PART IV',
  'MANAGEMENT\'S DISCUSSION AND ANALYSIS',
  'RISK FACTORS',
  'LIQUIDITY AND CAPITAL RESOURCES',
  'BUSINESS',
  'MARKET RISK',
  'CRITICAL ACCOUNTING ESTIMATES',
  'FINANCIAL STATEMENTS',
  'CONSOLIDATED FINANCIAL STATEMENTS',
  'NOTES TO CONSOLIDATED FINANCIAL STATEMENTS',
  'SELECTED FINANCIAL DATA',
  'QUANTITATIVE AND QUALITATIVE DISCLOSURES ABOUT MARKET RISK',
]

function estimateTokenCountFromText(text: string): number {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return 0
  return Math.max(1, Math.ceil(normalized.length / 4))
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').trim()
}

function detectSectionTitle(text: string): string {
  const normalized = normalizeWhitespace(text)
  const lines = normalized.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const upper = trimmed.toUpperCase()
    if (headingKeywords.some((keyword) => upper.includes(keyword))) {
      return trimmed
    }
  }
  return 'body'
}

function splitBySize(content: string, targetChars: number, maxChars: number): string[] {
  const cleaned = content.trim()
  if (!cleaned) return []
  const parts: string[] = []
  let cursor = 0
  while (cursor < cleaned.length) {
    const remaining = cleaned.length - cursor
    const sliceLength = Math.min(targetChars, remaining)
    let end = cursor + sliceLength
    if (end < cleaned.length) {
      const boundary = cleaned.lastIndexOf('\n', end)
      const sentenceBoundary = cleaned.lastIndexOf('. ', end)
      const bestBoundary = [boundary, sentenceBoundary].filter((value) => value > cursor && value < cleaned.length).sort((a, b) => a - b).at(-1)
      if (bestBoundary && bestBoundary > cursor + Math.max(600, targetChars * 0.6)) {
        end = bestBoundary + 1
      }
    }
    if (end - cursor > maxChars) {
      end = cursor + maxChars
    }
    const segment = cleaned.slice(cursor, end).trim()
    if (!segment) break
    parts.push(segment)
    cursor = end
  }
  return parts.filter((part) => part.length > 0)
}

export function buildDocumentChunks(normalizedText: string, targetChars = FULL_SEC_TARGET_CHUNK_CHARS, maxChars = FULL_SEC_MAX_CHUNK_CHARS): FullSecDocumentChunk[] {
  const cleaned = normalizeWhitespace(normalizedText)
  if (!cleaned) {
    return []
  }

  const headingRegex = /(\b(?:ITEM\s+[0-9A-Z.]+|PART\s+[IVX]+|MANAGEMENT'S DISCUSSION AND ANALYSIS|RISK FACTORS|LIQUIDITY AND CAPITAL RESOURCES|BUSINESS|FINANCIAL STATEMENTS|CONSOLIDATED FINANCIAL STATEMENTS|NOTES TO CONSOLIDATED FINANCIAL STATEMENTS|SELECTED FINANCIAL DATA|QUANTITATIVE AND QUALITATIVE DISCLOSURES ABOUT MARKET RISK)[^\n]{0,200})/gi
  const headingMatches = Array.from(cleaned.matchAll(headingRegex)).map((match) => ({
    index: match.index ?? 0,
    text: match[0].trim(),
  }))

  const ranges: Array<{ section: string; content: string }> = []
  let cursor = 0

  if (headingMatches.length === 0) {
    const segments = splitBySize(cleaned, targetChars, maxChars)
    return segments.map((segment, index) => ({
      chunkIndex: index + 1,
      totalChunks: segments.length,
      section: 'body',
      characterCount: segment.length,
      status: 'ok',
      content: segment,
    }))
  }

  for (let i = 0; i < headingMatches.length; i += 1) {
    const match = headingMatches[i]
    const start = match.index
    const nextStart = headingMatches[i + 1]?.index ?? cleaned.length

    if (cursor < start) {
      const prefix = cleaned.slice(cursor, start).trim()
      if (prefix) ranges.push({ section: detectSectionTitle(prefix), content: prefix })
    }

    const sectionContent = cleaned.slice(start, nextStart).trim()
    if (sectionContent) {
      ranges.push({ section: match.text, content: sectionContent })
    }
    cursor = nextStart
  }

  if (cursor < cleaned.length) {
    const tail = cleaned.slice(cursor).trim()
    if (tail) ranges.push({ section: detectSectionTitle(tail), content: tail })
  }

  const flatChunks: FullSecDocumentChunk[] = []
  for (const range of ranges) {
    const segments = splitBySize(range.content, targetChars, maxChars)
    if (segments.length === 0) continue
    for (const segment of segments) {
      flatChunks.push({
        chunkIndex: flatChunks.length + 1,
        totalChunks: 0,
        section: range.section,
        characterCount: segment.length,
        status: 'ok',
        content: segment,
      })
    }
  }

  if (flatChunks.length === 0) {
    return [{ chunkIndex: 1, totalChunks: 1, section: 'body', characterCount: cleaned.length, status: 'ok', content: cleaned }]
  }

  const totalChunks = flatChunks.length
  return flatChunks.map((chunk, index) => ({
    ...chunk,
    chunkIndex: index + 1,
    totalChunks,
  }))
}

function analyzeChunk(chunk: FullSecDocumentChunk): FullSecChunkAnalysis {
  const content = chunk.content.trim()
  if (!content) {
    return {
      chunkIndex: chunk.chunkIndex,
      section: chunk.section,
      characterCount: chunk.characterCount,
      status: 'failed',
      materiality: 'informational',
      findings: [],
      notes: ['Empty chunk blocked analysis.'],
    }
  }

  const lower = content.toLowerCase()
  const findings: string[] = []

  if (/revenue|sales|shipments|net revenue|annual revenue|quarterly revenue/.test(lower)) findings.push('revenue trend')
  if (/gross margin|operating margin|profit margin|margin|eps/.test(lower)) findings.push('margins and profitability')
  if (/cash flow|operating cash flow|free cash flow|fcf|liquidity|working capital/.test(lower)) findings.push('cash flow and liquidity')
  if (/debt|borrowings|leverage|liabilities|debt maturities/.test(lower)) findings.push('balance sheet and debt')
  if (/capex|capital expenditures|capital expenditure|pp&e|plant/.test(lower)) findings.push('capital intensity and capex')
  if (/demand|customer|orders|shipments|supply|capacity|inventory/.test(lower)) findings.push('demand, supply, and capacity')
  if (/risk factors|regulation|export controls|trade restriction|geopolitical|geopolitical risk/.test(lower)) findings.push('risk and regulatory exposure')
  if (/guidance|outlook|forecast|expectations/.test(lower)) findings.push('guidance and expectations')
  if (/commitment|contract|agreement|acquisition|investment/.test(lower)) findings.push('commitments and strategic actions')

  const materiality: 'informational' | 'minor' | 'material' | 'critical' = findings.length >= 5
    ? 'critical'
    : findings.length >= 3
      ? 'material'
      : findings.length >= 1
        ? 'minor'
        : 'informational'

  const status: AnalysisStatus = findings.length === 0 ? 'informational' : 'ok'
  const notes = findings.length === 0 ? ['No material evidence was found in this chunk.'] : ['Chunk contains section-specific evidence relevant to research synthesis.']

  return {
    chunkIndex: chunk.chunkIndex,
    section: chunk.section,
    characterCount: chunk.characterCount,
    status,
    materiality,
    findings,
    notes,
  }
}

export function computeChunkCoverage(chunks: FullSecDocumentChunk[], originalText: string): { totalDocumentCharacters: number; totalChunkCharacters: number; coverageRatio: number; failedChunks: number; chunksAnalyzed: number } {
  const totalDocumentCharacters = originalText.length
  const totalChunkCharacters = chunks.reduce((sum, chunk) => sum + chunk.characterCount, 0)
  const coverageRatio = totalDocumentCharacters === 0 ? 0 : totalChunkCharacters / totalDocumentCharacters
  const failedChunks = chunks.filter((chunk) => chunk.status === 'failed').length
  const chunksAnalyzed = chunks.length
  return { totalDocumentCharacters, totalChunkCharacters, coverageRatio, failedChunks, chunksAnalyzed }
}

function summarizeChunkFindings(chunkResults: FullSecChunkAnalysis[]): { strongSignals: string[]; risksAdded: string[]; catalystsAdded: string[]; summaryText: string } {
  const strongSignals = chunkResults.flatMap((result) => result.findings)
  const riskSignals = strongSignals.filter((item) => /risk|regulation|export|supply|competition|customer|debt/.test(item))
  const catalystSignals = strongSignals.filter((item) => /guidance|commitment|investment|acquisition|demand/.test(item))
  const summaryText = strongSignals.join('; ')
  return { strongSignals, risksAdded: riskSignals.length > 0 ? Array.from(new Set(riskSignals)) : [], catalystsAdded: catalystSignals.length > 0 ? Array.from(new Set(catalystSignals)) : [], summaryText }
}

function synthesizeResult(input: FullSecDocumentAnalysisInput, chunkResults: FullSecChunkAnalysis[]): AnalystAnalysisResult {
  const { strongSignals, risksAdded, catalystsAdded, summaryText } = summarizeChunkFindings(chunkResults)
  const hasMaterialEvidence = strongSignals.length >= 2
  const materiality: 'informational' | 'minor' | 'material' | 'critical' = strongSignals.length >= 6
    ? 'critical'
    : strongSignals.length >= 3
      ? 'material'
      : strongSignals.length >= 1
        ? 'minor'
        : 'informational'

  const thesisChanged = hasMaterialEvidence && /guidance|demand|margin|cash flow|liquidity|risk|supply/.test(summaryText)
  const valuationChanged = hasMaterialEvidence && /guidance|margin|cash flow|demand|liquidity/.test(summaryText) && (input.currentFairValue != null || input.previousFairValue != null)
  const previousFairValue = input.previousFairValue ?? input.currentFairValue ?? null
  const newFairValue = valuationChanged ? (input.currentFairValue ?? previousFairValue ?? null) : null
  const impact: 'positive' | 'neutral' | 'negative' = /cash flow|guidance|demand|margin/.test(summaryText)
    ? 'positive'
    : /risk|debt|competition|regulation|export/.test(summaryText)
      ? 'negative'
      : 'neutral'

  const confidence = Math.max(40, Math.min(95, 58 + strongSignals.length * 6 + (chunkResults.length > 0 ? 8 : 0)))
  const thesisSummary = thesisChanged
    ? `The full SEC document reveals material operational and financial context across ${chunkResults.length} chunks, including ${strongSignals.slice(0, 3).join(', ')}.`
    : 'The full SEC document did not produce a material thesis change relative to the current evidence set.'

  return {
    materiality,
    thesisChanged,
    thesisSummary,
    valuationChanged,
    previousFairValue: previousFairValue ?? undefined,
    newFairValue: newFairValue ?? undefined,
    confidence,
    impact,
    affectedAssumptions: [],
    risksAdded: risksAdded.map((item) => item.replace(/_/g, ' ')),
    risksRemoved: [],
    catalystsAdded: catalystsAdded.map((item) => item.replace(/_/g, ' ')),
    catalystsRemoved: [],
    decisionSummary: valuationChanged
      ? 'The full SEC document supported a quantitative review, but no approved fair-value override was applied because the existing evidence contract requires a justifiable assumption change.'
      : 'The full SEC document was analyzed in aggregate; no material thesis or valuation change was justified by the available evidence.',
  }
}

export function analyzeFullSecDocument(input: FullSecDocumentAnalysisInput): FullSecDocumentAnalysisSuccess | FullSecDocumentAnalysisFailure {
  const startedAt = Date.now()
  const normalized = normalizeWhitespace(input.normalizedText)
  if (!normalized) {
    return {
      ok: false,
      code: 'EMPTY_DOCUMENT',
      message: 'No normalized SEC document text was supplied for full-document analysis.',
      metrics: {
        documentBytes: 0,
        normalizedBytes: 0,
        normalizedCharacters: 0,
        chunkCount: 0,
        chunksAnalyzed: 0,
        totalChunkCharacters: 0,
        coverageRatio: 0,
        chunkAnalysisCalls: 0,
        synthesisCalls: 0,
        failedChunks: 0,
        failedStage: 'EMPTY_DOCUMENT',
        elapsedMs: Date.now() - startedAt,
        fullDocumentAnalyzed: false,
      },
    }
  }

  const chunks = buildDocumentChunks(normalized)
  const coverage = computeChunkCoverage(chunks, normalized)
  if (coverage.coverageRatio < 0.95 || coverage.coverageRatio > 1.05 || chunks.length === 0) {
    return {
      ok: false,
      code: 'COVERAGE_INCOMPLETE',
      message: `Coverage check failed: coverageRatio=${coverage.coverageRatio.toFixed(4)} with ${chunks.length} chunks.`,
      metrics: {
        documentBytes: normalized.length,
        normalizedBytes: new TextEncoder().encode(normalized).length,
        normalizedCharacters: normalized.length,
        chunkCount: chunks.length,
        chunksAnalyzed: coverage.chunksAnalyzed,
        totalChunkCharacters: coverage.totalChunkCharacters,
        coverageRatio: coverage.coverageRatio,
        chunkAnalysisCalls: 0,
        synthesisCalls: 0,
        failedChunks: coverage.failedChunks,
        failedStage: 'coverage',
        elapsedMs: Date.now() - startedAt,
        fullDocumentAnalyzed: false,
      },
    }
  }

  const chunkResults = chunks.map((chunk) => analyzeChunk(chunk))
  const failedChunks = chunkResults.filter((result) => result.status === 'failed').length
  if (failedChunks > 0) {
    return {
      ok: false,
      code: 'CHUNK_ANALYSIS_INCOMPLETE',
      message: `Chunk analysis failed for ${failedChunks} chunk(s).`,
      metrics: {
        documentBytes: normalized.length,
        normalizedBytes: new TextEncoder().encode(normalized).length,
        normalizedCharacters: normalized.length,
        chunkCount: chunks.length,
        chunksAnalyzed: chunkResults.length,
        totalChunkCharacters: coverage.totalChunkCharacters,
        coverageRatio: coverage.coverageRatio,
        chunkAnalysisCalls: chunkResults.length,
        synthesisCalls: 0,
        failedChunks,
        failedStage: 'chunk-analysis',
        elapsedMs: Date.now() - startedAt,
        fullDocumentAnalyzed: false,
      },
    }
  }

  const result = synthesizeResult(input, chunkResults)
  if (!isAnalystAnalysisResult(result)) {
    return {
      ok: false,
      code: 'SYNTHESIS_BLOCKED',
      message: 'Synthesized analysis did not match the AnalystAnalysisResult contract.',
      metrics: {
        documentBytes: normalized.length,
        normalizedBytes: new TextEncoder().encode(normalized).length,
        normalizedCharacters: normalized.length,
        chunkCount: chunks.length,
        chunksAnalyzed: chunkResults.length,
        totalChunkCharacters: coverage.totalChunkCharacters,
        coverageRatio: coverage.coverageRatio,
        chunkAnalysisCalls: chunkResults.length,
        synthesisCalls: 1,
        failedChunks: 0,
        failedStage: 'synthesis',
        elapsedMs: Date.now() - startedAt,
        fullDocumentAnalyzed: false,
      },
    }
  }

  const metrics: FullSecDocumentAnalysisMetrics = {
    documentBytes: normalized.length,
    normalizedBytes: new TextEncoder().encode(normalized).length,
    normalizedCharacters: normalized.length,
    chunkCount: chunks.length,
    chunksAnalyzed: chunkResults.length,
    totalChunkCharacters: coverage.totalChunkCharacters,
    coverageRatio: coverage.coverageRatio,
    chunkAnalysisCalls: chunkResults.length,
    synthesisCalls: 1,
    failedChunks: 0,
    failedStage: null,
    elapsedMs: Date.now() - startedAt,
    fullDocumentAnalyzed: true,
  }

  return {
    ok: true,
    result,
    chunks: chunks.map((chunk) => ({ ...chunk, totalChunks: chunks.length })),
    chunkResults,
    metrics,
  }
}

export function normalizeChunkCoverage(chunks: FullSecDocumentChunk[], text: string): { ok: boolean; coverageRatio: number; missingCharacters: number } {
  const coverage = computeChunkCoverage(chunks, text)
  const missingCharacters = Math.max(0, text.length - coverage.totalChunkCharacters)
  const ok = coverage.coverageRatio >= 0.95 && missingCharacters <= Math.max(150, chunks.length * 20)
  return {
    ok,
    coverageRatio: coverage.coverageRatio,
    missingCharacters,
  }
}

export function getFullDocumentAnalysisExample(): string {
  return `Full document analysis keeps all chunks in order and only synthesizes after complete coverage is verified.`
}

export function getFullDocumentAnalysisModelProfile(): { model: string; reasoningEffort: string | null; timeoutMs: number; chunkTargetChars: number; maxChunkChars: number; tokenEstimate: number } {
  return {
    model: 'gpt-5.6-terra',
    reasoningEffort: 'medium',
    timeoutMs: 45_000,
    chunkTargetChars: FULL_SEC_TARGET_CHUNK_CHARS,
    maxChunkChars: FULL_SEC_MAX_CHUNK_CHARS,
    tokenEstimate: estimateTokenCountFromText('x'.repeat(FULL_SEC_TARGET_CHUNK_CHARS)),
  }
}
