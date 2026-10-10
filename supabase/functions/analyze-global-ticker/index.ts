import { createBackendClient, requireAuthenticatedUser } from '../_shared/supabase.ts'
import { errorResponse, handleOptions, ok, readJson } from '../_shared/response.ts'

type SourceReference = {
  ref: string
  record_id: string
  source_type: string
  title: string
  published_at: string | null
  url: string | null
}

type AnalysisOutput = {
  sentiment: 'Bullish' | 'Bearish' | 'Neutral'
  executive_summary: string
  key_findings: string[]
  sec_filings_analysis: string
  financial_metrics: Array<{
    metric: string
    value: string
    change_percent: string | null
    source_refs: string[]
  }>
  risk_assessment: Array<{
    risk: string
    details: string
    severity: 'High' | 'Moderate' | 'Low'
    source_refs: string[]
  }>
  catalysts: string[]
  conclusion: string
}

const newsExtractors = ['finviz-news-table', 'yahoo_finance_rss', 'bing_news_rss', 'google_news_rss']

const reportSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['sentiment', 'executive_summary', 'key_findings', 'sec_filings_analysis', 'financial_metrics', 'risk_assessment', 'catalysts', 'conclusion'],
  properties: {
    sentiment: { type: 'string', enum: ['Bullish', 'Bearish', 'Neutral'] },
    executive_summary: { type: 'string' },
    key_findings: { type: 'array', items: { type: 'string' } },
    sec_filings_analysis: { type: 'string' },
    financial_metrics: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['metric', 'value', 'change_percent', 'source_refs'],
        properties: {
          metric: { type: 'string' },
          value: { type: 'string' },
          change_percent: { type: ['string', 'null'] },
          source_refs: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    risk_assessment: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['risk', 'details', 'severity', 'source_refs'],
        properties: {
          risk: { type: 'string' },
          details: { type: 'string' },
          severity: { type: 'string', enum: ['High', 'Moderate', 'Low'] },
          source_refs: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    catalysts: { type: 'array', items: { type: 'string' } },
    conclusion: { type: 'string' },
  },
}

const systemPrompt = `You are an institutional equity research analyst. Produce a source-grounded due diligence report using only the evidence in the user message.

Mandatory sections are represented by the required JSON fields: executive_summary, sec_filings_analysis, financial_metrics, risk_assessment, catalysts, and conclusion. A bibliography is assembled by the server from the exact source records provided.

Evidence and accuracy rules:
- Never invent financial values, dates, percentage changes, filing contents, analyst views, insider activity, or causal explanations.
- Financial metrics may only repeat values explicitly present in the supplied Finviz snapshot. Preserve their units and label them accurately. Do not recalculate a percentage change unless both the starting and ending values and their periods are explicitly supplied; if no supported change exists, use null.
- Leave financial_metrics empty: the server fills that table directly from the stored snapshot so each displayed value remains verifiable. Keep financial numerals and percentages out of prose fields.
- Cite every factual finding with its source reference key exactly as supplied, in square brackets (for example [SEC-1] or [MKT-1]). Each financial metric and risk must also include its applicable source_refs. Do not create reference keys.
- Distinguish facts from interpretation, state the data date where available, and disclose when evidence is missing or conflicting.
- Discuss the actual SEC forms and document titles present in the evidence; do not assume a filing exists. If no filings were provided, say so explicitly.
- Keep risk severity proportional to the evidence. Do not turn absence of data into proof of safety or risk.
- If the evidence is sparse, explicitly state that the conclusion is limited. Never fill gaps with general market knowledge.
- Write concise, professional institutional prose. Avoid generic quadrant summaries and unsupported investment recommendations.`

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown, maxLength = 1800): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function getOutputText(value: unknown): string | null {
  const response = record(value)
  if (typeof response.output_text === 'string') return response.output_text
  if (!Array.isArray(response.output)) return null
  for (const output of response.output) {
    const content = record(output).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      const outputPart = record(part)
      if (outputPart.type === 'output_text' && typeof outputPart.text === 'string') return outputPart.text
    }
  }
  return null
}

function newestTimestamp(values: Array<string | null | undefined>): string | null {
  const valid = values.filter((value): value is string => Boolean(value) && !Number.isNaN(Date.parse(value as string)))
  if (valid.length === 0) return null
  return valid.reduce((newest, value) => Date.parse(value) > Date.parse(newest) ? value : newest)
}

function cleanRefs(refs: string[], validRefs: Set<string>): string[] {
  return [...new Set(refs.filter((ref) => validRefs.has(ref)))]
}

function getFiniteMetric(value: unknown): string | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const normalized = String(value).trim()
  return normalized && Number.isFinite(Number(normalized)) ? normalized : null
}

function buildFinancialMetrics(snapshot: Record<string, unknown> | null): AnalysisOutput['financial_metrics'] {
  if (!snapshot) return []
  const metrics: AnalysisOutput['financial_metrics'] = []
  const add = (field: string, metric: string, unit: string, changePercent: string | null = null) => {
    const value = getFiniteMetric(snapshot[field])
    if (value !== null) metrics.push({ metric, value: `${value}${unit}`, change_percent: changePercent, source_refs: ['MKT-1'] })
  }
  add('price', 'Latest price', ' USD')
  const dailyMove = getFiniteMetric(snapshot.change_value)
  const dailyChange = getFiniteMetric(snapshot.change_pct)
  if (dailyMove !== null || dailyChange !== null) {
    metrics.push({
      metric: 'Daily price movement',
      value: dailyMove === null ? 'Not provided' : `${dailyMove} USD`,
      change_percent: dailyChange === null ? null : `${dailyChange}%`,
      source_refs: ['MKT-1'],
    })
  }
  add('market_cap', 'Market capitalization', ' USD')
  add('pe', 'P/E ratio', '')
  add('forward_pe', 'Forward P/E ratio', '')
  add('eps_growth', 'EPS growth', '%')
  add('sales_growth', 'Sales growth', '%')
  add('beta', 'Beta', '')
  add('high_52w', '52-week high', ' USD')
  add('low_52w', '52-week low', ' USD')
  add('insider_ownership', 'Insider ownership', '%')
  add('institutional_ownership', 'Institutional ownership', '%')
  return metrics
}

function validateCitationKeys(value: string, validRefs: Set<string>): string {
  return value.replace(/\[([A-Z]+-\d+)\]/g, (match, ref: string) => validRefs.has(ref) ? match : '[citation unavailable]')
}

function validateAnalysis(value: unknown): value is AnalysisOutput {
  const result = record(value)
  const sentiments = ['Bullish', 'Bearish', 'Neutral']
  if (!sentiments.includes(String(result.sentiment))) return null
  if (typeof result.executive_summary !== 'string' || typeof result.sec_filings_analysis !== 'string' || typeof result.conclusion !== 'string') return null
  if (!Array.isArray(result.key_findings) || !Array.isArray(result.financial_metrics) || !Array.isArray(result.risk_assessment) || !Array.isArray(result.catalysts)) return null
  const stringsOnly = (values: unknown[]) => values.every((entry) => typeof entry === 'string')
  if (!stringsOnly(result.key_findings) || !stringsOnly(result.catalysts)) return null
  if (!result.financial_metrics.every((entry) => {
    const item = record(entry)
    return typeof item.metric === 'string' && typeof item.value === 'string' &&
      (typeof item.change_percent === 'string' || item.change_percent === null) &&
      Array.isArray(item.source_refs) && stringsOnly(item.source_refs)
  })) return null
  if (!result.risk_assessment.every((entry) => {
    const item = record(entry)
    return typeof item.risk === 'string' && typeof item.details === 'string' &&
      ['High', 'Moderate', 'Low'].includes(String(item.severity)) &&
      Array.isArray(item.source_refs) && stringsOnly(item.source_refs)
  })) return null
  return true
}

Deno.serve(async (request) => {
  const optionsResponse = handleOptions(request)
  if (optionsResponse) return optionsResponse
  if (request.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'Use POST', 405, request)

  try {
    await requireAuthenticatedUser(request)
  } catch (error) {
    const code = error instanceof Error ? error.message : ''
    if (code === 'BACKEND_CONFIG_MISSING') return errorResponse(code, 'Supabase backend configuration is missing.', 500, request)
    return errorResponse('UNAUTHORIZED', 'A valid Supabase access token is required to generate a report.', 401, request)
  }

  try {
    const body = await readJson(request)
    const ticker = typeof body?.ticker === 'string' ? body.ticker.trim().toUpperCase() : ''
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker)) {
      return errorResponse('INVALID_TICKER', 'ticker must be a valid symbol such as NVDA.', 400, request)
    }
    const since = typeof body?.since === 'string' ? body.since : null
    if (since && Number.isNaN(Date.parse(since))) return errorResponse('INVALID_SINCE', 'since must be a valid date.', 400, request)

    const client = createBackendClient('service_role')
    const [filingsResult, newsResult, ratingsResult, insidersResult, snapshotResult] = await Promise.all([
      client.from('scraped_items').select('id,title,content,url,published_at,scraped_at,metadata').eq('ticker', ticker).eq('metadata->>source', 'SEC').order('scraped_at', { ascending: false }).limit(30),
      client.from('scraped_items').select('id,title,content,url,published_at,scraped_at,metadata').eq('ticker', ticker).eq('item_type', 'news').in('metadata->>extractor', newsExtractors).order('scraped_at', { ascending: false }).limit(30),
      client.from('finviz_analyst_ratings').select('id,rating_date,action,analyst,rating_change,price_target_change,scraped_at').eq('ticker', ticker).order('rating_date', { ascending: false }).limit(20),
      client.from('finviz_insider_trades').select('id,insider_name,relationship,transaction_date,transaction,cost,shares,value,shares_total,sec_form4_url,scraped_at').eq('ticker', ticker).order('transaction_date', { ascending: false }).limit(20),
      client.from('finviz_market_data').select('id,price,change_value,change_pct,volume,avg_volume,market_cap,pe,forward_pe,eps_growth,sales_growth,beta,high_52w,low_52w,insider_ownership,institutional_ownership,source,updated_at').eq('ticker', ticker).order('updated_at', { ascending: false }).limit(1).maybeSingle(),
    ])

    const queryError = filingsResult.error ?? newsResult.error ?? ratingsResult.error ?? insidersResult.error ?? snapshotResult.error
    if (queryError) {
      console.error(JSON.stringify({ event: 'global_analysis_data_query_failed', ticker, error: queryError.message }))
      return errorResponse('DATABASE_QUERY_FAILED', 'Could not load the source data required for this report.', 500, request)
    }

    const filings = filingsResult.data ?? []
    const news = newsResult.data ?? []
    const ratings = ratingsResult.data ?? []
    const insiderTrades = insidersResult.data ?? []
    const snapshot = snapshotResult.data
    const latestDataAt = newestTimestamp([
      ...filings.map((item) => item.scraped_at),
      ...news.map((item) => item.scraped_at),
      ...ratings.map((item) => item.scraped_at),
      ...insiderTrades.map((item) => item.scraped_at),
      snapshot?.updated_at,
    ])
    const hasNewData = !since || (latestDataAt !== null && Date.parse(latestDataAt) > Date.parse(since))

    if (body?.check_only === true) return ok({ ticker, has_new_data: hasNewData }, request)
    if (since && !hasNewData) return ok({ ticker, unchanged: true, has_new_data: false }, request)

    const bibliography: SourceReference[] = []
    const filingEvidence = filings.map((item, index) => {
      const ref = `SEC-${index + 1}`
      bibliography.push({ ref, record_id: item.id, source_type: 'SEC filing', title: text(item.title, 300) || 'SEC filing', published_at: item.published_at, url: getString(item.url) })
      return {
        ref,
        title: text(item.title, 300),
        published_at: item.published_at,
        url: item.url,
        content: text(item.content, 3500),
        metadata: record(item.metadata),
      }
    })
    const newsEvidence = news.map((item, index) => {
      const ref = `NEWS-${index + 1}`
      bibliography.push({ ref, record_id: item.id, source_type: 'Market news', title: text(item.title, 300) || 'Market news article', published_at: item.published_at, url: getString(item.url) })
      return { ref, title: text(item.title, 300), published_at: item.published_at, url: item.url, excerpt: text(item.content, 1000) }
    })
    const ratingEvidence = ratings.map((item, index) => {
      const ref = `RATING-${index + 1}`
      bibliography.push({ ref, record_id: item.id, source_type: 'Analyst rating', title: `${text(item.analyst, 160) || 'Analyst'} — ${text(item.action, 160) || 'Rating update'}`, published_at: item.rating_date, url: null })
      return { ref, ...item }
    })
    const insiderEvidence = insiderTrades.map((item, index) => {
      const ref = `INSIDER-${index + 1}`
      bibliography.push({ ref, record_id: item.id, source_type: 'Insider transaction', title: `${text(item.insider_name, 160) || 'Insider'} — ${text(item.transaction, 160) || 'Transaction'}`, published_at: item.transaction_date, url: getString(item.sec_form4_url) })
      return { ref, ...item }
    })
    let marketEvidence: Record<string, unknown> | null = null
    if (snapshot) {
      const ref = 'MKT-1'
      bibliography.push({ ref, record_id: snapshot.id, source_type: 'Finviz market snapshot', title: `${ticker} market data snapshot`, published_at: snapshot.updated_at, url: null })
      marketEvidence = { ref, ...snapshot }
    }

    const apiKey = Deno.env.get('OPENAI_API_KEY')
    if (!apiKey) {
      console.error(JSON.stringify({ event: 'global_analysis_openai_not_configured', ticker }))
      return errorResponse('AI_PROVIDER_NOT_CONFIGURED', 'The report-generation provider is not configured.', 500, request)
    }
    const model = Deno.env.get('AI_MODEL') || 'gpt-5.6-terra'
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 60000)
    let aiResponse: Response
    try {
      const payload: Record<string, unknown> = {
        model,
        input: `${systemPrompt}\n\nTICKER: ${ticker}\nDATA AS OF: ${latestDataAt ?? 'unknown'}\n\nSOURCE EVIDENCE:\n${JSON.stringify({
          sec_filings: filingEvidence,
          market_metrics: marketEvidence,
          insider_transactions: insiderEvidence,
          analyst_ratings: ratingEvidence,
          market_news: newsEvidence,
        })}`,
        text: { format: { type: 'json_schema', name: 'institutional_due_diligence_report', strict: true, schema: reportSchema } },
      }
      const reasoningEffort = Deno.env.get('AI_REASONING_EFFORT')
      if (reasoningEffort) payload.reasoning = { effort: reasoningEffort }
      aiResponse = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeoutId)
    }
    const aiPayload: unknown = await aiResponse.json().catch(() => null)
    if (!aiResponse.ok) {
      const providerStatus = aiResponse.status
      console.error(JSON.stringify({ event: 'global_analysis_provider_failed', ticker, status: providerStatus }))
      return errorResponse('AI_PROVIDER_ERROR', 'The report-generation provider could not complete the report.', providerStatus === 429 ? 429 : 502, request)
    }
    const outputText = getOutputText(aiPayload)
    if (!outputText) return errorResponse('AI_INVALID_RESPONSE', 'The report provider returned no structured report.', 502, request)
    let parsed: unknown
    try {
      parsed = JSON.parse(outputText) as unknown
    } catch {
      return errorResponse('AI_INVALID_RESPONSE', 'The report provider returned invalid structured data.', 502, request)
    }
    if (!validateAnalysis(parsed)) return errorResponse('AI_INVALID_RESPONSE', 'The report did not match the required report structure.', 502, request)
    const analysis = parsed

    const validRefs = new Set(bibliography.map((source) => source.ref))
    analysis.executive_summary = validateCitationKeys(analysis.executive_summary, validRefs)
    analysis.key_findings = analysis.key_findings.map((finding) => validateCitationKeys(finding, validRefs))
    analysis.sec_filings_analysis = validateCitationKeys(analysis.sec_filings_analysis, validRefs)
    analysis.catalysts = analysis.catalysts.map((catalyst) => validateCitationKeys(catalyst, validRefs))
    analysis.conclusion = validateCitationKeys(analysis.conclusion, validRefs)
    analysis.financial_metrics = buildFinancialMetrics(marketEvidence)
    analysis.risk_assessment = analysis.risk_assessment
      .map((risk) => ({
        ...risk,
        risk: validateCitationKeys(risk.risk, validRefs),
        details: validateCitationKeys(risk.details, validRefs),
        source_refs: cleanRefs(risk.source_refs, validRefs),
      }))
      .filter((risk) => risk.source_refs.length > 0)
    const result = {
      ticker,
      analysis,
      bibliography,
      generated_at: new Date().toISOString(),
      data_counts: {
        news: news.length,
        sec_filings: filings.length,
        insider_trades: insiderTrades.length,
        analyst_ratings: ratings.length,
      },
    }
    console.info(JSON.stringify({ event: 'global_analysis_generated', ticker, model, data_counts: result.data_counts, bibliography_count: bibliography.length }))
    return ok(result, request)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return errorResponse('AI_PROVIDER_TIMEOUT', 'The report-generation provider timed out.', 504, request)
    }
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error(JSON.stringify({ event: 'global_analysis_failed', error: message }))
    return errorResponse('GLOBAL_ANALYSIS_FAILED', 'Could not generate the market report.', 500, request)
  }
})
