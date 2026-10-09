import type { ReactNode } from 'react'

export function Navbar({ children }: { children?: ReactNode }) {
  return (
    <nav className="marketmole-navbar" aria-label="Main navigation">
      <a className="marketmole-navbar-brand" href="/" aria-label="MarketMole home">
        <span>Market</span>
        <strong>Mole</strong>
        <span className="marketmole-navbar-dot" aria-hidden="true">.</span>
      </a>
      {children}
      <span className="marketmole-navbar-caption">INDEPENDENT MARKET INTELLIGENCE</span>
    </nav>
  )
}
