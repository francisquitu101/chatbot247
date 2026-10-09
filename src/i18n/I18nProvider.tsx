import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { translations, translate, type Language } from './translations'
import { I18nContext } from './I18nContext'
import { TerminalLoader } from '../components/TerminalLoader'

export function I18nProvider({ session, children }: { session: Session; children: ReactNode }) {
  const [language, setLanguageState] = useState<Language | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let active = true
    setLoading(true)
    async function loadPreference() {
      if (!supabase) {
        setLanguageState(null)
        setLoading(false)
        return
      }

      try {
        const { data } = await supabase.from('user_preferences').select('preferred_language').eq('user_id', session.user.id).maybeSingle()
        if (!active) return
        const preferred = data?.preferred_language
        setLanguageState(preferred === 'en' || preferred === 'es' ? preferred : null)
      } catch {
        // Keep the preference unresolved only for this in-memory session.
      } finally {
        if (active) setLoading(false)
      }
    }
    void loadPreference()
    return () => { active = false }
  }, [session.user.id])

  const setLanguage = useCallback(async (languageToSave: Language) => {
    if (!supabase) {
      return
    }

    setSaving(true)
    setLanguageState(languageToSave)
    const { error } = await supabase.from('user_preferences').upsert({ user_id: session.user.id, preferred_language: languageToSave }, { onConflict: 'user_id' })
    setSaving(false)
    if (error) return
  }, [session.user.id])

  const value = useMemo(() => ({ language: language ?? 'en', t: (key: Parameters<typeof translate>[1]) => translate(language ?? 'en', key), setLanguage }), [language, setLanguage])

  if (loading) return <TerminalLoader message={translations.en.loadingPreferences} />
  if (!language) return <LanguageSetup saving={saving} onSelect={setLanguage} />
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

function LanguageSetup({ saving, onSelect }: { saving: boolean; onSelect: (language: Language) => Promise<void> }) {
  return <main className="language-shell"><section className="language-panel"><p className="eyebrow">INVESTMENT RESEARCH</p><h1>{translations.en.welcome}</h1><p className="language-question">{translations.en.chooseLanguage}</p><div className="language-options"><button disabled={saving} onClick={() => void onSelect('en')}>{translations.en.english}</button><button disabled={saving} onClick={() => void onSelect('es')}>{translations.en.spanish}</button></div></section></main>
}
