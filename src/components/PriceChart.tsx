import { useEffect, useRef, useState } from 'react'
import type { CandlestickData, IChartApi, IPriceLine, ISeriesApi, ISeriesMarkersPluginApi, LineData, Time, UTCTimestamp } from 'lightweight-charts'
import { supabase } from '../lib/supabase'
import type { FinvizAnalystRating, FinvizInsiderTrade } from '../types'
import { buildChartMarkers, resolveCandleTime, toUtcDay, type ChartMarkerEvent } from './chartMarkers'

export type PriceChartCandle = {
  time: number
  open: number
  high: number
  low: number
  close: number
}

type ChartPayload = {
  candles: PriceChartCandle[]
  currency: string
}

type PriceChartProps = {
  ticker: string
  insiderTrades: FinvizInsiderTrade[]
  ratings: FinvizAnalystRating[]
  onCandlesChange: (candles: PriceChartCandle[]) => void
}

type MarkerTooltip = {
  x: number
  y: number
  time: number
  events: ChartMarkerEvent[]
}

type ChartControl =
  | { action: 'ZOOM_TO_RANGE'; start: string; end: string }
  | { action: 'HIGHLIGHT_DATE'; date: string }
  | { action: 'ADD_PRICE_LINE'; price: number; title: string; color: string }
  | { action: 'ADD_TREND_LINE'; data: LineData<Time>[]; color: string }
  | { action: 'CLEAR_LINES' }

const SAFE_CHART_COLOR = /^#(?:[\da-f]{3}|[\da-f]{6})$/i

function toDateRangeTime(value: string): string | null {
  return toUtcDay(value) === null ? null : value
}

function readChartControl(value: unknown): ChartControl | null {
  if (!value || typeof value !== 'object') return null
  const detail = value as Record<string, unknown>
  if (detail.action === 'ZOOM_TO_RANGE' && typeof detail.start === 'string' && typeof detail.end === 'string') {
    const start = toDateRangeTime(detail.start)
    const end = toDateRangeTime(detail.end)
    if (start && end && start < end) return { action: 'ZOOM_TO_RANGE', start, end }
    return null
  }
  if (detail.action === 'HIGHLIGHT_DATE' && typeof detail.date === 'string') {
    const date = toDateRangeTime(detail.date)
    if (date) return { action: 'HIGHLIGHT_DATE', date }
  }
  if (
    detail.action === 'ADD_PRICE_LINE' &&
    typeof detail.price === 'number' &&
    Number.isFinite(detail.price) &&
    detail.price > 0 &&
    typeof detail.title === 'string' &&
    detail.title.trim().length > 0 &&
    detail.title.length <= 80 &&
    typeof detail.color === 'string' &&
    SAFE_CHART_COLOR.test(detail.color)
  ) {
    return { action: 'ADD_PRICE_LINE', price: detail.price, title: detail.title.trim(), color: detail.color }
  }
  if (
    detail.action === 'ADD_TREND_LINE' &&
    typeof detail.color === 'string' &&
    SAFE_CHART_COLOR.test(detail.color) &&
    Array.isArray(detail.data) &&
    detail.data.length >= 2 &&
    detail.data.length <= 100
  ) {
    const data: LineData<Time>[] = []
    for (const point of detail.data) {
      if (!point || typeof point !== 'object' || typeof point.time !== 'string' || toDateRangeTime(point.time) === null) return null
      if (typeof point.value !== 'number' || !Number.isFinite(point.value) || point.value <= 0) return null
      data.push({ time: point.time, value: point.value })
    }
    if (data.some((point, index) => index > 0 && String(data[index - 1].time) >= String(point.time))) return null
    return { action: 'ADD_TREND_LINE', data, color: detail.color }
  }
  if (detail.action === 'CLEAR_LINES') return { action: 'CLEAR_LINES' }
  return null
}

function clearTechnicalLines(
  chart: IChartApi | null,
  series: ISeriesApi<'Candlestick', Time> | null,
  priceLines: IPriceLine[],
  trendSeries: ISeriesApi<'Line', Time>[],
) {
  if (series) priceLines.forEach((line) => series.removePriceLine(line))
  if (chart) trendSeries.forEach((trend) => chart.removeSeries(trend))
  priceLines.length = 0
  trendSeries.length = 0
}

function formatMarkerDate(time: number): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(time * 1000))
}

function buildSampleCandles(ticker: string): CandlestickData<UTCTimestamp>[] {
  const seed = [...ticker].reduce((value, character) => (value * 31 + character.charCodeAt(0)) >>> 0, 7)
  let previousClose = 45 + (seed % 180)
  const candles: CandlestickData<UTCTimestamp>[] = []
  const today = new Date()

  for (let dayOffset = 120; dayOffset >= 0; dayOffset -= 1) {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - dayOffset))
    if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue
    const index = candles.length + seed
    const change = Math.sin(index * 0.39) * 1.8 + Math.cos(index * 0.13) * 0.9
    const open = previousClose
    const close = Math.max(1, open + change)
    const spread = 0.4 + ((index * 17) % 100) / 100
    candles.push({
      time: Math.floor(date.getTime() / 1000) as UTCTimestamp,
      open,
      high: Math.max(open, close) + spread,
      low: Math.max(0.01, Math.min(open, close) - spread),
      close,
    })
    previousClose = close
  }

  return candles
}

export function PriceChart({ ticker, insiderTrades, ratings, onCandlesChange }: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick', Time> | null>(null)
  const priceLinesRef = useRef<IPriceLine[]>([])
  const trendSeriesRef = useRef<ISeriesApi<'Line', Time>[]>([])
  const pendingControlsRef = useRef<ChartControl[]>([])
  const controlExecutionRef = useRef<Promise<void>>(Promise.resolve())
  const simulatedCandlesRef = useRef(false)
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null)
  const markerEventsRef = useRef<Map<number, ChartMarkerEvent[]>>(new Map())
  const markerTimesByDateRef = useRef<Map<string, UTCTimestamp>>(new Map())
  const [candles, setCandles] = useState<CandlestickData<UTCTimestamp>[]>([])
  const [currency, setCurrency] = useState('USD')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [sampleMessage, setSampleMessage] = useState<string | null>(null)
  const [chartInstance, setChartInstance] = useState(0)
  const [markerTooltip, setMarkerTooltip] = useState<MarkerTooltip | null>(null)

  useEffect(() => {
    onCandlesChange(simulatedCandlesRef.current ? [] : candles.map((candle) => ({
      time: Number(candle.time),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    })))
  }, [candles, onCandlesChange])

  useEffect(() => {
    let active = true
    simulatedCandlesRef.current = false
    setLoading(true)
    setError(null)
    setCandles([])
    setSampleMessage(null)

    const showSampleChart = (reason: string) => {
      if (!active) return
      simulatedCandlesRef.current = true
      setCandles(buildSampleCandles(ticker))
      setCurrency('DEMO')
      setSampleMessage(reason)
      setLoading(false)
    }

    const loadChart = async () => {
      if (!supabase) {
        showSampleChart('Live price history is unavailable; this simulated chart is for layout preview only.')
        return
      }

      const { data, error: invokeError } = await supabase.functions.invoke<{
        success: boolean
        data?: ChartPayload
        error?: { message?: string }
      }>('stock-chart', { body: { ticker } })
      if (!active) return
      if (invokeError || data?.success !== true || !Array.isArray(data.data?.candles)) {
        showSampleChart(`Live price history could not be loaded; this simulated chart is for preview only. ${data?.error?.message ?? invokeError?.message ?? ''}`.trim())
        return
      }

      const parsedCandles = data.data.candles
        .filter((candle) =>
          Number.isInteger(candle.time) &&
          [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)
        )
        .map((candle) => ({
          ...candle,
          time: candle.time as UTCTimestamp,
        }))
      setCandles(parsedCandles)
      setCurrency(data.data.currency)
      if (parsedCandles.length === 0) {
        showSampleChart('No live price history is available; this simulated chart is for preview only.')
        return
      }
      setLoading(false)
    }

    void loadChart()
    return () => { active = false }
  }, [ticker])

  useEffect(() => {
    const container = containerRef.current
    if (!container || candles.length === 0) return

    let active = true
    let chart: IChartApi | null = null
    let chartSeries: ISeriesApi<'Candlestick', Time> | null = null
    const priceLines = priceLinesRef.current
    const trendSeries = trendSeriesRef.current
    let resizeObserver: ResizeObserver | null = null
    const renderChart = async () => {
      try {
        const { CandlestickSeries, ColorType, createChart, createSeriesMarkers } = await import('lightweight-charts')
        if (!active) return
        chart = createChart(container, {
          width: container.clientWidth,
          height: container.clientHeight,
          layout: {
            background: { type: ColorType.Solid, color: 'transparent' },
            textColor: '#68746f',
            fontFamily: "'Inter', system-ui, sans-serif",
          },
          grid: {
            vertLines: { color: 'rgba(19, 33, 39, 0.04)' },
            horzLines: { color: 'rgba(19, 33, 39, 0.07)' },
          },
          rightPriceScale: { borderColor: 'rgba(19, 33, 39, 0.1)' },
          timeScale: { borderColor: 'rgba(19, 33, 39, 0.1)', timeVisible: false },
          crosshair: { mode: 1 },
        })
        const series = chart.addSeries(CandlestickSeries, {
          upColor: '#16845b',
          downColor: '#df685f',
          borderVisible: false,
          wickUpColor: '#16845b',
          wickDownColor: '#df685f',
        })
        chartSeries = series
        chartRef.current = chart
        seriesRef.current = series
        series.setData(candles)
        markersRef.current = createSeriesMarkers(series)
        chart.timeScale().fitContent()
        chart.subscribeCrosshairMove((event) => {
          if (!event.point || typeof event.time !== 'number') {
            setMarkerTooltip(null)
            return
          }
          const events = markerEventsRef.current.get(event.time)
          if (!events?.length) {
            setMarkerTooltip(null)
            return
          }
          const width = container.clientWidth
          const height = container.clientHeight
          setMarkerTooltip({
            x: Math.min(Math.max(event.point.x + 12, 8), Math.max(8, width - 290)),
            y: Math.min(Math.max(event.point.y + 12, 8), Math.max(8, height - 170)),
            time: event.time,
            events,
          })
        })

        resizeObserver = new ResizeObserver(() => {
          const { width, height } = container.getBoundingClientRect()
          if (width > 0 && height > 0) {
            chart?.applyOptions({ width: Math.floor(width), height: Math.floor(height) })
          }
        })
        resizeObserver.observe(container)
        setChartInstance((current) => current + 1)
        window.setTimeout(() => {
          const pendingControls = pendingControlsRef.current.splice(0)
          pendingControls.forEach((control) => {
            window.dispatchEvent(new CustomEvent('luna-chart-control', { detail: control }))
          })
        }, 0)
      } catch {
        if (active) {
          setError('Unable to render the price chart.')
          setCandles([])
        }
      }
    }

    void renderChart()

    return () => {
      active = false
      resizeObserver?.disconnect()
      pendingControlsRef.current = []
      clearTechnicalLines(chart, chartSeries, priceLines, trendSeries)
      chartRef.current = null
      seriesRef.current = null
      markersRef.current = null
      markerTimesByDateRef.current = new Map()
      setMarkerTooltip(null)
      chart?.remove()
    }
  }, [candles])

  useEffect(() => {
    const markerData = buildChartMarkers(candles, insiderTrades, ratings)
    markerEventsRef.current = markerData.eventsByTime
    markerTimesByDateRef.current = markerData.timeByDate
    markersRef.current?.setMarkers(markerData.markers)
  }, [chartInstance, candles, insiderTrades, ratings])

  useEffect(() => {
    const applyChartControl = async (control: ChartControl) => {
      const chart = chartRef.current
      if (control.action === 'CLEAR_LINES') {
        clearTechnicalLines(chart, seriesRef.current, priceLinesRef.current, trendSeriesRef.current)
        return
      }
      if (!chart) return

      try {
        if (control.action === 'ZOOM_TO_RANGE') {
          chart.timeScale().setVisibleRange({ from: control.start, to: control.end })
          return
        }

        if (control.action === 'ADD_PRICE_LINE') {
          const series = seriesRef.current
          if (!series) return
          const line = series.createPriceLine({
            price: control.price,
            color: control.color,
            title: control.title,
            lineStyle: 2,
            axisLabelVisible: true,
          })
          priceLinesRef.current.push(line)
          return
        }

        if (control.action === 'ADD_TREND_LINE') {
          const { LineSeries, LineStyle } = await import('lightweight-charts')
          if (chartRef.current !== chart) return
          const trendSeries = chart.addSeries(LineSeries, {
            color: control.color,
            lineWidth: 2,
            lineStyle: LineStyle.LargeDashed,
          })
          trendSeriesRef.current.push(trendSeries)
          trendSeries.setData(control.data)
          return
        }

        const targetTime = toUtcDay(control.date)
        if (targetTime === null) return
        const candleTime = markerTimesByDateRef.current.get(control.date)
          ?? resolveCandleTime(targetTime, candles.map((candle) => Number(candle.time)))
        if (candleTime === null) return

        const candle = candles.find((item) => Number(item.time) === Number(candleTime))
        if (!candle) return
        const center = new Date(Number(candleTime) * 1000)
        const start = new Date(center.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
        const end = new Date(center.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
        chart.timeScale().setVisibleRange({ from: start, to: end })
        if (seriesRef.current) chart.setCrosshairPosition(candle.close, candleTime as UTCTimestamp, seriesRef.current)
      } catch (controlError) {
        console.warn('[price-chart] Could not apply chart control:', controlError)
      }
    }

    const handleChartControl = (event: Event) => {
      const control = readChartControl((event as CustomEvent<unknown>).detail)
      if (!control) return
      if (!chartRef.current) {
        if (control.action === 'CLEAR_LINES') pendingControlsRef.current = []
        else if (pendingControlsRef.current.length < 20) pendingControlsRef.current.push(control)
        return
      }
      controlExecutionRef.current = controlExecutionRef.current
        .then(() => applyChartControl(control))
        .catch((controlError: unknown) => {
          console.warn('[price-chart] Could not apply chart control:', controlError)
        })
    }

    window.addEventListener('luna-chart-control', handleChartControl)
    return () => window.removeEventListener('luna-chart-control', handleChartControl)
  }, [candles])

  return (
    <section className="luna-price-chart" aria-label={`${ticker} six-month price chart`}>
      <div className="luna-price-chart-heading">
        <div>
          <p>MARKET DATA · 6 MONTHS</p>
          <h2>{ticker} Price History</h2>
        </div>
        <span>DAILY · {currency}</span>
      </div>
      {sampleMessage && (
        <p className="luna-chart-sample-notice" role="status">
          SIMULATED PREVIEW · NOT REAL PRICES — {sampleMessage}
        </p>
      )}
      {loading && <div className="luna-chart-state" role="status">Loading price history…</div>}
      {!loading && error && <div className="luna-chart-state luna-chart-error" role="status">{error}</div>}
      <div ref={containerRef} className="luna-price-chart-canvas" hidden={loading || Boolean(error)}>
        {markerTooltip && (
          <div
            className="luna-chart-marker-tooltip"
            role="tooltip"
            style={{ left: markerTooltip.x, top: markerTooltip.y }}
          >
            <strong>{formatMarkerDate(markerTooltip.time)}</strong>
            {markerTooltip.events.map((event, index) => (
              <span key={`${event.type}-${event.name}-${index}`}>
                <b>{event.type === 'Insider transaction' ? `Insider: ${event.name}` : `Analyst: ${event.name}`}</b>
                <br />
                {event.detail}
              </span>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
