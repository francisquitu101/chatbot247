import type { ReactNode } from 'react'

export function Navbar({ children }: { children?: ReactNode }) {
  return (
    <nav className="marketmole-navbar" aria-label="Main navigation">
      <a className="marketmole-navbar-brand" href="/" aria-label="Norvexai home">
        <img src="/branding/norvexai-logo-cropped.png" alt="Norvexai by N01 Labs" />
      </a>
      {children}
      <span className="marketmole-navbar-caption">INDEPENDENT MARKET INTELLIGENCE</span>
    </nav>
  )
}
