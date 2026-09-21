import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { NotificationPreferences } from '../types'

export function NotificationPreferences() {
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    loadPreferences()
  }, [])

  async function loadPreferences() {
    try {
      setLoading(true)
      setError(null)

      if (!supabase) {
        setError('Supabase not initialized')
        return
      }

      const client: NonNullable<typeof supabase> = supabase

      const {
        data: { user },
      } = await supabase.auth.getUser()

      if (!user) {
        setError('Not authenticated')
        return
      }

      const { data, error: fetchError } = await client
        .from('notification_preferences')
        .select('*')
        .eq('user_id', user.id)
        .single()

      if (fetchError) {
        if (fetchError.code === 'PGRST116') {
          // No preferences found, create default ones
          const { data: newPrefs, error: createError } = await client
            .from('notification_preferences')
            .insert({
              user_id: user.id,
              email: user.email || '',
              email_enabled: true,
              news_enabled: true,
              sec_enabled: true,
              ratings_enabled: true,
              insider_trades_enabled: true,
            })
            .select()
            .single()

          if (createError) throw createError
          setPrefs(newPrefs as unknown as NotificationPreferences)
        } else {
          throw fetchError
        }
      } else {
        setPrefs(data as unknown as NotificationPreferences)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load preferences')
    } finally {
      setLoading(false)
    }
  }

  async function savePreferences(updates: Partial<NotificationPreferences>) {
    if (!prefs || !supabase) return

    const client: NonNullable<typeof supabase> = supabase

    try {
      setSaving(true)
      setError(null)
      setSuccess(false)

      const { error: updateError } = await client
        .from('notification_preferences')
        .update(updates)
        .eq('user_id', prefs.user_id)

      if (updateError) throw updateError

      setPrefs({ ...prefs, ...updates })
      setSuccess(true)
      setTimeout(() => setSuccess(false), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save preferences')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="notification-preferences"><p>Loading preferences...</p></div>
  }

  if (!prefs) {
    return <div className="notification-preferences"><p>Could not load preferences</p></div>
  }

  return (
    <div className="notification-preferences">
      <h2>Email Notifications</h2>

      {error && <div className="error-message">{error}</div>}
      {success && <div className="success-message">Preferences saved successfully</div>}

      <div className="preferences-section">
        <label className="preference-group">
          <input
            type="checkbox"
            checked={prefs.email_enabled}
            onChange={(e) =>
              savePreferences({
                ...prefs,
                email_enabled: e.target.checked,
              })
            }
            disabled={saving}
          />
          <span className="preference-label">
            <strong>Enable email notifications</strong>
            <em>Receive notifications about new market data</em>
          </span>
        </label>
      </div>

      {prefs.email_enabled && (
        <div className="preferences-section">
          <p className="section-title">Notification types</p>

          <label className="preference-option">
            <input
              type="checkbox"
              checked={prefs.news_enabled}
              onChange={(e) =>
                savePreferences({
                  ...prefs,
                  news_enabled: e.target.checked,
                })
              }
              disabled={saving}
            />
            <span>News</span>
          </label>

          <label className="preference-option">
            <input
              type="checkbox"
              checked={prefs.sec_enabled}
              onChange={(e) =>
                savePreferences({
                  ...prefs,
                  sec_enabled: e.target.checked,
                })
              }
              disabled={saving}
            />
            <span>SEC Filings</span>
          </label>

          <label className="preference-option">
            <input
              type="checkbox"
              checked={prefs.ratings_enabled}
              onChange={(e) =>
                savePreferences({
                  ...prefs,
                  ratings_enabled: e.target.checked,
                })
              }
              disabled={saving}
            />
            <span>Analyst Ratings</span>
          </label>

          <label className="preference-option">
            <input
              type="checkbox"
              checked={prefs.insider_trades_enabled}
              onChange={(e) =>
                savePreferences({
                  ...prefs,
                  insider_trades_enabled: e.target.checked,
                })
              }
              disabled={saving}
            />
            <span>Insider Trades</span>
          </label>
        </div>
      )}

      <div className="preferences-footer">
        <p className="info-text">
          <strong>Email:</strong> {prefs.email}
        </p>
        <p className="info-text">
          Notifications will only be sent for new data matching your watched tickers and enabled preferences.
        </p>
      </div>
    </div>
  )
}
