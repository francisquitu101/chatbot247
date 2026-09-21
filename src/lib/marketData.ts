import type { SupabaseClient } from '@supabase/supabase-js'

export type NormalizedMarketSnapshot = {
  ticker: string
  price: number | null
  change: number | null
  changePct: number | null
  volume: number | null
  avgVolume: number | null
  marketCap: number | null
  pe: number | null
  forwardPe: number | null
  epsGrowth: number | null
  salesGrowth: number | null
  beta: number | null
  high52w: number | null
  low52w: number | null
  insiderOwnership: number | null
  institutionalOwnership: number | null
  updatedAt: string | null
  source: 'FINVIZ'
}

function normalizeTickerName(value: string | null | undefined) {
  return (value ?? '').trim().toUpperCase()
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
}

function stripTags(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function normalizeCompactMetric(value: string | null | undefined): number | null {
  const cleaned = (value ?? '').trim().replace(/[$,%\s]/g, '')
  if (!cleaned || cleaned === '—' || cleaned === 'N/A') return null
  const match = cleaned.match(/^([+-]?(?:\d+\.?\d*|\d*\.\d+))([KMBT])?$/i)
  if (!match) {
    const plain = Number.parseFloat(cleaned)
    return Number.isFinite(plain) ? plain : null
  }

  const numeric = Number.parseFloat(match[1])
  const suffix = match[2]?.toUpperCase() ?? ''
  const multiplier = suffix === 'K' ? 1_000 : suffix === 'M' ? 1_000_000 : suffix === 'B' ? 1_000_000_000 : suffix === 'T' ? 1_000_000_000_000 : 1
  return numeric * multiplier
}

function parseCompactNumber(value: string): number | null {
  return normalizeCompactMetric(value)
}

function parsePercentValue(value: string): number | null {
  const cleaned = value.trim().replace(/[$,%\s]/g, '')
  if (!cleaned || cleaned === '—' || cleaned === 'N/A') return null
  if (!Number.isFinite(Number.parseFloat(cleaned.replace(/[+-]/g, '')))) return null
  const normalized = cleaned.replace(/%/g, '')
  const numeric = Number.parseFloat(normalized)
  return Number.isFinite(numeric) ? numeric : null
}

function parseSignedFloat(value: string): number | null {
  const cleaned = value.trim().replace(/[^0-9.+-]/g, '')
  if (!cleaned || cleaned === '—' || cleaned === 'N/A' || cleaned === '+') return null
  const numeric = Number.parseFloat(cleaned)
  return Number.isFinite(numeric) ? numeric : null
}

function collectTableRows(html: string): string[] {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => match[1] ?? '')
}

function collectRowCells(rowHtml: string): string[] {
  return [...rowHtml.matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)].map((match) => stripTags(match[1] ?? ''))
}

function valueForLabel(label: string, row: string[]): string | null {
  const normalizedLabel = label.toLowerCase()
  const index = row.findIndex((cell) => cell.toLowerCase().includes(normalizedLabel))
  if (index === -1) return null
  return row[index + 1] ?? null
}

export class FinvizMarketDataAdapter {
  static fromHtml(html: string, ticker: string): NormalizedMarketSnapshot | null {
    const rows = collectTableRows(html)
    const snapshot: Partial<NormalizedMarketSnapshot> = {
      ticker: normalizeTickerName(ticker),
      source: 'FINVIZ',
      updatedAt: new Date().toISOString(),
    }

    const rowEntries = rows.flatMap((row) => {
      const cells = collectRowCells(row)
      return cells.length > 0 ? [cells] : []
    })

    for (const row of rowEntries) {
      const priceValue = valueForLabel('price', row)
      if (priceValue && snapshot.price === undefined) {
        snapshot.price = parseSignedFloat(priceValue)
      }

      const changeValue = valueForLabel('change', row)
      if (changeValue && snapshot.change === undefined) {
        snapshot.change = parseSignedFloat(changeValue)
      }

      const changePctValue = valueForLabel('change %', row) ?? valueForLabel('change%', row)
      if (changePctValue && snapshot.changePct === undefined) {
        snapshot.changePct = parsePercentValue(changePctValue)
      }

      const volumeValue = valueForLabel('volume', row)
      if (volumeValue && snapshot.volume === undefined) {
        snapshot.volume = parseCompactNumber(volumeValue)
      }

      const avgVolumeValue = valueForLabel('avg volume', row)
      if (avgVolumeValue && snapshot.avgVolume === undefined) {
        snapshot.avgVolume = parseCompactNumber(avgVolumeValue)
      }

      const marketCapValue = valueForLabel('market cap', row)
      if (marketCapValue && snapshot.marketCap === undefined) {
        snapshot.marketCap = parseCompactNumber(marketCapValue)
      }

      const peValue = valueForLabel('p/e', row)
      if (peValue && snapshot.pe === undefined) {
        snapshot.pe = parseSignedFloat(peValue)
      }

      const forwardPeValue = valueForLabel('forward p/e', row) ?? valueForLabel('fwd p/e', row)
      if (forwardPeValue && snapshot.forwardPe === undefined) {
        snapshot.forwardPe = parseSignedFloat(forwardPeValue)
      }

      const epsGrowthValue = valueForLabel('eps growth', row)
      if (epsGrowthValue && snapshot.epsGrowth === undefined) {
        snapshot.epsGrowth = parsePercentValue(epsGrowthValue)
      }

      const salesGrowthValue = valueForLabel('sales growth', row)
      if (salesGrowthValue && snapshot.salesGrowth === undefined) {
        snapshot.salesGrowth = parsePercentValue(salesGrowthValue)
      }

      const betaValue = valueForLabel('beta', row)
      if (betaValue && snapshot.beta === undefined) {
        snapshot.beta = parseSignedFloat(betaValue)
      }

      const high52wValue = valueForLabel('52w high', row)
      if (high52wValue && snapshot.high52w === undefined) {
        snapshot.high52w = parseSignedFloat(high52wValue)
      }

      const low52wValue = valueForLabel('52w low', row)
      if (low52wValue && snapshot.low52w === undefined) {
        snapshot.low52w = parseSignedFloat(low52wValue)
      }

      const insiderOwnershipValue = valueForLabel('insider ownership', row)
      if (insiderOwnershipValue && snapshot.insiderOwnership === undefined) {
        snapshot.insiderOwnership = parsePercentValue(insiderOwnershipValue)
      }

      const institutionalOwnershipValue = valueForLabel('institutional ownership', row)
      if (institutionalOwnershipValue && snapshot.institutionalOwnership === undefined) {
        snapshot.institutionalOwnership = parsePercentValue(institutionalOwnershipValue)
      }
    }

    const hasAnyMetric = [
      snapshot.price,
      snapshot.change,
      snapshot.changePct,
      snapshot.volume,
      snapshot.avgVolume,
      snapshot.marketCap,
      snapshot.pe,
      snapshot.forwardPe,
      snapshot.epsGrowth,
      snapshot.salesGrowth,
      snapshot.beta,
      snapshot.high52w,
      snapshot.low52w,
      snapshot.insiderOwnership,
      snapshot.institutionalOwnership,
    ].some((value) => value !== undefined && value !== null)

    if (!hasAnyMetric) return null

    return {
      ticker: snapshot.ticker ?? normalizeTickerName(ticker),
      price: snapshot.price ?? null,
      change: snapshot.change ?? null,
      changePct: snapshot.changePct ?? null,
      volume: snapshot.volume ?? null,
      avgVolume: snapshot.avgVolume ?? null,
      marketCap: snapshot.marketCap ?? null,
      pe: snapshot.pe ?? null,
      forwardPe: snapshot.forwardPe ?? null,
      epsGrowth: snapshot.epsGrowth ?? null,
      salesGrowth: snapshot.salesGrowth ?? null,
      beta: snapshot.beta ?? null,
      high52w: snapshot.high52w ?? null,
      low52w: snapshot.low52w ?? null,
      insiderOwnership: snapshot.insiderOwnership ?? null,
      institutionalOwnership: snapshot.institutionalOwnership ?? null,
      updatedAt: snapshot.updatedAt ?? null,
      source: 'FINVIZ',
    }
  }

  static fromRow(row: Record<string, unknown> | null | undefined): NormalizedMarketSnapshot | null {
    if (!row || typeof row !== 'object') return null

    const getNumber = (key: string) => {
      const value = row[key]
      if (typeof value === 'number' && Number.isFinite(value)) return value
      if (typeof value === 'string' && value.trim().length > 0) {
        const numeric = Number.parseFloat(value)
        return Number.isFinite(numeric) ? numeric : null
      }
      return null
    }

    return {
      ticker: normalizeTickerName(typeof row.ticker === 'string' ? row.ticker : null),
      price: getNumber('price'),
      change: getNumber('change_value') ?? getNumber('change'),
      changePct: getNumber('change_pct') ?? getNumber('changePct'),
      volume: getNumber('volume'),
      avgVolume: getNumber('avg_volume') ?? getNumber('avgVolume'),
      marketCap: getNumber('market_cap') ?? getNumber('marketCap'),
      pe: getNumber('pe'),
      forwardPe: getNumber('forward_pe') ?? getNumber('forwardPe'),
      epsGrowth: getNumber('eps_growth') ?? getNumber('epsGrowth'),
      salesGrowth: getNumber('sales_growth') ?? getNumber('salesGrowth'),
      beta: getNumber('beta'),
      high52w: getNumber('high_52w') ?? getNumber('high52w'),
      low52w: getNumber('low_52w') ?? getNumber('low52w'),
      insiderOwnership: getNumber('insider_ownership') ?? getNumber('insiderOwnership'),
      institutionalOwnership: getNumber('institutional_ownership') ?? getNumber('institutionalOwnership'),
      updatedAt: typeof row.updated_at === 'string' ? row.updated_at : typeof row.updatedAt === 'string' ? row.updatedAt : null,
      source: 'FINVIZ',
    }
  }
}

export async function getMarketSnapshotForTicker(client: SupabaseClient, ticker: string): Promise<NormalizedMarketSnapshot | null> {
  const normalizedTicker = normalizeTickerName(ticker)
  const { data, error } = await client
    .from('finviz_market_data')
    .select('*')
    .eq('ticker', normalizedTicker)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    throw error
  }

  return data ? FinvizMarketDataAdapter.fromRow(data) : null
}
