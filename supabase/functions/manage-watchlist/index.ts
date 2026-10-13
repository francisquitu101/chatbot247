import { createBackendClient, requireAuthenticatedUser } from '../_shared/supabase.ts'
import { errorResponse, handleOptions, ok, readJson } from '../_shared/response.ts'
import { normalizeTicker } from '../_shared/scraper.ts'

Deno.serve(async (request) => {
  const optionsResponse = handleOptions(request)
  if (optionsResponse) return optionsResponse
  if (request.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'Use POST', 405, request)

  try {
    const user = await requireAuthenticatedUser(request)
    const body = await readJson(request)
    if (!body) return errorResponse('INVALID_JSON', 'Request body must be a JSON object', 400, request)

    const ticker = normalizeTicker(body.ticker)
    const action = body.action
    if (!ticker || (action !== 'enable' && action !== 'disable')) {
      return errorResponse('INVALID_WATCHLIST_REQUEST', 'ticker and action are required', 400, request)
    }

    const client = createBackendClient()
    if (action === 'enable') {
      const { data, error } = await client.rpc('add_ticker_to_user_watchlist', {
        p_user_id: user.id,
        p_ticker: ticker,
      })
      if (error) {
        if (error.message.includes('WATCHLIST_LIMIT_REACHED')) {
          return errorResponse(
            'WATCHLIST_LIMIT_REACHED',
            'Your Free plan includes 3 tickers. Upgrade to Pro for up to 10 tickers at $6.90/month.',
            403,
            request,
          )
        }
        if (error.message.includes('INVALID_WATCHLIST_TICKER')) {
          return errorResponse(
            'INVALID_WATCHLIST_REQUEST',
            'Enter a valid stock ticker.',
            400,
            request,
          )
        }
        throw error
      }
      return ok(data, request)
    }

    const { error } = await client
      .from('user_watchlist')
      .delete()
      .eq('user_id', user.id)
      .eq('ticker', ticker)
    if (error) throw error
    return ok({ ticker, enabled: false }, request)
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (message && message !== 'AUTHORIZATION_REQUIRED' && message !== 'INVALID_ACCESS_TOKEN') {
      console.error('manage-watchlist failed:', message)
    }
    if (message === 'AUTHORIZATION_REQUIRED' || message === 'INVALID_ACCESS_TOKEN') {
      return errorResponse('UNAUTHORIZED', 'A valid Supabase access token is required', 401, request)
    }
    if (message === 'BACKEND_CONFIG_MISSING') {
      return errorResponse('BACKEND_CONFIG_MISSING', 'Supabase backend configuration is missing', 500, request)
    }
    return errorResponse('WATCHLIST_ERROR', 'Unable to update the monitored universe', 500, request)
  }
})
