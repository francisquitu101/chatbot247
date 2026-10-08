import { ArrowRight, Sparkles } from 'lucide-react'

export function AppAnalystsPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  return (
    <div className="analysts-page">
      <header className="page-heading simple-heading">
        <div>
          <p className="eyebrow">APP</p>
          <h1>Your analysts</h1>
        </div>
        <button type="button" className="primary-button-inline inverse" onClick={() => onNavigate('/analyst/NVDA')}>
          <ArrowRight size={16} /> Open NVDA analyst
        </button>
      </header>

      <section className="analyst-list-grid">
        <article className="section-card analyst-summary-card">
          <div className="analyst-card-topline">
            <span className="source-badge">NVDA</span>
            <span className="status-pill"><span className="status-dot" /> LIVE</span>
          </div>
          <h2>NVIDIA</h2>
          <p>Persistent public AI analyst for NVIDIA.</p>
          <button type="button" className="secondary-button wide" onClick={() => onNavigate('/analyst/NVDA')}>Open analyst</button>
        </article>

        <article className="section-card analyst-summary-card muted-card">
          <div className="analyst-card-topline">
            <span className="feature-kicker">PLAN</span>
            <Sparkles size={16} />
          </div>
          <h2>Private analyst slots</h2>
          <p>Free: 1 public/demo analyst · Pro: multiple private analysts · Premium: more concurrent analysts.</p>
        </article>
      </section>

    </div>
  )
}
