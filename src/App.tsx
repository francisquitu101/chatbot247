import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { ensureUserProfile } from './lib/auth'
import { supabase } from './lib/supabase'
import { TerminalLoader } from './components/TerminalLoader'
import { PublicAnalystPage } from './pages/PublicAnalystPage'

type CheckoutStatus = 'success' | 'pending' | 'failure'
type PayPalCaptureState = 'loading' | 'completed' | 'failed' | null

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

function CheckoutReturnPage({ status, session }: { status: CheckoutStatus; session: Session | null }) {
  const [captureState, setCaptureState] = useState<PayPalCaptureState>(null)

  useEffect(() => {
    if (status !== 'success') return

    let active = true
    const capturePayment = async () => {
      const orderId = new URLSearchParams(window.location.search).get('token')
      if (!supabase || !session || !orderId) {
        if (active) setCaptureState('failed')
        return
      }

      setCaptureState('loading')
      try {
        const { data: response, error } = await supabase.functions.invoke<{
          success: boolean
          data?: { status?: string }
        }>('capture-paypal-order', { body: { order_id: orderId } })
        if (!active) return
        setCaptureState(!error && response?.success === true && response.data?.status === 'completed'
          ? 'completed'
          : 'failed')
      } catch {
        if (active) setCaptureState('failed')
      }
    }

    void capturePayment()
    return () => { active = false }
  }, [session, status])

  const content = status === 'success'
    ? captureState === 'completed'
      ? {
          eyebrow: 'PAYMENT CONFIRMED',
          title: 'Payment Successful.',
          message: 'Welcome to MarketMole Pro!',
          detail: 'Your PayPal payment was captured and Pro access is active.',
        }
      : captureState === 'failed'
        ? {
            eyebrow: 'PAYMENT NOT CONFIRMED',
            title: 'We could not confirm your payment.',
            message: 'Pro access has not been activated.',
            detail: 'Sign in with the account used for checkout, then reload this page to retry the confirmation.',
          }
        : {
            eyebrow: 'CAPTURING PAYMENT',
            title: 'Confirming your payment…',
            message: 'Please keep this page open.',
            detail: 'PayPal approval is complete; MarketMole is securely capturing your payment.',
          }
    : status === 'pending'
      ? {
          eyebrow: 'PAYMENT PROCESSING',
          title: 'Your payment is pending.',
          message: 'PayPal has not completed this payment yet.',
          detail: 'You can return to MarketMole and check again later.',
        }
      : {
          eyebrow: 'PAYMENT NOT COMPLETED',
          title: 'We could not confirm your payment.',
          message: 'No Pro subscription was activated.',
          detail: 'You can return to MarketMole and try checkout again.',
        }
  const displayStatus = status === 'success' && captureState === 'failed' ? 'failure' : status
  const isCapturing = status === 'success' && (captureState === null || captureState === 'loading')

  return (
    <main className="checkout-return">
      <section className={`checkout-return-card checkout-return-${displayStatus}`} aria-labelledby="checkout-return-title" aria-busy={isCapturing}>
        <span className="checkout-return-mark" aria-hidden="true">{displayStatus === 'success' ? '✓' : displayStatus === 'pending' || isCapturing ? '…' : '!'}</span>
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
    return <CheckoutReturnPage status={route.checkoutStatus} session={session} />
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
