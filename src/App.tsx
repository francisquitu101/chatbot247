import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { ensureUserProfile } from './lib/auth'
import { supabase } from './lib/supabase'
import { PublicAnalystPage } from './pages/PublicAnalystPage'

function routeFromLocation() {
  const pathname = window.location.pathname.replace(/\/+$/, '') || '/'
  const analystMatch = pathname.match(/^\/analyst\/([^/]+)$/i)
  if (analystMatch) return { ticker: decodeURIComponent(analystMatch[1]).toUpperCase() }

  return { ticker: 'NVDA' }
}

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [route, setRoute] = useState(routeFromLocation)

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
    return <div className="center-state"><strong>Preparing MarketMole...</strong></div>
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
