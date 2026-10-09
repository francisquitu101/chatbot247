export function TerminalLoader({ message = 'Loading analyst data streams...' }: { message?: string }) {
  return (
    <main className="terminal-loader" role="status" aria-live="polite">
      <section className="terminal-loader-window" aria-label="MarketMole startup">
        <div className="terminal-loader-titlebar">
          <span />
          <span />
          <span />
          <strong>marketmole://boot</strong>
        </div>
        <div className="terminal-loader-body">
          <p><span>&gt;</span> MarketMole Intelligence System</p>
          <p><span>&gt;</span> Initializing secure market streams...</p>
          <p className="terminal-loader-current"><span>&gt;</span> {message}<i aria-hidden="true" /></p>
          <div className="terminal-loader-progress"><span /></div>
        </div>
      </section>
    </main>
  )
}
