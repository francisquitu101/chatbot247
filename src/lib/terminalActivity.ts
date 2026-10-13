export type TerminalActivityEventType = 'news' | 'filing' | 'rating' | 'insider' | 'system'

export type TerminalActivityEvent = {
  id: string
  ticker: string
  type: TerminalActivityEventType
  timestamp: string | null
  dateOnly: boolean
  timestampLabel: string
  receivedAt: string | null
  sourceFiledAt: string | null
  message: string
}

const appTimeZone = 'America/New_York'
type SourceActivityType = Exclude<TerminalActivityEventType, 'system'>

function isSourceActivityType(value: unknown): value is SourceActivityType {
  return value === 'news' || value === 'filing' || value === 'rating' || value === 'insider'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isValidCalendarDate(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function validTimestamp(value: string | null): number | null {
  if (!value) return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}

export function compareTerminalActivityEventsNewestFirst(left: TerminalActivityEvent, right: TerminalActivityEvent): number {
  const leftTime = validTimestamp(left.timestamp)
  const rightTime = validTimestamp(right.timestamp)
  if (leftTime === null && rightTime !== null) return 1
  if (leftTime !== null && rightTime === null) return -1
  if (leftTime === null && rightTime === null) {
    return (validTimestamp(right.receivedAt) ?? 0) - (validTimestamp(left.receivedAt) ?? 0)
  }
  if (leftTime === null || rightTime === null) return 0
  return rightTime - leftTime
}

export function normalizeTerminalActivityRows(ticker: string, rows: unknown): TerminalActivityEvent[] {
  const normalizedTicker = ticker.trim().toUpperCase()
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(normalizedTicker)) {
    throw new Error('Terminal activity requires a valid ticker.')
  }
  if (!Array.isArray(rows)) {
    throw new Error('Terminal activity returned an invalid data format.')
  }

  const events = rows.flatMap((value): TerminalActivityEvent[] => {
    if (!isRecord(value)) throw new Error('Terminal activity returned an invalid event.')
    if (typeof value.ticker !== 'string' || value.ticker.trim().toUpperCase() !== normalizedTicker) return []
    if (
      typeof value.event_id !== 'string' ||
      !isSourceActivityType(value.event_type) ||
      typeof value.event_date_only !== 'boolean' ||
      typeof value.event_label !== 'string' ||
      typeof value.message !== 'string' ||
      (value.event_date !== null && typeof value.event_date !== 'string') ||
      (value.received_at !== null && typeof value.received_at !== 'string') ||
      (value.source_filed_at !== null && typeof value.source_filed_at !== 'string')
    ) {
      throw new Error('Terminal activity returned an invalid event.')
    }
    return [{
      id: value.event_id,
      ticker: normalizedTicker,
      type: value.event_type,
      timestamp: value.event_date,
      dateOnly: value.event_date_only,
      timestampLabel: value.event_label,
      receivedAt: value.received_at,
      sourceFiledAt: value.source_filed_at,
      message: value.message,
    }]
  })

  return events.sort(compareTerminalActivityEventsNewestFirst)
}

function formatCalendarDate(value: string): string {
  const [year, month, day] = value.split('-').map(Number)
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)))
}

function formatDateTime(value: string): string | null {
  const time = validTimestamp(value)
  if (time === null) return null
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZone: appTimeZone,
    timeZoneName: 'short',
  }).format(new Date(time))
}

export function formatTerminalClock(value: string | null): string {
  return value ? formatDateTime(value) ?? 'Date unavailable' : 'Date unavailable'
}

export function formatTerminalEventTimestamp(event: TerminalActivityEvent): string {
  let eventDate = `${event.timestampLabel}: Date unavailable`
  if (event.timestamp && event.dateOnly && isValidCalendarDate(event.timestamp)) {
    eventDate = `${event.timestampLabel}: ${formatCalendarDate(event.timestamp)}`
  } else if (event.timestamp && !event.dateOnly) {
    const formattedDateTime = formatDateTime(event.timestamp)
    if (formattedDateTime) eventDate = `${event.timestampLabel}: ${formattedDateTime}`
  }
  if (event.type === 'system') return eventDate
  const parts = [eventDate]
  if (event.sourceFiledAt) {
    parts.push(`Form 4 source time: ${event.sourceFiledAt} (timezone unavailable)`)
  }
  return parts.join(' · ')
}
