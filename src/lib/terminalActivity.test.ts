import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getLatestTerminalActivity } from './queries/company'
import { formatTerminalEventTimestamp, normalizeTerminalActivityRows } from './terminalActivity'

function activityRow(overrides: Record<string, unknown> = {}) {
  return {
    event_id: 'insider-1',
    ticker: 'NVDA',
    event_type: 'insider',
    event_date: '2026-09-21',
    event_date_only: true,
    event_label: 'Transaction date',
    received_at: '2026-10-08T14:37:36.896Z',
    source_filed_at: null,
    message: 'Insider action: Sale by Teter Timothy S.',
    ...overrides,
  }
}

function mockClient(result: { data: unknown; error: unknown }) {
  return {
    rpc: vi.fn().mockResolvedValue(result),
  } as unknown as SupabaseClient
}

describe('terminal tracker data', () => {
  it('loads NVDA events for the requested ticker', async () => {
    const client = mockClient({ data: [activityRow()], error: null })
    const result = await getLatestTerminalActivity(client, 'nvda')

    expect(client.rpc).toHaveBeenCalledWith('get_public_terminal_activity', { p_ticker: 'NVDA', p_since: null })
    expect(result.errors).toEqual([])
    expect(result.events.map((event) => event.ticker)).toEqual(['NVDA'])
  })

  it('loads TSLA independently rather than requiring a public analyst row', async () => {
    const client = mockClient({ data: [activityRow({ ticker: 'TSLA', event_id: 'rating-tsla', event_type: 'rating' })], error: null })
    const result = await getLatestTerminalActivity(client, 'TSLA')

    expect(client.rpc).toHaveBeenCalledWith('get_public_terminal_activity', { p_ticker: 'TSLA', p_since: null })
    expect(result.events.map((event) => event.ticker)).toEqual(['TSLA'])
  })

  it('passes the last successful poll cursor when requesting only new events', async () => {
    const client = mockClient({ data: [], error: null })
    await getLatestTerminalActivity(client, 'NVDA', '2026-10-13T12:00:00.000Z')
    expect(client.rpc).toHaveBeenCalledWith('get_public_terminal_activity', {
      p_ticker: 'NVDA',
      p_since: '2026-10-13T12:00:00.000Z',
    })
  })

  it('treats a valid ticker with no new events as an empty successful result', async () => {
    const result = await getLatestTerminalActivity(mockClient({ data: [], error: null }), 'TSLA')
    expect(result).toEqual({ events: [], errors: [] })
  })

  it('surfaces collection or query errors instead of displaying an empty feed', async () => {
    const result = await getLatestTerminalActivity(mockClient({ data: null, error: { message: 'database unavailable' } }), 'TSLA')
    expect(result.events).toEqual([])
    expect(result.errors).toEqual(['Terminal activity: database unavailable'])
  })

  it('filters mixed-ticker responses so events never leak between ticker terminals', () => {
    const events = normalizeTerminalActivityRows('TSLA', [
      activityRow({ ticker: 'NVDA' }),
      activityRow({ ticker: 'TSLA', event_id: 'tsla-1' }),
    ])
    expect(events).toHaveLength(1)
    expect(events[0].ticker).toBe('TSLA')
  })
})

describe('terminal event timestamps', () => {
  it('keeps a date-only event on its source calendar date without inventing a time', () => {
    const [event] = normalizeTerminalActivityRows('NVDA', [activityRow()])
    const formatted = formatTerminalEventTimestamp(event)

    expect(formatted).toContain('Transaction date: 21 Sept 2026')
    expect(formatted).not.toContain('21:00')
    expect(formatted).toContain('Received: 08 Oct 2026, 10:37:36 GMT-4')
  })

  it('converts a full UTC timestamp to the application timezone and preserves its date', () => {
    const [event] = normalizeTerminalActivityRows('NVDA', [activityRow({
      event_type: 'news',
      event_date: '2026-10-13T12:43:45.000Z',
      event_date_only: false,
      event_label: 'Published',
    })])
    const formatted = formatTerminalEventTimestamp(event)

    expect(formatted).toContain('Published: 13 Oct 2026, 08:43:45 GMT-4')
  })

  it('distinguishes publication time from database receipt time', () => {
    const [event] = normalizeTerminalActivityRows('NVDA', [activityRow({
      event_type: 'news',
      event_date: '2026-10-13T12:43:45.000Z',
      event_date_only: false,
      event_label: 'Published',
      received_at: '2026-10-13T13:10:00.000Z',
    })])
    const formatted = formatTerminalEventTimestamp(event)

    expect(formatted).toContain('Published: 13 Oct 2026, 08:43:45 GMT-4')
    expect(formatted).toContain('Received: 13 Oct 2026, 09:10:00 GMT-4')
  })

  it('shows historical events with their event date and later receipt date separately', () => {
    const [event] = normalizeTerminalActivityRows('NVDA', [activityRow()])
    const formatted = formatTerminalEventTimestamp(event)
    expect(formatted.indexOf('21 Sept 2026')).toBeLessThan(formatted.indexOf('08 Oct 2026'))
  })

  it('formats an SEC filing date as a calendar date rather than a midnight timestamp', () => {
    const [event] = normalizeTerminalActivityRows('NVDA', [activityRow({
      event_type: 'filing',
      event_date: '2026-10-09',
      event_label: 'Filing date',
      message: 'SEC filing filed: 4 — NVIDIA CORP',
    })])
    const formatted = formatTerminalEventTimestamp(event)
    expect(formatted).toContain('Filing date: 09 Oct 2026')
    expect(formatted).not.toContain('00:00')
  })

  it('preserves a Form 4 source display timestamp but identifies its missing timezone', () => {
    const [event] = normalizeTerminalActivityRows('NVDA', [activityRow({ source_filed_at: 'Sep 21 04:22 PM' })])
    const formatted = formatTerminalEventTimestamp(event)
    expect(formatted).toContain('Form 4 source time: Sep 21 04:22 PM (timezone unavailable)')
  })

  it('labels malformed event timestamps as unavailable and still shows a valid receipt time', () => {
    const [event] = normalizeTerminalActivityRows('NVDA', [activityRow({ event_date: 'not-a-date' })])
    const formatted = formatTerminalEventTimestamp(event)
    expect(formatted).toContain('Transaction date: Date unavailable')
    expect(formatted).toContain('Received: 08 Oct 2026, 10:37:36 GMT-4')
  })

  it('does not normalize an impossible date-only calendar value into another date', () => {
    const [event] = normalizeTerminalActivityRows('NVDA', [activityRow({ event_date: '2026-02-31' })])
    expect(formatTerminalEventTimestamp(event)).toContain('Transaction date: Date unavailable')
  })

  it('labels both event and receipt times unavailable when neither source is valid', () => {
    const [event] = normalizeTerminalActivityRows('NVDA', [activityRow({ event_date: null, received_at: null })])
    expect(formatTerminalEventTimestamp(event)).toBe('Transaction date: Date unavailable · Received: Date unavailable')
  })
})
