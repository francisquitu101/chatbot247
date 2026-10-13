import { errorResponse, handleOptions, ok, readJson } from '../_shared/response.ts'
import { requireAuthenticatedUser } from '../_shared/supabase.ts'

type Candle = {
  time: string
  open: number
  high: number
  low: number
  close: number
}

type TechnicalCommand =
  { action: 'ADD_PRICE_LINE'; price: number; title: string; color: string }

const MAX_CANDLES = 180
const MIN_PRICE_LEVELS = 3
const MAX_PRICE_LEVELS = 5
const COLOR_PATTERN = /^#(?:[\da-f]{3}|[\da-f]{6})$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function parseCandles(value: unknown): Candle[] | null {
  if (!Array.isArray(value) || value.length < 20 || value.length > MAX_CANDLES) return null
  const candles: Candle[] = []
  for (const valueCandle of value) {
    if (!isRecord(valueCandle)) return null
    const time = valueCandle.time
    const open = valueCandle.open
    const high = valueCandle.high
    const low = valueCandle.low
    const close = valueCandle.close
    if (!isIsoDate(time)) return null
    if (![open, high, low, close].every((price) => typeof price === 'number' && Number.isFinite(price) && price > 0)) return null
    if (typeof open !== 'number' || typeof high !== 'number' || typeof low !== 'number' || typeof close !== 'number') return null
    if (
      high < Math.max(open, close, low) ||
      low > Math.min(open, close, high) ||
      (candles.length > 0 && candles[candles.length - 1].time >= time)
    ) return null
    candles.push({
      time,
      open,
      high,
      low,
      close,
    })
  }
  return candles
}

function parseAnalysis(value: unknown, candles: Candle[]): { mini_brief: string; commands: TechnicalCommand[] } | null {
  if (!isRecord(value) || typeof value.mini_brief !== 'string' || !Array.isArray(value.commands)) return null
  const rawBrief = value.mini_brief.trim()
  if (!rawBrief || rawBrief.length > 600) return null
  const miniBrief = rawBrief.split(/\r?\n/).slice(0, 3).join('\n')
  const minPrice = Math.min(...candles.map((candle) => candle.low)) * 0.75
  const maxPrice = Math.max(...candles.map((candle) => candle.high)) * 1.25
  const commands: TechnicalCommand[] = []
  let targetPrice: number | null = null
  let supportLevels = 0
  let resistanceOrPivotLevels = 0

  for (const valueCommand of value.commands) {
    if (
      !isRecord(valueCommand) ||
      valueCommand.action !== 'ADD_PRICE_LINE' ||
      typeof valueCommand.color !== 'string' ||
      !COLOR_PATTERN.test(valueCommand.color) ||
      typeof valueCommand.price !== 'number' ||
      !Number.isFinite(valueCommand.price) ||
      valueCommand.price < minPrice ||
      valueCommand.price > maxPrice ||
      typeof valueCommand.title !== 'string' ||
      valueCommand.title.trim().length === 0 ||
      valueCommand.title.length > 80
    ) return null

    const title = valueCommand.title.trim()
    const normalizedTitle = title.toLowerCase()
    const color = valueCommand.color.toLowerCase()
    if (normalizedTitle === 'target price') {
      if (targetPrice !== null || !['#eab308', '#a855f7'].includes(color)) return null
      targetPrice = valueCommand.price
    } else if (normalizedTitle === 'support') {
      if (color !== '#22c55e') return null
      supportLevels += 1
    } else if (normalizedTitle === 'resistance') {
      if (color !== '#ef4444') return null
      resistanceOrPivotLevels += 1
    } else if (normalizedTitle === 'pivot') {
      if (!['#ef4444', '#64748b'].includes(color)) return null
      resistanceOrPivotLevels += 1
    } else {
      return null
    }
    commands.push({ action: 'ADD_PRICE_LINE', price: valueCommand.price, title, color: valueCommand.color })
  }

  if (
    commands.length < MIN_PRICE_LEVELS ||
    commands.length > MAX_PRICE_LEVELS ||
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
  return { mini_brief: miniBrief, commands }
}

const responseSchema = {
  type: 'object',
  properties: {
    mini_brief: { type: 'string' },
    commands: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['ADD_PRICE_LINE'] },
          price: { type: 'number' },
          title: { type: 'string' },
          color: { type: 'string' },
        },
        required: ['action', 'price', 'title', 'color'],
        additionalProperties: false,
      },
    },
  },
  required: ['mini_brief', 'commands'],
  additionalProperties: false,
}

Deno.serve(async (request) => {
  const optionsResponse = handleOptions(request)
  if (optionsResponse) return optionsResponse
  if (request.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'Use POST to analyze price history.', 405, request)

  try {
    await requireAuthenticatedUser(request)
    const body = await readJson(request)
    if (!body) return errorResponse('INVALID_REQUEST', 'A JSON request body is required.', 400, request)
    if (typeof body.ticker !== 'string' || !/^[A-Z0-9.-]{1,12}$/i.test(body.ticker.trim())) {
      return errorResponse('INVALID_TICKER', 'Provide a valid stock ticker.', 400, request)
    }
    const candles = parseCandles(body.ohlc)
    if (!candles) {
      return errorResponse('INVALID_PRICE_HISTORY', `Provide between 20 and ${MAX_CANDLES} valid, chronological OHLC candles.`, 400, request)
    }

    const apiKey = Deno.env.get('OPENAI_API_KEY')
    if (!apiKey) return errorResponse('OPENAI_API_KEY_NOT_CONFIGURED', 'OPENAI_API_KEY is not configured as an Edge Function secret.', 500, request)

    const ticker = body.ticker.trim().toUpperCase()
    const openAiResponse = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: Deno.env.get('AI_MODEL') ?? 'gpt-4.1-mini',
        input: [
          {
            role: 'system',
            content: [{
              type: 'input_text',
              text: `You are a quantitative technical analyst. Analyze only the supplied chronological daily OHLC prices for ${ticker}. Return exclusively ADD_PRICE_LINE commands for horizontal price levels and no other chart actions. Return 3 to 5 distinct, actionable levels grounded in the supplied price action: exactly one "Target Price" in gold #eab308, 1 to 2 "Support" levels in green #22c55e, and 1 to 2 "Resistance" levels in red #ef4444 or "Pivot" levels in red #ef4444 or gray #64748b. First calculate 14-session average true range (ATR). Calculate a short-term Target Price from the latest close adjusted by approximately 1 to 1.5 ATR in the direction supported by recent price structure. Select support from recent swing lows and resistance/pivots from observed swing highs or repeated turning levels. Do not use external information, invent levels, or claim certainty. The mini_brief must be no more than three lines and explicitly state "Target Price $<number>" matching the Target Price command, with concise justification from recent structure and volatility/ATR. Prices must be positive, within the supplied observed range, and distinct. Return strictly the required JSON schema.`,
            }],
          },
          {
            role: 'user',
            content: [{ type: 'input_text', text: JSON.stringify({ ticker, ohlc: candles }) }],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'technical_chart_analysis',
            strict: true,
            schema: responseSchema,
          },
        },
        max_output_tokens: 1200,
        store: false,
      }),
      signal: AbortSignal.timeout(30000),
    })

    if (!openAiResponse.ok) {
      console.error(JSON.stringify({ event: 'technical_analysis_provider_failed', status: openAiResponse.status }))
      return errorResponse('AI_PROVIDER_ERROR', 'The technical analysis provider could not complete the request.', 502, request)
    }

    let providerPayload: unknown
    try {
      providerPayload = await openAiResponse.json()
    } catch {
      return errorResponse('AI_INVALID_RESPONSE', 'The technical analysis provider returned malformed JSON.', 502, request)
    }
    if (!isRecord(providerPayload) || !Array.isArray(providerPayload.output)) {
      return errorResponse('AI_INVALID_RESPONSE', 'The technical analysis provider returned an invalid response.', 502, request)
    }
    const outputText = providerPayload.output
      .filter(isRecord)
      .flatMap((item) => Array.isArray(item.content) ? item.content : [])
      .filter(isRecord)
      .find((item) => item.type === 'output_text' && typeof item.text === 'string')?.text
    if (typeof outputText !== 'string') {
      return errorResponse('AI_INVALID_RESPONSE', 'The technical analysis provider returned no structured report.', 502, request)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(outputText)
    } catch {
      return errorResponse('AI_INVALID_RESPONSE', 'The technical analysis provider returned malformed JSON.', 502, request)
    }
    const analysis = parseAnalysis(parsed, candles)
    if (!analysis) return errorResponse('AI_INVALID_RESPONSE', 'The technical analysis provider returned invalid or unsupported chart commands.', 502, request)
    return ok(analysis, request)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'UNKNOWN_ERROR'
    if (message === 'AUTHORIZATION_REQUIRED' || message === 'INVALID_ACCESS_TOKEN') {
      return errorResponse(message, 'Sign in to run technical analysis.', 401, request)
    }
    if (message === 'BACKEND_CONFIG_MISSING') {
      return errorResponse(message, 'Supabase backend secrets are not configured.', 500, request)
    }
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      return errorResponse('AI_PROVIDER_TIMEOUT', 'Technical analysis timed out. Please try again.', 504, request)
    }
    console.error('[analyze-chart-technicals] Request failed:', error)
    return errorResponse('TECHNICAL_ANALYSIS_FAILED', 'Unable to complete technical analysis.', 500, request)
  }
})
