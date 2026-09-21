import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { AuthView } from './components/AuthView'
import { ApplicationShell } from './components/layout/ApplicationShell'
import { NotificationPreferences } from './components/NotificationPreferences'
import { ensureUserProfile } from './lib/auth'
import { supabase } from './lib/supabase'
import { I18nProvider } from './i18n/I18nProvider'
import { PublicLandingPage } from './pages/PublicLandingPage'
import { PublicAnalystPage } from './pages/PublicAnalystPage'
import { AppAnalystsPage } from './pages/AppAnalystsPage'
import { PrivateAnalystWorkspacePage } from './pages/PrivateAnalystWorkspacePage'

function routeFromLocation() {
  const pathname = window.location.pathname.replace(/\/+$/, '') || '/'

  if (pathname === '/') return { name: 'public-analyst' as const, ticker: 'NVDA' }
  if (pathname === '/live') return { name: 'public-analyst' as const, ticker: 'NVDA' }
  if (pathname === '/login') return { name: 'login' as const, ticker: null }
  if (pathname === '/app') return { name: 'app' as const, ticker: null }
  if (pathname === '/app/analysts') return { name: 'app-analysts' as const, ticker: null }
  if (pathname === '/settings') return { name: 'settings' as const, ticker: null }

  const publicAnalystMatch = pathname.match(/^\/analyst\/([^/]+)$/i)
  if (publicAnalystMatch) return { name: 'public-analyst' as const, ticker: decodeURIComponent(publicAnalystMatch[1]).toUpperCase() }

  const privateAnalystMatch = pathname.match(/^\/app\/analysts\/([^/]+)$/i)
  if (privateAnalystMatch) return { name: 'private-analyst' as const, ticker: decodeURIComponent(privateAnalystMatch[1]).toUpperCase() }

  return { name: 'landing' as const, ticker: null }
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
          // The profile bootstrap is best-effort at runtime; the app will continue with the session.
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
          // Ignore profile bootstrap failures; session remains valid and UI can still render.
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

  function navigate(path: string) {
    window.history.pushState({}, '', path)
    setRoute(routeFromLocation())
  }

  const isPublicRoute = route.name === 'landing' || route.name === 'public-analyst'
  const isPrivateRoute = route.name === 'app' || route.name === 'app-analysts' || route.name === 'private-analyst' || route.name === 'settings'

  if (authLoading) {
    return <div className="center-state"><strong>Authenticating...</strong><span>Preparing the analyst workspace.</span></div>
  }

  if (!supabase) {
    return <div className="center-state"><strong>Supabase configuration is missing.</strong><span>Add the public Vite environment variables to start the app.</span></div>
  }

  if (!session && route.name === 'login') {
    return <AuthView />
  }

  if (!session && isPublicRoute) {
    if (route.name === 'public-analyst' && route.ticker) return <PublicAnalystPage ticker={route.ticker} />
    return <PublicAnalystPage ticker="NVDA" />
  }

  if (!session && isPrivateRoute) {
    return <AuthView />
  }

  if (route.name === 'public-analyst' && route.ticker) return <PublicAnalystPage ticker={route.ticker} />
  return <PublicAnalystPage ticker="NVDA" />

  const authenticatedSupabase = supabase as NonNullable<typeof supabase>

  if (route.name === 'settings') {
    return (
      <I18nProvider session={session!}>
        <ApplicationShell session={session!} onSignOut={() => void authenticatedSupabase.auth.signOut()} onNavigate={navigate}>
          <div className="settings-page">
            <section className="page-heading simple-heading"><div><h1>Settings</h1></div></section>
            <NotificationPreferences />
          </div>
        </ApplicationShell>
      </I18nProvider>
    )
  }

  if (route.name === 'app') {
    return (
      <I18nProvider session={session!}>
        <ApplicationShell session={session!} onSignOut={() => void authenticatedSupabase.auth.signOut()} onNavigate={navigate}>
          <AppAnalystsPage onNavigate={navigate} />
        </ApplicationShell>
      </I18nProvider>
    )
  }

  if (route.name === 'app-analysts') {
    return (
      <I18nProvider session={session!}>
        <ApplicationShell session={session!} onSignOut={() => void authenticatedSupabase.auth.signOut()} onNavigate={navigate}>
          <AppAnalystsPage onNavigate={navigate} />
        </ApplicationShell>
      </I18nProvider>
    )
  }

  if (route.name === 'private-analyst') {
    const privateTicker = route.ticker ?? 'NVDA'

    return (
      <I18nProvider session={session!}>
        <ApplicationShell session={session!} onSignOut={() => void authenticatedSupabase.auth.signOut()} onNavigate={navigate}>
          <PrivateAnalystWorkspacePage ticker={privateTicker} onNavigate={navigate} />
        </ApplicationShell>
      </I18nProvider>
    )
  }

  return (
    <I18nProvider session={session!}>
      <ApplicationShell session={session!} onSignOut={() => void authenticatedSupabase.auth.signOut()} onNavigate={navigate}>
        <AppAnalystsPage onNavigate={navigate} />
      </ApplicationShell>
    </I18nProvider>
  )
}

export default App
