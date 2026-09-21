import { supabase } from './supabase'

export async function ensureUserProfile() {
  if (!supabase) {
    throw new Error('Supabase configuration is missing. Add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY before authenticating.')
  }

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser()

  if (userError || !user) {
    throw userError ?? new Error('No authenticated user found.')
  }

  const client: NonNullable<typeof supabase> = supabase

  const { data: existingProfile, error: existingProfileError } = await client
    .from('profiles')
    .select('id')
    .eq('id', user.id)
    .maybeSingle()

  if (existingProfileError && existingProfileError.code !== 'PGRST116') {
    throw existingProfileError
  }

  if (existingProfile) {
    return existingProfile
  }

  const { error: insertError } = await client.from('profiles').insert({
    id: user.id,
    full_name: user.user_metadata?.full_name ?? user.email?.split('@')[0] ?? 'Analyst',
    avatar_url: user.user_metadata?.avatar_url ?? null,
  })

  if (insertError) {
    throw insertError
  }

  return { id: user.id }
}
