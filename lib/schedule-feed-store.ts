import { ok } from 'node:assert'
import { Gauge } from 'prom-client'

import { connectToPostgres } from './db.js'
import { register as metricsRegister } from './metrics.js'

const RETENTION_MS = process.env.SCHEDULE_FEED_USED_RETENTION
	? parseInt(process.env.SCHEDULE_FEED_USED_RETENTION) * 1000
	: 24 * 60 * 60 * 1000

interface ScheduleFeedArchive {
	available: boolean
	etag: string | null
	feedDigest: string
	firstRequestedAt: string | null
	importedAt: string
	lastModified: string | null
	lastRequestedAt: string | null
	sizeBytes: number
}

interface ScheduleFeedArchiveRow {
	etag: string | null
	feed_digest: string
	feed_zip: Buffer
	first_requested_at: Date | null
	imported_at: Date
	last_modified: string | null
	last_requested_at: Date | null
}

const archivedScheduleFeeds = new Gauge({
	name: 'schedule_feed_archives_total',
	help: 'number of archived GTFS Schedule feeds',
	registers: [metricsRegister],
})

const activeScheduleFeedLeases = new Gauge({
	name: 'schedule_feed_active_leases_total',
	help: 'number of schedule feed digests requested within the retention window',
	registers: [metricsRegister],
})

let schemaPromise: Promise<void> | null = null
let dbPromise: ReturnType<typeof connectToPostgres> | null = null
let lastMetricsRefreshAt = 0

const getStoreDb = () => {
	dbPromise ??= connectToPostgres()
	return dbPromise
}

const ensureScheduleFeedStore = async () => {
	if (schemaPromise !== null) return schemaPromise

	schemaPromise = (async () => {
		const db = await getStoreDb()
		await db.query(`
			CREATE TABLE IF NOT EXISTS schedule_feed_archives (
				feed_digest TEXT PRIMARY KEY,
				db_name TEXT NOT NULL UNIQUE,
				imported_at TIMESTAMPTZ NOT NULL,
				feed_zip BYTEA NOT NULL,
				etag TEXT,
				last_modified TEXT,
				first_requested_at TIMESTAMPTZ,
				last_requested_at TIMESTAMPTZ
			)
		`)
	})()

	try {
		await schemaPromise
	} catch (error) {
		schemaPromise = null
		throw error
	}
}

const refreshArchiveMetrics = async (force = false) => {
	if (!force && Date.now() - lastMetricsRefreshAt < 10_000) return
	const db = await getStoreDb()
	const { rows } = await db.query<{
		active: string
		total: string
	}>(
		`
			SELECT
				count(*)::text AS total,
				count(*) FILTER (
					WHERE last_requested_at >= now() - ($1 * interval '1 millisecond')
				)::text AS active
			FROM schedule_feed_archives
		`,
		[RETENTION_MS],
	)
	const [row] = rows
	archivedScheduleFeeds.set(parseInt(row?.total ?? '0'))
	activeScheduleFeedLeases.set(parseInt(row?.active ?? '0'))
	lastMetricsRefreshAt = Date.now()
}

const storeScheduleFeedArchive = async (cfg: {
	dbName: string
	etag: string | null
	feedDigest: string
	feedZip: Buffer
	importedAt: number
	lastModified: string | null
}) => {
	await ensureScheduleFeedStore()
	const { dbName, etag, feedDigest, feedZip, importedAt, lastModified } = cfg
	const db = await getStoreDb()
	await db.query(
		`
				INSERT INTO schedule_feed_archives (
					feed_digest,
					db_name,
					imported_at,
					feed_zip,
					etag,
					last_modified
				)
				VALUES ($1, $2, to_timestamp($3), $4, $5, $6)
				ON CONFLICT (feed_digest) DO UPDATE SET
					db_name = EXCLUDED.db_name,
					imported_at = EXCLUDED.imported_at,
					feed_zip = EXCLUDED.feed_zip,
					etag = EXCLUDED.etag,
					last_modified = EXCLUDED.last_modified
			`,
		[feedDigest, dbName, importedAt, feedZip, etag, lastModified],
	)
	await refreshArchiveMetrics(true)
}

const getScheduleFeedValidators = async () => {
	await ensureScheduleFeedStore()
	const db = await getStoreDb()
	const { rows } = await db.query<{
		etag: string | null
		last_modified: string | null
	}>(`
			SELECT etag, last_modified
			FROM schedule_feed_archives
			ORDER BY imported_at DESC
			LIMIT 1
		`)
	const [latest] = rows
	return {
		etag: latest?.etag ?? null,
		lastModified: latest?.last_modified ?? null,
	}
}

const listScheduleFeedArchives = async (): Promise<ScheduleFeedArchive[]> => {
	await ensureScheduleFeedStore()
	const db = await getStoreDb()
	const { rows } = await db.query<
		Omit<ScheduleFeedArchiveRow, 'feed_zip'> & { size_bytes: number }
	>(`
			SELECT
				feed_digest,
				imported_at,
				etag,
				last_modified,
				first_requested_at,
				last_requested_at,
				octet_length(feed_zip) AS size_bytes
			FROM schedule_feed_archives
			ORDER BY imported_at DESC
		`)
	return rows.map((row) => ({
		available: true,
		etag: row.etag,
		feedDigest: row.feed_digest,
		firstRequestedAt: row.first_requested_at?.toISOString() ?? null,
		importedAt: row.imported_at.toISOString(),
		lastModified: row.last_modified,
		lastRequestedAt: row.last_requested_at?.toISOString() ?? null,
		sizeBytes: row.size_bytes,
	}))
}

const markScheduleFeedRequested = async (feedDigest: string) => {
	await ensureScheduleFeedStore()
	const db = await getStoreDb()
	const result = await db.query(
		`
				UPDATE schedule_feed_archives
				SET
					first_requested_at = coalesce(first_requested_at, now()),
					last_requested_at = now()
				WHERE feed_digest = $1
			`,
		[feedDigest],
	)
	await refreshArchiveMetrics()
	return result.rowCount === 1
}

const getScheduleFeedArchive = async (feedDigest: string) => {
	await ensureScheduleFeedStore()
	const db = await getStoreDb()
	const { rows } = await db.query<ScheduleFeedArchiveRow>(
		`
				UPDATE schedule_feed_archives
				SET
					first_requested_at = coalesce(first_requested_at, now()),
					last_requested_at = now()
				WHERE feed_digest = $1
				RETURNING
					feed_digest,
					imported_at,
					feed_zip,
					etag,
					last_modified,
					first_requested_at,
					last_requested_at
			`,
		[feedDigest],
	)
	await refreshArchiveMetrics()
	const [row] = rows
	if (!row) return null
	return {
		etag: row.etag,
		feedDigest: row.feed_digest,
		feedZip: row.feed_zip,
		importedAt: row.imported_at,
		lastModified: row.last_modified,
	}
}

const queryRetainedScheduleFeedDigests = async (latestDigest: string) => {
	await ensureScheduleFeedStore()
	ok(latestDigest, 'latestDigest')
	const db = await getStoreDb()
	const { rows } = await db.query<{ feed_digest: string }>(
		`
				SELECT feed_digest
				FROM schedule_feed_archives
				WHERE
					feed_digest = $1
					OR last_requested_at >= now() - ($2 * interval '1 millisecond')
			`,
		[latestDigest, RETENTION_MS],
	)
	return new Set(rows.map((row) => row.feed_digest))
}

const deleteScheduleFeedArchive = async (feedDigest: string) => {
	await ensureScheduleFeedStore()
	const db = await getStoreDb()
	await db.query('DELETE FROM schedule_feed_archives WHERE feed_digest = $1', [
		feedDigest,
	])
	await refreshArchiveMetrics(true)
}

const closeScheduleFeedStore = async () => {
	if (dbPromise !== null) {
		const db = await dbPromise
		await db.end()
		dbPromise = null
		schemaPromise = null
	}
}

export {
	closeScheduleFeedStore,
	deleteScheduleFeedArchive,
	ensureScheduleFeedStore,
	getScheduleFeedArchive,
	getScheduleFeedValidators,
	listScheduleFeedArchives,
	markScheduleFeedRequested,
	queryRetainedScheduleFeedDigests,
	storeScheduleFeedArchive,
}
