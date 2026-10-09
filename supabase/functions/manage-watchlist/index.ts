import { createBackendClient, requireAuthenticatedUser } from '../_shared/supabase.ts'
import { errorResponse, handleOptions, ok, readJson } from '../_shared/response.ts'
import { normalizeTicker } from '../_shared/scraper.ts'

Deno.serve(async (request) => {
  const optionsResponse = handleOptions(request)
  if (optionsResponse) return optionsResponse
  if (request.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'Use POST', 405, request)

  try {
    await requireAuthenticatedUser(request)
    const body = await readJson(request)
    if (!body) return errorResponse('INVALID_JSON', 'Request body must be a JSON object', 400, request)

    const ticker = normalizeTicker(body.ticker)
    const action = body.action
    if (!ticker || (action !== 'enable' && action !== 'disable')) {
      return errorResponse('INVALID_WATCHLIST_REQUEST', 'ticker and action are required', 400, request)
    }

    const client = createBackendClient()
    if (action === 'enable') {
      const { data, error } = await client
        .from('tracked_stocks')
        .upsert({ ticker, enabled: true }, { onConflict: 'ticker' })
        .select('id, ticker, company_name, enabled, created_at')
        .single()
      if (error) throw error
      return ok(data, request)
    }

    const { error } = await client
      .from('tracked_stocks')
      .update({ enabled: false })
      .eq('ticker', ticker)
    if (error) throw error
    return ok({ ticker, enabled: false }, request)
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (message === 'AUTHORIZATION_REQUIRED' || message === 'INVALID_ACCESS_TOKEN') {
      return errorResponse('UNAUTHORIZED', 'A valid Supabase access token is required', 401, request)
    }
    if (message === 'BACKEND_CONFIG_MISSING') {
      return errorResponse('BACKEND_CONFIG_MISSING', 'Supabase backend configuration is missing', 500, request)
    }
    return errorResponse('WATCHLIST_ERROR', 'Unable to update the monitored universe', 500, request)
  }
})
