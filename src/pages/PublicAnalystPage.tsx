import { useEffect, useMemo, useState } from 'react'
import { Chrome } from 'lucide-react'
import { getPrivateAnalystByTicker, getPublicAnalystByTicker } from '../lib/analystData'
import { type NormalizedMarketSnapshot } from '../lib/marketData'
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

function formatMoney(value: number | null | undefined) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value)
}

function formatSignedPrice(value: number | null | undefined) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—'
  return `${value >= 0 ? '+' : '-'}${formatMoney(Math.abs(value))}`
}

function formatSignedPercent(value: number | null | undefined, digits = 2) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—'
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`
}

function formatCompactNumber(value: number | null | undefined) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—'
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return value.toLocaleString('en-US')
}

function format52wRange(low: number | null | undefined, high: number | null | undefined) {
  if (typeof low !== 'number' || typeof high !== 'number') return '—'
  return `${formatMoney(low)} - ${formatMoney(high)}`
}

function formatDate(value: string | null | undefined) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date)
}

function formatLunaTimestamp(value: string | null | undefined) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(date).replace(',', ' ·')
}

function formatFilingDate(value: string | null | undefined) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(date)
}

function formatClock(value: string | null | undefined) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}

function toReadableList(values: Array<unknown> | undefined | null) {
  return (values ?? []).flatMap((item) => {
    if (typeof item === 'string') return item.trim() ? [item.trim()] : []
    if (item && typeof item === 'object' && 'name' in item && typeof item.name === 'string') return [item.name]
    return []
  })
}

function getStatusLabel(processingStatus: string | undefined | null) {
  const normalized = (processingStatus ?? 'idle').toLowerCase()
  if (normalized.includes('error')) return 'ERROR'
  if (normalized.includes('process') || normalized.includes('analyz') || normalized.includes('read') || normalized.includes('search') || normalized.includes('updat') || normalized.includes('queue')) return 'PROCESSING'
  return 'MONITORING'
}

function getFreshnessLabel(updatedAt: string | null | undefined) {
  if (!updatedAt) return 'STALE'
  const ageMinutes = (Date.now() - new Date(updatedAt).getTime()) / 60000
  return ageMinutes <= 30 ? 'FRESH' : 'STALE'
}

function getRealDecisionEvents(
  list: Array<{
    id?: string | null
    event?: string | null
    reasoning_summary?: string | null
    source?: string | null
    source_type?: string | null
    impact?: string | null
    evidence?: string | null
    timestamp?: string | null
  }> | undefined | null,
) {
  return (list ?? []).filter((event) => {
    if (!event) return false
    const combined = [
      event.event,
      event.reasoning_summary,
      event.source,
      event.source_type,
      event.impact,
      event.evidence,
    ].filter((value): value is string => typeof value === 'string')
    return combined.length === 0 || !combined.some((value) => isDemoArtifact(value))
  })
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

function getRunResultObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function readText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

export function AnalystExperienceDisplay({ ticker, privateView = false }: { ticker?: string; privateView?: boolean }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)
  const [authBusy, setAuthBusy] = useState(false)
  const [data, setData] = useState<Awaited<ReturnType<typeof getPublicAnalystByTicker>> | null>(null)
  const [marketSnapshot, setMarketSnapshot] = useState<NormalizedMarketSnapshot | null>(null)
  const [trackedCompanies, setTrackedCompanies] = useState<Array<{ ticker: string; company_name: string | null }>>([])

  const activeTicker = useMemo(() => (ticker ?? 'NVDA').toUpperCase(), [ticker])

  async function handleGoogleSignIn() {
    if (!supabase) return

    setAuthBusy(true)
    setAuthError(null)

    try {
      const redirectUrl = getAuthRedirectUrl('/app')
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

        const { data: sessionData } = await client.auth.getSession()
        const isSignedIn = Boolean(sessionData.session)

        let companyRows: Array<{ ticker: string; company_name: string | null }> = []

        if (isSignedIn) {
          const companiesResult = await client
            .from('tracked_stocks')
            .select('ticker, company_name')
            .eq('enabled', true)
            .order('ticker', { ascending: true })

          if (companiesResult.error) {
            console.warn('Tracked stocks lookup failed for authenticated user', companiesResult.error)
          } else {
            companyRows = (companiesResult.data ?? []).filter((row) => typeof row?.ticker === 'string' && row.ticker.trim().length > 0)
          }
        }

        const tickers = companyRows.map((row) => row.ticker.toUpperCase())

        const marketResult = tickers.length > 0
          ? await client
              .from('finviz_market_data')
              .select('*')
              .in('ticker', tickers)
              .order('updated_at', { ascending: false })
          : { data: [] as Record<string, unknown>[] }

        const latestMarketByTicker = new Map<string, Record<string, unknown>>()
        for (const row of marketResult.data ?? []) {
          const tickerValue = typeof row?.ticker === 'string' ? row.ticker.toUpperCase() : null
          if (!tickerValue || latestMarketByTicker.has(tickerValue)) continue
          latestMarketByTicker.set(tickerValue, row)
        }

        const result = privateView
          ? await (async () => {
            const { data: { user }, error: userError } = await client.auth.getUser()
            if (userError) throw userError
            if (!user) throw new Error('No authenticated user found.')
            return getPrivateAnalystByTicker(client, activeTicker, user.id)
          })()
          : await getPublicAnalystByTicker(client, activeTicker)

        const { data: marketData, error: marketError } = await client
          .from('finviz_market_data')
          .select('*')
          .eq('ticker', activeTicker)
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        if (marketError) {
          console.warn('Market data lookup failed', marketError)
        }

        if (!isMounted) return
        setTrackedCompanies(companyRows)
        setData(result)
        setMarketSnapshot(marketData as NormalizedMarketSnapshot | null)
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
      .subscribe()

    return () => {
      isMounted = false
      void client.removeChannel(channel)
    }
  }, [activeTicker, privateView])

  const analyst = data?.analyst ?? null
  const thesis = data?.thesisHistory?.[0] ?? null
  const thesisHistory = data?.thesisHistory ?? []
  const thesisSummary = analyst ? cleanupDisplayText(thesis?.summary ?? analyst.current_thesis ?? 'No thesis available yet.') : '—'
  const assumptions = toReadableList(thesis?.assumptions as unknown[] | undefined)
  const decisionList = getRealDecisionEvents(data?.decisionEvents)
  const evidenceList = getRealEvidence(data?.evidenceItems)
  const valuationList = data?.valuationHistory ?? []
  const processingStatus = typeof data?.state?.processing_status === 'string' ? data.state.processing_status : 'idle'
  const hasActiveRun = (data?.runs ?? []).some((run: { status: string }) => run.status === 'started')
  const hasProcessingJob = (data?.jobs ?? []).some((job: { status: string }) => job.status === 'processing')
  const isStaleProcessingState = processingStatus === 'analyzing' && !hasActiveRun && !hasProcessingJob
  const statusLabel = isStaleProcessingState ? 'MONITORING' : getStatusLabel(processingStatus)
  const marketPrice = marketSnapshot?.price ?? null
  const marketSource = marketSnapshot?.source ?? 'FINVIZ'
  const marketFreshness = getFreshnessLabel(marketSnapshot?.updatedAt ?? null)
  const companyName = analyst ? cleanupDisplayText(analyst.company_name ?? '—') : '—'
  const aiSummary = thesisSummary === '—' ? 'Awaiting the next real analyst update.' : thesisSummary
  const statusTone = statusLabel === 'ERROR' ? 'error' : statusLabel === 'PROCESSING' ? 'active' : 'idle'

  const realRuns = (data?.runs ?? []).filter((run) => {
    if (!run) return false
    if (run.status === 'failed') return false
    return Boolean(run.started_at || run.completed_at || run.created_at || run.evidence_id)
  }).sort((left, right) => {
    const leftStamp = new Date(left.completed_at ?? left.started_at ?? left.created_at ?? 0).getTime()
    const rightStamp = new Date(right.completed_at ?? right.started_at ?? right.created_at ?? 0).getTime()
    return leftStamp - rightStamp
  })

  const evidenceById = new Map((evidenceList ?? []).filter((item) => item.id).map((item) => [item.id as string, item]))

  const researchTranscript = realRuns.map((run) => {
    const result = getRunResultObject(run.result_json)
    const evidence = run.evidence_id ? evidenceById.get(run.evidence_id) ?? null : null
    const evidenceTitle = evidence?.title ? cleanupDisplayText(evidence.title) : null
    const evidenceSourceType = evidence?.source_type ? evidence.source_type.toUpperCase() : null
    const evidencePublishedAt = evidence?.published_at ?? null
    const evidenceSourceDate = formatFilingDate(evidencePublishedAt)
    const thesisSummary = readText(result?.thesisSummary)
    const decisionSummary = readText(result?.decisionSummary)
    const confidenceValue = typeof result?.confidence === 'number' ? result.confidence : undefined
    const thesisChanged = Boolean(result?.thesisChanged)
    const valuationChanged = Boolean(result?.valuationChanged)
    const previousFairValue = typeof result?.previousFairValue === 'number' ? result.previousFairValue : null
    const newFairValue = typeof result?.newFairValue === 'number' ? result.newFairValue : null
    const materiality = readText(result?.materiality)
    const impact = readText(result?.impact)

    const primaryText = decisionSummary ?? thesisSummary ?? null
    const secondaryText = thesisChanged && thesisSummary && thesisSummary !== decisionSummary ? thesisSummary : null
    const fairValueText = valuationChanged && previousFairValue !== null && newFairValue !== null && previousFairValue !== newFairValue
      ? `${formatMoney(previousFairValue)} → ${formatMoney(newFairValue)}`
      : null
    const sourceContext = evidenceSourceType && evidenceTitle
      ? `${evidenceSourceType} · ${evidenceTitle}`
      : evidenceTitle || null
    const stamp = run.completed_at ?? run.started_at ?? run.created_at ?? new Date().toISOString()
    const label = thesisChanged ? 'THESIS UPDATED' : valuationChanged ? 'FAIR VALUE' : null

    return {
      id: `run-${run.id}`,
      kind: thesisChanged ? 'thesis' : valuationChanged ? 'valuation' : decisionSummary ? 'decision' : 'research',
      stamp,
      label,
      primaryText: primaryText ? cleanupDisplayText(primaryText) : null,
      secondaryText: secondaryText ? cleanupDisplayText(secondaryText) : null,
      fairValueText,
      source: sourceContext,
      sourceDate: evidenceSourceDate,
      confidence: confidenceValue !== undefined ? `Confidence ${confidenceValue}%` : null,
      meta: [
        impact && (thesisChanged || valuationChanged) ? `Impact ${impact}` : null,
        materiality && (thesisChanged || valuationChanged) ? `Materiality ${materiality}` : null,
      ].filter((value): value is string => Boolean(value)),
    }
  })

  useEffect(() => {
    const feed = document.querySelector('.luna-chat-feed') as HTMLElement | null
    if (feed) {
      feed.scrollTop = feed.scrollHeight
    }
  }, [researchTranscript.length])

  if (loading) {
    return <div className="center-state"><strong>Loading analyst...</strong><span>Fetching the latest evidence and thesis history.</span></div>
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
      <div className="luna-window">
        <header className="luna-window-header">
          <div className="luna-mini-ident" aria-label={`Luna analyst for ${activeTicker}`}>
            <span className="luna-mini-name">LUNA</span>
            <span className="luna-mini-divider">·</span>
            <span className="luna-mini-ticker">{activeTicker}</span>
          </div>

          <div className="luna-header-actions">
            <button type="button" className="google-button" onClick={() => void handleGoogleSignIn()} disabled={authBusy}>
              <Chrome size={16} />
              {authBusy ? 'Connecting...' : 'Continue with Google'}
            </button>
            <div className={`luna-mini-status ${statusTone}`}>
              <span className="live-dot" />
              {statusLabel}
            </div>
          </div>
        </header>

        {authError && <div className="luna-auth-error">{authError}</div>}

        <main className="luna-chat-feed" aria-live="polite">
          {researchTranscript.length === 0 ? (
            <div className="empty-research-state">No live research events are available yet.</div>
          ) : researchTranscript.map((message) => (
            <article key={message.id} className={`luna-chat-message ${message.kind}`}>
              {message.source && (
                <div className="luna-source-block">
                  <span className="luna-source-label">Source</span>
                  <strong>{message.source}</strong>
                  {message.sourceDate && <span className="luna-source-date">Filed {message.sourceDate}</span>}
                </div>
              )}

              <div className="luna-chat-meta">
                <span className="luna-chat-author">LUNA</span>
                <time>{formatLunaTimestamp(message.stamp)}</time>
              </div>

              {message.label && <div className="mini-tag">{message.label}</div>}

              {message.primaryText && <p className="luna-chat-body">{message.primaryText}</p>}
              {message.secondaryText && <p className="luna-chat-detail">{message.secondaryText}</p>}

              {message.fairValueText && (
                <div className="luna-chat-valuation">
                  <span>Fair value</span>
                  <strong>{message.fairValueText}</strong>
                </div>
              )}

              {message.confidence && (
                <div className="luna-chat-confidence">
                  <span>{message.confidence}</span>
                </div>
              )}

              {message.meta.length > 0 && (
                <div className="mini-meta-row subtle">
                  {message.meta.map((tag) => <span key={`${message.id}-${tag}`}>{tag}</span>)}
                </div>
              )}
            </article>
          ))}
        </main>

        <footer className="luna-window-footer">
          <div className="luna-window-status">
            <span className="live-dot" />
            {statusLabel}
          </div>
        </footer>
      </div>
    </div>
  )
}

export function PublicAnalystPage({ ticker }: { ticker?: string }) {
  return <AnalystExperienceDisplay ticker={ticker} />
}
