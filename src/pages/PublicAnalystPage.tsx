import { useEffect, useMemo, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { ArrowRight, Brain, ChartColumnIncreasing, Chrome, Crown, Download, ExternalLink, FileText, FolderOpen, LogOut, Newspaper, RefreshCw, Star } from 'lucide-react'
import { Navbar } from '../components/Navbar'
import { TerminalLoader } from '../components/TerminalLoader'
import { getPrivateAnalystByTicker, getPublicAnalystByTicker } from '../lib/analystData'
import { getFinvizCompanyActivity, getFinvizCompanyNews, getLatestTerminalActivity, type TerminalActivityEvent } from '../lib/queries/company'
import { getAuthRedirectUrl, supabase } from '../lib/supabase'

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

function formatMarketMoleTimestamp(value: string | null | undefined) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(date).replace(',', ' ·')
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
  const dateOnly = value.match(/^(\d{4}-\d{2}-\d{2})$/)
  const date = new Date(dateOnly ? `${dateOnly[1]}T00:00:00Z` : value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: dateOnly ? 'UTC' : 'America/New_York',
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

type AnalystApp = 'sec' | 'insider' | 'ratings' | 'news' | 'analysis'

type NewsBriefing =
  | { status: 'loading' }
  | { status: 'success'; summary: string }
  | { status: 'irrelevant' }
  | { status: 'error' }

const TERMINAL_IDLE_MESSAGES = [
  '[SYS] Monitoring data streams...',
  '[SYS] Decrypting market noise...',
  '[SYS] Watching for new filings and insider activity...',
]

type GlobalTickerAnalysis = {
  ticker: string
  analysis: {
    sentiment: 'Bullish' | 'Bearish' | 'Neutral'
    thesis: string
    fundamentals: string
    market_noise: string
  }
  generated_at: string
  data_counts: {
    news: number
    sec_filings: number
    insider_trades: number
    analyst_ratings: number
  }
}

type GlobalAnalysisFreshness = {
  ticker: string
  has_new_data?: boolean
  unchanged?: boolean
}

function getExternalHttpUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
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
  const [newsError, setNewsError] = useState<string | null>(null)
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
  const [finvizActivity, setFinvizActivity] = useState<Awaited<ReturnType<typeof getFinvizCompanyActivity>>>({ ratings: [], insiderTrades: [] })
  const [finvizNews, setFinvizNews] = useState<Awaited<ReturnType<typeof getFinvizCompanyNews>>>([])
  const [terminalActivity, setTerminalActivity] = useState<TerminalActivityEvent[]>([])
  const [terminalActivityErrors, setTerminalActivityErrors] = useState<string[]>([])
  const [terminalIdleIndex, setTerminalIdleIndex] = useState(0)

  const activeTicker = useMemo(() => (ticker ?? 'NVDA').toUpperCase(), [ticker])
  const sessionUserId = session?.user.id ?? null

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

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setTerminalIdleIndex((current) => (current + 1) % TERMINAL_IDLE_MESSAGES.length)
    }, 6_000)
    return () => window.clearInterval(intervalId)
  }, [])

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
    if (!supabase || globalAnalysisBusy) return
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
      if (invokeError) throw invokeError
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
    if (!supabase || globalAnalysisTicker !== activeTicker || !globalAnalysisGeneratedAt) {
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
        if (invokeError) throw invokeError
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
  }, [activeTicker, globalAnalysisGeneratedAt, globalAnalysisTicker])

  useEffect(() => {
    let isMounted = true

    if (!supabase) {
      setLoading(false)
      setError('Supabase configuration is missing. Add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.')
      return () => { isMounted = false }
    }

    const client = supabase

    async function loadAnalyst() {
      try {
        setLoading(true)
        setError(null)
        setNewsError(null)

        const result = privateView
          ? await (async () => {
            const { data: { user }, error: userError } = await client.auth.getUser()
            if (userError) throw userError
            if (!user) throw new Error('No authenticated user found.')
            return getPrivateAnalystByTicker(client, activeTicker, user.id)
          })()
          : await getPublicAnalystByTicker(client, activeTicker)
        const marketActivity = await getFinvizCompanyActivity(client, activeTicker)
        let marketNews: Awaited<ReturnType<typeof getFinvizCompanyNews>> = []
        let marketNewsError: string | null = null
        try {
          marketNews = await getFinvizCompanyNews(client, activeTicker)
        } catch (newsFetchError) {
          marketNewsError = getErrorMessage(newsFetchError, 'Finviz news request failed.')
        }

        if (!isMounted) return
        setData(result)
        setFinvizActivity(marketActivity)
        setFinvizNews(marketNews)
        setNewsError(marketNewsError)
      } catch (fetchError) {
        if (!isMounted) return
        setError(fetchError instanceof Error ? fetchError.message : 'Unable to load analyst.')
      } finally {
        if (isMounted) {
          setLoading(false)
        }
      }
    }

    void loadAnalyst()

    const channel = client
      .channel(`analyst-live-${activeTicker}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'analyst_state' }, () => { void loadAnalyst() })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'decision_events' }, () => { void loadAnalyst() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'analyst_jobs' }, () => { void loadAnalyst() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'finviz_insider_trades', filter: `ticker=eq.${activeTicker}` }, () => { void loadAnalyst() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'finviz_analyst_ratings', filter: `ticker=eq.${activeTicker}` }, () => { void loadAnalyst() })
      .subscribe()

    return () => {
      isMounted = false
      void client.removeChannel(channel)
    }
  }, [activeTicker, privateView, session?.user.id])

  useEffect(() => {
    const client = supabase
    const analystId = data?.analyst.id
    if (!client || !analystId) {
      setTerminalActivity([])
      setTerminalActivityErrors([])
      return
    }

    let isMounted = true
    const refreshTerminalActivity = async () => {
      try {
        const activity = await getLatestTerminalActivity(client, activeTicker, analystId)
        if (!isMounted) return
        setTerminalActivity(activity.events)
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
  }, [activeTicker, data?.analyst.id])

  const evidenceList = getRealEvidence(data?.evidenceItems)
  const processingStatus = typeof data?.state?.processing_status === 'string' ? data.state.processing_status : 'idle'
  const hasActiveRun = (data?.runs ?? []).some((run: { status: string }) => run.status === 'started')
  const hasProcessingJob = (data?.jobs ?? []).some((job: { status: string }) => job.status === 'processing')
  const isStaleProcessingState = processingStatus === 'analyzing' && !hasActiveRun && !hasProcessingJob
  const statusLabel = isStaleProcessingState ? '' : getStatusLabel(processingStatus)
  const statusTone = statusLabel === 'ERROR' ? 'error' : 'active'
  const desktopSources = [
    { id: 'sec' as const, label: 'SEC Filings', Icon: FolderOpen },
    { id: 'insider' as const, label: 'Insider Trading', Icon: ChartColumnIncreasing },
    { id: 'ratings' as const, label: 'Analyst Ratings', Icon: Star },
    { id: 'news' as const, label: 'Market News', Icon: Newspaper },
    { id: 'analysis' as const, label: 'Analysis', Icon: FolderOpen },
  ]

  const secFiles = evidenceList.filter((item) => item.source_type?.toUpperCase() === 'SEC')
  const activeTitle = {
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

  if (loading) {
    return <TerminalLoader message="Loading analyst evidence and thesis history..." />
  }

  if (error) {
    return <div className="center-state"><strong>Unable to load analyst.</strong><span>{error}</span></div>
  }

  if (!data || !data.analyst) {
    return (
      <div className="research-terminal research-terminal-empty">
        <div className="terminal-empty-shell">
          <span className="terminal-kicker">ANALYST NOT INITIALIZED</span>
          <h1>{activeTicker}</h1>
          <p>No analyst state is currently available for this company.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="luna-chat-shell">
      <Navbar />
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

        {activeApp === 'sec' && (
          <main className="luna-data-view luna-sec-explorer">
            {secFiles.length === 0 ? (
              <div className="luna-placeholder-state">
                <FolderOpen size={28} />
                <strong>No SEC filings available</strong>
                <span>Original filing documents will appear here when available.</span>
              </div>
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
            {finvizActivity.insiderTrades.length === 0 ? (
              <div className="luna-placeholder-state">
                <ChartColumnIncreasing size={26} />
                <strong>{session ? 'No insider transactions available' : 'Sign in to view insider transactions'}</strong>
                <span>{session ? 'Finviz insider transactions will appear here when available.' : 'Finviz market data is available to authenticated users.'}</span>
              </div>
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
                    {finvizActivity.insiderTrades.map((trade) => (
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
            {finvizActivity.ratings.length === 0 ? (
              <div className="luna-placeholder-state">
                <Star size={26} />
                <strong>{session ? 'No analyst ratings available' : 'Sign in to view analyst ratings'}</strong>
                <span>{session ? 'Finviz analyst ratings will appear here when available.' : 'Finviz market data is available to authenticated users.'}</span>
              </div>
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
                    {finvizActivity.ratings.map((rating) => (
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
              <span className="luna-report-count">{finvizNews.length} {finvizNews.length === 1 ? 'article' : 'articles'}</span>
            </div>
            {newsError ? (
              <div className="luna-news-empty" role="status">
                <Newspaper size={25} />
                <strong>News stream unavailable</strong>
                <span>{newsError}</span>
              </div>
            ) : finvizNews.length === 0 ? (
              <div className="luna-news-empty">
                <Newspaper size={25} />
                <strong>Awaiting news stream...</strong>
                <span>New market headlines will appear here as they are collected.</span>
              </div>
            ) : (
              <div className="luna-news-list">
                {finvizNews.map((item) => {
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
                  <span className="luna-report-eyebrow">MULTI-SOURCE MARKET VIEW</span>
                  <h2>Global Analysis · {activeTicker}</h2>
                </div>
                <button
                  type="button"
                  className="global-analysis-button"
                  onClick={() => void handleGlobalAnalysis()}
                  disabled={globalAnalysisBusy || (globalAnalysis?.ticker === activeTicker && (globalAnalysisHasUpdates === false || globalAnalysisChecking))}
                  title={globalAnalysis?.ticker === activeTicker && globalAnalysisHasUpdates === false
                    ? 'No new market data since this analysis was generated.'
                    : undefined}
                >
                  <Brain size={15} className={globalAnalysisBusy ? 'spinning' : undefined} />
                  {globalAnalysisBusy
                    ? 'Analyzing…'
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
              {globalAnalysis?.ticker === activeTicker && (
                <>
                  <div className="global-analysis-grid">
                    <section className={`global-analysis-sentiment sentiment-${globalAnalysis.analysis.sentiment.toLowerCase()}`}>
                      <span>OVERALL SENTIMENT</span>
                      <strong>{globalAnalysis.analysis.sentiment}</strong>
                    </section>
                    <section className="global-analysis-card">
                      <span>INVESTMENT THESIS</span>
                      <p>{globalAnalysis.analysis.thesis}</p>
                    </section>
                    <section className="global-analysis-card">
                      <span>FUNDAMENTALS</span>
                      <p>{globalAnalysis.analysis.fundamentals}</p>
                    </section>
                    <section className="global-analysis-card">
                      <span>MARKET NOISE</span>
                      <p>{globalAnalysis.analysis.market_noise}</p>
                    </section>
                  </div>
                  <p className="global-analysis-meta">
                    Based on {globalAnalysis.data_counts.news} news · {globalAnalysis.data_counts.sec_filings} SEC filings · {globalAnalysis.data_counts.insider_trades} insider trades · {globalAnalysis.data_counts.analyst_ratings} ratings
                    {' · '}Generated {formatMarketMoleTimestamp(globalAnalysis.generated_at)}
                  </p>
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

      <aside className="luna-window luna-terminal-window" aria-label="MarketMole Terminal">
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
          {terminalActivity.map((event) => (
            <p key={event.id}>
              <span>&gt;</span> [{formatTerminalTimestamp(event.timestamp)}] {event.message}
            </p>
          ))}
          {terminalActivity.length === 0 && terminalActivityErrors.length === 0 && (
            <p className="luna-terminal-empty"><span>&gt;</span> Awaiting market activity...</p>
          )}
          {terminalActivityErrors.map((message) => (
            <p className="luna-terminal-error" key={message}><span>&gt;</span> Feed unavailable: {message}</p>
          ))}
          <p className="luna-terminal-system" key={`system-${terminalIdleIndex}`}>
            <span>&gt;</span> {TERMINAL_IDLE_MESSAGES[terminalIdleIndex]}
          </p>
          <div className="luna-terminal-cursor" aria-hidden="true" />
        </div>
      </aside>
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
