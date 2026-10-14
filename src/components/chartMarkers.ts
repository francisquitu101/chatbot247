import type { CandlestickData, SeriesMarker, SeriesMarkerBar, UTCTimestamp } from 'lightweight-charts'
import { deduplicateSupersededProposedSales } from '../lib/insiderTrades'
import type { FinvizAnalystRating, FinvizInsiderTrade } from '../types'

export type ChartMarkerEvent = {
  type: 'Insider transaction' | 'Analyst rating'
  name: string
  detail: string
  insiderTransaction?: 'sale' | 'purchase' | 'exercise' | 'other'
  ratingAction?: 'upgrade' | 'downgrade' | 'other'
}

type ChartMarkerData = {
  markers: SeriesMarker<UTCTimestamp>[]
  eventsByTime: Map<number, ChartMarkerEvent[]>
  timeByDate: Map<string, UTCTimestamp>
}

export function toUtcDay(value: string | null | undefined): number | null {
  if (!value) return null
  const datePart = value.match(/^(\d{4}-\d{2}-\d{2})/)?.[1]
  if (!datePart) return null
  const date = new Date(`${datePart}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== datePart) return null
  return Math.floor(date.getTime() / 1000)
}

function toDateKey(time: number): string {
  return new Date(time * 1000).toISOString().slice(0, 10)
}

export function resolveCandleTime(targetTime: number, candleTimes: number[]): number | null {
  let previousTime: number | null = null
  for (const candleTime of candleTimes) {
    if (candleTime === targetTime) return candleTime
    if (candleTime > targetTime) break
    previousTime = candleTime
  }
  return previousTime !== null && targetTime - previousTime <= 3 * 24 * 60 * 60 ? previousTime : null
}

export function buildChartMarkers(
  candles: CandlestickData<UTCTimestamp>[],
  insiderTrades: FinvizInsiderTrade[],
  ratings: FinvizAnalystRating[],
): ChartMarkerData {
  const candleTimes = candles.map((candle) => Number(candle.time)).sort((left, right) => left - right)
  const eventsByDate = new Map<string, ChartMarkerEvent[]>()

  const addEvent = (date: string | null | undefined, event: ChartMarkerEvent) => {
    const targetTime = toUtcDay(date)
    if (targetTime === null) return
    const dateKey = toDateKey(targetTime)
    const events = eventsByDate.get(dateKey) ?? []
    events.push(event)
    eventsByDate.set(dateKey, events)
  }

  for (const trade of deduplicateSupersededProposedSales(insiderTrades)) {
    const transaction = trade.transaction.trim() || 'Transaction'
    const insiderTransaction = /sale/i.test(transaction)
      ? 'sale'
      : /\b(?:purchase|buy)\b/i.test(transaction)
        ? 'purchase'
        : /option|exercise/i.test(transaction)
          ? 'exercise'
          : 'other'
    const details = [
      transaction,
      trade.shares.trim() ? `#Shares: ${trade.shares.trim()}` : '',
      trade.value.trim() ? `Value: ${trade.value.trim()}` : '',
    ].filter(Boolean)
    addEvent(trade.transaction_date, {
      type: 'Insider transaction',
      name: trade.insider_name.trim() || 'Insider',
      detail: details.join(' · '),
      insiderTransaction,
    })
  }

  for (const rating of ratings) {
    const ratingAction = `${rating.action} ${rating.rating_change}`.trim()
    const isUpgrade = /\bupgrade(?:d)?\b/i.test(ratingAction)
    const isDowngrade = /\bdowngrade(?:d)?\b/i.test(ratingAction)
    const label = rating.analyst.trim() || 'Analyst'
    addEvent(rating.rating_date, {
      type: 'Analyst rating',
      name: label,
      detail: [rating.action, rating.rating_change, rating.price_target_change].filter(Boolean).join(' · ') || 'Rating update',
      ratingAction: isUpgrade ? 'upgrade' : isDowngrade ? 'downgrade' : 'other',
    })
  }

  const markerEntries: Array<{ marker: SeriesMarkerBar<UTCTimestamp>; date: string; events: ChartMarkerEvent[] }> = []
  const timeByDate = new Map<string, UTCTimestamp>()
  const eventsByCandle = new Map<number, ChartMarkerEvent[]>()
  for (const [date, events] of eventsByDate) {
    const targetTime = toUtcDay(date)
    if (targetTime === null) continue
    const candleTime = resolveCandleTime(targetTime, candleTimes)
    if (candleTime === null) continue
    const candleEvents = eventsByCandle.get(candleTime) ?? []
    candleEvents.push(...events)
    eventsByCandle.set(candleTime, candleEvents)
    timeByDate.set(date, candleTime as UTCTimestamp)
  }

  for (const [candleTime, events] of eventsByCandle) {
    const date = new Date(candleTime * 1000).toISOString().slice(0, 10)
    const insiderEvents = events.filter((event) => event.type === 'Insider transaction')
    const ratingEvents = events.filter((event) => event.type === 'Analyst rating')
    const sales = events.filter((event) => event.insiderTransaction === 'sale').length
    const purchases = events.filter((event) => event.insiderTransaction === 'purchase').length
    const upgrades = events.filter((event) => event.ratingAction === 'upgrade').length
    const downgrades = events.filter((event) => event.ratingAction === 'downgrade').length
    const categories = Number(insiderEvents.length > 0) + Number(ratingEvents.length > 0)

    let marker: Omit<SeriesMarkerBar<UTCTimestamp>, 'time' | 'id'>
    if (events.length === 1) {
      const [event] = events
      if (event.insiderTransaction === 'sale') {
        marker = { position: 'aboveBar', shape: 'arrowDown', color: '#dc4c4c', text: 'Sale', size: 1 }
      } else if (event.insiderTransaction === 'purchase') {
        marker = { position: 'belowBar', shape: 'arrowUp', color: '#16845b', text: 'Buy', size: 1 }
      } else if (event.insiderTransaction === 'exercise') {
        marker = { position: 'belowBar', shape: 'circle', color: '#3978b8', text: 'Exercise', size: 1 }
      } else if (event.insiderTransaction === 'other') {
        marker = { position: 'belowBar', shape: 'circle', color: '#3978b8', text: 'Insider', size: 1 }
      } else if (event.ratingAction === 'upgrade') {
        marker = { position: 'belowBar', shape: 'circle', color: '#16845b', text: 'Upgrade', size: 1 }
      } else if (event.ratingAction === 'downgrade') {
        marker = { position: 'belowBar', shape: 'circle', color: '#3978b8', text: 'Downgrade', size: 1 }
      } else {
        marker = { position: 'belowBar', shape: 'circle', color: '#3978b8', text: 'Rating', size: 1 }
      }
    } else if (categories > 1) {
      marker = { position: 'aboveBar', shape: 'circle', color: '#3978b8', text: `${events.length} Events`, size: 1 }
    } else if (sales > 0 && insiderEvents.length === sales) {
      marker = { position: 'aboveBar', shape: 'arrowDown', color: '#dc4c4c', text: `${sales} Sales`, size: 1 }
    } else if (purchases > 0 && insiderEvents.length === purchases) {
      marker = { position: 'belowBar', shape: 'arrowUp', color: '#16845b', text: `${purchases} Purchases`, size: 1 }
    } else if (insiderEvents.length > 0) {
      marker = { position: 'belowBar', shape: 'circle', color: '#3978b8', text: `${insiderEvents.length} Insider Events`, size: 1 }
    } else if (upgrades > 0 && ratingEvents.length === upgrades) {
      marker = { position: 'belowBar', shape: 'circle', color: '#16845b', text: `${upgrades} Upgrades`, size: 1 }
    } else if (downgrades > 0 && ratingEvents.length === downgrades) {
      marker = { position: 'belowBar', shape: 'circle', color: '#3978b8', text: `${downgrades} Downgrades`, size: 1 }
    } else {
      marker = { position: 'belowBar', shape: 'circle', color: '#3978b8', text: `${ratingEvents.length} Ratings`, size: 1 }
    }

    markerEntries.push({ marker: { ...marker, time: candleTime as UTCTimestamp, id: date }, date, events })
    timeByDate.set(date, candleTime as UTCTimestamp)
  }
  markerEntries.sort((left, right) => Number(left.marker.time) - Number(right.marker.time) || left.date.localeCompare(right.date))
  const eventsByTime = new Map<number, ChartMarkerEvent[]>()
  for (const { marker, events } of markerEntries) {
    const time = Number(marker.time)
    const dayEvents = eventsByTime.get(time) ?? []
    dayEvents.push(...events)
    eventsByTime.set(time, dayEvents)
  }

  return { markers: markerEntries.map(({ marker }) => marker), eventsByTime, timeByDate }
}
