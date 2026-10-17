import type { ReactNode } from 'react'

export function Navbar({ children }: { children?: ReactNode }) {
  return (
    <nav className="norvexai-navbar" aria-label="Main navigation">
      <a className="norvexai-navbar-brand" href="/" aria-label="Norvexai home">
        <img src="/branding/norvexai-logo-cropped.png" alt="Norvexai by N01 Labs" />
      </a>
      {children}
    </nav>
  )
}
