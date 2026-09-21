import { ArrowLeft } from 'lucide-react'
import { AnalystExperienceDisplay } from './PublicAnalystPage'

export function PrivateAnalystWorkspacePage({ ticker, onNavigate }: { ticker: string; onNavigate: (path: string) => void }) {
  return (
    <div className="private-workspace-page">
      <header className="page-heading simple-heading private-header">
        <div>
          <button type="button" className="back-link-button" onClick={() => onNavigate('/app/analysts')}>
            <ArrowLeft size={16} /> Back to analysts
          </button>
          <p className="eyebrow">PRIVATE WORKSPACE</p>
          <h1>{ticker.toUpperCase()} analyst</h1>
        </div>
      </header>
      <AnalystExperienceDisplay ticker={ticker} privateView />
    </div>
  )
}
