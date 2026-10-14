import type { FinvizInsiderTrade } from '../types'

function normalizedShares(value: string | null | undefined): string | null {
  const normalized = value?.replace(/,/g, '').trim()
  return normalized && /^[+-]?\d+(?:\.\d+)?$/.test(normalized) ? normalized.replace(/^\+/, '') : null
}

function normalizedNameTokens(value: string): Set<string> {
  const suffixes = new Set(['JR', 'SR', 'II', 'III', 'IV', 'V'])
  return new Set(
    value.normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .match(/[A-Z]+/g)
      ?.filter((token) => token.length > 1 && !suffixes.has(token)) ?? [],
  )
}

function sameInsider(left: string, right: string): boolean {
  const leftTokens = normalizedNameTokens(left)
  const rightTokens = normalizedNameTokens(right)
  if (leftTokens.size < 2 || rightTokens.size < 2) return false

  const sharedTokens = [...leftTokens].filter((token) => rightTokens.has(token)).length
  const diceSimilarity = (2 * sharedTokens) / (leftTokens.size + rightTokens.size)
  return sharedTokens >= 2 && diceSimilarity >= 0.8
}

function dateOrdinal(value: string): number | null {
  const datePart = value.match(/^(\d{4}-\d{2}-\d{2})/)?.[1]
  if (!datePart) return null
  const date = new Date(`${datePart}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== datePart) return null
  return Math.floor(date.getTime() / 86_400_000)
}

function isProposedSale(transaction: string): boolean {
  return /\bproposed\s+sale\b/i.test(transaction)
}

function isCompletedSale(transaction: string): boolean {
  return !isProposedSale(transaction) && /\bsale\b/i.test(transaction)
}

function representsSameSale(proposed: FinvizInsiderTrade, completed: FinvizInsiderTrade): boolean {
  if (proposed.ticker.trim().toUpperCase() !== completed.ticker.trim().toUpperCase()) return false

  const proposedShares = normalizedShares(proposed.shares)
  if (!proposedShares || proposedShares !== normalizedShares(completed.shares)) return false

  const proposedDate = dateOrdinal(proposed.transaction_date)
  const completedDate = dateOrdinal(completed.transaction_date)
  if (proposedDate === null || completedDate === null || Math.abs(proposedDate - completedDate) > 1) return false

  return sameInsider(proposed.insider_name, completed.insider_name)
}

export function deduplicateSupersededProposedSales(trades: FinvizInsiderTrade[]): FinvizInsiderTrade[] {
  const completedSales = trades.filter((trade) => isCompletedSale(trade.transaction))
  return trades.filter((trade) =>
    !isProposedSale(trade.transaction) ||
    !completedSales.some((sale) => representsSameSale(trade, sale)),
  )
}
