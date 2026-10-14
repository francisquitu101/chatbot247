import { describe, expect, it } from 'vitest'
import type { FinvizInsiderTrade } from '../types'
import { deduplicateSupersededProposedSales } from './insiderTrades'

function trade(overrides: Partial<FinvizInsiderTrade> = {}): FinvizInsiderTrade {
  return {
    id: 'trade',
    ticker: 'KURA',
    source_id: 'source',
    insider_name: 'FORD KATHLEEN',
    relationship: 'Officer',
    transaction_date: '2026-10-01',
    transaction: 'Proposed Sale',
    cost: '$10.00',
    shares: '1,000',
    value: '$10,000',
    shares_total: '2,000',
    sec_form4_url: 'https://example.com/form4',
    created_at: '2026-10-01',
    scraped_at: '2026-10-01',
    content_hash: 'hash',
    ...overrides,
  }
}

describe('deduplicateSupersededProposedSales', () => {
  it('prefers a matching completed sale when name order and date differ slightly', () => {
    const proposed = trade()
    const completed = trade({
      id: 'completed',
      insider_name: 'Kathleen Ford',
      transaction_date: '2026-10-02',
      transaction: 'Sale',
      cost: '$10.12',
      content_hash: 'completed-hash',
    })

    expect(deduplicateSupersededProposedSales([proposed, completed])).toEqual([completed])
  })

  it('does not collapse trades with different shares, insider, ticker, or a date gap over one day', () => {
    const proposed = trade()
    const mismatches = [
      trade({ id: 'different-shares', transaction: 'Sale', shares: '1,001' }),
      trade({ id: 'different-person', transaction: 'Sale', insider_name: 'TETER TIMOTHY' }),
      trade({ id: 'different-ticker', transaction: 'Sale', ticker: 'NVDA' }),
      trade({ id: 'different-date', transaction: 'Sale', transaction_date: '2026-10-03' }),
    ]

    for (const completed of mismatches) {
      expect(deduplicateSupersededProposedSales([proposed, completed])).toHaveLength(2)
    }
  })

  it('retains proposed sales when there is no matching completed sale', () => {
    const proposed = trade()
    expect(deduplicateSupersededProposedSales([proposed])).toEqual([proposed])
  })
})
