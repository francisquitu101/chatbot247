export type GlobalAnalysisBibliographyItem = {
  ref: string
  record_id: string
  source_type: string
  title: string
  published_at: string | null
  url: string | null
}

export type GlobalTickerAnalysis = {
  ticker: string
  analysis: {
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
  bibliography: GlobalAnalysisBibliographyItem[]
  generated_at: string
  data_counts: {
    news: number
    sec_filings: number
    insider_trades: number
    analyst_ratings: number
  }
}

type GlobalAnalysisReportProps = {
  report: GlobalTickerAnalysis
}

function formatReportTimestamp(value: string | null) {
  if (!value) return 'Date unavailable'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Date unavailable'
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(date)
}

function getExternalUrl(value: string | null) {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

function SourceReferences({ refs }: { refs: string[] }) {
  if (refs.length === 0) return null
  return <p className="report-source-refs">Sources: {refs.join(', ')}</p>
}

export function GlobalAnalysisReport({ report }: GlobalAnalysisReportProps) {
  const { analysis, bibliography, data_counts: counts } = report

  return (
    <article className="institutional-report" aria-label={`${report.ticker} due diligence report`}>
      <header className="institutional-report-cover">
        <p className="institutional-report-brand">MarketMole · Institutional Research</p>
        <span className={`report-sentiment sentiment-${analysis.sentiment.toLowerCase()}`}>
          {analysis.sentiment} assessment
        </span>
        <h2>{report.ticker} | Equity Due Diligence</h2>
        <p>Evidence-based market and filing review · Generated {formatReportTimestamp(report.generated_at)}</p>
        <p className="report-data-counts">
          Source coverage: {counts.sec_filings} SEC filings · {counts.news} news items · {counts.insider_trades} insider transactions · {counts.analyst_ratings} analyst ratings
        </p>
      </header>

      <section className="institutional-report-section">
        <h3>1. Executive Summary</h3>
        <p>{analysis.executive_summary}</p>
        <ul>
          {analysis.key_findings.map((finding, index) => <li key={`${index}-${finding}`}>{finding}</li>)}
        </ul>
      </section>

      <section className="institutional-report-section">
        <h3>2. SEC Filings Analysis</h3>
        <p>{analysis.sec_filings_analysis}</p>
      </section>

      <section className="institutional-report-section">
        <h3>3. Financial Metrics</h3>
        {analysis.financial_metrics.length > 0 ? (
          <div className="report-table-wrap">
            <table className="report-metrics-table">
              <thead>
                <tr><th>Metric</th><th>Reported value</th><th>Change</th><th>Evidence</th></tr>
              </thead>
              <tbody>
                {analysis.financial_metrics.map((metric, index) => (
                  <tr key={`${metric.metric}-${index}`}>
                    <th scope="row">{metric.metric}</th>
                    <td>{metric.value}</td>
                    <td>{metric.change_percent ?? 'Not provided'}</td>
                    <td>{metric.source_refs.length > 0 ? metric.source_refs.join(', ') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p>No supported financial metrics were available in the collected source data.</p>}
      </section>

      <section className="institutional-report-section">
        <h3>4. Risk Evaluation</h3>
        {analysis.risk_assessment.length > 0 ? (
          <ol className="report-risk-list">
            {analysis.risk_assessment.map((risk, index) => (
              <li key={`${risk.risk}-${index}`}>
                <strong>{risk.risk}</strong>
                <span className={`report-risk-severity severity-${risk.severity.toLowerCase()}`}>{risk.severity}</span>
                <p>{risk.details}</p>
                <SourceReferences refs={risk.source_refs} />
              </li>
            ))}
          </ol>
        ) : <p>No specific risks could be substantiated from the available evidence.</p>}
      </section>

      <section className="institutional-report-section">
        <h3>5. Catalysts and Developments</h3>
        {analysis.catalysts.length > 0
          ? <ul>{analysis.catalysts.map((catalyst, index) => <li key={`${index}-${catalyst}`}>{catalyst}</li>)}</ul>
          : <p>No sourced catalysts were identified in the reviewed materials.</p>}
      </section>

      <section className="institutional-report-section">
        <h3>6. Conclusion</h3>
        <p>{analysis.conclusion}</p>
      </section>

      <section className="institutional-report-section report-bibliography">
        <h3>7. Bibliography</h3>
        {bibliography.length > 0 ? (
          <ol>
            {bibliography.map((source) => (
              <li key={source.ref}>
                <strong>[{source.ref}] {source.title || 'Untitled source'}</strong>
                <span>{source.source_type} · {formatReportTimestamp(source.published_at)}</span>
                <span>Database record: {source.record_id}</span>
                {getExternalUrl(source.url) && (
                  <a href={getExternalUrl(source.url) ?? undefined} target="_blank" rel="noreferrer">
                    {getExternalUrl(source.url)}
                  </a>
                )}
              </li>
            ))}
          </ol>
        ) : <p>No source documents were available for this report.</p>}
      </section>

      <footer className="institutional-report-disclaimer">
        This report summarizes collected public information and is not investment advice. Verify source documents before relying on any finding.
      </footer>
    </article>
  )
}
