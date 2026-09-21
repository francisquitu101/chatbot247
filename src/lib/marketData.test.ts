import { describe, expect, it } from 'vitest'
import { FinvizMarketDataAdapter, normalizeCompactMetric } from './marketData'

describe('FinvizMarketDataAdapter', () => {
  it('parses price, change, volume and market cap from a realistic Finviz HTML snippet', () => {
    const html = `
      <table>
        <tr><td>Price</td><td>$182.33</td></tr>
        <tr><td>Change</td><td>+1.72</td></tr>
        <tr><td>Change %</td><td>+0.95%</td></tr>
        <tr><td>Volume</td><td>24.7M</td></tr>
        <tr><td>Avg Volume</td><td>31.4M</td></tr>
        <tr><td>Market Cap</td><td>$3.4T</td></tr>
        <tr><td>P/E</td><td>58.7</td></tr>
        <tr><td>Forward P/E</td><td>37.1</td></tr>
        <tr><td>EPS growth</td><td>+123.4%</td></tr>
        <tr><td>Sales growth</td><td>+114.3%</td></tr>
        <tr><td>Beta</td><td>1.84</td></tr>
        <tr><td>52W High</td><td>184.35</td></tr>
        <tr><td>52W Low</td><td>96.30</td></tr>
        <tr><td>Insider Ownership</td><td>0.15%</td></tr>
        <tr><td>Institutional Ownership</td><td>67.11%</td></tr>
      </table>
    `

    const snapshot = FinvizMarketDataAdapter.fromHtml(html, 'NVDA')

    expect(snapshot).not.toBeNull()
    expect(snapshot?.price).toBe(182.33)
    expect(snapshot?.change).toBe(1.72)
    expect(snapshot?.changePct).toBe(0.95)
    expect(snapshot?.volume).toBe(24_700_000)
    expect(snapshot?.avgVolume).toBe(31_400_000)
    expect(snapshot?.marketCap).toBe(3_400_000_000_000)
    expect(snapshot?.pe).toBe(58.7)
    expect(snapshot?.forwardPe).toBe(37.1)
    expect(snapshot?.epsGrowth).toBe(123.4)
    expect(snapshot?.salesGrowth).toBe(114.3)
    expect(snapshot?.beta).toBe(1.84)
    expect(snapshot?.high52w).toBe(184.35)
    expect(snapshot?.low52w).toBe(96.3)
    expect(snapshot?.insiderOwnership).toBe(0.15)
    expect(snapshot?.institutionalOwnership).toBe(67.11)
    expect(snapshot?.source).toBe('FINVIZ')
  })

  it('keeps compact market metrics as real numeric values instead of integer-only placeholders', () => {
    expect(normalizeCompactMetric('1.46')).toBe(1.46)
    expect(normalizeCompactMetric('1.46B')).toBe(1_460_000_000)
    expect(normalizeCompactMetric('24.7M')).toBe(24_700_000)
  })

  it('returns null when the market fields are missing or malformed', () => {
    expect(FinvizMarketDataAdapter.fromHtml('<table><tr><td>hello</td><td>world</td></tr></table>', 'NVDA')).toBeNull()
  })

  it('supports stale timestamps and keeps unknowns absent', () => {
    const snapshot = FinvizMarketDataAdapter.fromHtml('<table><tr><td>Price</td><td>—</td></tr></table>', 'NVDA')
    expect(snapshot).toBeNull()
  })
})
