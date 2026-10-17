import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { ensureUserProfile } from './lib/auth'
import { supabase } from './lib/supabase'
import { TerminalLoader } from './components/TerminalLoader'
import { PublicAnalystPage } from './pages/PublicAnalystPage'

type CheckoutStatus = 'success' | 'pending' | 'failure'
type PayPalCheckoutState = 'loading' | 'active' | 'legacy_completed' | 'pending' | 'failed' | null

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
  const [subscriptionState, setSubscriptionState] = useState<PayPalCheckoutState>(null)

  useEffect(() => {
    if (status !== 'success') return

    let active = true
    let attempts = 0
    let retryTimer: number | undefined
    const confirmSubscription = async () => {
      const query = new URLSearchParams(window.location.search)
      const subscriptionId = query.get('subscription_id')
      const legacyOrderId = query.get('token')
      if (!supabase || !session || (!subscriptionId && !legacyOrderId)) {
        if (active) setSubscriptionState('failed')
        return
      }

      attempts += 1
      if (attempts === 1) setSubscriptionState('loading')
      try {
        const result = subscriptionId
          ? await supabase.functions.invoke<{
            success: boolean
            data?: { status?: string }
          }>('confirm-paypal-subscription', {
            body: { subscription_id: subscriptionId },
          })
          : await supabase.functions.invoke<{
          success: boolean
          data?: { status?: string }
        }>('capture-paypal-order', { body: { order_id: legacyOrderId } })
        const { data: response, error } = result
        if (!active) return
        if (!error && response?.success === true && response.data?.status === 'active') {
          setSubscriptionState('active')
        } else if (
          !error &&
          response?.success === true &&
          response.data?.status === 'completed'
        ) {
          setSubscriptionState('legacy_completed')
        } else if (
          attempts < 12 &&
          (!response?.success || response.data?.status === 'approval_pending' || error)
        ) {
          setSubscriptionState('pending')
          retryTimer = window.setTimeout(() => void confirmSubscription(), 5_000)
        } else {
          setSubscriptionState('failed')
        }
      } catch {
        if (!active) return
        if (attempts < 12) {
          setSubscriptionState('pending')
          retryTimer = window.setTimeout(() => void confirmSubscription(), 5_000)
        } else {
          setSubscriptionState('failed')
        }
      }
    }

    void confirmSubscription()
    return () => {
      active = false
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
    }
  }, [session, status])

  const content = status === 'success'
    ? subscriptionState === 'active'
      ? {
          eyebrow: 'SUBSCRIPTION ACTIVE',
          title: 'Welcome to Pro.',
          message: 'Welcome to Norvexai Pro!',
          detail: 'Your monthly PayPal subscription is active. Your Watchlist now supports up to 10 tickers.',
        }
      : subscriptionState === 'legacy_completed'
        ? {
            eyebrow: 'PAYMENT CONFIRMED',
            title: 'Welcome to Pro.',
            message: 'Welcome to Norvexai Pro!',
            detail: 'Your PayPal payment was captured and Pro access is active.',
          }
      : subscriptionState === 'pending'
        ? {
            eyebrow: 'SUBSCRIPTION PENDING',
            title: 'PayPal is still processing your approval.',
            message: 'Pro access is not active yet.',
            detail: 'Keep this page open briefly or return later after PayPal confirms the subscription.',
          }
      : subscriptionState === 'failed'
        ? {
            eyebrow: 'SUBSCRIPTION NOT CONFIRMED',
            title: 'We could not confirm your subscription.',
            message: 'Pro access has not been activated.',
            detail: 'Sign in with the account used for checkout, then reload this page to retry the confirmation.',
          }
        : {
            eyebrow: 'VERIFYING SUBSCRIPTION',
            title: 'Confirming your PayPal subscription…',
            message: 'Please keep this page open.',
            detail: 'PayPal approval is complete; Norvexai is verifying the recurring plan.',
          }
    : status === 'pending'
      ? {
          eyebrow: 'SUBSCRIPTION PROCESSING',
          title: 'Your subscription is pending.',
          message: 'PayPal has not activated the subscription yet.',
          detail: 'You can return to Norvexai and check again later.',
        }
      : {
          eyebrow: 'SUBSCRIPTION NOT COMPLETED',
          title: 'We could not confirm your subscription.',
          message: 'No Pro access was activated.',
          detail: 'You can return to Norvexai and try checkout again.',
        }
  const displayStatus = status === 'success' && subscriptionState === 'failed'
    ? 'failure'
    : status === 'success' && subscriptionState === 'pending'
      ? 'pending'
      : status
  const isVerifying = status === 'success' && (subscriptionState === null || subscriptionState === 'loading')

  return (
    <main className="checkout-return">
      <section className={`checkout-return-card checkout-return-${displayStatus}`} aria-labelledby="checkout-return-title" aria-busy={isVerifying}>
        <span className="checkout-return-mark" aria-hidden="true">{displayStatus === 'success' ? '✓' : displayStatus === 'pending' || isVerifying ? '…' : '!'}</span>
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
    return <TerminalLoader message="Preparing Norvexai..." />
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
