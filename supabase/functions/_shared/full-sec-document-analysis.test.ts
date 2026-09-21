import { describe, it, expect } from 'vitest'
import { analyzeFullSecDocument, buildDocumentChunks, computeChunkCoverage, normalizeChunkCoverage } from './full-sec-document-analysis'

describe('full SEC document analysis', () => {
  it('chunks a full document and preserves section ordering', () => {
    const text = [
      'Item 1. Business',
      'Revenue grew by 25% in the quarter.',
      'The business expanded globally and increased shipments.',
      'Item 7. Management\'s Discussion and Analysis',
      'Operating margin expanded and cash flow remained strong.',
      'Risk factors include export controls and competition.',
    ].join('\n\n')

    const chunks = buildDocumentChunks(text)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0].section).toMatch(/Item 1|body/i)
    expect(chunks.map((chunk) => chunk.section).join(' ')).toContain('Item 1')
    expect(chunks.map((chunk) => chunk.section).join(' ')).toContain('Item 7')
  })

  it('preserves high coverage over the normalized document', () => {
    const text = 'Item 1. Business\n\n' + 'A'.repeat(4500) + '\n\nItem 7. Management\'s Discussion and Analysis\n\n' + 'B'.repeat(4300)
    const chunks = buildDocumentChunks(text)
    const coverage = computeChunkCoverage(chunks, text)
    expect(chunks.length).toBeGreaterThan(0)
    expect(coverage.coverageRatio).toBeGreaterThan(0.95)
    expect(coverage.failedChunks).toBe(0)
  })

  it('splits oversized sections conservatively', () => {
    const text = 'Item 7. Management\'s Discussion and Analysis\n\n' + 'X'.repeat(80000)
    const chunks = buildDocumentChunks(text)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => chunk.characterCount <= 24000)).toBe(true)
  })

  it('fails cleanly on empty document input', () => {
    const result = analyzeFullSecDocument({ ticker: 'NVDA', normalizedText: '' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('EMPTY_DOCUMENT')
  })

  it('blocks synthesis if chunk coverage is incomplete', () => {
    const text = 'Item 1. Business\n\n' + 'A'.repeat(2500)
    const partialChunks = [{
      chunkIndex: 1,
      totalChunks: 1,
      section: 'body',
      characterCount: 100,
      status: 'ok',
      content: 'Item 1. Business',
    }]
    const coverage = normalizeChunkCoverage(partialChunks, text)
    expect(coverage.ok).toBe(false)
    expect(coverage.coverageRatio).toBeLessThan(1)
  })

  it('returns a structured result when the document is valid', () => {
    const text = [
      'Item 1. Business',
      'Revenue grew by 25%. Gross margin expanded to 75%. Cash flow remained strong.',
      'Item 7. Management\'s Discussion and Analysis',
      'Demand remained healthy. Margins improved. Guidance remains constructive.',
      'Risk factors include export controls and competition.',
    ].join('\n\n')

    const result = analyzeFullSecDocument({ ticker: 'NVDA', normalizedText: text, currentThesis: 'Demand remains durable.', currentFairValue: 180, previousFairValue: 170, confidence: 75 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.metrics.coverageRatio).toBeGreaterThan(0.95)
      expect(result.metrics.failedChunks).toBe(0)
      expect(result.metrics.chunksAnalyzed).toBe(result.metrics.chunkCount)
      expect(result.result.materiality).toBeDefined()
      expect(typeof result.result.decisionSummary).toBe('string')
    }
  })
})
