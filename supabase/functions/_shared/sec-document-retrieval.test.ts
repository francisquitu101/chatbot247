import { describe, it, expect } from 'vitest'
import { buildCanonicalSecDocumentUrl, normalizeAccessionNumber, normalizeSecDocument, retrieveSecDocument } from './sec-document-retrieval'

describe('SEC document retrieval utilities', () => {
  it('builds the canonical SEC archive URL from metadata', () => {
    const url = buildCanonicalSecDocumentUrl({
      cik: '0001045810',
      accessionNumber: '0001045810-26-000075',
      primaryDocument: 'nvda-20260726.htm',
    })

    expect(url).toBe('https://www.sec.gov/Archives/edgar/data/1045810/000104581026000075/nvda-20260726.htm')
  })

  it('normalizes accession numbers without guessing values', () => {
    expect(normalizeAccessionNumber('0001045810-26-000075')).toBe('0001045810-26-000075')
    expect(normalizeAccessionNumber('   ')).toBeNull()
  })

  it('normalizes HTML to readable text without stripping meaningful headings', () => {
    const html = `
      <html><body>
      <h1>Item 1. Business</h1>
      <p>Revenue grew by 25%.</p>
      <h2>Risk Factors</h2>
      <p>Market risk and export controls.</p>
      </body></html>
    `

    const normalized = normalizeSecDocument(html)
    expect(normalized).toContain('Item 1. Business')
    expect(normalized).toContain('Revenue grew by 25%.')
    expect(normalized).toContain('Risk Factors')
  })

  it('rejects invalid SEC metadata', () => {
    expect(() => buildCanonicalSecDocumentUrl({
      cik: 'abc',
      accessionNumber: '0001045810-26-000075',
      primaryDocument: 'nvda-20260726.htm',
    })).toThrow('SEC_METADATA_INVALID')
  })

  it('respects the configured size limit before downloading an oversized body', async () => {
    const response = await retrieveSecDocument(
      {
        cik: '0001045810',
        accessionNumber: '0001045810-26-000075',
        primaryDocument: 'nvda-20260726.htm',
      },
      {
        timeoutMs: 5000,
        maxBytes: 1,
        userAgent: 'TestUserAgent/1.0',
      },
    )

    expect(response.ok).toBe(false)
    expect(['SEC_SIZE_LIMIT', 'SEC_HTTP_ERROR', 'SEC_NETWORK_ERROR', 'SEC_TIMEOUT']).toContain(response.code)
  })
})
