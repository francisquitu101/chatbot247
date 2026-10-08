import type { SupabaseClient } from '@supabase/supabase-js'
import type { FinvizAnalystRating, FinvizInsiderTrade, ScrapedItem, TrackedStock } from '../../types'

const itemSelect = 'id, source_id, ticker, title, content, author, url, published_at, scraped_at, content_hash, metadata, created_at, item_type'

export type CompanyData = {
  stock: TrackedStock | null
  items: ScrapedItem[]
  ratings: FinvizAnalystRating[]
  insiderTrades: FinvizInsiderTrade[]
}

export type FinvizCompanyActivity = Pick<CompanyData, 'ratings' | 'insiderTrades'>

export type CompanySummary = {
  stock: TrackedStock | null
  totalNews: number
  totalFilings: number
  totalRatings: number
  totalInsiders: number
  latestNewsDate: string | null
  latestFilingDate: string | null
  latestRatingDate: string | null
  latestInsiderDate: string | null
}

export type CompanyActivityFeed = {
  recentNews: ScrapedItem[]
  recentFilings: ScrapedItem[]
  recentRatings: FinvizAnalystRating[]
  recentInsiders: FinvizInsiderTrade[]
}

export async function getCompanyData(client: SupabaseClient, ticker: string): Promise<CompanyData> {
  const normalizedTicker = ticker.toUpperCase()
  const [stockResult, itemsResult, ratingsResult, insiderResult] = await Promise.all([
    client.from('tracked_stocks').select('id, ticker, company_name, enabled, created_at').eq('ticker', normalizedTicker).eq('enabled', true).maybeSingle(),
    client.from('scraped_items').select(itemSelect).eq('ticker', normalizedTicker).order('published_at', { ascending: false, nullsFirst: false }).order('scraped_at', { ascending: false }).limit(1000),
    client.from('finviz_analyst_ratings').select('id, ticker, source_id, rating_date, action, analyst, rating_change, price_target_change, created_at, scraped_at, content_hash').eq('ticker', normalizedTicker).order('rating_date', { ascending: false }),
    client.from('finviz_insider_trades').select('id, ticker, source_id, insider_name, relationship, transaction_date, transaction, cost, shares, value, shares_total, sec_form4_url, form4_display_timestamp, created_at, scraped_at, content_hash').eq('ticker', normalizedTicker).order('transaction_date', { ascending: false }),
  ])

  for (const result of [stockResult, itemsResult, ratingsResult, insiderResult]) {
    if (result.error) throw result.error
  }

  return {
    stock: (stockResult.data ?? null) as TrackedStock | null,
    items: (itemsResult.data ?? []) as ScrapedItem[],
    ratings: (ratingsResult.data ?? []) as FinvizAnalystRating[],
    insiderTrades: (insiderResult.data ?? []) as FinvizInsiderTrade[],
  }
}

export async function getFinvizCompanyActivity(client: SupabaseClient, ticker: string): Promise<FinvizCompanyActivity> {
  const normalizedTicker = ticker.toUpperCase()
  const [ratingsResult, insiderResult] = await Promise.all([
    client.from('finviz_analyst_ratings')
      .select('id, ticker, source_id, rating_date, action, analyst, rating_change, price_target_change, created_at, scraped_at, content_hash')
      .eq('ticker', normalizedTicker)
      .order('rating_date', { ascending: false }),
    client.from('finviz_insider_trades')
      .select('id, ticker, source_id, insider_name, relationship, transaction_date, transaction, cost, shares, value, shares_total, sec_form4_url, form4_display_timestamp, created_at, scraped_at, content_hash')
      .eq('ticker', normalizedTicker)
      .order('transaction_date', { ascending: false }),
  ])

  for (const result of [ratingsResult, insiderResult]) {
    if (result.error) throw result.error
  }

  return {
    ratings: (ratingsResult.data ?? []) as FinvizAnalystRating[],
    insiderTrades: (insiderResult.data ?? []) as FinvizInsiderTrade[],
  }
}

export async function getCompanySummary(client: SupabaseClient, ticker: string): Promise<CompanySummary> {
  const normalizedTicker = ticker.toUpperCase()
  
  // Get stock and all items for counting and latest dates
  const [stockResult, itemsResult, ratingsResult, insiderResult] = await Promise.all([
    client.from('tracked_stocks').select('id, ticker, company_name, enabled, created_at').eq('ticker', normalizedTicker).eq('enabled', true).maybeSingle(),
    client.from('scraped_items').select('id, published_at, item_type, metadata').eq('ticker', normalizedTicker).order('published_at', { ascending: false, nullsFirst: false }).limit(1000),
    client.from('finviz_analyst_ratings').select('id, rating_date').eq('ticker', normalizedTicker).order('rating_date', { ascending: false }).limit(1),
    client.from('finviz_insider_trades').select('id, transaction_date').eq('ticker', normalizedTicker).order('transaction_date', { ascending: false }).limit(1),
  ])

  for (const result of [stockResult, itemsResult, ratingsResult, insiderResult]) {
    if (result.error) throw result.error
  }

  // Calculate totals from items
  const items = (itemsResult.data ?? []) as Array<{ id: string; published_at: string | null; item_type: string; metadata: Record<string, unknown> }>
  const allRatings = (ratingsResult.data ?? []) as Array<{ id: string; rating_date: string }>
  const allInsiders = (insiderResult.data ?? []) as Array<{ id: string; transaction_date: string }>
  const newsItems = items.filter((item) => !((item.metadata.source === 'SEC' || typeof item.metadata.accessionNumber === 'string') || item.item_type === 'post'))
  const filingItems = items.filter((item) => item.metadata.source === 'SEC' || typeof item.metadata.accessionNumber === 'string')
  
  return {
    stock: (stockResult.data ?? null) as TrackedStock | null,
    totalNews: newsItems.length,
    totalFilings: filingItems.length,
    totalRatings: allRatings.length,
    totalInsiders: allInsiders.length,
    latestNewsDate: newsItems[0]?.published_at ?? null,
    latestFilingDate: filingItems[0]?.published_at ?? null,
    latestRatingDate: allRatings[0]?.rating_date ?? null,
    latestInsiderDate: allInsiders[0]?.transaction_date ?? null,
  }
}

export async function getCompanyActivityFeed(client: SupabaseClient, ticker: string): Promise<CompanyActivityFeed> {
  const normalizedTicker = ticker.toUpperCase()

  // Fetch recent items of each type - limited to 20 each
  const [itemsResult, ratingsResult, insidersResult] = await Promise.all([
    client.from('scraped_items').select(itemSelect).eq('ticker', normalizedTicker).neq('item_type', 'post').order('published_at', { ascending: false, nullsFirst: false }).limit(40),
    client.from('finviz_analyst_ratings').select('id, ticker, source_id, rating_date, action, analyst, rating_change, price_target_change, created_at, scraped_at, content_hash').eq('ticker', normalizedTicker).order('rating_date', { ascending: false }).limit(20),
    client.from('finviz_insider_trades').select('id, ticker, source_id, insider_name, relationship, transaction_date, transaction, cost, shares, value, shares_total, sec_form4_url, form4_display_timestamp, created_at, scraped_at, content_hash').eq('ticker', normalizedTicker).order('transaction_date', { ascending: false }).limit(20),
  ])

  for (const result of [itemsResult, ratingsResult, insidersResult]) {
    if (result.error) throw result.error
  }

  // Separate news and filings from items
  const allItems = (itemsResult.data ?? []) as ScrapedItem[]
  const recentNews = allItems.filter((item) => !(item.metadata.source === 'SEC' || typeof item.metadata.accessionNumber === 'string')).slice(0, 20)
  const recentFilings = allItems.filter((item) => item.metadata.source === 'SEC' || typeof item.metadata.accessionNumber === 'string').slice(0, 20)

  return {
    recentNews,
    recentFilings,
    recentRatings: (ratingsResult.data ?? []) as FinvizAnalystRating[],
    recentInsiders: (insidersResult.data ?? []) as FinvizInsiderTrade[],
  }
}

export async function getDashboardData(client: SupabaseClient): Promise<{ stocks: TrackedStock[]; items: ScrapedItem[]; ratings: FinvizAnalystRating[]; insiderTrades: FinvizInsiderTrade[] }> {
  const stocksResult = await client.from('tracked_stocks').select('id, ticker, company_name, enabled, created_at').eq('enabled', true).order('ticker')
  if (stocksResult.error) throw stocksResult.error
  const stocks = (stocksResult.data ?? []) as TrackedStock[]
  const [itemsByTicker, ratingsResult, insiderResult] = await Promise.all([Promise.all(stocks.map(async (stock) => {
    const result = await client.from('scraped_items').select(itemSelect).eq('ticker', stock.ticker).order('published_at', { ascending: false, nullsFirst: false }).order('scraped_at', { ascending: false }).limit(1000)
    if (result.error) throw result.error
    return (result.data ?? []) as ScrapedItem[]
  })), client.from('finviz_analyst_ratings').select('id, ticker, source_id, rating_date, action, analyst, rating_change, price_target_change, created_at, scraped_at, content_hash').in('ticker', stocks.map((stock) => stock.ticker)), client.from('finviz_insider_trades').select('id, ticker, source_id, insider_name, relationship, transaction_date, transaction, cost, shares, value, shares_total, sec_form4_url, form4_display_timestamp, created_at, scraped_at, content_hash').in('ticker', stocks.map((stock) => stock.ticker))])
  if (ratingsResult.error) throw ratingsResult.error
  if (insiderResult.error) throw insiderResult.error
  return { stocks, items: itemsByTicker.flat(), ratings: (ratingsResult.data ?? []) as FinvizAnalystRating[], insiderTrades: (insiderResult.data ?? []) as FinvizInsiderTrade[] }
}
