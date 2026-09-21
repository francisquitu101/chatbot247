import type { ScrapedItemDraft } from './scraper.ts'
import type { FinvizAnalystRatingDraft, FinvizInsiderTradeDraft, FinvizMarketSnapshotDraft } from '../scrape-finviz/scraper.ts'
import { createBackendClient } from './supabase.ts'

export async function resolveSourceId(slug: string): Promise<string> { const { data, error } = await createBackendClient().from('sources').select('id').eq('slug', slug).eq('enabled', true).maybeSingle(); if (error) throw new Error(`Could not resolve source: ${error.message}`); if (!data) throw new Error(`Source '${slug}' was not found or is disabled`); return data.id }
export async function assertTrackedTicker(ticker: string): Promise<void> { const { data, error } = await createBackendClient().from('tracked_stocks').select('ticker').eq('ticker', ticker).eq('enabled', true).maybeSingle(); if (error) throw new Error(`Could not resolve ticker: ${error.message}`); if (!data) throw new Error('TICKER_NOT_TRACKED') }
export async function saveScrapedItem(item: ScrapedItemDraft): Promise<'new' | 'duplicate'> { const { error } = await createBackendClient().from('scraped_items').insert(item); if (!error) return 'new'; if (error.code === '23505') return 'duplicate'; throw new Error(`Could not save scraped item: ${error.message}`) }

export type SaveSecItemsResult = { new: number; duplicate: number; newInserted: number; existingSkipped: number }

export async function saveSecScrapedItems(items: ScrapedItemDraft[]): Promise<SaveSecItemsResult> {
	if (items.length === 0) return { new: 0, duplicate: 0, newInserted: 0, existingSkipped: 0 }
	const client = createBackendClient()
	const accessions = items
		.map((item) => typeof item.metadata.accessionNumber === 'string' ? item.metadata.accessionNumber : '')
		.filter(Boolean)
	const existing = await client
		.from('scraped_items')
		.select('metadata')
		.eq('source_id', items[0].source_id)
		.eq('ticker', items[0].ticker)
		.in('metadata->>accessionNumber', [...new Set(accessions)])
	if (existing.error) throw new Error(`Could not resolve SEC duplicates: ${existing.error.message}`)
	const existingAccessions = new Set((existing.data ?? []).map((row) => {
		const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : {}
		return typeof metadata.accessionNumber === 'string' ? metadata.accessionNumber : ''
	}).filter(Boolean))
	let newCount = 0
	let duplicate = 0
	let existingSkipped = 0
	for (const item of items) {
		const accessionNumber = typeof item.metadata.accessionNumber === 'string' ? item.metadata.accessionNumber : ''
		if (existingAccessions.has(accessionNumber)) {
			duplicate += 1
			existingSkipped += 1
			continue
		}
		const inserted = await client.from('scraped_items').insert(item)
		if (!inserted.error) newCount += 1
		else if (inserted.error.code === '23505') duplicate += 1
		else throw new Error(`Could not save SEC scraped item: ${inserted.error.message}`)
	}
	return { new: newCount, duplicate, newInserted: newCount, existingSkipped }
}

export async function saveFinvizScrapedItem(item: ScrapedItemDraft): Promise<'new' | 'duplicate' | 'updated'> {
	const client = createBackendClient()
	const { error: insertError } = await client.from('scraped_items').insert(item)
	if (!insertError) return 'new'
	if (insertError.code !== '23505') throw new Error(`Could not save scraped item: ${insertError.message}`)

	const findExisting = async (column: 'content_hash' | 'url', value: string) => client
		.from('scraped_items')
		.select('id, title, published_at, metadata')
		.eq('source_id', item.source_id)
		.eq('ticker', item.ticker)
		.eq(column, value)
		.limit(1)
		.maybeSingle()

	let lookup = await findExisting('content_hash', item.content_hash)
	if (!lookup.data && !lookup.error) lookup = await findExisting('url', item.url)
	if (lookup.error) throw new Error(`Could not resolve duplicate scraped item: ${lookup.error.message}`)
	if (!lookup.data || item.published_at === null || lookup.data.published_at !== null) return 'duplicate'

	const existingMetadata = lookup.data.metadata && typeof lookup.data.metadata === 'object' && !Array.isArray(lookup.data.metadata)
		? lookup.data.metadata as Record<string, unknown>
		: {}
	const newRawTimestamp = typeof item.metadata.raw_timestamp === 'string' ? item.metadata.raw_timestamp : null
	const newProvider = typeof item.metadata.provider === 'string' ? item.metadata.provider.trim() : ''
	const existingProvider = typeof existingMetadata.provider === 'string' ? existingMetadata.provider.trim() : ''
	const legacyProvider = newProvider.length > 0 && (
		existingProvider === `${lookup.data.title ?? ''} (${newProvider})` ||
		existingProvider.endsWith(`(${newProvider})`)
	)
	const metadata = {
		...existingMetadata,
		...(newRawTimestamp ? { raw_timestamp: newRawTimestamp } : {}),
		...(newProvider && (!existingProvider || legacyProvider) ? { provider: newProvider } : {}),
	}

	const { error: updateError } = await client
		.from('scraped_items')
		.update({ published_at: item.published_at, metadata })
		.eq('id', lookup.data.id)
		.is('published_at', null)

	if (updateError) throw new Error(`Could not update duplicate scraped item: ${updateError.message}`)
	return 'updated'
}

type ExistingFinvizItem = {
	id: string
	source_id: string
	ticker: string | null
	content_hash: string
	url: string
	title: string | null
	published_at: string | null
	metadata: Record<string, unknown>
}

export type SaveFinvizItemsResult = { new: number; duplicate: number; updated: number }

function itemKey(sourceId: string, ticker: string | null, value: string): string {
	return `${sourceId}\u0000${ticker ?? ''}\u0000${value}`
}

function metadataForRepair(existing: ExistingFinvizItem, item: ScrapedItemDraft): Record<string, unknown> {
	const existingMetadata = existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
		? existing.metadata
		: {}
	const newRawTimestamp = typeof item.metadata.raw_timestamp === 'string' ? item.metadata.raw_timestamp : null
	const newProvider = typeof item.metadata.provider === 'string' ? item.metadata.provider.trim() : ''
	const existingProvider = typeof existingMetadata.provider === 'string' ? existingMetadata.provider.trim() : ''
	const legacyProvider = newProvider.length > 0 && (
		existingProvider === `${existing.title ?? ''} (${newProvider})` ||
		existingProvider.endsWith(`(${newProvider})`)
	)

	return {
		...existingMetadata,
		...(newRawTimestamp ? { raw_timestamp: newRawTimestamp } : {}),
		...(newProvider && (!existingProvider || legacyProvider) ? { provider: newProvider } : {}),
	}
}

async function updateFinvizItem(client: ReturnType<typeof createBackendClient>, existing: ExistingFinvizItem, item: ScrapedItemDraft): Promise<void> {
	const { error } = await client
		.from('scraped_items')
		.update({ published_at: item.published_at, metadata: metadataForRepair(existing, item) })
		.eq('id', existing.id)
		.is('published_at', null)
	if (error) throw new Error(`Could not update duplicate scraped item: ${error.message}`)
}

async function findExistingFinvizItem(client: ReturnType<typeof createBackendClient>, item: ScrapedItemDraft): Promise<ExistingFinvizItem | null> {
	const fields = 'id, source_id, ticker, content_hash, url, title, published_at, metadata'
	const byHash = await client
		.from('scraped_items')
		.select(fields)
		.eq('source_id', item.source_id)
		.eq('ticker', item.ticker)
		.eq('content_hash', item.content_hash)
		.limit(1)
		.maybeSingle()
	if (byHash.error) throw new Error(`Could not resolve duplicate scraped item: ${byHash.error.message}`)
	if (byHash.data) return byHash.data as ExistingFinvizItem

	const byUrl = await client
		.from('scraped_items')
		.select(fields)
		.eq('source_id', item.source_id)
		.eq('ticker', item.ticker)
		.eq('url', item.url)
		.limit(1)
		.maybeSingle()
	if (byUrl.error) throw new Error(`Could not resolve duplicate scraped item: ${byUrl.error.message}`)
	return byUrl.data as ExistingFinvizItem | null
}

async function classifyExistingFinvizItem(client: ReturnType<typeof createBackendClient>, item: ScrapedItemDraft, existing: ExistingFinvizItem): Promise<'duplicate' | 'updated'> {
	if (item.published_at === null || existing.published_at !== null) return 'duplicate'
	await updateFinvizItem(client, existing, item)
	return 'updated'
}

async function saveAfterFinvizBatchConflict(client: ReturnType<typeof createBackendClient>, item: ScrapedItemDraft): Promise<{ result: 'new' | 'duplicate' | 'updated'; existing?: ExistingFinvizItem }> {
	const { error } = await client.from('scraped_items').insert(item)
	if (!error) return { result: 'new' }
	if (error.code !== '23505') throw new Error(`Could not save scraped item: ${error.message}`)

	const existing = await findExistingFinvizItem(client, item)
	if (!existing) throw new Error('Could not resolve duplicate scraped item after batch conflict')
	return { result: await classifyExistingFinvizItem(client, item, existing), existing }
}

export async function saveFinvizScrapedItems(items: ScrapedItemDraft[]): Promise<SaveFinvizItemsResult> {
	if (items.length === 0) return { new: 0, duplicate: 0, updated: 0 }

	const client = createBackendClient()
	const firstItem = items[0]
	const fields = 'id, source_id, ticker, content_hash, url, title, published_at, metadata'
	const hashes = [...new Set(items.map((item) => item.content_hash))]
	const existingByHash = new Map<string, ExistingFinvizItem>()
	const byHash = await client
		.from('scraped_items')
		.select(fields)
		.eq('source_id', firstItem.source_id)
		.eq('ticker', firstItem.ticker)
		.in('content_hash', hashes)
	if (byHash.error) throw new Error(`Could not resolve duplicate scraped items: ${byHash.error.message}`)
	for (const row of (byHash.data ?? []) as ExistingFinvizItem[]) existingByHash.set(itemKey(row.source_id, row.ticker, row.content_hash), row)

	const unresolved = items.filter((item) => !existingByHash.has(itemKey(item.source_id, item.ticker, item.content_hash)))
	const existingByUrl = new Map<string, ExistingFinvizItem>()
	const urls = [...new Set(unresolved.map((item) => item.url))]
	if (urls.length > 0) {
		const byUrl = await client
			.from('scraped_items')
			.select(fields)
			.eq('source_id', firstItem.source_id)
			.eq('ticker', firstItem.ticker)
			.in('url', urls)
		if (byUrl.error) throw new Error(`Could not resolve duplicate scraped items: ${byUrl.error.message}`)
		for (const row of (byUrl.data ?? []) as ExistingFinvizItem[]) existingByUrl.set(itemKey(row.source_id, row.ticker, row.url), row)
	}

	const newItems: ScrapedItemDraft[] = []
	const repairs: Array<{ item: ScrapedItemDraft; existing: ExistingFinvizItem }> = []
	let duplicate = 0
	for (const item of items) {
		const existing = existingByHash.get(itemKey(item.source_id, item.ticker, item.content_hash)) ?? existingByUrl.get(itemKey(item.source_id, item.ticker, item.url))
		if (!existing) {
			newItems.push(item)
		} else if (item.published_at !== null && existing.published_at === null) {
			repairs.push({ item, existing })
		} else {
			duplicate += 1
		}
	}

	let newCount = 0
	let updated = 0
	if (newItems.length > 0) {
		const { error } = await client.from('scraped_items').insert(newItems)
		if (!error) {
			newCount = newItems.length
		} else if (error.code === '23505') {
			for (const item of newItems) {
				const result = await saveAfterFinvizBatchConflict(client, item)
				if (result.result === 'new') newCount += 1
				else if (result.result === 'updated') updated += 1
				else duplicate += 1
			}
		} else {
			throw new Error(`Could not save scraped items: ${error.message}`)
		}
	}

	for (const repair of repairs) {
		await updateFinvizItem(client, repair.existing, repair.item)
		updated += 1
	}

	return { new: newCount, duplicate, updated }
}

export type SaveStructuredFinvizResult = { new: number; duplicate: number }

async function saveStructuredFinvizRecords<T extends { source_id: string; ticker: string; content_hash: string }>(table: string, items: T[]): Promise<SaveStructuredFinvizResult> {
	if (items.length === 0) return { new: 0, duplicate: 0 }
	const client = createBackendClient()
	const hashes = [...new Set(items.map((item) => item.content_hash))]
	const existing = await client.from(table).select('content_hash').eq('source_id', items[0].source_id).eq('ticker', items[0].ticker).in('content_hash', hashes)
	if (existing.error) throw new Error(`Could not resolve FINVIZ structured duplicates: ${existing.error.message}`)
	const existingHashes = new Set((existing.data ?? []).map((row) => row.content_hash).filter((hash): hash is string => typeof hash === 'string'))
	let newCount = 0
	let duplicate = 0
	for (const item of items) {
		if (existingHashes.has(item.content_hash)) {
			duplicate += 1
			continue
		}
		const inserted = await client.from(table).insert(item)
		if (!inserted.error) {
			newCount += 1
			existingHashes.add(item.content_hash)
		} else if (inserted.error.code === '23505') duplicate += 1
		else throw new Error(`Could not save FINVIZ structured record: ${inserted.error.message}`)
	}
	return { new: newCount, duplicate }
}

export function saveFinvizAnalystRatings(items: FinvizAnalystRatingDraft[]): Promise<SaveStructuredFinvizResult> {
	return saveStructuredFinvizRecords('finviz_analyst_ratings', items)
}

export function saveFinvizInsiderTrades(items: FinvizInsiderTradeDraft[]): Promise<SaveStructuredFinvizResult> {
	return saveStructuredFinvizRecords('finviz_insider_trades', items)
}

export async function saveFinvizMarketSnapshots(items: FinvizMarketSnapshotDraft[]): Promise<{ new: number }> {
	if (items.length === 0) return { new: 0 }
	const client = createBackendClient()
	const { error } = await client.from('finviz_market_data').insert(items)
	if (error) throw new Error(`Could not save FINVIZ market snapshot: ${error.message}`)
	return { new: items.length }
}
