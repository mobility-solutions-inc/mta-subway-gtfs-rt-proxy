import { ok } from 'node:assert'
import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Counter } from 'prom-client'

import type { FeedEntityType } from './lib/serve-gtfs-rt.js'
import type {
	HttpRequest,
	HttpResponse,
	ScheduleFeedDatabase,
} from './lib/types.js'
import {
	feedNameDimension,
	publishCloudWatchMetrics,
} from './lib/cloudwatch-metrics.js'
import { ALL_FEEDS } from './lib/feeds.js'
import { startFetchingRealtimeFeed } from './lib/fetch-realtime-feed.js'
import { createLogger } from './lib/logger.js'
import { createParseAndProcessFeed } from './lib/match.js'
import {
	createMetricsServer,
	register as metricsRegister,
} from './lib/metrics.js'
import { protobufLongToNumber } from './lib/protobuf.js'
import {
	pruneScheduleFeedVersions,
	startRefreshingScheduleFeed,
} from './lib/refresh-schedule-feeds.js'
import {
	closeScheduleFeedStore,
	getScheduleFeedArchive,
	listScheduleFeedArchives,
	markScheduleFeedRequested,
} from './lib/schedule-feed-store.js'
import { serveFeed } from './lib/serve-gtfs-rt.js'

const SERVICE_LOG_LEVEL = process.env.LOG_LEVEL_SERVICE ?? 'info'

const unavailableScheduleFeedRequests = new Counter({
	name: 'schedule_feed_unavailable_digest_requests_total',
	help: 'number of requests for a schedule feed digest that is unavailable',
	labelNames: ['endpoint'],
	registers: [metricsRegister],
})

interface CreateServiceOptions {
	port?: number
}

interface FeedHandler {
	serveFeed: (
		req: HttpRequest,
		res: HttpResponse,
		entityType?: FeedEntityType | null,
	) => void
	stop: () => void
}

interface ScheduleFeedHandlers {
	checkIfHealthy: () => Promise<boolean>
	closeConnections: () => Promise<void>
	databaseName: string
	feedHandlers: Map<string, FeedHandler>
}

const getPort = (address: AddressInfo | string | null) => {
	ok(
		address && typeof address !== 'string',
		'server address must be an AddressInfo',
	)
	return address.port
}

const createService = async (opt: CreateServiceOptions = {}) => {
	const { port } = {
		port: parseInt(process.env.PORT ?? '3000'),
		...opt,
	}

	const metricsServer = createMetricsServer()

	const logger = createLogger('service', SERVICE_LOG_LEVEL)

	// todo: iterate over all schedule feeds
	const [scheduleFeed] = ALL_FEEDS
	logger.debug(
		{
			feeds: [scheduleFeed],
		},
		'configured feed(s)',
	)
	const { scheduleFeedName, scheduleFeedUrl, realtimeFeeds } = scheduleFeed

	const logCtx = {
		scheduleFeedName,
	}

	// ## fetch of GTFS Realtime feeds
	// Each realtime feed neeeds only one fetcher, regardless of how many schedule feeds it is matched against.

	// realtimeFeedName -> {abortFetching, events}
	const realtimeFetchersByName = new Map<
		string,
		ReturnType<typeof startFetchingRealtimeFeed>
	>()

	for (const realtimeFeed of realtimeFeeds) {
		const { realtimeFeedName, realtimeFeedUrl, realtimeFeedApiKey } =
			realtimeFeed
		logger.debug(
			logCtx,
			`setting up realtime feed fetcher for "${realtimeFeedName}"`,
		)

		const { abortFetching, events } = startFetchingRealtimeFeed({
			realtimeFeedName,
			realtimeFeedUrl,
			realtimeFeedApiKey,
		})

		realtimeFetchersByName.set(realtimeFeedName, {
			abortFetching,
			events,
		})
	}

	// ## configure matching & serving of fetched realtime feeds
	// We set up a nested Map structure below to accomodate the following business logic:
	// - Each schedule feed has a constantly changing set of versions, each "schedule feed version" identified by its digest (and its database name, which includes the feed digest).
	// - We match each of the schedule feed's `r` associated realtime feeds against each of the its `v` versions, so we end up with `r * v` "feed handlers".
	// - Each "feed handler" consists of two functions `matchAndEncodeFeed` & `serveFeed`.

	// todo: after process start it is empty, figure out a solution
	// todo [breaking]: rename `closeConnections` to e.g. `stopMatchingRealtimeFeed`
	// scheduleFeedDigest -> {
	// 	feedHandlers: realtimeFeedName -> {serveFeed, stop},
	// 	closeConnections,
	// }
	const feedHandlersByScheduleFeedDigest = new Map<
		string,
		ScheduleFeedHandlers
	>()

	const addScheduleFeedVersion = async (
		scheduleFeedDigest: string,
		scheduleDatabaseName: string,
	) => {
		const _logCtx = {
			...logCtx,
			scheduleFeedDigest,
			scheduleDatabaseName,
		}
		logger.info(
			_logCtx,
			`creating new matcher for schedule database "${scheduleDatabaseName}"`,
		)

		// Note: Prometheus stores time series per combination of label values, so having labels with a high or even unbound cardinality is a problem. We still want to be able to tell the schedule databases' metrics apart in the monitoring system, so we add the first hex digit (with a cardinality of 16) of the GTFS Schedule feed's hash as a label.
		// see also https://www.robustperception.io/cardinality-is-key/
		const scheduleFeedDigestSlice = scheduleFeedDigest.slice(0, 1)

		const {
			parseAndProcessFeed: parseAndMatchRealtimeFeed,
			stop: stopMatchingRealtimeFeed,
			checkIfHealthy: checkIfMatcherIsHealthy,
		} = await createParseAndProcessFeed({
			// todo: pass realtimeFeedName through into metrics?
			scheduleDatabaseName,
			scheduleFeedDigest,
			scheduleFeedDigestSlice,
		})

		const createFeedHandler = (realtimeFeedName: string): FeedHandler => {
			const __logCtx = {
				..._logCtx,
				realtimeFeedName,
			}
			logger.debug(__logCtx, 'setting up feed handler')

			const { setFeed: setFeedMessage, onRequest: serveFeedOnRequest } =
				serveFeed({
					scheduleFeedDigest,
					scheduleFeedDigestSlice,
				})

			const startedProcessingAt = Date.now()
			let lastSuccessfulProcessingAt = 0
			let pendingFeedEncoded: Buffer | null = null
			let processing = false
			let stopped = false

			const drainRealtimeFeedUpdates = async () => {
				if (processing) return
				processing = true
				try {
					while (!stopped && pendingFeedEncoded !== null) {
						const feedEncoded = pendingFeedEncoded
						pendingFeedEncoded = null
						logger.trace(
							{
								...__logCtx,
								feedEncoded,
							},
							'processing realtime feed',
						)

						try {
							const feedMessage = await parseAndMatchRealtimeFeed(
								feedEncoded,
								realtimeFeedName,
							)
							setFeedMessage(feedMessage)
							lastSuccessfulProcessingAt = Date.now()
							const sourceTimestamp = feedMessage.header.timestamp
							const sourceTimestampMs =
								sourceTimestamp === undefined || sourceTimestamp === null
									? lastSuccessfulProcessingAt
									: protobufLongToNumber(sourceTimestamp) * 1000
							await publishCloudWatchMetrics([
								{
									MetricName: 'RealtimeFeedAgeSeconds',
									Dimensions: feedNameDimension(realtimeFeedName),
									Unit: 'Seconds',
									Value: Math.max(0, (Date.now() - sourceTimestampMs) / 1000),
								},
							])
							logger.debug(
								__logCtx,
								'successfully processed realtime feed update',
							)
						} catch (err: unknown) {
							await publishCloudWatchMetrics([
								{
									MetricName: 'RealtimeFeedAgeSeconds',
									Dimensions: feedNameDimension(realtimeFeedName),
									Unit: 'Seconds',
									Value:
										(Date.now() -
											(lastSuccessfulProcessingAt || startedProcessingAt)) /
										1000,
								},
							])
							logger.warn(
								{
									...__logCtx,
									error: err,
								},
								'failed to process realtime feed update',
							)
						}
					}
				} finally {
					processing = false
				}
			}

			const processRealtimeFeed = ({
				feedEncoded,
			}: {
				feedEncoded: Buffer
			}) => {
				// When processing takes longer than the upstream cadence, keep only the
				// newest pending response rather than serving updates out of order.
				pendingFeedEncoded = feedEncoded
				void drainRealtimeFeedUpdates()
			}

			// connect with realtime fetcher
			ok(realtimeFetchersByName.has(realtimeFeedName), realtimeFeedName)
			const { events: realtimeFeedEvents } =
				realtimeFetchersByName.get(realtimeFeedName)!
			realtimeFeedEvents.on('update', processRealtimeFeed)
			const stopListeningToRealtimeFeedUpdates = () => {
				stopped = true
				pendingFeedEncoded = null
				realtimeFeedEvents.removeListener('update', processRealtimeFeed)
			}

			return {
				serveFeed: serveFeedOnRequest,
				stop: stopListeningToRealtimeFeedUpdates,
			}
		}

		const feedHandlers = new Map<string, FeedHandler>()
		for (const { realtimeFeedName } of realtimeFeeds) {
			const feedHandler = createFeedHandler(realtimeFeedName)
			feedHandlers.set(realtimeFeedName, feedHandler)
		}

		feedHandlersByScheduleFeedDigest.set(scheduleFeedDigest, {
			feedHandlers,
			closeConnections: stopMatchingRealtimeFeed,
			checkIfHealthy: checkIfMatcherIsHealthy,
			databaseName: scheduleDatabaseName,
		})
	}

	// todo: isn't this function called only after the database has been (attempted to get) removed? why close client connections then? solving this properly needs v5 of postgis-gtfs-importer.
	const removeScheduleFeedVersion = (scheduleFeedDigest: string) => {
		logger.info(
			logCtx,
			`removing obsolete matcher for digest "${scheduleFeedDigest}"`,
		)

		const { feedHandlers, closeConnections } =
			feedHandlersByScheduleFeedDigest.get(scheduleFeedDigest)!

		for (const feedHandler of feedHandlers.values()) {
			feedHandler.stop()
		}

		closeConnections().catch((err: unknown) => {
			const message = err instanceof Error ? err.message : String(err)
			logger.warn(
				logCtx,
				`failed to closeConnections obsolete matcher for digest "${scheduleFeedDigest}": ${message}`,
			)
			logger.debug(err)
		})

		feedHandlersByScheduleFeedDigest.delete(scheduleFeedDigest)
	}

	// ## refreshing of GTFS Schedule feeds

	let currentDatabases: ScheduleFeedDatabase[] = []
	{
		currentDatabases = await pruneScheduleFeedVersions(scheduleFeedName)
		// todo: do this in parallel?
		for (const { name, feedDigest } of currentDatabases) {
			logger.trace(
				logCtx,
				`adding handlers for already imported schedule feed version with digest "${feedDigest}"`,
			)
			await addScheduleFeedVersion(feedDigest, name)
		}
	}

	const {
		checkIfHealthy: checkIfScheduleFeedRefreshIsHealthy,
		checkIfReady: checkIfScheduleFeedRefreshIsReady,
		stopRefreshing: stopRefreshingScheduleFeed,
	} = startRefreshingScheduleFeed({
		scheduleFeedName,
		scheduleFeedUrl,
		onImportDone: async ({ currentDatabases: _currentDatabases }) => {
			currentDatabases = _currentDatabases
			logger.trace(
				logCtx,
				'currently imported databases: ' +
					currentDatabases.map((db) => db.name).join(', '),
			)

			for (const oldScheduleFeedDigest of feedHandlersByScheduleFeedDigest.keys()) {
				if (
					!currentDatabases.find(
						({ feedDigest }) => feedDigest === oldScheduleFeedDigest,
					)
				) {
					logger.trace(
						logCtx,
						`removing handlers for obsolete schedule feed version with digest "${oldScheduleFeedDigest}"`,
					)
					removeScheduleFeedVersion(oldScheduleFeedDigest)
				}
			}

			for (const newScheduleFeedVersion of currentDatabases) {
				const { name: scheduleDatabaseName, feedDigest: scheduleFeedDigest } =
					newScheduleFeedVersion
				const existingHandlers =
					feedHandlersByScheduleFeedDigest.get(scheduleFeedDigest)
				if (
					existingHandlers &&
					existingHandlers.databaseName !== scheduleDatabaseName
				) {
					logger.info(
						{
							...logCtx,
							scheduleFeedDigest,
							oldScheduleDatabaseName: existingHandlers.databaseName,
							scheduleDatabaseName,
						},
						'replacing matcher after a digest was re-imported',
					)
					removeScheduleFeedVersion(scheduleFeedDigest)
				}
				if (!feedHandlersByScheduleFeedDigest.has(scheduleFeedDigest)) {
					logger.trace(
						logCtx,
						`adding handlers for new schedule feed version with digest "${scheduleFeedDigest}"`,
					)
					await addScheduleFeedVersion(scheduleFeedDigest, scheduleDatabaseName)
				}
			}
		},
	})

	// ## serve matched realtime feeds via HTTP

	// modeled after https://github.com/derhuerst/hafas-gtfs-rt-feed/blob/8.2.3/lib/serve.js#L156-L217
	const onRequest = (req: HttpRequest, res: HttpResponse) => {
		logger.trace(
			{
				httpVersion: req.httpVersion,
				method: req.method,
				url: req.url,
				headers: req.headers,
			},
			'handling incoming HTTP request',
		)
		const url = new URL(req.url ?? '/', 'http://localhost')
		const pathComponents =
			url.pathname === '/' ? [] : url.pathname.slice(1).split('/')

		// /feeds
		if (pathComponents[0] === 'feeds' && pathComponents.length === 1) {
			const body = currentDatabases.flatMap((scheduleFeedDb) => {
				const {
					feedDigest: scheduleFeedDigest,
					importedAt: scheduleFeedImportedAt,
				} = scheduleFeedDb
				if (!feedHandlersByScheduleFeedDigest.has(scheduleFeedDigest)) {
					return []
				}
				const handlers =
					feedHandlersByScheduleFeedDigest.get(scheduleFeedDigest)
				ok(handlers, 'missing feed handlers')
				const realtimeFeedNames = Array.from(handlers.feedHandlers.keys())
				return realtimeFeedNames.map((realtimeFeedName) => ({
					realtimeFeedName,
					scheduleFeedDigest,
					scheduleFeedImportedAt: new Date(
						scheduleFeedImportedAt * 1000,
					).toISOString(),
				}))
			})
			res.setHeader('content-type', 'application/json')
			res.end(JSON.stringify(body))
			return
		}

		// /feeds/:realtimeFeedName[/:entityType]?schedule-feed-digest
		// todo: use express for routing?
		if (
			pathComponents[0] === 'feeds' &&
			(pathComponents.length === 2 || pathComponents.length === 3)
		) {
			const realtimeFeedName = pathComponents[1]
			const entityType = pathComponents[2] ?? null
			if (
				entityType !== null &&
				entityType !== 'trip-updates' &&
				entityType !== 'vehicle-positions'
			) {
				res.statusCode = 404
				res.end('invalid realtime entity type')
				return
			}
			if (!realtimeFetchersByName.has(realtimeFeedName)) {
				res.statusCode = 404
				res.end('invalid realtime feed name')
				return
			}

			if (!url.searchParams.has('schedule-feed-digest')) {
				res.statusCode = 400
				res.end('missing schedule-feed-digest parameter')
				return
			}
			const scheduleFeedDigest = url.searchParams.get('schedule-feed-digest')
			ok(scheduleFeedDigest, 'missing schedule-feed-digest parameter')
			void (async () => {
				const marked = await markScheduleFeedRequested(scheduleFeedDigest)
				if (!marked) {
					unavailableScheduleFeedRequests.inc({ endpoint: 'realtime' })
					await publishCloudWatchMetrics([
						{
							MetricName: 'UnavailableDigestRequests',
							Unit: 'Count',
							Value: 1,
						},
					])
					res.statusCode = 404
					res.end('invalid/unknown schedule-feed-digest')
					return
				}
				const handlers =
					feedHandlersByScheduleFeedDigest.get(scheduleFeedDigest)
				if (!handlers) {
					res.statusCode = 503
					res.end('schedule feed digest is not ready')
					return
				}
				const feedHandler = handlers.feedHandlers.get(realtimeFeedName)
				ok(feedHandler, 'missing realtime feed handler')
				const { serveFeed } = feedHandler
				serveFeed(req, res, entityType)
			})().catch((error: unknown) => {
				logger.warn(
					{ error, scheduleFeedDigest },
					'failed to renew schedule feed lease',
				)
				res.statusCode = 503
				res.end('failed to renew schedule feed lease')
			})
			return
		}

		if (pathComponents[0] === 'schedule-feeds' && pathComponents.length === 1) {
			void (async () => {
				const archives = await listScheduleFeedArchives()
				res.setHeader('content-type', 'application/json')
				res.end(
					JSON.stringify({
						latestScheduleFeedDigest: archives[0]?.feedDigest ?? null,
						scheduleFeeds: archives,
					}),
				)
			})().catch((error: unknown) => {
				logger.warn({ error }, 'failed to list archived schedule feeds')
				res.statusCode = 503
				res.end('failed to list schedule feeds')
			})
			return
		}

		if (pathComponents[0] === 'schedule-feeds' && pathComponents.length === 2) {
			const scheduleFeedDigest = pathComponents[1]
			void (async () => {
				const archive = await getScheduleFeedArchive(scheduleFeedDigest)
				if (archive === null) {
					unavailableScheduleFeedRequests.inc({ endpoint: 'archive' })
					void publishCloudWatchMetrics([
						{
							MetricName: 'UnavailableDigestRequests',
							Unit: 'Count',
							Value: 1,
						},
					])
					res.statusCode = 404
					res.end('invalid/unknown schedule-feed-digest')
					return
				}
				res.setHeader('content-type', 'application/zip')
				res.setHeader(
					'content-disposition',
					`attachment; filename="nyct-subway-${scheduleFeedDigest}.zip"`,
				)
				if (archive.etag) res.setHeader('etag', archive.etag)
				if (archive.lastModified) {
					res.setHeader('last-modified', archive.lastModified)
				}
				res.end(archive.feedZip)
			})().catch((error: unknown) => {
				logger.warn(
					{ error, scheduleFeedDigest },
					'failed to serve archived schedule feed',
				)
				res.statusCode = 503
				res.end('failed to serve schedule feed')
			})
			return
		}

		if (pathComponents[0] === 'live' && pathComponents.length === 1) {
			res.statusCode = 200
			res.end('')
			return
		}

		if (pathComponents[0] === 'health' && pathComponents.length === 1) {
			void (async () => {
				try {
					const statuses = await Promise.all([
						checkIfScheduleFeedRefreshIsHealthy(),
						...Array.from(feedHandlersByScheduleFeedDigest.values()).flatMap(
							({ checkIfHealthy }) => checkIfHealthy(),
						),
					])
					res.statusCode = statuses.some((status) => status !== true)
						? 503
						: 200
					res.end('')
				} catch (err) {
					logger.warn(
						{
							error: err,
						},
						'failed to check if healthy',
					)
					res.statusCode = 503 // Service Unavailable
					res.end('')
				}
			})()
			return
		}
		if (pathComponents[0] === 'ready' && pathComponents.length === 1) {
			void (async () => {
				try {
					const isReady = await checkIfScheduleFeedRefreshIsReady()
					res.statusCode = isReady ? 200 : 503
					res.end('')
				} catch (err) {
					logger.warn(
						{
							error: err,
						},
						'failed to check if ready',
					)
					res.statusCode = 503 // Service Unavailable
					res.end('')
				}
			})()
			return
		}

		res.statusCode = 404
		res.end('not found')
	}

	// todo: enable CORS?
	const server = createHttpServer(onRequest)
	await new Promise<void>((resolve) => {
		server.listen(port, () => {
			resolve()
		})
	})
	logger.info(`listening on port ${getPort(server.address())}`)

	await metricsServer.start()
	logger.info(
		`metrics server listening on port ${getPort(metricsServer.address())}`,
	)

	const stopService = async () => {
		stopRefreshingScheduleFeed()
		// todo: info-log
		for (const { abortFetching } of realtimeFetchersByName.values()) {
			abortFetching()
		}
		for (const {
			closeConnections,
		} of feedHandlersByScheduleFeedDigest.values()) {
			await closeConnections()
		}
		await closeScheduleFeedStore()
		server.close()
	}

	return {
		stopService,
	}
}

export { createService }
