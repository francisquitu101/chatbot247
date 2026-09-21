export const SEC_FETCH_TIMEOUT_MS = 20_000
export const SEC_MAX_DOCUMENT_BYTES = 25 * 1024 * 1024
export const SEC_DOCUMENT_RETRY_MAX = 2

export type SecDocumentMetadata = {
  cik?: unknown
  accessionNumber?: unknown
  accession_number?: unknown
  primaryDocument?: unknown
  form?: unknown
  form_type?: unknown
  reportDate?: unknown
  filing_date?: unknown
  company_name?: unknown
}

export type SecDocumentFetchResult =
  | {
      ok: true
      sourceUrl: string
      status: number
      contentType: string
      documentBytes: number
      html: string
      normalizedText: string
      normalizedBytes: number
    }
  | {
      ok: false
      code: string
      message: string
      sourceUrl?: string
      status?: number
    }

export function normalizeAccessionNumber(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

export function buildCanonicalSecDocumentUrl(metadata: SecDocumentMetadata): string {
  const rawCik = typeof metadata.cik === 'string' ? metadata.cik.trim() : null
  const accession = normalizeAccessionNumber(metadata.accessionNumber ?? metadata.accession_number)
  const primaryDocument = typeof metadata.primaryDocument === 'string' ? metadata.primaryDocument.trim() : null

  if (!rawCik || !accession || !primaryDocument) {
    throw new Error('SEC_METADATA_INCOMPLETE')
  }

  const cikDigits = rawCik.replace(/^0+/, '')
  if (!/^\d{10}$/.test(rawCik) || !/^\d{10}-\d{2}-\d{6}$/.test(accession) || !/^.{1,200}$/.test(primaryDocument)) {
    throw new Error('SEC_METADATA_INVALID')
  }

  const accessionNoDashes = accession.replace(/-/g, '')
  return `https://www.sec.gov/Archives/edgar/data/${cikDigits}/${accessionNoDashes}/${primaryDocument}`
}

function getServerUserAgent(): string {
  if (typeof process !== 'undefined' && process.env && process.env.SEC_USER_AGENT) {
    return process.env.SEC_USER_AGENT.trim() || 'InvestmentCommunity/1.0 (+https://example.invalid)'
  }
  if (typeof Deno !== 'undefined') {
    const envValue = Deno.env.get('SEC_USER_AGENT')
    if (envValue && envValue.trim()) return envValue.trim()
  }
  return 'InvestmentCommunity/1.0 (+https://example.invalid)'
}

function looksLikeSecDocument(html: string): boolean {
  const lower = html.toLowerCase()
  const secMarkers = [
    '<html',
    '<body',
    'management\'s discussion and analysis',
    'risk factors',
    'financial statements',
    'item 1.',
    'item 7',
    'consolidated statements',
    'edgar',
  ]
  return secMarkers.some((marker) => lower.includes(marker))
}

function normalizeHtmlToText(html: string): string {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')

  const withStructure = withoutScripts
    .replace(/<h([1-6])[^>]*>/gi, '\n\n### ')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<p[^>]*>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<tr[^>]*>/gi, '\n')
    .replace(/<td[^>]*>|<th[^>]*>/gi, ' | ')
    .replace(/<\/td>|<\/th>/gi, ' ')
    .replace(/<div[^>]*>/gi, '\n')
    .replace(/<section[^>]*>/gi, '\n')
    .replace(/<article[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')

  const decoded = withStructure
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;/gi, "'")
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')

  return decoded
    .replace(/\u00a0/g, ' ')
    .replace(/\s*\|\s*/g, ' | ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

async function readLimitedResponseBody(response: Response, maxBytes: number): Promise<{ buffer: Uint8Array; finalStatus: number }> {
  if (!response.body) {
    throw new Error('SEC_RESPONSE_BODY_MISSING')
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        reader.cancel()
        throw new Error('SEC_SIZE_LIMIT')
      }
      chunks.push(value)
    }
  }

  const buffer = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    buffer.set(chunk, offset)
    offset += chunk.byteLength
  }

  return { buffer, finalStatus: response.status }
}

async function fetchWithTimeout(url: string, options: { timeoutMs: number; maxBytes: number; userAgent: string }): Promise<SecDocumentFetchResult> {
  const maxRetries = 2
  let lastStatus: number | undefined
  let lastCode = 'SEC_NETWORK_ERROR'
  let lastMessage = 'Unable to retrieve SEC filing.'

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs)
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': options.userAgent,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      })

      lastStatus = response.status
      const contentType = response.headers.get('content-type') ?? ''

      if (response.status === 403) {
        return { ok: false, code: 'SEC_FORBIDDEN', message: 'SEC rejected the request (403). Verify the User-Agent and SEC access policy.', sourceUrl: url, status: response.status }
      }
      if (response.status === 404) {
        return { ok: false, code: 'SEC_NOT_FOUND', message: 'SEC filing not found for the supplied accession and primary document.', sourceUrl: url, status: response.status }
      }
      if (response.status === 429) {
        return { ok: false, code: 'SEC_RATE_LIMITED', message: 'SEC rate limited the request.', sourceUrl: url, status: response.status }
      }
      if (response.status >= 500) {
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
          continue
        }
        return { ok: false, code: 'SEC_HTTP_ERROR', message: `SEC returned HTTP ${response.status}.`, sourceUrl: url, status: response.status }
      }
      if (response.status !== 200) {
        return { ok: false, code: 'SEC_HTTP_ERROR', message: `Unexpected SEC status ${response.status}.`, sourceUrl: url, status: response.status }
      }

      const isHtml = /text\/html|application\/xhtml\+xml|application\/xml/i.test(contentType)
      if (!isHtml) {
        return { ok: false, code: 'SEC_INVALID_CONTENT', message: `Expected an HTML SEC filing but received ${contentType || 'unknown content-type'}.`, sourceUrl: url, status: response.status }
      }

      const { buffer } = await readLimitedResponseBody(response, options.maxBytes)
      if (buffer.length === 0) {
        return { ok: false, code: 'SEC_EMPTY_DOCUMENT', message: 'SEC response was empty.', sourceUrl: url, status: response.status }
      }

      const html = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
      if (!looksLikeSecDocument(html)) {
        return { ok: false, code: 'SEC_INVALID_CONTENT', message: 'The retrieved response does not resemble an SEC filing document.', sourceUrl: url, status: response.status }
      }

      const normalizedText = normalizeHtmlToText(html)
      if (!normalizedText || normalizedText.length < 200) {
        return { ok: false, code: 'SEC_INVALID_CONTENT', message: 'The retrieved SEC document is empty after normalization.', sourceUrl: url, status: response.status }
      }

      return {
        ok: true,
        sourceUrl: url,
        status: response.status,
        contentType: contentType || 'text/html',
        documentBytes: buffer.byteLength,
        html,
        normalizedText,
        normalizedBytes: new TextEncoder().encode(normalizedText).length,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown SEC fetch error.'
      if (error instanceof DOMException && error.name === 'AbortError') {
        lastCode = 'SEC_TIMEOUT'
        lastMessage = `SEC request timed out after ${options.timeoutMs} ms.`
      } else if (message === 'SEC_SIZE_LIMIT') {
        lastCode = 'SEC_SIZE_LIMIT'
        lastMessage = `SEC document exceeded ${options.maxBytes} bytes.`
      } else if (message === 'SEC_RESPONSE_BODY_MISSING') {
        lastCode = 'SEC_INVALID_CONTENT'
        lastMessage = 'SEC response had no readable body.'
      } else {
        lastCode = 'SEC_NETWORK_ERROR'
        lastMessage = `SEC fetch failed: ${message}`
      }
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
        continue
      }
      return { ok: false, code: lastCode, message: lastMessage, sourceUrl: url, status: lastStatus }
    } finally {
      clearTimeout(timer)
    }
  }

  return { ok: false, code: lastCode, message: lastMessage, sourceUrl: url, status: lastStatus }
}

export async function retrieveSecDocument(metadata: SecDocumentMetadata, options?: { timeoutMs?: number; maxBytes?: number; userAgent?: string }): Promise<SecDocumentFetchResult> {
  try {
    const sourceUrl = buildCanonicalSecDocumentUrl(metadata)
    return await fetchWithTimeout(sourceUrl, {
      timeoutMs: options?.timeoutMs ?? SEC_FETCH_TIMEOUT_MS,
      maxBytes: options?.maxBytes ?? SEC_MAX_DOCUMENT_BYTES,
      userAgent: options?.userAgent ?? getServerUserAgent(),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to construct SEC document URL.'
    if (message === 'SEC_METADATA_INCOMPLETE') {
      return { ok: false, code: 'SEC_METADATA_INCOMPLETE', message: 'Missing cik, accessionNumber/accession_number, or primaryDocument.' }
    }
    if (message === 'SEC_METADATA_INVALID') {
      return { ok: false, code: 'SEC_METADATA_INVALID', message: 'The supplied SEC metadata does not match the expected EDGAR document schema.' }
    }
    return { ok: false, code: 'SEC_NETWORK_ERROR', message }
  }
}

export function normalizeSecDocument(html: string): string {
  return normalizeHtmlToText(html)
}
