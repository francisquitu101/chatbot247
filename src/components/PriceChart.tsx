import { useEffect, useRef, useState } from 'react'
import type { CandlestickData, IChartApi, UTCTimestamp } from 'lightweight-charts'
import { supabase } from '../lib/supabase'

type ChartCandle = {
  time: number
  open: number
  high: number
  low: number
  close: number
}

type ChartPayload = {
  candles: ChartCandle[]
  currency: string
}

export function PriceChart({ ticker }: { ticker: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [candles, setCandles] = useState<CandlestickData<UTCTimestamp>[]>([])
  const [currency, setCurrency] = useState('USD')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    setCandles([])

    const loadChart = async () => {
      if (!supabase) {
        if (active) {
          setError('Price history is unavailable because Supabase is not configured.')
          setLoading(false)
        }
        return
      }

      const { data, error: invokeError } = await supabase.functions.invoke<{
        success: boolean
        data?: ChartPayload
        error?: { message?: string }
      }>('stock-chart', { body: { ticker } })
      if (!active) return
      if (invokeError || data?.success !== true || !Array.isArray(data.data?.candles)) {
        setError(data?.error?.message ?? invokeError?.message ?? 'Unable to load price history.')
        setLoading(false)
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
      if (parsedCandles.length === 0) setError('No price history is available for this ticker.')
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
    let resizeObserver: ResizeObserver | null = null
    const renderChart = async () => {
      try {
        const { CandlestickSeries, ColorType, createChart } = await import('lightweight-charts')
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
        series.setData(candles)
        chart.timeScale().fitContent()

        resizeObserver = new ResizeObserver(() => {
          chart?.applyOptions({ width: container.clientWidth, height: container.clientHeight })
        })
        resizeObserver.observe(container)
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
      chart?.remove()
    }
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
      {loading && <div className="luna-chart-state" role="status">Loading price history…</div>}
      {!loading && error && <div className="luna-chart-state luna-chart-error" role="status">{error}</div>}
      <div ref={containerRef} className="luna-price-chart-canvas" hidden={loading || Boolean(error)} />
    </section>
  )
}
