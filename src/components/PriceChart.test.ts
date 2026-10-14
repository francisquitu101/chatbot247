import { describe, expect, it } from 'vitest'
import type { CandlestickData, UTCTimestamp } from 'lightweight-charts'
import type { FinvizAnalystRating, FinvizInsiderTrade } from '../types'
import { buildChartMarkers } from './chartMarkers'

function candle(date: string): CandlestickData<UTCTimestamp> {
  return {
    time: (Date.parse(`${date}T00:00:00.000Z`) / 1000) as UTCTimestamp,
    open: 100,
    high: 105,
    low: 95,
    close: 102,
  }
}

function insiderTrade(transaction: string, transactionDate = '2026-09-28'): FinvizInsiderTrade {
  return {
    id: transaction,
    ticker: 'KURA',
    source_id: 'source',
    insider_name: 'Teresa Brophy',
    relationship: 'Officer',
    transaction_date: transactionDate,
    transaction,
    cost: '$10.00',
    shares: '1,000',
    value: '$10,000',
    shares_total: '2,000',
    sec_form4_url: 'https://example.com/form4',
    created_at: transactionDate,
    scraped_at: transactionDate,
    content_hash: transaction,
  }
}

function analystRating(action: string, ratingChange: string, targetChange: string): FinvizAnalystRating {
  return {
    id: action,
    ticker: 'KURA',
    source_id: 'source',
    rating_date: '2026-09-28',
    action,
    analyst: 'Example Securities',
    rating_change: ratingChange,
    price_target_change: targetChange,
    created_at: '2026-09-28',
    scraped_at: '2026-09-28',
    content_hash: action,
  }
}

describe('buildChartMarkers', () => {
  it('keeps separate sale events and maps them to their matching candle date', () => {
    const result = buildChartMarkers(
      [candle('2026-09-28')],
      [insiderTrade('Proposed Sale'), insiderTrade('Sale')],
      [],
    )

    expect(result.markers).toHaveLength(1)
    expect(result.markers[0].time).toBe(candle('2026-09-28').time)
    expect(result.eventsByTime.get(Number(result.markers[0].time))).toEqual([
      expect.objectContaining({ detail: 'Proposed Sale · #Shares: 1,000 · Value: $10,000' }),
      expect.objectContaining({ detail: 'Sale · #Shares: 1,000 · Value: $10,000' }),
    ])
  })

  it('includes option exercises and non-upgrade analyst ratings in event details', () => {
    const result = buildChartMarkers(
      [candle('2026-09-28')],
      [insiderTrade('Option Exercise')],
      [analystRating('Rating Change', 'Reiterated Buy', '$8.00 → $12.00')],
    )

    const events = result.eventsByTime.get(Number(result.markers[0].time))
    expect(events).toEqual([
      expect.objectContaining({
        detail: 'Option Exercise · #Shares: 1,000 · Value: $10,000',
        insiderTransaction: 'exercise',
      }),
      expect.objectContaining({
        name: 'Example Securities',
        detail: 'Rating Change · Reiterated Buy · $8.00 → $12.00',
        ratingAction: 'other',
      }),
    ])
  })

  it('aligns a weekend event to the preceding available trading candle', () => {
    const result = buildChartMarkers(
      [candle('2026-09-25'), candle('2026-09-28')],
      [insiderTrade('Sale', '2026-09-27')],
      [],
    )

    expect(result.markers[0].time).toBe(candle('2026-09-25').time)
  })
})
