import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

export type AuthenticatedUser = {
  id: string
  email?: string | null
}

export type AuthCheckResult =
  | { ok: true; user: AuthenticatedUser }
  | { ok: false; code: 'AUTHORIZATION_REQUIRED' | 'INVALID_ACCESS_TOKEN' | 'BACKEND_CONFIG_MISSING'; message: string }

function getSecretApiKey(name = 'watchlistscheduler'): string {
  const explicitKeyNames: Record<string, string> = {
    watchlistscheduler: 'WATCHLIST_SCHEDULER_KEY',
  }

  const explicitKeyName = explicitKeyNames[name]
  if (explicitKeyName) {
    const explicitKey = Deno.env.get(explicitKeyName)
    if (typeof explicitKey === 'string' && explicitKey.length > 0) {
      return explicitKey
    }
  }

  const rawKeys = Deno.env.get('SUPABASE_SECRET_KEYS')
  if (!rawKeys) {
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (serviceRoleKey) return serviceRoleKey
    throw new Error('BACKEND_CONFIG_MISSING')
  }

  try {
    const keys = JSON.parse(rawKeys) as Record<string, unknown>
    const key = keys[name]
    if (typeof key !== 'string' || key.length === 0) throw new Error('BACKEND_CONFIG_MISSING')
    return key
  } catch {
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (serviceRoleKey) return serviceRoleKey
    throw new Error('BACKEND_CONFIG_MISSING')
  }
}

export function createBackendClient(secretName: 'watchlistscheduler' | 'notificationservice' = 'watchlistscheduler') {
  const url = Deno.env.get('SUPABASE_URL')
  const secretKey = getSecretApiKey(secretName)

  if (!url) {
    throw new Error('BACKEND_CONFIG_MISSING')
  }

  return createClient(url, secretKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  })
}

export async function validateSupabaseUserToken(request: Request): Promise<AuthCheckResult> {
  const authorization = request.headers.get('authorization') ?? ''

  if (!authorization.startsWith('Bearer ')) {
    return {
      ok: false,
      code: 'AUTHORIZATION_REQUIRED',
      message: 'A valid Bearer token is required.',
    }
  }

  const token = authorization.slice('Bearer '.length).trim()
  if (!token) {
    return {
      ok: false,
      code: 'AUTHORIZATION_REQUIRED',
      message: 'Authorization token is empty.',
    }
  }

  try {
    const { data, error } = await createBackendClient().auth.getUser(token)

    if (error || !data.user) {
      return {
        ok: false,
        code: 'INVALID_ACCESS_TOKEN',
        message: 'Token is expired, invalid, or not authorized.',
      }
    }

    return {
      ok: true,
      user: {
        id: data.user.id,
        email: data.user.email ?? null,
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'UNKNOWN_ERROR'

    if (message === 'BACKEND_CONFIG_MISSING') {
      return {
        ok: false,
        code: 'BACKEND_CONFIG_MISSING',
        message: 'Supabase backend secrets are not configured.',
      }
    }

    return {
      ok: false,
      code: 'INVALID_ACCESS_TOKEN',
      message: 'Token validation failed.',
    }
  }
}

export async function requireAuthenticatedUser(request: Request): Promise<AuthenticatedUser> {
  const result = await validateSupabaseUserToken(request)

  if (!result.ok) {
    throw new Error(result.code)
  }

  return result.user
}