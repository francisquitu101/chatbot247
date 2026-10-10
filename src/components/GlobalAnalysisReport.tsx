import { Download } from 'lucide-react'

export type GlobalAnalysisBibliographyItem = {
  ref: string
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

function CitationText({ text, bibliography }: { text: string; bibliography: GlobalAnalysisBibliographyItem[] }) {
  const knownReferences = new Set(bibliography.map((source) => source.ref))
  const parts = (text ?? '').split(/(\[\d+\])/g)

  return parts.map((part, index) => {
    const citation = part.match(/^\[(\d+)\]$/)
    if (!citation || !knownReferences.has(citation[1])) return part
    return (
      <sup className="citation-link" key={`${index}-${citation[1]}`}>
        <a href={`#bib-${citation[1]}`} aria-label={`Bibliography reference ${citation[1]}`}>
          {citation[1]}
        </a>
      </sup>
    )
  })
}

export function GlobalAnalysisReport({ report }: GlobalAnalysisReportProps) {
  const { analysis, bibliography, data_counts: counts } = report

  return (
    <article className="institutional-report" aria-label={`${report.ticker} due diligence report`}>
      <div className="institutional-report-actions">
        <button type="button" className="global-analysis-export-button" onClick={() => window.print()}>
          <Download size={14} />
          Export PDF
        </button>
      </div>
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
        <p><CitationText text={analysis.executive_summary} bibliography={bibliography} /></p>
        <ul>
          {analysis.key_findings.map((finding, index) => (
            <li key={`${index}-${finding}`}><CitationText text={finding} bibliography={bibliography} /></li>
          ))}
        </ul>
      </section>

      <section className="institutional-report-section">
        <h3>2. SEC Filings Analysis</h3>
        <p><CitationText text={analysis.sec_filings_analysis} bibliography={bibliography} /></p>
      </section>

      <section className="institutional-report-section">
        <h3>3. Financial Metrics</h3>
        {analysis.financial_metrics.length > 0 ? (
          <div className="report-table-wrap">
            <table className="report-metrics-table">
              <thead>
                <tr><th>Metric</th><th>Value</th></tr>
              </thead>
              <tbody>
                {analysis.financial_metrics.map((metric, index) => (
                  <tr key={`${metric.metric}-${index}`}>
                    <th scope="row">{metric.metric}</th>
                    <td>{metric.value}</td>
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
                <strong><CitationText text={risk.risk} bibliography={bibliography} /></strong>
                <span className={`report-risk-severity severity-${risk.severity.toLowerCase()}`}>{risk.severity}</span>
                <p><CitationText text={risk.details} bibliography={bibliography} /></p>
              </li>
            ))}
          </ol>
        ) : <p>No specific risks could be substantiated from the available evidence.</p>}
      </section>

      <section className="institutional-report-section">
        <h3>5. Catalysts and Developments</h3>
        {analysis.catalysts.length > 0
          ? <ul>{analysis.catalysts.map((catalyst, index) => <li key={`${index}-${catalyst}`}><CitationText text={catalyst} bibliography={bibliography} /></li>)}</ul>
          : <p>No sourced catalysts were identified in the reviewed materials.</p>}
      </section>

      <section className="institutional-report-section">
        <h3>6. Conclusion</h3>
        <p><CitationText text={analysis.conclusion} bibliography={bibliography} /></p>
      </section>

      <section className="institutional-report-section report-bibliography">
        <h3>7. Bibliography</h3>
        {bibliography.length > 0 ? (
          <ol>
            {bibliography.map((source) => (
              <li id={`bib-${source.ref}`} key={source.ref}>
                <strong>[{source.ref}] {source.title || 'Untitled source'}</strong>
                <span>{formatReportTimestamp(source.published_at)}</span>
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
