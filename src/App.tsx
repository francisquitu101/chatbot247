import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { ensureUserProfile } from './lib/auth'
import { supabase } from './lib/supabase'
import { TerminalLoader } from './components/TerminalLoader'
import { PublicAnalystPage } from './pages/PublicAnalystPage'

type CheckoutStatus = 'success' | 'pending' | 'failure'

type AppRoute = {
  ticker: string
  checkoutStatus?: CheckoutStatus
}

function routeFromLocation(): AppRoute {
  const pathname = window.location.pathname.replace(/\/+$/, '') || '/'
  const checkoutMatch = pathname.match(/^\/checkout\/(success|pending|failure)$/i)
  if (checkoutMatch) {
    return {
      ticker: 'NVDA',
      checkoutStatus: checkoutMatch[1].toLowerCase() as CheckoutStatus,
    }
  }
  const analystMatch = pathname.match(/^\/analyst\/([^/]+)$/i)
  if (analystMatch) return { ticker: decodeURIComponent(analystMatch[1]).toUpperCase() }

  return { ticker: 'NVDA' }
}

function CheckoutReturnPage({ status }: { status: CheckoutStatus }) {
  const content = {
    success: {
      eyebrow: 'PAYMENT CONFIRMED',
      title: 'Payment Successful.',
      message: 'Welcome to MarketMole Pro!',
      detail: 'Your Pro access will be ready as soon as the payment confirmation finishes syncing.',
    },
    pending: {
      eyebrow: 'PAYMENT PROCESSING',
      title: 'Your payment is pending.',
      message: 'We will activate MarketMole Pro when Mercado Pago confirms it.',
      detail: 'You can return to MarketMole; your Pro status will refresh automatically after confirmation.',
    },
    failure: {
      eyebrow: 'PAYMENT NOT COMPLETED',
      title: 'We could not confirm your payment.',
      message: 'No Pro subscription was activated.',
      detail: 'You can return to MarketMole and try checkout again.',
    },
  }[status]

  return (
    <main className="checkout-return">
      <section className={`checkout-return-card checkout-return-${status}`} aria-labelledby="checkout-return-title">
        <span className="checkout-return-mark" aria-hidden="true">{status === 'success' ? '✓' : status === 'pending' ? '…' : '!'}</span>
        <p className="checkout-return-eyebrow">{content.eyebrow}</p>
        <h1 id="checkout-return-title">{content.title}</h1>
        <p className="checkout-return-message">{content.message}</p>
        <p className="checkout-return-detail">{content.detail}</p>
        <a className="checkout-return-button" href="/">Return to Dashboard</a>
      </section>
    </main>
  )
}

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [route, setRoute] = useState<AppRoute>(routeFromLocation)

  useEffect(() => {
    if (!supabase) {
      setAuthLoading(false)
      return
    }

    const client = supabase
    let isActive = true

    const hydrateSession = async () => {
      const { data } = await client.auth.getSession()
      if (!isActive) return
      setSession(data.session)
      if (data.session) {
        try {
          await ensureUserProfile()
        } catch {
          // The profile bootstrap is best-effort; the public analyst remains available.
        }
      }
      setAuthLoading(false)
    }

    void hydrateSession()

    const { data: listener } = client.auth.onAuthStateChange(async (_event, nextSession) => {
      if (!isActive) return
      setSession(nextSession)
      if (nextSession) {
        try {
          await ensureUserProfile()
        } catch {
          // The profile bootstrap is best-effort; the public analyst remains available.
        }
      }
    })
    const onPopState = () => setRoute(routeFromLocation())
    window.addEventListener('popstate', onPopState)

    return () => {
      isActive = false
      listener.subscription.unsubscribe()
      window.removeEventListener('popstate', onPopState)
    }
  }, [])

  if (authLoading) {
    return <TerminalLoader message="Preparing MarketMole..." />
  }

  if (route.checkoutStatus) {
    return <CheckoutReturnPage status={route.checkoutStatus} />
  }

  if (!supabase) {
    return <div className="center-state"><strong>Supabase configuration is missing.</strong><span>Add the public Vite environment variables to start the app.</span></div>
  }

  const authenticatedClient = supabase

  return (
    <PublicAnalystPage
      ticker={route.ticker ?? 'NVDA'}
      session={session}
      onSignOut={() => void authenticatedClient.auth.signOut()}
    />
  )
}

export default App
