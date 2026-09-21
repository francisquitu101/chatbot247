import { ArrowRight, BrainCircuit, CheckCircle2, Sparkles } from 'lucide-react'

export function PublicLandingPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  return (
    <main className="landing-page">
      <header className="landing-header">
        <div className="brand-lockup">
          <div className="brand-mark-sm">A</div>
          <span>Astra Research</span>
        </div>
        <nav className="landing-nav">
          <button type="button" onClick={() => onNavigate('/live')}>Watch live</button>
          <button type="button" className="primary-button-inline" onClick={() => onNavigate('/login')}>Create your analyst</button>
        </nav>
      </header>

      <section className="hero-section">
        <div className="hero-copy">
          <p className="eyebrow">AUTONOMOUS AI EQUITY RESEARCH</p>
          <h1>Watch an AI analyst work.</h1>
          <p className="hero-subtitle">AI analysts continuously monitor new evidence, update their thesis, and show you what changed.</p>
          <div className="hero-actions">
            <button type="button" className="primary-button-full" onClick={() => onNavigate('/live')}>
              WATCH LIVE <ArrowRight size={18} />
            </button>
            <button type="button" className="secondary-button" onClick={() => onNavigate('/login')}>
              CREATE YOUR ANALYST
            </button>
          </div>
          <ul className="trust-list">
            <li><CheckCircle2 size={16} /> Evidence-backed decision making</li>
            <li><CheckCircle2 size={16} /> Thesis and valuation revisions over time</li>
            <li><CheckCircle2 size={16} /> Persistent analyst state architecture</li>
          </ul>
        </div>

        <div className="hero-visual section-card">
          <div className="hero-card-header">
            <span className="status-pill"><span className="status-dot" /> LIVE</span>
            <span className="source-badge">NVDA</span>
          </div>
          <div className="hero-analyst-summary">
            <h2>AI Analyst</h2>
            <p>Updated after review of latest evidence.</p>
          </div>
          <div className="hero-metric-row">
            <div>
              <span>Fair Value</span>
              <strong>$28.40</strong>
            </div>
            <div>
              <span>Thesis</span>
              <strong>Cautiously Bullish</strong>
            </div>
          </div>
          <div className="mini-feed">
            <div><Sparkles size={14} /> SEC filing detected</div>
            <div><BrainCircuit size={14} /> Cash runway assumption updated</div>
            <div><Sparkles size={14} /> Fair value recalculated</div>
          </div>
        </div>
      </section>

      <section className="feature-grid">
        <div className="section-card feature-card">
          <span className="feature-kicker">Decision stream</span>
          <h3>See what changed.</h3>
          <p>Each update is tied to concrete evidence and an explicit impact on the thesis or valuation.</p>
        </div>
        <div className="section-card feature-card">
          <span className="feature-kicker">Thesis engine</span>
          <h3>Keep a living investment view.</h3>
          <p>The analyst evolves through document review, scenario updates, and versioned reasoning.</p>
        </div>
        <div className="section-card feature-card">
          <span className="feature-kicker">Private workspace</span>
          <h3>Launch a tailored analyst.</h3>
          <p>Prepare the product for private analysts tied to a user, ticker, and configurable state model.</p>
        </div>
      </section>
    </main>
  )
}
