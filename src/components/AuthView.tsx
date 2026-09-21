import { useState } from 'react'
import { Chrome } from 'lucide-react'
import { getAuthRedirectUrl, supabase } from '../lib/supabase'

export function AuthView() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase) return
    setBusy(true)
    setError(null)

    try {
      const result = mode === 'sign-in'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password })

      if (result.error) {
        setError(result.error.message)
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Unable to authenticate.')
    } finally {
      setBusy(false)
    }
  }

  async function handleGoogleSignIn() {
    if (!supabase) return

    setBusy(true)
    setError(null)

    try {
      const redirectUrl = getAuthRedirectUrl('/app')
      const result = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: redirectUrl },
      })

      if (result.error) {
        setError(result.error.message)
      }
    } catch (signInError) {
      setError(signInError instanceof Error ? signInError.message : 'Google sign-in failed.')
    } finally {
      setBusy(false)
    }
  }

  return <main className="auth-shell">
    <section className="auth-panel auth-panel-simple">
      <p className="eyebrow">AUTONOMOUS AI EQUITY RESEARCH</p>
      <h1>Access your analyst</h1>
      <div className="auth-actions-stack">
        <button type="button" className="google-button" onClick={() => void handleGoogleSignIn()} disabled={busy}>
          <Chrome size={18} />
          Continue with Google
        </button>
      </div>

      <div className="divider"><span>or continue with email</span></div>

      <form onSubmit={submit} className="auth-form">
        <label>Email<input className="auth-input" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
        <label>Password<input className="auth-input" type="password" autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'} value={password} onChange={(event) => setPassword(event.target.value)} minLength={6} required /></label>
        {error && <p className="form-error">{error}</p>}
        <button className="primary-button" disabled={busy}>{busy ? 'Connecting...' : mode === 'sign-in' ? 'Sign in' : 'Create account'}</button>
      </form>
      <button className="text-button" type="button" onClick={() => { setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in'); setError(null) }}>
        {mode === 'sign-in' ? 'Need an account? Create one' : 'Already have an account? Sign in'}
      </button>
    </section>
  </main>
}
