import { useState } from 'react'
import { Activity, LoaderCircle, Trash2 } from 'lucide-react'
import type { PriceChartCandle } from './PriceChart'
import { supabase } from '../lib/supabase'

type TechnicalChartCommand = {
  action: 'ADD_PRICE_LINE'
  price: number
  title: string
  color: string
}

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

function parseTechnicalAnalysis(value: unknown): TechnicalAnalysisResponse | null {
  if (!isRecord(value) || typeof value.mini_brief !== 'string' || !Array.isArray(value.commands)) return null
  const miniBrief = value.mini_brief.trim()
  if (!miniBrief || miniBrief.length > 600) return null

  const commands: TechnicalChartCommand[] = []
  let targetPrice: number | null = null
  let supportLevels = 0
  let resistanceOrPivotLevels = 0
  for (const valueCommand of value.commands) {
    if (
      !isRecord(valueCommand) ||
      valueCommand.action !== 'ADD_PRICE_LINE' ||
      typeof valueCommand.color !== 'string' ||
      !CHART_COLOR_PATTERN.test(valueCommand.color) ||
      typeof valueCommand.price !== 'number' ||
      !Number.isFinite(valueCommand.price) ||
      valueCommand.price <= 0 ||
      typeof valueCommand.title !== 'string' ||
      valueCommand.title.trim().length === 0 ||
      valueCommand.title.length > 80
    ) return null

    const title = valueCommand.title.trim()
    const normalizedTitle = title.toLowerCase()
    const color = valueCommand.color.toLowerCase()
    if (
      normalizedTitle === 'target price' &&
      targetPrice === null &&
      ['#eab308', '#a855f7'].includes(color)
    ) {
      targetPrice = valueCommand.price
    } else if (normalizedTitle === 'support' && color === '#22c55e') {
      supportLevels += 1
    } else if (normalizedTitle === 'resistance' && color === '#ef4444') {
      resistanceOrPivotLevels += 1
    } else if (normalizedTitle === 'pivot' && ['#ef4444', '#64748b'].includes(color)) {
      resistanceOrPivotLevels += 1
    } else {
      return null
    }
    commands.push({ action: 'ADD_PRICE_LINE', price: valueCommand.price, title, color: valueCommand.color })
  }

  if (
    commands.length < 3 ||
    commands.length > 5 ||
    new Set(commands.map((command) => command.price)).size !== commands.length ||
    targetPrice === null ||
    supportLevels < 1 ||
    supportLevels > 2 ||
    resistanceOrPivotLevels < 1 ||
    resistanceOrPivotLevels > 2 ||
    !/\btarget price\b/i.test(miniBrief)
  ) return null
  const statedTarget = miniBrief.match(/\btarget price\b.{0,40}?\$?\s*([\d,]+(?:\.\d+)?)/i)?.[1]
  if (!statedTarget || Math.abs(Number(statedTarget.replace(/,/g, '')) - targetPrice) > Math.max(targetPrice * 0.015, 0.02)) return null
  return { mini_brief: miniBrief.split(/\r?\n/).slice(0, 3).join('\n'), commands }
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
        Analyze recent price action and plot key horizontal target, support, and resistance levels.
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
      {loading && <p className="technical-copilot-status" role="status">Evaluating target, support, resistance, and volatility levels…</p>}
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
            {analysis.commands.length} horizontal {analysis.commands.length === 1 ? 'level' : 'levels'} applied
          </span>
        </section>
      )}
      <p className="technical-copilot-disclaimer">Quantitative context only. Not investment advice.</p>
      <img
        className="mascot-overlay"
        src="https://i.postimg.cc/VNjWnrk9/Topo-de-marketing-con-laptop.png"
        alt="Norvexai market analysis assistant"
      />
    </aside>
  )
}
