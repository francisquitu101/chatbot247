import { useEffect, useMemo, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { ArrowRight, ChartColumnIncreasing, Chrome, ExternalLink, FileText, FolderOpen, LogOut, RefreshCw, Star } from 'lucide-react'
import { getPrivateAnalystByTicker, getPublicAnalystByTicker } from '../lib/analystData'
import { getFinvizCompanyActivity } from '../lib/queries/company'
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

function getRunResultObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function readText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

type AnalystApp = 'sec' | 'insider' | 'ratings' | 'analysis'

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
  const [enqueueBusy, setEnqueueBusy] = useState(false)
  const [enqueueMessage, setEnqueueMessage] = useState<string | null>(null)
  const [enqueueError, setEnqueueError] = useState<string | null>(null)
  const [activeApp, setActiveApp] = useState<AnalystApp>('sec')
  const [data, setData] = useState<Awaited<ReturnType<typeof getPublicAnalystByTicker>> | null>(null)
  const [finvizActivity, setFinvizActivity] = useState<Awaited<ReturnType<typeof getFinvizCompanyActivity>>>({ ratings: [], insiderTrades: [] })

  const activeTicker = useMemo(() => (ticker ?? 'NVDA').toUpperCase(), [ticker])

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

        const result = privateView
          ? await (async () => {
            const { data: { user }, error: userError } = await client.auth.getUser()
            if (userError) throw userError
            if (!user) throw new Error('No authenticated user found.')
            return getPrivateAnalystByTicker(client, activeTicker, user.id)
          })()
          : await getPublicAnalystByTicker(client, activeTicker)
        const marketActivity = await getFinvizCompanyActivity(client, activeTicker)

        if (!isMounted) return
        setData(result)
        setFinvizActivity(marketActivity)
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
    { id: 'analysis' as const, label: 'Analysis', Icon: FolderOpen },
  ]

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

  const secFiles = evidenceList.filter((item) => item.source_type?.toUpperCase() === 'SEC')
  const activeTitle = {
    sec: 'SEC Filings',
    insider: 'Insider Tracker',
    ratings: 'Analyst Ratings',
    analysis: 'Analysis',
  }[activeApp]

  useEffect(() => {
    const feed = document.querySelector('.luna-chat-feed') as HTMLElement | null
    if (feed) {
      feed.scrollTop = feed.scrollHeight
    }
  }, [activeApp, researchTranscript.length])

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
        <div className="luna-titlebar" aria-label="LUNA application window">
          <div className="luna-window-controls" aria-hidden="true">
            <span className="luna-window-control close" />
            <span className="luna-window-control minimize" />
            <span className="luna-window-control maximize" />
          </div>
          <span className="luna-titlebar-label">LUNA · {activeTitle}</span>
          <span className="luna-titlebar-spacer" aria-hidden="true" />
        </div>
        <header className="luna-window-header">
          <div className="luna-mini-ident" aria-label={`Luna analyst for ${activeTicker}`}>
            <span className="luna-mini-name">LUNA</span>
            <span className="luna-mini-divider">·</span>
            <span className="luna-mini-ticker">{activeTicker}</span>
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

        {activeApp === 'analysis' && <main className="luna-chat-feed" aria-live="polite">
          {researchTranscript.length === 0 ? (
            <div className="empty-research-state">No LUNA analysis is available yet.</div>
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

              {message.confidence && <div className="luna-chat-confidence"><span>{message.confidence}</span></div>}

              {message.meta.length > 0 && (
                <div className="mini-meta-row subtle">
                  {message.meta.map((tag) => <span key={`${message.id}-${tag}`}>{tag}</span>)}
                </div>
              )}
            </article>
          ))}
        </main>}

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

      <aside className="luna-window luna-terminal-window" aria-label="LUNA Core Terminal">
        <div className="luna-titlebar luna-terminal-titlebar">
          <div className="luna-window-controls" aria-hidden="true">
            <span className="luna-window-control close" />
            <span className="luna-window-control minimize" />
            <span className="luna-window-control maximize" />
          </div>
          <span className="luna-titlebar-label">LUNA Core Terminal</span>
          <span className="luna-titlebar-spacer" aria-hidden="true" />
        </div>
        <div className="luna-terminal-content">
          <div className="luna-terminal-preview-label">VISUAL PREVIEW · NOT LIVE TELEMETRY</div>
          <p><span>&gt;</span> Initializing SEC monitor...</p>
          <p><span>&gt;</span> Polling EDGAR database... <b>[OK]</b></p>
          <p><span>&gt;</span> Parsing Insider Form 4...</p>
          <p><span>&gt;</span> Awaiting new jobs...</p>
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
