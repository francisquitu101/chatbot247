import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { ArrowRight, Brain, ChartColumnIncreasing, Chrome, Crown, Download, ExternalLink, FileText, FolderOpen, LogOut, Newspaper, Plus, RefreshCw, Star, TrendingUp } from 'lucide-react'
import { Navbar } from '../components/Navbar'
import { PriceChart } from '../components/PriceChart'
import { GlobalAnalysisReport, type GlobalTickerAnalysis } from '../components/GlobalAnalysisReport'
import { getPrivateAnalystByTicker, getPublicAnalystByTicker } from '../lib/analystData'
import { getFinvizCompanyInsiderTrades, getFinvizCompanyNews, getFinvizCompanyRatings, getLatestTerminalActivity, getSecCompanyFilings, type TerminalActivityEvent } from '../lib/queries/company'
import { getAuthRedirectUrl, getUserWatchlist, supabase, updateWatchlist } from '../lib/supabase'

const DEMO_PATTERNS = [/\[DEMO SEEDED\]/i, /demo_seed/i, /synthetic_test/i, /demo seed/i, /synthetic/i, /development test/i]

function isDemoArtifact(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return DEMO_PATTERNS.some((pattern) => pattern.test(value))
}

function cleanupDisplayText(value: string | null | undefined): string {
  if (!value) return '—'
  const trimmed = value.trim()
  return isDemoArtifact(trimmed) ? '—' : trimmed
}

function formatFinvizTimestamp(value: string | null | undefined) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/New_York',
    timeZoneName: 'short',
  }).format(date).replace(',', ' ·')
}

function formatTerminalTimestamp(value: string | null | undefined) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)
}

function formatFilingDate(value: string | null | undefined) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(date)
}

function getStatusLabel(processingStatus: string | undefined | null) {
  const normalized = (processingStatus ?? 'idle').toLowerCase()
  if (normalized.includes('error')) return 'ERROR'
  if (normalized.includes('process') || normalized.includes('analyz') || normalized.includes('read') || normalized.includes('search') || normalized.includes('updat') || normalized.includes('queue')) return 'PROCESSING'
  return ''
}

function getRealEvidence(
  list: Array<{
    id?: string | null
    title?: string | null
    summary?: string | null
    source_type?: string | null
    source_url?: string | null
    published_at?: string | null
    raw_metadata?: Record<string, unknown> | null
  }> | undefined | null,
) {
  return (list ?? []).filter((item) => {
    if (!item) return false
    const combined = [item.title, item.summary, item.source_type, item.source_url].filter((value): value is string => typeof value === 'string')
    return combined.length === 0 || !combined.some((value) => isDemoArtifact(value))
  })
}

function readText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function getPayPalCheckoutUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    const hostname = url.hostname.toLowerCase()
    const isPayPalHost = hostname === 'paypal.com' || hostname.endsWith('.paypal.com')
    return url.protocol === 'https:' && isPayPalHost ? url : null
  } catch {
    return null
  }
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  if (error && typeof error === 'object') {
    const errorFields = error as Record<string, unknown>
    const errorCode = typeof errorFields.code === 'string' ? errorFields.code : ''
    const errorDetails = [errorFields.message, errorFields.details]
      .filter((value): value is string => typeof value === 'string')
      .join(' ')
      .toLowerCase()
    if (
      errorCode === '42501'
      || errorCode === '42883'
      || errorCode === 'PGRST202'
      || errorDetails.includes('permission denied for table scraped_items')
      || errorDetails.includes('get_public_finviz_news')
    ) {
      return 'Apply Supabase migration 20261009160000_cache_news_briefs_and_multisource_terminal.sql to enable the public news feed.'
    }
    const details = ['message', 'details', 'hint', 'code']
      .map((field) => errorFields[field])
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
    if (details.length > 0) return details.join(' · ')
  }
  return fallback
}

type AnalystApp = 'chart' | 'sec' | 'insider' | 'ratings' | 'news' | 'analysis'

type TickerExtractionState = {
  status: 'running' | 'complete' | 'error'
  step: number
  message?: string
}

const EMPTY_STATE_COPY: Record<Exclude<AnalystApp, 'chart'>, string> = {
  sec: 'No SEC filings available for',
  insider: 'No insider trading records found for',
  ratings: 'No recent analyst ratings for',
  news: 'No recent market news aggregated for',
  analysis: 'Market analysis not yet initialized for',
}

const EMPTY_STATE_DESCRIPTION = 'No records are currently available for this source and ticker.'

type NewsBriefing =
  | { status: 'loading' }
  | { status: 'success'; summary: string }
  | { status: 'irrelevant' }
  | { status: 'error' }

type GlobalAnalysisFreshness = {
  ticker: string
  has_new_data?: boolean
  unchanged?: boolean
}

async function getFunctionErrorMessage(error: unknown): Promise<string> {
  if (error && typeof error === 'object' && 'context' in error) {
    const context = error.context
    if (context instanceof Response) {
      const payload: unknown = await context.clone().json().catch(() => null)
      if (payload && typeof payload === 'object' && 'error' in payload) {
        const errorPayload = payload.error
        if (errorPayload && typeof errorPayload === 'object' && 'message' in errorPayload && typeof errorPayload.message === 'string') {
          return errorPayload.message
        }
      }
    }
  }
  return getErrorMessage(error, 'The Edge Function request failed.')
}

function getExternalHttpUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

function DataLoadingState({ ticker }: { ticker: string }) {
  return (
    <div className="luna-data-loading" role="status" aria-live="polite">
      <RefreshCw size={18} className="spinning" aria-hidden="true" />
      <span>Loading verified data for {ticker}...</span>
    </div>
  )
}

function DataEmptyState({
  ticker,
  emptyMessage,
  errorMessage,
}: {
  ticker: string
  emptyMessage: string
  errorMessage?: string | null
}) {
  return (
    <div className="luna-data-empty" role={errorMessage ? 'alert' : 'status'}>
      <strong>{errorMessage ? 'Data source unavailable' : `${emptyMessage} ${ticker}.`}</strong>
      <span>{errorMessage ?? EMPTY_STATE_DESCRIPTION}</span>
    </div>
  )
}

function getFilingType(evidence: { title?: string | null; raw_metadata?: Record<string, unknown> | null } | null): string | null {
  if (!evidence) return null
  const metadata = evidence.raw_metadata
  const rawForm = metadata?.form ?? metadata?.form_type ?? metadata?.formType
  if (typeof rawForm === 'string' && rawForm.trim()) return rawForm.trim().toUpperCase()
  const titleMatch = evidence.title?.match(/\b(?:FORM\s*)?([0-9][A-Z]?\/?A?)\b/i)
  return titleMatch?.[1]?.toUpperCase() ?? null
}

export function AnalystExperienceDisplay({
  ticker,
  privateView = false,
  session,
  onSignOut,
}: {
  ticker?: string
  privateView?: boolean
  session?: Session | null
  onSignOut?: () => void
}) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)
  const [authBusy, setAuthBusy] = useState(false)
  const [isPro, setIsPro] = useState<boolean | null>(null)
  const [profileLoadError, setProfileLoadError] = useState<string | null>(null)
  const [checkoutBusy, setCheckoutBusy] = useState(false)
  const [checkoutError, setCheckoutError] = useState<string | null>(null)
  const [enqueueBusy, setEnqueueBusy] = useState(false)
  const [enqueueMessage, setEnqueueMessage] = useState<string | null>(null)
  const [enqueueError, setEnqueueError] = useState<string | null>(null)
  const [globalAnalysis, setGlobalAnalysis] = useState<GlobalTickerAnalysis | null>(null)
  const [globalAnalysisBusy, setGlobalAnalysisBusy] = useState(false)
  const [globalAnalysisError, setGlobalAnalysisError] = useState<string | null>(null)
  const [globalAnalysisHasUpdates, setGlobalAnalysisHasUpdates] = useState<boolean | null>(null)
  const [globalAnalysisChecking, setGlobalAnalysisChecking] = useState(false)
  const globalAnalysisTicker = globalAnalysis?.ticker
  const globalAnalysisGeneratedAt = globalAnalysis?.generated_at
  const [activeApp, setActiveApp] = useState<AnalystApp>('sec')
  const [briefingArticleId, setBriefingArticleId] = useState<string | null>(null)
  const [newsBriefings, setNewsBriefings] = useState<Record<string, NewsBriefing>>({})
  const [data, setData] = useState<Awaited<ReturnType<typeof getPublicAnalystByTicker>> | null>(null)
  const [loadedTicker, setLoadedTicker] = useState<string | null>(null)
  const [secFilings, setSecFilings] = useState<Awaited<ReturnType<typeof getSecCompanyFilings>>>([])
  const [finvizRatings, setFinvizRatings] = useState<Awaited<ReturnType<typeof getFinvizCompanyRatings>>>([])
  const [finvizInsiderTrades, setFinvizInsiderTrades] = useState<Awaited<ReturnType<typeof getFinvizCompanyInsiderTrades>>>([])
  const [finvizNews, setFinvizNews] = useState<Awaited<ReturnType<typeof getFinvizCompanyNews>>>([])
  const [feedLoading, setFeedLoading] = useState({ sec: true, insider: true, ratings: true, news: true })
  const [feedErrors, setFeedErrors] = useState<{ sec: string | null; insider: string | null; ratings: string | null; news: string | null }>({
    sec: null,
    insider: null,
    ratings: null,
    news: null,
  })
  const [terminalHistory, setTerminalHistory] = useState<Record<string, TerminalActivityEvent[]>>({})
  const [terminalActivityErrors, setTerminalActivityErrors] = useState<string[]>([])
  const [tickerExtraction, setTickerExtraction] = useState<Record<string, TickerExtractionState>>({})
  const [watchlist, setWatchlist] = useState<string[]>([(ticker ?? 'NVDA').toUpperCase()])
  const [watchlistInput, setWatchlistInput] = useState('')
  const [watchlistMessage, setWatchlistMessage] = useState<string | null>(null)
  const [watchlistOwner, setWatchlistOwner] = useState<string | null>(null)
  const loadedWatchlistKeyRef = useRef<string | null>(null)
  const refreshTickerDataRef = useRef<((tickerToRefresh: string) => Promise<void>) | null>(null)
  const tickerScanTimeoutsRef = useRef<Record<string, number[]>>({})
  const tickerScanIntervalsRef = useRef<Record<string, number[]>>({})
  const tickerScanIdsRef = useRef<Record<string, number>>({})
  const tickerScanFinishedIdsRef = useRef<Record<string, number>>({})
  const tickerScanSequenceRef = useRef(0)

  const [activeTicker, setActiveTicker] = useState((ticker ?? 'NVDA').toUpperCase())
  const activeTickerRef = useRef(activeTicker)
  activeTickerRef.current = activeTicker
  const sessionUserId = session?.user.id ?? null
  const watchlistStorageKey = sessionUserId ? `marketmole-watchlist:${sessionUserId}` : 'marketmole-watchlist:guest'

  useEffect(() => () => {
    Object.values(tickerScanTimeoutsRef.current).flat().forEach((timeoutId) => window.clearTimeout(timeoutId))
    Object.values(tickerScanIntervalsRef.current).flat().forEach((intervalId) => window.clearInterval(intervalId))
  }, [])

  useEffect(() => {
    Object.entries(tickerScanIntervalsRef.current).forEach(([ticker, intervalIds]) => {
      if (ticker === activeTicker) return
      intervalIds.forEach((intervalId) => window.clearInterval(intervalId))
      tickerScanIntervalsRef.current[ticker] = []
    })
  }, [activeTicker])

  useEffect(() => {
    const nextTicker = (ticker ?? 'NVDA').trim().toUpperCase()
    setActiveTicker(nextTicker)
  }, [ticker])

  useEffect(() => {
    if (loadedWatchlistKeyRef.current === watchlistStorageKey) return
    let nextWatchlist: string[] = [(ticker ?? 'NVDA').trim().toUpperCase()]
    try {
      const storedValue: unknown = JSON.parse(localStorage.getItem(watchlistStorageKey) ?? 'null')
      if (Array.isArray(storedValue)) {
        const validTickers = storedValue
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.trim().toUpperCase())
          .filter((value) => /^[A-Z0-9.^=-]{1,20}$/.test(value))
        if (validTickers.length > 0) nextWatchlist = [...new Set(validTickers)].slice(0, 10)
      }
    } catch {
      setWatchlistMessage('Could not load your saved watchlist.')
    }
    loadedWatchlistKeyRef.current = watchlistStorageKey
    setWatchlist(nextWatchlist)
    setActiveTicker((current) => nextWatchlist.includes(current) ? current : nextWatchlist[0])
    setWatchlistOwner(watchlistStorageKey)
  }, [watchlistStorageKey, ticker])

  useEffect(() => {
    if (watchlistOwner !== watchlistStorageKey) return
    try {
      localStorage.setItem(watchlistStorageKey, JSON.stringify(watchlist))
    } catch {
      setWatchlistMessage('Could not save your watchlist in this browser.')
    }
  }, [watchlist, watchlistOwner, watchlistStorageKey])

  useEffect(() => {
    const client = supabase
    if (!sessionUserId || !client || watchlistOwner !== watchlistStorageKey) return

    let isActive = true
    const syncWatchlist = async () => {
      try {
        const serverTickers = await getUserWatchlist(sessionUserId)
        const localValue: unknown = JSON.parse(localStorage.getItem(watchlistStorageKey) ?? 'null')
        const localTickers = Array.isArray(localValue)
          ? localValue
            .filter((value): value is string => typeof value === 'string')
            .map((value) => value.trim().toUpperCase())
            .filter((value) => /^[A-Z0-9.^=-]{1,20}$/.test(value))
          : []
        const mergedWatchlist = [...new Set([...serverTickers, ...localTickers])].slice(0, 10)
        const missingTickers = mergedWatchlist.filter((value) => !serverTickers.includes(value))

        if (missingTickers.length > 0) {
          const { data: authData, error: authError } = await client.auth.getSession()
          if (authError) throw authError
          const accessToken = authData.session?.access_token
          if (!accessToken) throw new Error('A valid session is required to sync your watchlist.')
          for (const value of missingTickers) {
            if (!isActive) return
            await updateWatchlist('enable', value, accessToken)
          }
        }

        if (isActive) setWatchlist(mergedWatchlist)
      } catch (syncError) {
        if (!isActive) return
        console.warn('[watchlist] Account sync failed:', syncError)
        setWatchlistMessage('Could not sync your account watchlist. Your browser copy is still available.')
      }
    }

    void syncWatchlist()
    return () => { isActive = false }
  }, [sessionUserId, watchlistOwner, watchlistStorageKey])

  useEffect(() => {
    if ((!session || isPro === false) && watchlist.length > 1) {
      const reducedWatchlist = [activeTicker]
      setWatchlist(reducedWatchlist)
      setWatchlistOwner(watchlistStorageKey)
    }
  }, [activeTicker, isPro, session, watchlist, watchlistStorageKey])

  useEffect(() => {
    if (!sessionUserId || !supabase) {
      setIsPro(null)
      setProfileLoadError(null)
      return
    }

    const client = supabase
    let active = true
    let checkoutRefreshes = 0
    const loadProfile = async () => {
      const { data: profile, error: queryError } = await client
        .from('profiles')
        .select('is_pro')
        .eq('id', sessionUserId)
        .maybeSingle()
      if (!active) return
      if (queryError) {
        setIsPro(null)
        setProfileLoadError('Unable to check your Pro subscription.')
        return
      }
      setIsPro(profile?.is_pro === true)
      setProfileLoadError(null)
    }

    void loadProfile()
    window.addEventListener('focus', loadProfile)
    const isCheckoutReturn = window.location.pathname.replace(/\/+$/, '') === '/checkout/success'
    let refreshInterval: number | undefined
    if (isCheckoutReturn) {
      refreshInterval = window.setInterval(() => {
          checkoutRefreshes += 1
          void loadProfile()
          if (checkoutRefreshes >= 24 && refreshInterval !== undefined) window.clearInterval(refreshInterval)
        }, 5_000)
    }

    return () => {
      active = false
      window.removeEventListener('focus', loadProfile)
      if (refreshInterval !== undefined) window.clearInterval(refreshInterval)
    }
  }, [sessionUserId])

  const appendTerminalEvents = useCallback((eventTicker: string, events: TerminalActivityEvent[]) => {
    if (events.length === 0) return
    setTerminalHistory((current) => {
      const existing = current[eventTicker] ?? []
      const knownIds = new Set(existing.map((event) => event.id))
      const additions = events.filter((event) => !knownIds.has(event.id))
      if (additions.length === 0) return current
      return {
        ...current,
        [eventTicker]: [...existing, ...additions]
          .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
          .slice(-200),
      }
    })
  }, [])

  const appendTerminalLog = useCallback((eventTicker: string, message: string) => {
    appendTerminalEvents(eventTicker, [{
      id: `${eventTicker}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: new Date().toISOString(),
      message,
    }])
  }, [appendTerminalEvents])

  async function handleUpgradeToPro() {
    if (!supabase || !session || checkoutBusy) return
    setCheckoutBusy(true)
    setCheckoutError(null)
    try {
      const { data: response, error: invokeError } = await supabase.functions.invoke<{
        success: boolean
        data?: { approval_url?: unknown }
      }>('create-checkout', { body: {} })
      if (invokeError) throw invokeError
      const checkoutUrl = response?.success ? getPayPalCheckoutUrl(response.data?.approval_url) : null
      if (!checkoutUrl) throw new Error('The payment provider returned an invalid checkout link.')
      window.location.assign(checkoutUrl.toString())
    } catch (error) {
      setCheckoutError(getErrorMessage(error, 'Unable to start checkout. Please try again.'))
      setCheckoutBusy(false)
    }
  }

  function handleWatchlistSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextTicker = watchlistInput.trim().toUpperCase()
    if (!/^[A-Z0-9.^=-]{1,20}$/.test(nextTicker)) {
      setWatchlistMessage('Enter a valid stock ticker.')
      return
    }
    if (watchlist.includes(nextTicker)) {
      setWatchlistMessage(`${nextTicker} is already in your watchlist.`)
      return
    }
    const limit = session && isPro === true ? 10 : 1
    if (watchlist.length >= limit) {
      setWatchlistMessage(limit === 1
        ? 'Upgrade to Pro to add up to 10 tickers.'
        : 'Your Pro watchlist supports up to 10 tickers.')
      return
    }
    setWatchlist((current) => [...current, nextTicker])
    setWatchlistInput('')
    setWatchlistMessage(null)
    setActiveTicker(nextTicker)
    const nextPath = `/analyst/${encodeURIComponent(nextTicker)}`
    if (window.location.pathname !== nextPath) {
      window.history.pushState({}, '', nextPath)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }
    void startTickerExtraction(nextTicker)
  }

  async function startTickerExtraction(nextTicker: string) {
    const client = supabase
    appendTerminalLog(nextTicker, `[SYS] Executing immediate deep-scan for ${nextTicker}...`)
    if (!client || !session) {
      appendTerminalLog(nextTicker, '[SYS] Sign in is required before live ticker extraction can start.')
      setTickerExtraction((current) => ({
        ...current,
        [nextTicker]: { status: 'error', step: 0, message: 'Sign in to start data extraction for this ticker.' },
      }))
      return
    }

    for (const timeoutId of tickerScanTimeoutsRef.current[nextTicker] ?? []) window.clearTimeout(timeoutId)
    tickerScanTimeoutsRef.current[nextTicker] = []
    for (const intervalId of tickerScanIntervalsRef.current[nextTicker] ?? []) window.clearInterval(intervalId)
    tickerScanIntervalsRef.current[nextTicker] = []
    const scanId = tickerScanSequenceRef.current + 1
    tickerScanSequenceRef.current = scanId
    tickerScanIdsRef.current[nextTicker] = scanId
    delete tickerScanFinishedIdsRef.current[nextTicker]

    const updateProgress = (step: number) => {
      setTickerExtraction((current) => current[nextTicker]?.status === 'running'
        ? { ...current, [nextTicker]: { status: 'running', step } }
        : current)
    }
    const refreshTickerData = async () => {
      const refresh = refreshTickerDataRef.current
      if (!refresh) throw new Error('Ticker data refresh is not ready.')
      await refresh(nextTicker)
    }
    const schedule = (delayMs: number, callback: () => void) => {
      const timeoutId = window.setTimeout(() => {
        tickerScanTimeoutsRef.current[nextTicker] = (tickerScanTimeoutsRef.current[nextTicker] ?? [])
          .filter((scheduledId) => scheduledId !== timeoutId)
        if (tickerScanIdsRef.current[nextTicker] !== scanId) return
        callback()
      }, delayMs)
      tickerScanTimeoutsRef.current[nextTicker].push(timeoutId)
    }
    let scraperRequestsSettled = false
    let scraperSucceeded = false
    let pollInFlight: Promise<void> | null = null
    let pollingInterval: number | null = null
    const stopPolling = () => {
      if (pollingInterval !== null) {
        window.clearInterval(pollingInterval)
        tickerScanIntervalsRef.current[nextTicker] = (tickerScanIntervalsRef.current[nextTicker] ?? [])
          .filter((intervalId) => intervalId !== pollingInterval)
        pollingInterval = null
      }
    }
    const pollForTickerData = async (): Promise<void> => {
      if (pollInFlight || tickerScanIdsRef.current[nextTicker] !== scanId) return pollInFlight ?? undefined
      pollInFlight = (async () => {
        const [scrapedResult, ratingsResult, insiderResult] = await Promise.all([
          client.from('scraped_items').select('id', { count: 'exact', head: true }).eq('ticker', nextTicker),
          client.from('finviz_analyst_ratings').select('id', { count: 'exact', head: true }).eq('ticker', nextTicker),
          client.from('finviz_insider_trades').select('id', { count: 'exact', head: true }).eq('ticker', nextTicker),
        ])
        const queryError = [scrapedResult.error, ratingsResult.error, insiderResult.error].find(Boolean)
        if (queryError) throw queryError
        const hasTickerData = [scrapedResult.count, ratingsResult.count, insiderResult.count]
          .some((count) => (count ?? 0) > 0)
        if (!hasTickerData && !scraperRequestsSettled) return

        stopPolling()
        tickerScanFinishedIdsRef.current[nextTicker] = scanId
        if (activeTickerRef.current === nextTicker) await refreshTickerData()
        if (tickerScanIdsRef.current[nextTicker] !== scanId) return
        setTickerExtraction((current) => ({
          ...current,
          [nextTicker]: hasTickerData
            ? { status: 'complete', step: 2, message: `Live data for ${nextTicker} is loaded.` }
            : scraperSucceeded
              ? { status: 'complete', step: 2, message: `Scan finished; no new records were found for ${nextTicker}.` }
              : { status: 'error', step: 2, message: `No data could be loaded for ${nextTicker}.` },
        }))
        if (hasTickerData) appendTerminalLog(nextTicker, `[SYS] Live Supabase records detected and loaded for ${nextTicker}.`)
      })().finally(() => {
        pollInFlight = null
      })
      return pollInFlight
    }
    const startPolling = () => {
      if (pollingInterval !== null) return
      pollingInterval = window.setInterval(() => {
        void pollForTickerData().catch((pollError: unknown) => {
          console.warn(`[ticker-scan] ${nextTicker} polling failed:`, pollError)
          const message = getErrorMessage(pollError, 'database query failed')
          appendTerminalLog(nextTicker, `[SYS] Data sync retry failed: ${message}`)
          setTickerExtraction((current) => current[nextTicker]?.status === 'running'
            ? { ...current, [nextTicker]: { status: 'error', step: current[nextTicker].step, message: `Database sync failed: ${message}` } }
            : current)
        })
      }, 3_000)
      tickerScanIntervalsRef.current[nextTicker].push(pollingInterval)
    }
    setTickerExtraction((current) => ({
      ...current,
      [nextTicker]: { status: 'running', step: 0 },
    }))

    try {
      const { data: authData, error: authError } = await client.auth.getSession()
      if (authError) throw authError
      const accessToken = authData.session?.access_token
      if (!accessToken) throw new Error('A valid session is required to enable ticker extraction.')

      const trackedTicker = await updateWatchlist('enable', nextTicker, accessToken)
      if (!trackedTicker) throw new Error(`Could not enable ${nextTicker} for background extraction.`)

      appendTerminalLog(nextTicker, `[SYS] Connecting to SEC EDGAR database for ${nextTicker}...`)
      appendTerminalLog(nextTicker, '[SYS] Scan started in background; checking for new records shortly.')
      schedule(2_000, () => {
        if (tickerScanFinishedIdsRef.current[nextTicker] === scanId) return
        appendTerminalLog(nextTicker, '[SYS] Extracting latest 8-K and 10-Q filings...')
        updateProgress(1)
      })
      schedule(6_000, () => {
        if (tickerScanFinishedIdsRef.current[nextTicker] === scanId) return
        appendTerminalLog(nextTicker, '[SYS] Aggregating market news and insider forms...')
        updateProgress(2)
      })
      startPolling()

      const runScraper = (
        functionName: 'scrape-sec' | 'scrape-finviz',
        sourceLabel: string,
      ) => client.functions.invoke<{
        success: boolean
        error?: { message?: string }
      }>(functionName, { body: { ticker: nextTicker } }).then(({ data: response, error: invokeError }) => {
        if (invokeError) throw invokeError
        if (response?.success !== true) {
          throw new Error(response?.error?.message ?? `${sourceLabel} extraction failed for ${nextTicker}.`)
        }
        appendTerminalLog(nextTicker, `[SYS] ${sourceLabel} extraction finished for ${nextTicker}.`)
        return response
      }).catch((scrapeError: unknown) => {
        console.warn(`[ticker-scan] ${sourceLabel} extraction failed for ${nextTicker}:`, scrapeError)
        appendTerminalLog(nextTicker, `[SYS] ${sourceLabel} extraction failed: ${getErrorMessage(scrapeError, 'request failed')}`)
        throw scrapeError
      })

      const scrapeResults = Promise.allSettled([
        runScraper('scrape-sec', 'SEC'),
        runScraper('scrape-finviz', 'Finviz'),
      ])

      void scrapeResults.then(async (results) => {
        const succeeded = results.filter((result) => result.status === 'fulfilled').length
        scraperSucceeded = succeeded > 0
        scraperRequestsSettled = true
        await pollForTickerData()
        if (tickerScanIdsRef.current[nextTicker] !== scanId || succeeded !== results.length) return

        const { data: enqueueResponse, error: enqueueError } = await client.functions.invoke<{
          success: boolean
          data?: { job_id?: string }
          error?: { message?: string }
        }>('enqueue-sec-analysis', { body: { ticker: nextTicker } })
        if (enqueueError || enqueueResponse?.success !== true || !enqueueResponse.data?.job_id) {
          const detail = enqueueError
            ? getErrorMessage(enqueueError, 'analysis job could not be queued')
            : enqueueResponse?.error?.message ?? 'No analysis job was created.'
          appendTerminalLog(nextTicker, `[SYS] Market data is ready; AI analysis was not queued: ${detail}`)
          return
        }
        appendTerminalLog(nextTicker, '[SYS] AI sentiment analysis queued in the background.')
        void client.functions.invoke<{ success: boolean; error?: { message?: string } }>(
          'process-analyst-job',
          { body: { job_id: enqueueResponse.data.job_id } },
        ).then(({ data: processResponse, error: processError }) => {
          if (processError) throw processError
          if (processResponse?.success !== true) {
            throw new Error(processResponse?.error?.message ?? 'AI analysis worker could not start.')
          }
          appendTerminalLog(nextTicker, '[SYS] AI analysis worker started in the background.')
        }).catch((processError: unknown) => {
          console.warn(`[ticker-scan] AI analysis worker failed for ${nextTicker}:`, processError)
          appendTerminalLog(nextTicker, `[SYS] AI analysis worker failed: ${getErrorMessage(processError, 'request failed')}`)
        })
      }).catch((backgroundError: unknown) => {
        console.warn(`[ticker-scan] Background completion handling failed for ${nextTicker}:`, backgroundError)
        appendTerminalLog(nextTicker, `[SYS] Background completion handling failed: ${getErrorMessage(backgroundError, 'refresh failed')}`)
      })
    } catch (extractionError) {
      const message = getErrorMessage(extractionError, `Unable to extract data for ${nextTicker}.`)
      appendTerminalLog(nextTicker, `[SYS] Extraction failed for ${nextTicker}: ${message}`)
      setTickerExtraction((current) => ({
        ...current,
        [nextTicker]: { status: 'error', step: current[nextTicker]?.step ?? 0, message },
      }))
      setWatchlistMessage(`${nextTicker} extraction failed: ${message}`)
    }
  }

  function handleWatchlistUpgrade() {
    if (session) {
      if (isPro !== true) void handleUpgradeToPro()
      return
    }
    void handleGoogleSignIn()
  }

  async function handleSummarizeNews(articleId: string, articleUrl: string | null, articleTitle: string) {
    setBriefingArticleId(articleId)
    const existingBriefing = newsBriefings[articleId]
    if (existingBriefing?.status === 'loading' || existingBriefing?.status === 'success' || existingBriefing?.status === 'irrelevant') return
    if (!supabase || !articleUrl) {
      setNewsBriefings((current) => ({ ...current, [articleId]: { status: 'error' } }))
      return
    }

    setNewsBriefings((current) => ({ ...current, [articleId]: { status: 'loading' } }))
    try {
      const { data: result, error: invocationError } = await supabase.functions.invoke<{
        success: boolean
        data?: { summary?: string; rejected?: boolean }
      }>('summarize-news', { body: { article_id: articleId, url: articleUrl, title: articleTitle, ticker: activeTicker } })
      if (invocationError) throw invocationError
      if (result?.success === true && result.data?.rejected === true) {
        setNewsBriefings((current) => ({ ...current, [articleId]: { status: 'irrelevant' } }))
        return
      }
      const summary = result?.success === true && typeof result.data?.summary === 'string'
        ? result.data.summary.trim()
        : ''
      if (!summary) throw new Error('Summarization returned no summary.')
      setNewsBriefings((current) => ({ ...current, [articleId]: { status: 'success', summary } }))
    } catch {
      setNewsBriefings((current) => ({ ...current, [articleId]: { status: 'error' } }))
    }
  }

  async function handleGoogleSignIn() {
    if (!supabase) return

    setAuthBusy(true)
    setAuthError(null)

    try {
      const redirectUrl = getAuthRedirectUrl('/analyst/NVDA')
      const result = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: redirectUrl },
      })

      if (result.error) {
        setAuthError(result.error.message)
      }
    } catch (signInError) {
      setAuthError(signInError instanceof Error ? signInError.message : 'Google sign-in failed.')
    } finally {
      setAuthBusy(false)
    }
  }

  async function handleEnqueueAnalysis() {
    if (!supabase || !session || enqueueBusy) return
    setEnqueueBusy(true)
    setEnqueueMessage(null)
    setEnqueueError(null)
    try {
      const { data: response, error: invokeError } = await supabase.functions.invoke<{
        outcome: 'QUEUED' | 'ALREADY_QUEUED'
        filing?: string
      }>('enqueue-sec-analysis', { body: { ticker: activeTicker } })
      if (invokeError) throw invokeError
      if (!response) throw new Error('The enqueue endpoint returned no response.')
      setEnqueueMessage(response.outcome === 'ALREADY_QUEUED'
        ? 'An analysis for the latest SEC filing is already queued.'
        : 'Latest SEC filing queued for durable analysis.')
    } catch (enqueueFailure) {
      setEnqueueError(enqueueFailure instanceof Error ? enqueueFailure.message : 'Unable to queue SEC analysis.')
    } finally {
      setEnqueueBusy(false)
    }
  }

  async function handleGlobalAnalysis() {
    if (!supabase || globalAnalysisBusy || !session) return
    setGlobalAnalysisBusy(true)
    setGlobalAnalysisError(null)
    try {
      const previousAnalysis = globalAnalysis?.ticker === activeTicker ? globalAnalysis : null
      const { data: response, error: invokeError } = await supabase.functions.invoke<{
        success: boolean
        data?: GlobalTickerAnalysis | GlobalAnalysisFreshness
        error?: { message?: string }
      }>('analyze-global-ticker', {
        body: { ticker: activeTicker, ...(previousAnalysis ? { since: previousAnalysis.generated_at } : {}) },
      })
      if (invokeError) throw new Error(await getFunctionErrorMessage(invokeError))
      if (!response?.success || !response.data) {
        throw new Error(response?.error?.message ?? 'The global analysis endpoint returned no analysis.')
      }
      if ('unchanged' in response.data && response.data.unchanged) {
        setGlobalAnalysisHasUpdates(false)
      } else if ('analysis' in response.data) {
        setGlobalAnalysis(response.data)
        setGlobalAnalysisHasUpdates(null)
      } else {
        throw new Error('The global analysis endpoint returned an invalid analysis.')
      }
    } catch (analysisFailure) {
      setGlobalAnalysisError(getErrorMessage(analysisFailure, 'Unable to generate the global ticker analysis.'))
    } finally {
      setGlobalAnalysisBusy(false)
    }
  }

  useEffect(() => {
    if (!supabase || !session || globalAnalysisTicker !== activeTicker || !globalAnalysisGeneratedAt) {
      setGlobalAnalysisHasUpdates(null)
      setGlobalAnalysisChecking(false)
      return
    }

    let isMounted = true
    const client = supabase

    async function checkForNewData() {
      setGlobalAnalysisChecking(true)
      try {
        const { data: response, error: invokeError } = await client.functions.invoke<{
          success: boolean
          data?: GlobalAnalysisFreshness
          error?: { message?: string }
        }>('analyze-global-ticker', {
          body: { ticker: activeTicker, since: globalAnalysisGeneratedAt, check_only: true },
        })
        if (invokeError) throw new Error(await getFunctionErrorMessage(invokeError))
        if (!response?.success || !response.data || typeof response.data.has_new_data !== 'boolean') {
          throw new Error(response?.error?.message ?? 'The market data freshness check returned an invalid response.')
        }
        if (isMounted) setGlobalAnalysisHasUpdates(response.data.has_new_data)
      } catch (freshnessFailure) {
        if (isMounted) {
          setGlobalAnalysisError(getErrorMessage(freshnessFailure, 'Unable to check for new market data.'))
        }
      } finally {
        if (isMounted) setGlobalAnalysisChecking(false)
      }
    }

    void checkForNewData()
    const intervalId = window.setInterval(() => void checkForNewData(), 60_000)
    return () => {
      isMounted = false
      window.clearInterval(intervalId)
    }
  }, [activeTicker, globalAnalysisGeneratedAt, globalAnalysisTicker, session])

  useEffect(() => {
    let isMounted = true
    const tickerToLoad = activeTicker

    if (!supabase) {
      setLoading(false)
      setLoadedTicker(tickerToLoad)
      setError('Supabase configuration is missing. Add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.')
      return () => { isMounted = false }
    }

    const client = supabase

    const isCurrentLoad = () => isMounted && tickerToLoad === activeTickerRef.current
    const setFeedLoadingState = (feed: keyof typeof feedLoading, isLoading: boolean) => {
      if (!isCurrentLoad()) return
      setFeedLoading((current) => ({ ...current, [feed]: isLoading }))
    }
    const setFeedError = (feed: keyof typeof feedErrors, message: string | null) => {
      if (!isCurrentLoad()) return
      setFeedErrors((current) => ({ ...current, [feed]: message }))
    }
    const loadAnalyst = async (tickerForAnalyst = tickerToLoad) => {
      try {
        if (isCurrentLoad()) {
          setLoading(true)
          setError(null)
        }

        const result = privateView
          ? await (async () => {
            const { data: { user }, error: userError } = await client.auth.getUser()
            if (userError) throw userError
            if (!user) throw new Error('No authenticated user found.')
            return getPrivateAnalystByTicker(client, tickerForAnalyst, user.id)
          })()
          : await getPublicAnalystByTicker(client, tickerForAnalyst)

        if (!isCurrentLoad() || tickerForAnalyst !== activeTickerRef.current) return
        setData(result)
      } catch (fetchError) {
        if (!isCurrentLoad() || tickerForAnalyst !== activeTickerRef.current) return
        setError(fetchError instanceof Error ? fetchError.message : 'Unable to load analyst.')
      } finally {
        if (isCurrentLoad() && tickerForAnalyst === activeTickerRef.current) {
          setLoading(false)
        }
      }
    }

    const loadFeed = async <T,>(
      feed: keyof typeof feedErrors,
      fetchFeed: () => Promise<T>,
      setResult: (value: T) => void,
    ) => {
      setFeedLoadingState(feed, true)
      setFeedError(feed, null)
      try {
        const result = await fetchFeed()
        if (isCurrentLoad()) setResult(result)
      } catch (fetchError) {
        const message = getErrorMessage(fetchError, `${feed} data request failed.`)
        console.warn(`[ticker-data] ${tickerToLoad} ${feed} feed failed:`, fetchError)
        setFeedError(feed, message)
      } finally {
        setFeedLoadingState(feed, false)
      }
    }

    const loadAllFeeds = () => Promise.all([
      loadFeed('sec', () => sessionUserId ? getSecCompanyFilings(client, tickerToLoad) : Promise.resolve([]), setSecFilings),
      loadFeed('insider', () => getFinvizCompanyInsiderTrades(client, tickerToLoad), setFinvizInsiderTrades),
      loadFeed('ratings', () => getFinvizCompanyRatings(client, tickerToLoad), setFinvizRatings),
      loadFeed('news', () => getFinvizCompanyNews(client, tickerToLoad), setFinvizNews),
    ]).then(() => undefined)
    const loadAllTickerData = () => Promise.all([loadAnalyst(), loadAllFeeds()]).then(() => undefined)

    refreshTickerDataRef.current = loadAllTickerData
    setData(null)
    setError(null)
    setLoading(true)
    setLoadedTicker(tickerToLoad)
    setSecFilings([])
    setFinvizRatings([])
    setFinvizInsiderTrades([])
    setFinvizNews([])
    setFeedErrors({ sec: null, insider: null, ratings: null, news: null })
    setFeedLoading({ sec: true, insider: true, ratings: true, news: true })

    void loadAllTickerData()

    const channel = client
      .channel(`analyst-live-${activeTicker}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'analyst_state' }, () => { void loadAnalyst() })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'decision_events' }, () => { void loadAnalyst() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'analyst_jobs' }, () => { void loadAnalyst() })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'scraped_items', filter: `ticker=eq.${activeTicker}` }, () => {
        void loadFeed('sec', () => sessionUserId ? getSecCompanyFilings(client, tickerToLoad) : Promise.resolve([]), setSecFilings)
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'finviz_insider_trades', filter: `ticker=eq.${activeTicker}` }, () => {
        void loadFeed('insider', () => getFinvizCompanyInsiderTrades(client, tickerToLoad), setFinvizInsiderTrades)
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'finviz_analyst_ratings', filter: `ticker=eq.${activeTicker}` }, () => {
        void loadFeed('ratings', () => getFinvizCompanyRatings(client, tickerToLoad), setFinvizRatings)
      })
      .subscribe()

    return () => {
      isMounted = false
      refreshTickerDataRef.current = null
      void client.removeChannel(channel)
    }
  }, [activeTicker, privateView, sessionUserId])

  useEffect(() => {
    const client = supabase
    const analystId = data?.analyst.id
    if (!client || !analystId) {
      setTerminalActivityErrors([])
      return
    }

    let isMounted = true
    const refreshTerminalActivity = async () => {
      try {
        const activity = await getLatestTerminalActivity(client, activeTicker, analystId)
        if (!isMounted) return
        appendTerminalEvents(activeTicker, activity.events)
        setTerminalActivityErrors(activity.errors)
      } catch (activityError) {
        if (!isMounted) return
        setTerminalActivityErrors([getErrorMessage(activityError, 'Unable to load terminal activity.')])
      }
    }

    void refreshTerminalActivity()
    const intervalId = window.setInterval(() => void refreshTerminalActivity(), 60_000)
    const channel = client
      .channel(`terminal-activity-${activeTicker}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'scraped_items', filter: `ticker=eq.${activeTicker}` }, () => { void refreshTerminalActivity() })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'finviz_insider_trades', filter: `ticker=eq.${activeTicker}` }, () => { void refreshTerminalActivity() })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'analyst_evidence', filter: `analyst_id=eq.${analystId}` }, () => { void refreshTerminalActivity() })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'finviz_analyst_ratings', filter: `ticker=eq.${activeTicker}` }, () => { void refreshTerminalActivity() })
      .subscribe()

    return () => {
      isMounted = false
      window.clearInterval(intervalId)
      void client.removeChannel(channel)
    }
  }, [activeTicker, appendTerminalEvents, data?.analyst.id])

  const isCurrentTickerLoading = loadedTicker !== activeTicker
  const isTickerExtractionRunning = tickerExtraction[activeTicker]?.status === 'running'
  const showTickerDataLoader = isCurrentTickerLoading || isTickerExtractionRunning
  const evidenceList = getRealEvidence(loadedTicker === activeTicker ? data?.evidenceItems : undefined)
  const processingStatus = typeof data?.state?.processing_status === 'string' ? data.state.processing_status : 'idle'
  const hasActiveRun = (data?.runs ?? []).some((run: { status: string }) => run.status === 'started')
  const hasProcessingJob = (data?.jobs ?? []).some((job: { status: string }) => job.status === 'processing')
  const isStaleProcessingState = processingStatus === 'analyzing' && !hasActiveRun && !hasProcessingJob
  const statusLabel = isStaleProcessingState ? '' : getStatusLabel(processingStatus)
  const statusTone = statusLabel === 'ERROR' ? 'error' : 'active'
  const currentTerminalHistory = terminalHistory[activeTicker] ?? []
  const desktopSources = [
    { id: 'chart' as const, label: 'Price Chart', Icon: TrendingUp },
    { id: 'sec' as const, label: 'SEC Filings', Icon: FolderOpen },
    { id: 'insider' as const, label: 'Insider Trading', Icon: ChartColumnIncreasing },
    { id: 'ratings' as const, label: 'Analyst Ratings', Icon: Star },
    { id: 'news' as const, label: 'Market News', Icon: Newspaper },
    { id: 'analysis' as const, label: 'Analysis', Icon: FolderOpen },
  ]

  const secFiles = [
    ...getRealEvidence((loadedTicker === activeTicker ? secFilings : []).map((filing) => ({
      id: filing.id,
      title: filing.title,
      source_type: 'SEC',
      source_url: filing.url,
      published_at: filing.published_at,
      raw_metadata: filing.metadata,
    }))),
    ...evidenceList.filter((item) => item.source_type?.toUpperCase() === 'SEC'),
  ].filter((file, index, files) => files.findIndex((candidate) => candidate.id === file.id) === index)
  const currentRatings = loadedTicker === activeTicker ? finvizRatings : []
  const currentInsiderTrades = loadedTicker === activeTicker ? finvizInsiderTrades : []
  const currentNews = loadedTicker === activeTicker ? finvizNews : []
  const activeTitle = {
    chart: 'Price Chart',
    sec: 'SEC Filings',
    insider: 'Insider Tracker',
    ratings: 'Analyst Ratings',
    news: 'Market News',
    analysis: 'Analysis',
  }[activeApp]

  useEffect(() => {
    const feed = document.querySelector('.luna-chat-feed') as HTMLElement | null
    if (feed) {
      feed.scrollTop = feed.scrollHeight
    }
  }, [activeApp])

  const watchlistPanel = (
    <section className="luna-watchlist" aria-label="Ticker watchlist">
      <div className="luna-watchlist-tickers">
        {watchlist.map((watchlistTicker) => (
          <button
            key={watchlistTicker}
            type="button"
            className={`luna-watchlist-ticker ${watchlistTicker === activeTicker ? 'active' : ''}`}
            onClick={() => {
              setActiveTicker(watchlistTicker)
              setWatchlistMessage(null)
              const nextPath = `/analyst/${encodeURIComponent(watchlistTicker)}`
              if (window.location.pathname !== nextPath) {
                window.history.pushState({}, '', nextPath)
                window.dispatchEvent(new PopStateEvent('popstate'))
              }
            }}
            aria-pressed={watchlistTicker === activeTicker}
          >
            {watchlistTicker}
          </button>
        ))}
      </div>
      <form className="luna-watchlist-form" onSubmit={handleWatchlistSubmit}>
        <label className="sr-only" htmlFor="watchlist-ticker-input">Add ticker to watchlist</label>
        <input
          id="watchlist-ticker-input"
          value={watchlistInput}
          onChange={(event) => setWatchlistInput(event.target.value)}
          placeholder="Add ticker"
          maxLength={20}
          autoComplete="off"
        />
        <button type="submit" aria-label="Add ticker" title="Add ticker"><Plus size={16} /></button>
      </form>
      <span className="luna-watchlist-count">{watchlist.length}/{session && isPro === true ? 10 : 1} TICKERS</span>
      {watchlistMessage && (
        <div className="luna-watchlist-message" role="status">
          <span>{watchlistMessage}</span>
          {watchlistMessage.startsWith('Upgrade to Pro') && (
            <button type="button" onClick={handleWatchlistUpgrade} disabled={checkoutBusy}>
              {session ? 'Upgrade to Pro' : 'Sign in to upgrade'}
            </button>
          )}
        </div>
      )}
    </section>
  )

  const terminalWindow = (
    <aside className="luna-window luna-terminal-window" aria-label="MarketMole Terminal" aria-busy={loading}>
      <div className="luna-titlebar luna-terminal-titlebar">
        <div className="luna-window-controls" aria-hidden="true">
          <span className="luna-window-control close" />
          <span className="luna-window-control minimize" />
          <span className="luna-window-control maximize" />
        </div>
        <span className="luna-titlebar-label">MarketMole Terminal</span>
        <span className="luna-titlebar-spacer" aria-hidden="true" />
      </div>
      <div className="luna-terminal-content">
        <div className="luna-terminal-preview-label">LIVE ACTIVITY · AMERICA/NEW_YORK</div>
        {!data && !tickerExtraction[activeTicker] && (
          <>
            <p className="luna-terminal-system"><span>&gt;</span> [SYS] Initializing data streams for {activeTicker}...</p>
            <p className="luna-terminal-system"><span>&gt;</span> [SYS] Fetching latest SEC filings and market news...</p>
          </>
        )}
        {tickerExtraction[activeTicker] && (
          <>
            {[
              `[SYS] Connecting to SEC EDGAR database for ${activeTicker}...`,
              '[SYS] Extracting latest 8-K and 10-Q filings...',
              '[SYS] Aggregating market news and insider forms...',
              '[SYS] Running AI sentiment analysis. This may take a minute...',
            ].slice(0, tickerExtraction[activeTicker].step + 1).map((message) => (
              <p className="luna-terminal-system" key={message}><span>&gt;</span> {message}</p>
            ))}
            {tickerExtraction[activeTicker].status === 'error' && (
              <p className="luna-terminal-error"><span>&gt;</span> {tickerExtraction[activeTicker].message}</p>
            )}
            {tickerExtraction[activeTicker].status === 'complete' && tickerExtraction[activeTicker].message && (
              <p className="luna-terminal-system"><span>&gt;</span> [SYS] {tickerExtraction[activeTicker].message}</p>
            )}
          </>
        )}
        {currentTerminalHistory.map((event) => (
          <p key={event.id}>
            <span>[{formatTerminalTimestamp(event.timestamp)}]</span> &gt; {event.message}
          </p>
        ))}
        {loading && <p className="luna-terminal-system"><span>&gt;</span> [SYS] Loading analyst data...</p>}
        {error && <p className="luna-terminal-error"><span>&gt;</span> Feed unavailable: {error}</p>}
        {currentTerminalHistory.length === 0 && terminalActivityErrors.length === 0 && data && !loading && (
          <p className="luna-terminal-empty"><span>&gt;</span> Awaiting market activity...</p>
        )}
        {terminalActivityErrors.map((message) => (
          <p className="luna-terminal-error" key={message}><span>[{formatTerminalTimestamp(new Date().toISOString())}]</span> &gt; Feed unavailable: {message}</p>
        ))}
        <div className="luna-terminal-cursor" aria-hidden="true" />
      </div>
    </aside>
  )

  if (loadedTicker !== activeTicker) {
    return (
      <div className="luna-chat-shell">
        <Navbar>{watchlistPanel}</Navbar>
        <div className="luna-desktop-icons" aria-label="Data sources">
          {desktopSources.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              className={`luna-desktop-icon ${activeApp === id ? 'selected' : ''}`}
              onClick={() => setActiveApp(id)}
              aria-pressed={activeApp === id}
            >
              <span className="luna-desktop-icon-art"><Icon size={25} strokeWidth={1.7} /></span>
              <span>{label}</span>
            </button>
          ))}
        </div>
        <div className="luna-desktop-windows">
          <section className="luna-window luna-analysis-window" aria-label={`${activeTitle} · ${activeTicker}`}>
            <div className="luna-titlebar">
              <div className="luna-window-controls" aria-hidden="true">
                <span className="luna-window-control close" />
                <span className="luna-window-control minimize" />
                <span className="luna-window-control maximize" />
              </div>
              <span className="luna-titlebar-label">{activeTitle}</span>
              <span className="luna-titlebar-spacer" aria-hidden="true" />
            </div>
            {activeApp === 'chart' ? (
              <main className="luna-data-view luna-chart-view" aria-label={`${activeTicker} price chart`}>
                <PriceChart ticker={activeTicker} />
              </main>
            ) : (
              <main className="luna-data-view luna-sec-explorer">
                {showTickerDataLoader ? (
                  <DataLoadingState ticker={activeTicker} />
                ) : (
                  <DataEmptyState ticker={activeTicker} emptyMessage={EMPTY_STATE_COPY[activeApp]} errorMessage={activeApp === 'analysis' ? error : null} />
                )}
              </main>
            )}
          </section>
          {terminalWindow}
        </div>
      </div>
    )
  }

  return (
    <div className="luna-chat-shell">
      <Navbar>{watchlistPanel}</Navbar>
      <img className="marketmole-desktop-mascot" src="/branding/marketmole-mascot.png" alt="" aria-hidden="true" />
      <div className="luna-desktop-icons" aria-label="Fuentes de datos">
        {desktopSources.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            className={`luna-desktop-icon ${activeApp === id ? 'selected' : ''}`}
            onClick={() => setActiveApp(id)}
            aria-pressed={activeApp === id}
          >
            <span className="luna-desktop-icon-art"><Icon size={25} strokeWidth={1.7} /></span>
            <span>{label}</span>
          </button>
        ))}
      </div>

      <div className="luna-desktop-windows">
      <div className="luna-window luna-analysis-window">
        <div className="luna-titlebar" aria-label="MarketMole application window">
          <div className="luna-window-controls" aria-hidden="true">
            <span className="luna-window-control close" />
            <span className="luna-window-control minimize" />
            <span className="luna-window-control maximize" />
          </div>
          <span className="luna-titlebar-label">{activeTitle}</span>
          <span className="luna-titlebar-spacer" aria-hidden="true" />
        </div>
        <header className="luna-window-header">
          <div className="luna-mini-ident" aria-label={`MarketMole analyst for ${activeTicker}`}>
            <img className="marketmole-header-icon" src="/branding/marketmole-icon.png" alt="" />
            <span className="luna-mini-name">MarketMole</span>
            <span className="luna-mini-divider">·</span>
            <span className="luna-mini-ticker">{activeTicker}</span>
            {activeTicker === 'NVDA' && (
              <img className="luna-ticker-logo" src="/branding/nvidia-logo.svg" alt="NVIDIA" />
            )}
          </div>

          <div className="luna-header-actions">
            {session ? (
              <div className="luna-session-controls">
                <span className="luna-session-email" title={session.user.email ?? undefined}>{session.user.email}</span>
                <button type="button" className="luna-signout-button" onClick={onSignOut} aria-label="Cerrar sesión" title="Cerrar sesión">
                  <LogOut size={15} />
                </button>
              </div>
            ) : privateView ? (
              <button type="button" className="google-button" onClick={() => void handleGoogleSignIn()} disabled={authBusy}>
                <Chrome size={16} />
                {authBusy ? 'Connecting...' : 'Continue with Google'}
              </button>
            ) : (
              <button type="button" className="luna-login-button" onClick={() => void handleGoogleSignIn()} disabled={authBusy}>
                <Chrome size={15} />
                {authBusy ? 'Conectando...' : 'Iniciar sesión con Google'}
                {!authBusy && <ArrowRight size={15} />}
              </button>
            )}
            {session && isPro === false && (
              <button
                type="button"
                className="luna-upgrade-button"
                onClick={() => void handleUpgradeToPro()}
                disabled={checkoutBusy}
              >
                <Crown size={14} />
                {checkoutBusy ? 'Opening checkout...' : 'Upgrade to Pro'}
              </button>
            )}
            {session && profileLoadError && <span className="luna-checkout-error" role="status">{profileLoadError}</span>}
            {session && checkoutError && <span className="luna-checkout-error" role="alert">{checkoutError}</span>}
            {statusLabel && (
              <div className={`luna-mini-status ${statusTone}`} role="status">
                <span className="live-dot" />
                {statusLabel}
              </div>
            )}
          </div>
        </header>

        {authError && <div className="luna-auth-error">{authError}</div>}

        {activeApp === 'chart' && (
          <main className="luna-data-view luna-chart-view" aria-label={`${activeTicker} price chart`}>
            <PriceChart ticker={activeTicker} />
          </main>
        )}

        {activeApp === 'sec' && (
          <main className="luna-data-view luna-sec-explorer">
            {showTickerDataLoader || feedLoading.sec ? (
              <DataLoadingState ticker={activeTicker} />
            ) : secFiles.length === 0 ? (
              <DataEmptyState ticker={activeTicker} emptyMessage={EMPTY_STATE_COPY.sec} errorMessage={feedErrors.sec} />
            ) : (
              <div className="luna-sec-grid">
                {secFiles.map((file) => {
                  const filingType = getFilingType(file) ?? 'SEC Filing'
                  const fileContents = (
                    <>
                      <span className="luna-sec-file-icon"><FileText size={34} strokeWidth={1.5} /></span>
                      <strong>{filingType}</strong>
                      <span>{formatFilingDate(file.published_at)}</span>
                      <small>{cleanupDisplayText(file.title)}</small>
                      {file.source_url && <ExternalLink size={13} className="luna-sec-file-link" aria-hidden="true" />}
                    </>
                  )
                  return file.source_url ? (
                    <a key={file.id} className="luna-sec-file" href={file.source_url} target="_blank" rel="noreferrer" aria-label={`${filingType}: ${file.title}`}>
                      {fileContents}
                    </a>
                  ) : (
                    <div key={file.id} className="luna-sec-file" aria-label={`${filingType}: ${file.title}`}>
                      {fileContents}
                    </div>
                  )
                })}
              </div>
            )}
          </main>
        )}

        {activeApp === 'insider' && (
          <main className="luna-data-view">
            {showTickerDataLoader || feedLoading.insider ? (
              <DataLoadingState ticker={activeTicker} />
            ) : currentInsiderTrades.length === 0 ? (
              <DataEmptyState ticker={activeTicker} emptyMessage={EMPTY_STATE_COPY.insider} errorMessage={feedErrors.insider} />
            ) : (
              <div className="luna-table-scroll">
                <table className="luna-financial-table luna-insider-table">
                  <thead>
                    <tr>
                      <th>Relationship</th>
                      <th>Date</th>
                      <th>Transaction</th>
                      <th>Cost</th>
                      <th>#Shares</th>
                      <th>Value ($)</th>
                      <th>#Shares Total</th>
                      <th>SEC Form 4</th>
                    </tr>
                  </thead>
                  <tbody>
                    {currentInsiderTrades.map((trade) => (
                      <tr key={trade.id}>
                        <td>
                          <div className="luna-insider-identity">
                            <span>{trade.relationship || '—'}</span>
                            {trade.insider_name && <small>{trade.insider_name}</small>}
                          </div>
                        </td>
                        <td>{formatFilingDate(trade.transaction_date)}</td>
                        <td>{trade.transaction || '—'}</td>
                        <td>{trade.cost || '—'}</td>
                        <td>{trade.shares || '—'}</td>
                        <td>{trade.value || '—'}</td>
                        <td>{trade.shares_total || '—'}</td>
                        <td>
                          {trade.sec_form4_url ? (
                            <a href={trade.sec_form4_url} target="_blank" rel="noreferrer" className="luna-table-link">
                              View filing
                            </a>
                          ) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </main>
        )}

        {activeApp === 'ratings' && (
          <main className="luna-data-view">
            {showTickerDataLoader || feedLoading.ratings ? (
              <DataLoadingState ticker={activeTicker} />
            ) : currentRatings.length === 0 ? (
              <DataEmptyState ticker={activeTicker} emptyMessage={EMPTY_STATE_COPY.ratings} errorMessage={feedErrors.ratings} />
            ) : (
              <div className="luna-table-scroll">
                <table className="luna-financial-table luna-ratings-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Action</th>
                      <th>Analyst</th>
                      <th>Rating Change</th>
                      <th>Price Target Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {currentRatings.map((rating) => (
                      <tr key={rating.id}>
                        <td>{formatFilingDate(rating.rating_date)}</td>
                        <td>{rating.action || '—'}</td>
                        <td>{rating.analyst || '—'}</td>
                        <td>{rating.rating_change || '—'}</td>
                        <td>{rating.price_target_change || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </main>
        )}

        {activeApp === 'news' && (
          <main className="luna-news-view" aria-live="polite">
            <div className="luna-news-heading">
              <div>
                <span className="luna-report-eyebrow">LATEST NEWS · {activeTicker}</span>
                <h2>Market News</h2>
              </div>
              <span className="luna-report-count">{currentNews.length} {currentNews.length === 1 ? 'article' : 'articles'}</span>
            </div>
            {feedErrors.news ? (
              <div className="luna-news-empty" role="status">
                <Newspaper size={25} />
                <strong>News stream unavailable</strong>
                <span>{feedErrors.news}</span>
              </div>
            ) : showTickerDataLoader || feedLoading.news ? (
              <div className="luna-news-empty">
                <DataLoadingState ticker={activeTicker} />
              </div>
            ) : currentNews.length === 0 ? (
              <div className="luna-news-empty">
                <DataEmptyState ticker={activeTicker} emptyMessage={EMPTY_STATE_COPY.news} />
              </div>
            ) : (
              <div className="luna-news-list">
                {currentNews.map((item) => {
                  const extractor = readText(item.metadata.extractor)
                  const publisher = readText(item.metadata.provider)
                    ?? readText(item.author)
                    ?? (extractor === 'yahoo_finance_rss' ? 'Yahoo Finance'
                      : extractor === 'bing_news_rss' ? 'Bing News'
                        : extractor === 'google_news_rss' ? 'Google News'
                          : extractor === 'finviz-news-table' ? 'Finviz' : 'News source')
                  const articleUrl = getExternalHttpUrl(item.url)
                  const headline = cleanupDisplayText(item.title)
                  const briefing = newsBriefings[item.id]
                  return (
                    <article className="luna-news-item" key={item.id}>
                      <div className="luna-news-item-meta">
                        <span>{publisher}</span>
                        <time dateTime={item.published_at ?? undefined}>{formatFinvizTimestamp(item.published_at)}</time>
                      </div>
                      <h3>{headline}</h3>
                      <button
                        type="button"
                        className="luna-news-brief-button"
                        aria-expanded={briefingArticleId === item.id}
                        aria-controls={`news-brief-${item.id}`}
                        disabled={briefing?.status === 'loading'}
                        onClick={() => {
                          if (briefingArticleId === item.id && (briefing?.status === 'success' || briefing?.status === 'irrelevant')) {
                            setBriefingArticleId(null)
                            return
                          }
                          void handleSummarizeNews(item.id, articleUrl, item.title?.trim() || headline)
                        }}
                      >
                        <Brain size={13} aria-hidden="true" />
                        {briefingArticleId === item.id && (briefing?.status === 'success' || briefing?.status === 'irrelevant')
                          ? 'Hide brief'
                          : briefing?.status === 'error'
                            ? 'Retry summary'
                            : 'Summarize'}
                      </button>
                      <div
                        className={`luna-news-brief${briefing?.status === 'loading' ? ' luna-news-brief-loading' : ''}`}
                        id={`news-brief-${item.id}`}
                        role="status"
                        aria-live="polite"
                        hidden={briefingArticleId !== item.id}
                      >
                        {briefing?.status === 'loading'
                          ? <span className="luna-news-brief-terminal">&gt; Extracting key metrics &amp; analyzing article...</span>
                          : briefing?.status === 'success'
                            ? briefing.summary
                            : briefing?.status === 'irrelevant'
                              ? 'This article was flagged as irrelevant (e.g., ad or unrelated company).'
                              : briefing?.status === 'error'
                                ? '[Error: Unable to extract article content]'
                                : null}
                      </div>
                      {articleUrl && (
                        <a href={articleUrl} target="_blank" rel="noreferrer">
                          Read original article <ExternalLink size={13} aria-hidden="true" />
                        </a>
                      )}
                    </article>
                  )
                })}
              </div>
            )}
          </main>
        )}

        {activeApp === 'analysis' && (
          <main className="luna-report-view" aria-live="polite">
            <section className="global-analysis-panel" aria-label={`Global market analysis for ${activeTicker}`}>
              <div className="global-analysis-pdf-brand" aria-hidden="true">
                <strong>Market<span>Mole</span>.</strong>
                <span>Equity Research Brief · {activeTicker}</span>
              </div>
              <div className="global-analysis-heading">
                <div>
                  <span className="luna-report-eyebrow">INSTITUTIONAL DUE DILIGENCE</span>
                  <h2>Equity Research Report · {activeTicker}</h2>
                </div>
                <button
                  type="button"
                  className="global-analysis-button"
                  onClick={() => void handleGlobalAnalysis()}
                  disabled={!session || globalAnalysisBusy || (globalAnalysis?.ticker === activeTicker && (globalAnalysisHasUpdates === false || globalAnalysisChecking))}
                  title={globalAnalysis?.ticker === activeTicker && globalAnalysisHasUpdates === false
                    ? 'No new market data since this analysis was generated.'
                    : undefined}
                >
                  <Brain size={15} className={globalAnalysisBusy ? 'spinning' : undefined} />
                  {globalAnalysisBusy
                    ? 'Analyzing…'
                    : !session
                      ? 'Sign in to run analysis'
                    : globalAnalysis?.ticker === activeTicker
                      ? globalAnalysisChecking
                        ? 'Checking for updates…'
                        : globalAnalysisHasUpdates === false
                          ? 'Up to date'
                          : 'Refresh analysis'
                      : 'Run analysis'}
                </button>
                {globalAnalysis?.ticker === activeTicker && (
                  <button
                    type="button"
                    className="global-analysis-export-button"
                    onClick={() => window.print()}
                  >
                    <Download size={14} />
                    Export PDF
                  </button>
                )}
              </div>
              {globalAnalysisError && <p className="global-analysis-error" role="alert">{globalAnalysisError}</p>}
              {globalAnalysisBusy && <p className="global-analysis-loading" role="status">&gt; Aggregating news, SEC filings, insider trades &amp; ratings...</p>}
              {!globalAnalysisBusy && globalAnalysis?.ticker !== activeTicker && (
                showTickerDataLoader
                  ? <DataLoadingState ticker={activeTicker} />
                  : <DataEmptyState ticker={activeTicker} emptyMessage={EMPTY_STATE_COPY.analysis} errorMessage={error} />
              )}
              {globalAnalysis?.ticker === activeTicker && (
                <>
                  <GlobalAnalysisReport report={globalAnalysis} />
                </>
              )}
            </section>
          </main>
        )}

        <footer className="luna-window-footer">
          <div className="luna-enqueue-feedback" aria-live="polite">
            {enqueueError && <span className="luna-enqueue-error">{enqueueError}</span>}
            {enqueueMessage && <span className="luna-enqueue-success">{enqueueMessage}</span>}
          </div>
          {activeApp === 'analysis' && session && secFiles.length > 0 && (
            <button
              type="button"
              className="luna-enqueue-button"
              onClick={() => void handleEnqueueAnalysis()}
              disabled={enqueueBusy || statusLabel === 'PROCESSING'}
            >
              <RefreshCw size={15} className={enqueueBusy ? 'spinning' : undefined} />
              {enqueueBusy ? 'Encolando…' : statusLabel === 'PROCESSING' ? 'Análisis en curso' : 'Actualizar análisis SEC'}
            </button>
          )}
        </footer>
      </div>

      {terminalWindow}
      </div>

    </div>
  )
}

export function PublicAnalystPage({
  ticker,
  session,
  onSignOut,
}: {
  ticker?: string
  session?: Session | null
  onSignOut?: () => void
}) {
  return <AnalystExperienceDisplay ticker={ticker} session={session} onSignOut={onSignOut} />
}
