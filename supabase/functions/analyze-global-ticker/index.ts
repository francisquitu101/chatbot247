import { createBackendClient, requireAuthenticatedUser } from '../_shared/supabase.ts'
import { errorResponse, handleOptions, ok, readJson } from '../_shared/response.ts'

type SourceReference = {
  ref: string
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
        required: ['metric', 'value'],
        properties: {
          metric: { type: 'string' },
          value: { type: 'string' },
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

const systemPrompt = `You are MarketMole's institutional equity research analyst. Write in an authoritative, proprietary research voice: state conclusions directly (for example, "Our analysis indicates..." or "Key performance indicators show..."). Never describe how information was gathered or refer to the source bundle as supplied evidence.

Mandatory sections are represented by the required JSON fields: executive_summary, sec_filings_analysis, financial_metrics, risk_assessment, catalysts, and conclusion. A numbered bibliography is assembled by the server from the exact source records used.

Evidence and accuracy rules:
- Never invent financial values, dates, percentage changes, filing contents, analyst views, insider activity, or causal explanations.
- Never mention Finviz, SeekingAlpha, scraping, extraction, a supplied evidence bundle, missing documents, or complain that an annual report or other filing was not provided. Do not expose data-provider names in the report narrative.
- When the records contain Form 4 filings or insider transactions without periodic financial statements, analyze the disclosed insider activity directly: identify the transaction type, reported shares/value where available, and whether activity is buying, selling, or mixed. Do not apologize for the absence of other filings.
- The server fills financial_metrics directly from the stored market snapshot. Return financial_metrics as an empty array. The rendered table has exactly two columns (Metric | Value); do not add change, evidence, or citation columns and do not place citations in metric values.
- Cite factual statements in narrative sections using only the plain numeric bibliography references provided, formatted exactly as [1], [2]. Never use source-type prefixes, invent references, or add references to financial_metrics.
- Write facts and interpretation in a confident, professional house voice. State material limitations as analytical scope (for example, "The assessment focuses on disclosed insider activity") rather than as process complaints.
- Keep risk severity proportional to the records and do not infer safety or risk from absent data. Never fill gaps with general market knowledge.
- Write concise institutional prose and avoid generic quadrant summaries or unsupported investment recommendations.`

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
  const add = (field: string, metric: string, unit: string) => {
    const value = getFiniteMetric(snapshot[field])
    if (value !== null) metrics.push({ metric, value: `${value}${unit}` })
  }
  add('price', 'Latest price', ' USD')
  const dailyMove = getFiniteMetric(snapshot.change_value)
  const dailyChange = getFiniteMetric(snapshot.change_pct)
  if (dailyMove !== null || dailyChange !== null) {
    metrics.push({
      metric: dailyChange !== null ? 'Daily price change' : 'Daily price movement',
      value: dailyChange !== null ? `${dailyChange}%` : `${dailyMove} USD`,
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
  return value.replace(/\[(\d+)\]/g, (match, ref: string) => validRefs.has(ref) ? match : '')
}

function validateAnalysis(value: unknown): value is AnalysisOutput {
  const result = record(value)
  const sentiments = ['Bullish', 'Bearish', 'Neutral']
  if (!sentiments.includes(String(result.sentiment))) return false
  if (typeof result.executive_summary !== 'string' || typeof result.sec_filings_analysis !== 'string' || typeof result.conclusion !== 'string') return false
  if (!Array.isArray(result.key_findings) || !Array.isArray(result.financial_metrics) || !Array.isArray(result.risk_assessment) || !Array.isArray(result.catalysts)) return false
  const stringsOnly = (values: unknown[]) => values.every((entry) => typeof entry === 'string')
  if (!stringsOnly(result.key_findings) || !stringsOnly(result.catalysts)) return false
  if (!result.financial_metrics.every((entry) => {
    const item = record(entry)
    return typeof item.metric === 'string' && typeof item.value === 'string'
  })) return false
  if (!result.risk_assessment.every((entry) => {
    const item = record(entry)
    return typeof item.risk === 'string' && typeof item.details === 'string' &&
      ['High', 'Moderate', 'Low'].includes(String(item.severity)) &&
      Array.isArray(item.source_refs) && stringsOnly(item.source_refs)
  })) return false
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
      client.from('scraped_items').select('title,content,url,published_at,scraped_at,metadata').eq('ticker', ticker).eq('metadata->>source', 'SEC').order('scraped_at', { ascending: false }).limit(30),
      client.from('scraped_items').select('title,content,url,published_at,scraped_at,metadata').eq('ticker', ticker).eq('item_type', 'news').in('metadata->>extractor', newsExtractors).order('scraped_at', { ascending: false }).limit(30),
      client.from('finviz_analyst_ratings').select('rating_date,action,analyst,rating_change,price_target_change,scraped_at').eq('ticker', ticker).order('rating_date', { ascending: false }).limit(20),
      client.from('finviz_insider_trades').select('insider_name,relationship,transaction_date,transaction,cost,shares,value,shares_total,sec_form4_url,scraped_at').eq('ticker', ticker).order('transaction_date', { ascending: false }).limit(20),
      client.from('finviz_market_data').select('price,change_value,change_pct,volume,avg_volume,market_cap,pe,forward_pe,eps_growth,sales_growth,beta,high_52w,low_52w,insider_ownership,institutional_ownership,updated_at').eq('ticker', ticker).order('updated_at', { ascending: false }).limit(1).maybeSingle(),
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
    const addBibliographyEntry = (title: string, published_at: string | null, url: string | null) => {
      const ref = String(bibliography.length + 1)
      bibliography.push({ ref, title, published_at, url })
      return ref
    }
    const filingEvidence = filings.map((item) => {
      const ref = addBibliographyEntry(text(item.title, 300) || 'SEC filing', item.published_at, getString(item.url))
      return {
        ref,
        title: text(item.title, 300),
        published_at: item.published_at,
        url: item.url,
        content: text(item.content, 3500),
        metadata: record(item.metadata),
      }
    })
    const newsEvidence = news.map((item) => {
      const ref = addBibliographyEntry(text(item.title, 300) || 'Market news article', item.published_at, getString(item.url))
      return { ref, title: text(item.title, 300), published_at: item.published_at, url: item.url, excerpt: text(item.content, 1000) }
    })
    const ratingEvidence = ratings.map((item) => {
      const ref = addBibliographyEntry(`${text(item.analyst, 160) || 'Analyst'} — ${text(item.action, 160) || 'Rating update'}`, item.rating_date, null)
      return { ref, ...item }
    })
    const insiderEvidence = insiderTrades.map((item) => {
      const ref = addBibliographyEntry(`${text(item.insider_name, 160) || 'Insider'} — ${text(item.transaction, 160) || 'Transaction'}`, item.transaction_date, getString(item.sec_form4_url))
      return { ref, ...item }
    })
    let marketEvidence: Record<string, unknown> | null = null
    if (snapshot) {
      const ref = addBibliographyEntry(`${ticker} market data snapshot`, snapshot.updated_at, null)
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
    analysis.risk_assessment = analysis.risk_assessment.map((risk) => {
      const sourceRefs = cleanRefs(risk.source_refs, validRefs)
      const details = validateCitationKeys(risk.details, validRefs)
      const missingCitations = sourceRefs.filter((ref) => !details.includes(`[${ref}]`))
      return {
        ...risk,
        risk: validateCitationKeys(risk.risk, validRefs),
        details: missingCitations.length > 0 ? `${details} ${missingCitations.map((ref) => `[${ref}]`).join(' ')}` : details,
        source_refs: sourceRefs,
      }
    })
    analysis.risk_assessment = analysis.risk_assessment.filter((risk) => risk.source_refs.length > 0)
    analysis.financial_metrics = buildFinancialMetrics(marketEvidence)
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
    const { error: persistError } = await client
      .from('global_ticker_analysis_reports')
      .upsert({
        ticker,
        analysis: result.analysis,
        bibliography: result.bibliography,
        generated_at: result.generated_at,
        data_counts: result.data_counts,
      }, { onConflict: 'ticker' })
    if (persistError) {
      console.error(JSON.stringify({ event: 'global_analysis_persistence_failed', ticker, error: persistError.message }))
      return errorResponse('REPORT_PERSISTENCE_FAILED', 'The report was generated but could not be saved. Please try again.', 500, request)
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
