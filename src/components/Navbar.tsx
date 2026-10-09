export function Navbar() {
  return (
    <nav className="marketmole-navbar" aria-label="Main navigation">
      <a className="marketmole-navbar-brand" href="/" aria-label="MarketMole home">
        <span>Market</span>
        <strong>Mole</strong>
        <span className="marketmole-navbar-dot" aria-hidden="true">.</span>
      </a>
      <span className="marketmole-navbar-caption">INDEPENDENT MARKET INTELLIGENCE</span>
    </nav>
  )
}
