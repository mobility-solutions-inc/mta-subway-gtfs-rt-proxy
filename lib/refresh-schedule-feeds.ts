import { ok } from 'node:assert'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import type { AddressInfo } from 'node:net'
import { queryImports } from '#postgis-gtfs-importer'
import { importGtfsAtomically } from '#postgis-gtfs-importer/import'
import ky from 'ky'
import pgFormat from 'pg-format'
import { Counter, Gauge, Summary } from 'prom-client'

import type { ScheduleFeedDatabase } from './types.js'
import {
	feedNameDimension,
	publishCloudWatchMetrics,
} from './cloudwatch-metrics.js'
import { connectToPostgres, getPgOpts } from './db.js'
import { createLogger } from './logger.js'
import { register as metricsRegister } from './metrics.js'
import {
	deleteScheduleFeedArchive,
	ensureScheduleFeedStore,
	getLatestScheduleFeedCheck,
	getScheduleFeedValidators,
	isScheduleFeedDigestRetained,
	markLatestScheduleFeedChecked,
	storeScheduleFeedArchive,
	withScheduleFeedDigestLock,
} from './schedule-feed-store.js'

const require = createRequire(import.meta.url)
const pkg = require('../../package.json') as {
	name: string
	version: string
}

const PREVIOUS_STOPTIMEUPDATES_POSTPROCESSING_D_PATH =
	require.resolve('./postprocessing.d/previous-stoptimeupdates.sql')
const POSTPROCESSING_D_PATH = dirname(
	PREVIOUS_STOPTIMEUPDATES_POSTPROCESSING_D_PATH,
)

const IMPORTER_LOG_LEVEL = process.env.LOG_LEVEL_POSTGIS_GTFS_IMPORTER ?? 'warn'
const SCHEDULE_DATA_LOG_LEVEL = process.env.LOG_LEVEL_SCHEDULE_DATA ?? 'info'
const DB_NAME_PREFIX = process.env.SCHEDULE_FEED_DB_NAME_PREFIX ?? 'gtfs_'
const FETCH_INTERVAL_MS = process.env.SCHEDULE_FEED_REFRESH_INTERVAL
	? parseInt(process.env.SCHEDULE_FEED_REFRESH_INTERVAL) * 1000
	: 15 * 60 * 1000
const FETCH_INTERVAL_MIN_MS = process.env.SCHEDULE_FEED_REFRESH_MIN_INTERVAL
	? parseInt(process.env.SCHEDULE_FEED_REFRESH_MIN_INTERVAL) * 1000
	: 60 * 1000
const STALE_AFTER_MS = process.env.SCHEDULE_FEED_STALE_AFTER
	? parseInt(process.env.SCHEDULE_FEED_STALE_AFTER) * 1000
	: 2 * 60 * 60 * 1000

const noOfImportedScheduleFeeds = new Gauge({
	name: 'imported_schedule_feeds_total',
	help: 'number of currently imported GTFS Schedule feeds',
	registers: [metricsRegister],
})
const scheduleFeedLastCheckedTimestamp = new Gauge({
	name: 'schedule_feed_last_checked_timestamp_seconds',
	help: 'UNIX timestamp of the latest successful upstream schedule check',
	registers: [metricsRegister],
	labelNames: ['feed_name'],
})
const scheduleFeedLastImportedTimestamp = new Gauge({
	name: 'schedule_feed_last_imported_timestamp_seconds',
	help: 'UNIX timestamp of the latest successful schedule import',
	registers: [metricsRegister],
	labelNames: ['feed_name'],
})
const scheduleFeedRefreshFailures = new Counter({
	name: 'schedule_feed_refresh_failures_total',
	help: 'number of failed schedule feed refresh cycles',
	registers: [metricsRegister],
	labelNames: ['feed_name'],
})
const fetchDurationSeconds = new Summary({
	name: 'schedule_feed_fetch_duration_seconds',
	help: 'time needed to fetch the GTFS Schedule feed',
	registers: [metricsRegister],
	labelNames: ['feed_name'],
})
const dataImported = new Gauge({
	name: 'schedule_feed_imported_boolean',
	help: 'during the last fetch/import cycle, whether the feed changed',
	registers: [metricsRegister],
	labelNames: ['feed_name'],
})
const importDurationSeconds = new Summary({
	name: 'schedule_feed_import_duration_seconds',
	help: 'time needed to import the GTFS Schedule feed',
	registers: [metricsRegister],
	labelNames: ['feed_name'],
})

interface QueryImportedScheduleFeedVersionsConfig {
	scheduleFeedName: string
}

const queryImportedScheduleFeedVersions = async (
	cfg: QueryImportedScheduleFeedVersionsConfig,
): Promise<ScheduleFeedDatabase[]> => {
	const { scheduleFeedName } = cfg
	ok(scheduleFeedName, 'scheduleFeedName')

	const databaseNamePrefix = `${DB_NAME_PREFIX}${scheduleFeedName}_`
	const { latestSuccessfulImports } = await queryImports({
		databaseNamePrefix,
		pgOpts: getPgOpts(),
	})
	const currentDatabases = latestSuccessfulImports.map((_import) => ({
		name: _import.dbName,
		importedAt: _import.importedAt,
		feedDigest: _import.feedDigest,
	}))
	noOfImportedScheduleFeeds.set(currentDatabases.length)
	return currentDatabases
}

const importerLogger = createLogger('postgis-gtfs-importer', IMPORTER_LOG_LEVEL)
const scheduleLogger = createLogger('schedule-data', SCHEDULE_DATA_LOG_LEVEL)

const downloadScheduleFeed = async (cfg: {
	feedName: string
	gtfsDownloadUrl: string
}) => {
	const { feedName, gtfsDownloadUrl } = cfg
	const { etag, lastModified } = await getScheduleFeedValidators()
	const headers: Record<string, string> = {
		'user-agent':
			process.env.SCHEDULE_FETCHING_USER_AGENT ?? `${pkg.name} v${pkg.version}`,
	}
	if (etag) headers['if-none-match'] = etag
	if (lastModified) headers['if-modified-since'] = lastModified

	const startedAt = performance.now()
	const response = await ky(gtfsDownloadUrl, {
		headers,
		redirect: 'follow',
		retry: { limit: 3 },
		throwHttpErrors: false,
	})
	fetchDurationSeconds.observe(
		{ feed_name: feedName },
		(performance.now() - startedAt) / 1000,
	)

	if (response.status === 304) {
		return { changed: false as const }
	}
	if (!response.ok) {
		throw new Error(`schedule feed request failed with HTTP ${response.status}`)
	}

	const feedZip = Buffer.from(await response.arrayBuffer())
	if (feedZip.length === 0) throw new Error('downloaded schedule feed is empty')
	return {
		changed: true as const,
		etag: response.headers.get('etag'),
		feedZip,
		lastModified: response.headers.get('last-modified'),
	}
}

const importDownloadedScheduleFeed = async (cfg: {
	feedZip: Buffer
	feedName: string
}) => {
	const { feedName, feedZip } = cfg
	const databaseNamePrefix = `${DB_NAME_PREFIX}${feedName}_`
	const verboseLogging = importerLogger.isLevelEnabled('trace')
	const localServer = createServer((_req, res) => {
		res.setHeader('content-type', 'application/zip')
		res.end(feedZip)
	})
	await new Promise<void>((resolve) => {
		localServer.listen(0, '127.0.0.1', resolve)
	})
	const address = localServer.address() as AddressInfo
	let result
	try {
		result = await importGtfsAtomically({
			logger: importerLogger,
			downloadScriptVerbose: verboseLogging,
			connectDownloadScriptToStdout: verboseLogging,
			importScriptVerbose: verboseLogging,
			connectImportScriptToStdout: verboseLogging,
			pgOpts: getPgOpts(),
			databaseNamePrefix,
			gtfsDownloadUrl: `http://127.0.0.1:${address.port}/gtfs.zip`,
			gtfsDownloadUserAgent:
				process.env.SCHEDULE_FETCHING_USER_AGENT ??
				`${pkg.name} v${pkg.version}`,
			gtfstidyBeforeImport: false,
			// Keep every successful version until its ZIP is archived and the lease
			// policy can run. Databases absent from the successful-import ledger are
			// unfinished imports and should be cleaned up by the importer.
			determineDbsToRetain: (imports) => imports.map(({ dbName }) => dbName),
			gtfsPostprocessingDPath: POSTPROCESSING_D_PATH,
		})
	} finally {
		await new Promise<void>((resolve, reject) => {
			localServer.close((error) => {
				if (error) reject(error)
				else resolve()
			})
		})
	}
	dataImported.set({ feed_name: feedName }, result.importSkipped ? 0 : 1)
	if (result.importDurationMs !== null) {
		importDurationSeconds.observe(
			{ feed_name: feedName },
			result.importDurationMs / 1000,
		)
	}
	return result
}

const pruneScheduleFeedVersions = async (scheduleFeedName: string) => {
	const current = await queryImportedScheduleFeedVersions({
		scheduleFeedName,
	})
	const [latest] = current
	if (!latest) return current

	const obsolete = current.filter(
		({ feedDigest }) => feedDigest !== latest.feedDigest,
	)
	if (obsolete.length === 0) return current

	const db = await connectToPostgres()
	try {
		for (const { feedDigest, name } of obsolete) {
			await withScheduleFeedDigestLock(db, feedDigest, async (client) => {
				if (
					await isScheduleFeedDigestRetained(
						client,
						feedDigest,
						latest.feedDigest,
					)
				) {
					return
				}
				scheduleLogger.info(
					{ feedDigest, scheduleDatabaseName: name },
					'pruning unleased schedule feed version',
				)
				await client.query(pgFormat('DROP DATABASE %I WITH (FORCE)', name))
				await client.query(
					'DELETE FROM latest_successful_imports WHERE db_name = $1',
					[name],
				)
				await deleteScheduleFeedArchive(feedDigest, client)
			})
		}
	} finally {
		await db.end()
	}
	return await queryImportedScheduleFeedVersions({ scheduleFeedName })
}

interface StartRefreshingScheduleFeedConfig {
	onImportDone: (payload: {
		currentDatabases: ScheduleFeedDatabase[]
	}) => Promise<void> | void
	scheduleFeedName: string
	scheduleFeedUrl: string
}

const startRefreshingScheduleFeed = (
	cfg: StartRefreshingScheduleFeedConfig,
) => {
	const { scheduleFeedName, scheduleFeedUrl, onImportDone } = cfg
	ok(scheduleFeedName, 'scheduleFeedName')
	ok(scheduleFeedUrl, 'scheduleFeedUrl')
	ok(onImportDone, 'onImportDone')

	let keepRefreshing = true
	let waitTimer: NodeJS.Timeout | null = null
	let isReady = false
	let lastSuccessfulCheckAt = 0

	void (async () => {
		await ensureScheduleFeedStore()
		const existing = await queryImportedScheduleFeedVersions({
			scheduleFeedName,
		})
		if (existing.length > 0) {
			isReady = true
			const persistedLastCheck = await getLatestScheduleFeedCheck()
			lastSuccessfulCheckAt = persistedLastCheck?.getTime() ?? 0
			if (lastSuccessfulCheckAt > 0) {
				scheduleFeedLastCheckedTimestamp.set(
					{ feed_name: scheduleFeedName },
					lastSuccessfulCheckAt / 1000,
				)
			}
			await onImportDone({ currentDatabases: existing })
		}

		while (keepRefreshing) {
			const startedAt = performance.now()
			try {
				const download = await downloadScheduleFeed({
					feedName: scheduleFeedName,
					gtfsDownloadUrl: scheduleFeedUrl,
				})

				let currentDatabases = existing
				if (download.changed) {
					const result = await importDownloadedScheduleFeed({
						feedZip: download.feedZip,
						feedName: scheduleFeedName,
					})
					currentDatabases = await queryImportedScheduleFeedVersions({
						scheduleFeedName,
					})
					const imported = result.newImport
						? {
								name: result.newImport.dbName,
								feedDigest: result.newImport.feedDigest,
								importedAt: result.newImport.importedAt,
							}
						: currentDatabases[0]
					ok(imported, 'schedule import did not produce an imported database')
					await storeScheduleFeedArchive({
						dbName: imported.name,
						etag: download.etag,
						feedDigest: imported.feedDigest,
						feedZip: download.feedZip,
						importedAt: imported.importedAt,
						lastModified: download.lastModified,
					})
					currentDatabases = await pruneScheduleFeedVersions(scheduleFeedName)
					if (!result.importSkipped) {
						scheduleFeedLastImportedTimestamp.set(
							{ feed_name: scheduleFeedName },
							imported.importedAt,
						)
					}
				} else {
					dataImported.set({ feed_name: scheduleFeedName }, 0)
					currentDatabases = await pruneScheduleFeedVersions(scheduleFeedName)
					const checkedAt = await markLatestScheduleFeedChecked()
					ok(
						checkedAt,
						'unchanged schedule feed has no archived successful version',
					)
					lastSuccessfulCheckAt = checkedAt.getTime()
				}

				if (download.changed) {
					const persistedLastCheck = await getLatestScheduleFeedCheck()
					ok(
						persistedLastCheck,
						'imported schedule feed has no check timestamp',
					)
					lastSuccessfulCheckAt = persistedLastCheck.getTime()
				}
				scheduleFeedLastCheckedTimestamp.set(
					{ feed_name: scheduleFeedName },
					lastSuccessfulCheckAt / 1000,
				)
				await publishCloudWatchMetrics([
					{
						MetricName: 'ScheduleRefreshSuccess',
						Dimensions: feedNameDimension(scheduleFeedName),
						Unit: 'Count',
						Value: 1,
					},
					{
						MetricName: 'ScheduleAgeSeconds',
						Dimensions: feedNameDimension(scheduleFeedName),
						Unit: 'Seconds',
						Value: Math.max(0, (Date.now() - lastSuccessfulCheckAt) / 1000),
					},
				])
				isReady = currentDatabases.length > 0
				await onImportDone({ currentDatabases })
			} catch (error) {
				scheduleFeedRefreshFailures.inc({ feed_name: scheduleFeedName })
				await publishCloudWatchMetrics([
					{
						MetricName: 'ScheduleRefreshSuccess',
						Dimensions: feedNameDimension(scheduleFeedName),
						Unit: 'Count',
						Value: 0,
					},
					{
						MetricName: 'ScheduleAgeSeconds',
						Dimensions: feedNameDimension(scheduleFeedName),
						Unit: 'Seconds',
						Value:
							lastSuccessfulCheckAt > 0
								? (Date.now() - lastSuccessfulCheckAt) / 1000
								: STALE_AFTER_MS / 1000 + 1,
					},
				])
				scheduleLogger.error(
					{ error, scheduleFeedName },
					'failed to refresh GTFS Schedule feed; retaining last successful version',
				)
			}

			const timePassedMs = performance.now() - startedAt
			const waitMs = Math.max(
				FETCH_INTERVAL_MS - timePassedMs,
				FETCH_INTERVAL_MIN_MS,
			)
			await new Promise<void>((resolve) => {
				waitTimer = setTimeout(resolve, waitMs)
			})
		}
	})().catch((error: unknown) => {
		scheduleLogger.error(
			{ error, scheduleFeedName },
			'schedule refresh loop stopped unexpectedly',
		)
	})

	const stopRefreshing = () => {
		keepRefreshing = false
		if (waitTimer !== null) clearTimeout(waitTimer)
	}
	const checkIfHealthy = () =>
		Promise.resolve(
			lastSuccessfulCheckAt > 0 &&
				Date.now() - lastSuccessfulCheckAt <= STALE_AFTER_MS,
		)
	const checkIfReady = () => Promise.resolve(isReady)

	return {
		stopRefreshing,
		checkIfHealthy,
		checkIfReady,
	}
}

export { queryImportedScheduleFeedVersions, startRefreshingScheduleFeed }
