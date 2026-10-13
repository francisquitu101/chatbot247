import { useState } from 'react'
import { Activity, LoaderCircle, Trash2 } from 'lucide-react'
import type { PriceChartCandle } from './PriceChart'
import { supabase } from '../lib/supabase'

type TechnicalChartCommand =
  | { action: 'ADD_PRICE_LINE'; price: number; title: string; color: string }
  | { action: 'ADD_TREND_LINE'; data: Array<{ time: string; value: number }>; color: string }

type TechnicalAnalysisResponse = {
  mini_brief: string
  commands: TechnicalChartCommand[]
}

type TechnicalCopilotPanelProps = {
  ticker: string
  candles: PriceChartCandle[]
  authenticated: boolean
}

const CHART_COLOR_PATTERN = /^#(?:[\da-f]{3}|[\da-f]{6})$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function parseTechnicalAnalysis(value: unknown): TechnicalAnalysisResponse | null {
  if (!isRecord(value) || typeof value.mini_brief !== 'string' || !Array.isArray(value.commands)) return null
  const miniBrief = value.mini_brief.trim()
  if (!miniBrief || miniBrief.length > 600) return null

  const commands: TechnicalChartCommand[] = []
  for (const valueCommand of value.commands) {
    if (!isRecord(valueCommand) || typeof valueCommand.color !== 'string' || !CHART_COLOR_PATTERN.test(valueCommand.color)) return null
    if (
      valueCommand.action === 'ADD_PRICE_LINE' &&
      typeof valueCommand.price === 'number' &&
      Number.isFinite(valueCommand.price) &&
      valueCommand.price > 0 &&
      typeof valueCommand.title === 'string' &&
      valueCommand.title.trim().length > 0 &&
      valueCommand.title.length <= 80
    ) {
      commands.push({
        action: 'ADD_PRICE_LINE',
        price: valueCommand.price,
        title: valueCommand.title.trim(),
        color: valueCommand.color,
      })
      continue
    }
    if (valueCommand.action === 'ADD_TREND_LINE' && Array.isArray(valueCommand.data) && valueCommand.data.length >= 2 && valueCommand.data.length <= 20) {
      const data: Array<{ time: string; value: number }> = []
      for (const valuePoint of valueCommand.data) {
        if (!isRecord(valuePoint) || !isIsoDate(valuePoint.time) || typeof valuePoint.value !== 'number' || !Number.isFinite(valuePoint.value) || valuePoint.value <= 0) return null
        data.push({ time: valuePoint.time, value: valuePoint.value })
      }
      if (data.some((point, index) => index > 0 && data[index - 1].time >= point.time)) return null
      commands.push({ action: 'ADD_TREND_LINE', data, color: valueCommand.color })
      continue
    }
    return null
  }

  return commands.length <= 6 ? { mini_brief: miniBrief.split(/\r?\n/).slice(0, 3).join('\n'), commands } : null
}

function toIsoDate(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().slice(0, 10)
}

export function TechnicalCopilotPanel({ ticker, candles, authenticated }: TechnicalCopilotPanelProps) {
  const [analysis, setAnalysis] = useState<TechnicalAnalysisResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function analyzeChart() {
    if (loading) return
    if (!authenticated) {
      setError('Sign in to run technical analysis.')
      return
    }
    if (!supabase) {
      setError('The Supabase client is not configured; technical analysis is unavailable.')
      return
    }
    if (candles.length < 20) {
      setError('At least 20 valid price candles are required for technical analysis.')
      return
    }

    setLoading(true)
    setError(null)
    try {
      const { data: response, error: invokeError } = await supabase.functions.invoke<{
        success: boolean
        data?: unknown
        error?: { message?: string }
      }>('analyze-chart-technicals', {
        body: {
          ticker,
          ohlc: candles.slice(-180).map((candle) => ({
            time: toIsoDate(candle.time),
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
          })),
        },
      })
      if (invokeError) throw invokeError
      if (!response?.success) throw new Error(response?.error?.message ?? 'The technical analysis request failed.')
      const parsed = parseTechnicalAnalysis(response.data)
      if (!parsed) throw new Error('The analysis service returned an invalid technical report.')

      setAnalysis(parsed)
      window.dispatchEvent(new CustomEvent('luna-chart-control', { detail: { action: 'CLEAR_LINES' } }))
      parsed.commands.forEach((command) => {
        window.dispatchEvent(new CustomEvent('luna-chart-control', { detail: command }))
      })
    } catch (analysisError) {
      const message = analysisError instanceof Error ? analysisError.message : 'Unable to analyze this price chart.'
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  function clearLines() {
    window.dispatchEvent(new CustomEvent('luna-chart-control', { detail: { action: 'CLEAR_LINES' } }))
    setAnalysis(null)
  }

  const dateRange = candles.length > 0
    ? `${toIsoDate(candles[0].time)} — ${toIsoDate(candles[candles.length - 1].time)}`
    : 'Waiting for price history'

  return (
    <aside className="technical-copilot-panel" aria-label={`${ticker} technical analysis copilot`}>
      <div className="technical-copilot-heading">
        <span className="technical-copilot-icon"><Activity size={17} /></span>
        <div>
          <span>QUANTITATIVE TOOLS</span>
          <h2>Technical Copilot</h2>
        </div>
      </div>
      <p className="technical-copilot-description">
        Analyze recent price action and plot source-based support, resistance, and trend lines.
      </p>
      <div className="technical-copilot-coverage">
        <span>{ticker} · {candles.length} sessions</span>
        <span>{dateRange}</span>
      </div>
      <button
        type="button"
        className="technical-copilot-button"
        onClick={() => void analyzeChart()}
        disabled={!authenticated || !supabase || loading || candles.length < 20}
      >
        {loading ? <LoaderCircle size={15} className="spinning" /> : <Activity size={15} />}
        {loading ? 'Scanning price action…' : 'Analyze Chart'}
      </button>
      {!authenticated && <p className="technical-copilot-hint">Sign in to run technical analysis.</p>}
      {authenticated && !supabase && <p className="technical-copilot-error" role="alert">Supabase is not configured.</p>}
      {loading && <p className="technical-copilot-status" role="status">Evaluating support, resistance, and trend structure…</p>}
      {error && <p className="technical-copilot-error" role="alert">{error}</p>}
      {analysis && (
        <section className="technical-copilot-result" aria-live="polite">
          <div className="technical-copilot-result-heading">
            <h3>Price Action Brief</h3>
            <button type="button" onClick={clearLines} aria-label="Clear technical chart lines" title="Clear technical chart lines">
              <Trash2 size={14} />
            </button>
          </div>
          <p>{analysis.mini_brief}</p>
          <span className="technical-copilot-command-count">
            {analysis.commands.length} chart {analysis.commands.length === 1 ? 'overlay' : 'overlays'} applied
          </span>
        </section>
      )}
      <p className="technical-copilot-disclaimer">Quantitative context only. Not investment advice.</p>
      <img
        className="mascot-overlay"
        src="https://i.postimg.cc/VNjWnrk9/Topo-de-marketing-con-laptop.png"
        alt="MarketMole mascot with a laptop"
      />
    </aside>
  )
}
