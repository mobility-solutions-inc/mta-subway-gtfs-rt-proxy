import { ok, strictEqual } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { afterEach, beforeEach, test } from 'node:test'
import { promisify } from 'node:util'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PromData, PromMetric, PromMetrics } from 'prom2javascript'
import { execa } from 'execa'
import ky from 'ky'
import { getMetricsFromIterator as parseMetricsFromIterator } from 'prom2javascript'

import { connectToPostgres } from '../lib/db.js'
import { createLogger } from '../lib/logger.js'
import gtfsRtBindings from '../lib/mta-gtfs-realtime.pb.js'
import { encodeFeedMessage } from '../lib/serve-gtfs-rt.js'

const { FeedMessage } = gtfsRtBindings.transit_realtime
const { Direction } = gtfsRtBindings.NyctTripDescriptor
const { VehicleStopStatus } = gtfsRtBindings.transit_realtime.VehiclePosition
// const {ScheduleRelationship} = gtfsRtBindings.transit_realtime.TripDescriptor

const PATH_TO_SERVICE = new URL(import.meta.resolve('../start.js')).pathname

const logger = createLogger('test', process.env.LOG_LEVEL_TEST ?? 'error')

// note: import.meta.resolve() is not stable yet!
const FOO_TRIP_ID_PREFIX = 'FoO_' // currently hard-coded in test/02-service-prepare.sh
const FOO_FEED = readFileSync(
	new URL(import.meta.resolve('../../test/foo.gtfs.zip')).pathname,
)

const BAR_TRIP_ID_PREFIX = 'bAr_' // currently hard-coded in test/02-service-prepare.sh
const BAR_FEED = readFileSync(
	new URL(import.meta.resolve('../../test/bar.gtfs.zip')).pathname,
)

const serveFile = async (filename: string) => {
	let file: Buffer | null = null
	let version = 0
	let notModifiedRequests = 0
	const setFile = (newFile: Buffer) => {
		file = newFile
		version++
	}
	const serveFile = (
		req: IncomingMessage,
		res: ServerResponse<IncomingMessage>,
	) => {
		const { pathname } = new URL(req.url ?? '/', 'http://example.org')
		if (pathname === '/' + filename && file !== null) {
			const etag = `"${filename}-${version}"`
			res.setHeader('etag', etag)
			if (req.headers['if-none-match'] === etag) {
				notModifiedRequests++
				res.writeHead(304).end()
				return
			}
			res.end(file)
		} else {
			res.writeHead(404).end()
		}
	}
	const server = await new Promise<ReturnType<typeof createServer>>(
		(resolve) => {
			const server = createServer(serveFile)
			server.listen(() => {
				resolve(server)
			})
		},
	)
	const address = server.address()
	ok(
		address && typeof address !== 'string',
		'test file server must listen on a TCP port',
	)
	return {
		getNotModifiedRequestCount: () => notModifiedRequests,
		port: address.port,
		stop: async () => {
			await new Promise<void>((resolve, reject) => {
				server.close((err) => {
					if (err) reject(err)
					else resolve()
				})
			})
		},
		setFile,
	}
}

interface ImportedScheduleFeed {
	realtimeFeedName: string
	scheduleFeedDigest: string
	scheduleFeedImportedAt: string
}

const fetchImportedScheduleFeeds = async (cfg: { port: number }) => {
	const { port } = cfg

	const url = `http://localhost:${port}/feeds`
	const res = await ky(url, {
		redirect: 'follow',
		retry: 0,
	})
	return await res.json<ImportedScheduleFeed[]>()
}

const waitForImportedScheduleFeeds = async (cfg: {
	expectedCount: number
	port: number
	timeoutMs?: number
}) => {
	const { expectedCount, port, timeoutMs = 30_000 } = cfg
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			const feeds = await fetchImportedScheduleFeeds({ port })
			if (feeds.length === expectedCount) return feeds
		} catch {
			// The service may still be starting.
		}
		await new Promise((resolve) => setTimeout(resolve, 500))
	}
	throw new Error(
		`timed out waiting for ${expectedCount} imported schedule feed(s)`,
	)
}

const fetchAndParseMatchedRealtimeFeed = async (cfg: {
	entityType?: 'trip-updates' | 'vehicle-positions'
	port: number
	realtimeFeedName: string
	scheduleFeedDigest: string
}) => {
	const { entityType, port, realtimeFeedName, scheduleFeedDigest } = cfg
	const suffix = entityType ? `/${entityType}` : ''
	const url = `http://localhost:${port}/feeds/${realtimeFeedName}${suffix}?schedule-feed-digest=${scheduleFeedDigest}`
	const deadline = Date.now() + 10_000
	while (true) {
		const res = await ky(url, {
			redirect: 'follow',
			retry: 0,
			throwHttpErrors: false,
		})
		if (res.ok) {
			const feedEncoded = Buffer.from(await res.arrayBuffer())
			return FeedMessage.decode(feedEncoded)
		}
		if (res.status !== 404 || Date.now() >= deadline) {
			throw new Error(
				`failed to fetch matched realtime feed: HTTP ${res.status}`,
			)
		}
		await new Promise((resolve) => setTimeout(resolve, 250))
	}
}

const fetchAndParseMetrics = async (cfg: { port: number }) => {
	const { port } = cfg
	const res = await ky(`http://localhost:${port}/metrics`, {
		redirect: 'follow',
		retry: 0,
	})
	const metricsEncoded = (await res.text()).split(/\r?\n/)
	const metrics = await parseMetricsFromIterator(
		metricsEncoded[Symbol.iterator](),
	)
	return metrics
}

const waitForScheduleImportedMetric = async (cfg: {
	feedName: string
	port: number
	value: number
}) => {
	const deadline = Date.now() + 10_000
	while (true) {
		const metrics = await fetchAndParseMetrics({ port: cfg.port })
		const imported = metricData(metrics.schedule_feed_imported_boolean).find(
			({ labels }) => labels.feed_name === cfg.feedName,
		)
		if (imported?.value === cfg.value) return metrics
		if (Date.now() >= deadline) return metrics
		await new Promise((resolve) => setTimeout(resolve, 250))
	}
}

const SCHEDULE_FEED_BOOKKEEPING_DB_NAME = `test_${Math.random().toString(16).slice(2, 4)}`
const SCHEDULE_FEED_DB_NAME_PREFIX = SCHEDULE_FEED_BOOKKEEPING_DB_NAME + '_'

const createTestDbs = async () => {
	const db = await connectToPostgres()

	await db.query(`CREATE DATABASE "${SCHEDULE_FEED_BOOKKEEPING_DB_NAME}"`)

	await promisify(db.end.bind(db))()
}

const purgeTestDbs = async () => {
	const db = await connectToPostgres()

	await db.query(`DROP DATABASE "${SCHEDULE_FEED_BOOKKEEPING_DB_NAME}"`)

	const { rows } = await db.query<{ db_name: string }>(`\
		SELECT datname AS db_name
		FROM pg_catalog.pg_database
		ORDER BY datname ASC
	`)
	for (const { db_name } of rows) {
		if (db_name.startsWith(SCHEDULE_FEED_DB_NAME_PREFIX)) {
			await db.query(`DROP DATABASE "${db_name}"`)
		}
	}

	await promisify(db.end.bind(db))()
}

const debugLogMatchingMetrics = (metrics: PromMetrics) => {
	logger.debug(
		{
			schedule_feed_imported_boolean:
				metrics.schedule_feed_imported_boolean.data,
			tripupdates_matching_successes_total:
				metrics.tripupdates_matching_successes_total.data,
			tripupdates_matching_failures_total:
				metrics.tripupdates_matching_failures_total.data,
			vehiclepositions_matching_successes_total:
				metrics.vehiclepositions_matching_successes_total.data,
			vehiclepositions_matching_failures_total:
				metrics.vehiclepositions_matching_failures_total.data,
		},
		'matching metrics',
	)
}

const metricData = (metric: PromMetric): PromData[] => metric.data as PromData[]

const assertMatchingSuccess = (
	successesName: string,
	successes: PromMetric,
	matching_method: string,
	filterFn: (variant: PromData) => boolean,
) => {
	const _successes = metricData(successes).find(
		(variant) =>
			filterFn(variant) && variant.labels.matching_method === matching_method,
	)
	ok(
		(_successes?.value ?? 0) > 0,
		`${successesName}{matching_method=${matching_method}} (${_successes?.value}) should be > 0`,
	)
}

const tripUpdate1 = {
	trip: {
		trip_id: 'b-outbound-on-working-days',
		start_date: '20190507',
		route_id: 'B',
		'.nyct_trip_descriptor': { train_id: 'some-train-id', is_assigned: true },
	},
	stop_time_update: [
		{
			arrival: { time: 1557245580 }, // 2019-05-07T18:13:00+02:00
			departure: { time: 1557245658 }, // 2019-05-07T18:14:18+02:00
			stop_id: 'center',
		},
		{
			arrival: { time: 1557246070 }, // 2019-05-07T18:21:10+02:00
			departure: { time: 1557246145 }, // 2019-05-07T18:22:25+02:00
			stop_id: 'lake',
			'.nyct_stop_time_update': { scheduled_track: '1a' },
		},
		{
			arrival: { time: 1557246610 }, // 2019-05-07T18:40:00+02:00
			departure: { time: 1557246660 }, // 2019-05-07T18:31:00+02:00
			stop_id: 'airport',
			'.nyct_stop_time_update': { scheduled_track: '2b' },
		},
	],
}
const vehiclePosition1 = {
	trip: {
		trip_id: 'b-outbound-on-working-days',
		start_date: '20190507',
		route_id: 'B',
		'.nyct_trip_descriptor': {
			train_id: 'another-train-id',
			is_assigned: true,
			direction: Direction.EAST,
		},
	},
	current_stop_sequence: 13, // approaching `lake`
	current_status: VehicleStopStatus.INCOMING_AT,
	timestamp: 1557245960, // 2019-05-07T18:19:20+02:00
	stop_id: 'lake',
}
const feedMessage0 = {
	header: {
		gtfs_realtime_version: '1.0',
		timestamp: 1557235838, // 2019-05-07T15:30:38+02:00,
		'.nyct_feed_header': {
			nyct_subway_version: '1.0',
			trip_replacement_period: [], // todo
		},
	},
	entity: [
		{
			id: 'one',
			trip_update: tripUpdate1,
		},
		{
			id: 'two',
			vehicle: vehiclePosition1,
		},
	],
}
const feedMessage1 = {
	...feedMessage0,
	header: {
		...feedMessage0.header,
		timestamp: feedMessage0.header.timestamp + 14, // 2019-05-07T15:30:52+02:00
	},
	entity: [
		{
			id: 'three',
			trip_update: {
				...tripUpdate1,
				stop_time_update: [
					// we omit the 0th item
					{
						...tripUpdate1.stop_time_update[1],
						departure: {
							// 2019-05-07T18:22:58+02:00
							time: tripUpdate1.stop_time_update[1].departure.time + 33,
						},
					},
					...tripUpdate1.stop_time_update.slice(2),
				],
			},
		},
		...feedMessage0.entity.slice(1),
	],
}

beforeEach(createTestDbs)
afterEach(purgeTestDbs)

test('importing Schedule feed, matching & serving Realtime feed works', async () => {
	const port = 10_000 + Math.round(Math.random() * 9999)
	const metricsPort = 20_000 + Math.round(Math.random() * 9999)
	const env: Record<string, string> = {
		PORT: String(port),
		METRICS_SERVER_PORT: String(metricsPort),
		PGDATABASE: SCHEDULE_FEED_BOOKKEEPING_DB_NAME,
		SCHEDULE_FEED_DB_NAME_PREFIX,
		SCHEDULE_FEED_REFRESH_INTERVAL: '3', // seconds
		SCHEDULE_FEED_REFRESH_MIN_INTERVAL: '3', // seconds
		SCHEDULE_FEED_USED_RETENTION: '8', // seconds
		REALTIME_FEED_FETCH_INTERVAL: '1', // seconds
		REALTIME_FEED_FETCH_MIN_INTERVAL: '1', // seconds
	}

	const {
		port: scheduleFeedPort,
		getNotModifiedRequestCount,
		stop: stopServingScheduleFeed,
		setFile: setScheduleFeed,
	} = await serveFile('gtfs.zip')
	const scheduleFeedName = 'nyct_subway' // currently hard-coded by lib/feeds.js
	env.NYCT_SUBWAY_SCHEDULE_FEED_URL = `http://localhost:${scheduleFeedPort}/gtfs.zip`

	const {
		port: realtimeFeedPort,
		stop: stopServingRealtimeFeed,
		setFile: setRealtimeFeed,
	} = await serveFile('gtfs-rt.pb')
	const realtimeFeedName = 'nyct_subway_1234567' // currently hard-coded by lib/feeds.js
	env.NYCT_SUBWAY_1234567_REALTIME_FEED_URL = `http://localhost:${realtimeFeedPort}/gtfs-rt.pb`
	for (const name of ['ACE', 'BDFM', 'G', 'JZ', 'L', 'NQRW', 'SI']) {
		env[`NYCT_SUBWAY_${name}_REALTIME_FEED_URL`] = '-'
	}

	// Both the success as well as the failure metrics each have several variants, for example one for each matching method. Currently, we only assert that there are more successes for a specific matching method than all failures (of that schedule feed digest & route_id) combined.
	// todo: assert more specifically?
	const checkTripUpdatesMatchingSuccessesAndFailures = (
		metrics: PromMetrics,
		matchingMethod: string,
	) => {
		const { tripupdates_matching_successes_total } = metrics
		assertMatchingSuccess(
			'tripupdates_matching_successes_total',
			tripupdates_matching_successes_total,
			matchingMethod,
			({ labels: { schedule_feed_digest: sched_digest, route_id } }) =>
				sched_digest === scheduleFeedDigest.slice(0, sched_digest.length) &&
				route_id === tripUpdate1.trip.route_id,
		)
	}
	const checkVehiclePositionsMatchingSuccessesAndFailures = (
		metrics: PromMetrics,
		matchingMethod: string,
	) => {
		const { vehiclepositions_matching_successes_total } = metrics
		assertMatchingSuccess(
			'vehiclepositions_matching_successes_total',
			vehiclepositions_matching_successes_total,
			matchingMethod,
			({ labels: { schedule_feed_digest: sched_digest, route_id } }) =>
				sched_digest === scheduleFeedDigest.slice(0, sched_digest.length) &&
				route_id === vehiclePosition1.trip.route_id,
		)
	}

	setScheduleFeed(FOO_FEED)
	let scheduleFeedDigest = ''
	setRealtimeFeed(encodeFeedMessage(feedMessage0))

	const staleScheduleDatabaseName = `${SCHEDULE_FEED_DB_NAME_PREFIX}${scheduleFeedName}_missing`
	{
		const db = await connectToPostgres({
			database: SCHEDULE_FEED_BOOKKEEPING_DB_NAME,
		})
		await db.query(`
			CREATE TABLE latest_successful_imports (
				db_name TEXT PRIMARY KEY,
				imported_at INTEGER NOT NULL,
				feed_digest TEXT NOT NULL
			)
		`)
		await db.query(
			`INSERT INTO latest_successful_imports (db_name, imported_at, feed_digest)
			 VALUES ($1, $2, $3)`,
			[staleScheduleDatabaseName, 1, 'missing-digest'],
		)
		await promisify(db.end.bind(db))()
	}

	// todo: pass in `now`?
	const pServiceProcess = execa(process.execPath, [PATH_TO_SERVICE], {
		stdio: 'inherit',
		env: {
			...process.env,
			...env,
		},
	})

	const pTest = (async () => {
		// check matching with FOO_FEED
		// todo: get notified about schedule re-import instead of waiting
		{
			const importedScheduleFeeds = await waitForImportedScheduleFeeds({
				expectedCount: 1,
				port,
			})
			strictEqual(
				importedScheduleFeeds.length,
				1,
				'should be exactly 1 imported Schedule feed',
			)
			const importedFoo = importedScheduleFeeds[0]
			ok(importedFoo, 'set of imported Schedule feeds should include FOO_FEED')
			scheduleFeedDigest = importedFoo.scheduleFeedDigest

			const db = await connectToPostgres({
				database: SCHEDULE_FEED_BOOKKEEPING_DB_NAME,
			})
			const staleImport = await db.query<{ exists: boolean }>(
				'SELECT EXISTS (SELECT 1 FROM latest_successful_imports WHERE db_name = $1) AS exists',
				[staleScheduleDatabaseName],
			)
			await promisify(db.end.bind(db))()
			strictEqual(
				staleImport.rows[0]?.exists,
				false,
				'startup should reconcile bookkeeping that points to a missing database',
			)

			const scheduleFeeds = await ky(
				`http://localhost:${port}/schedule-feeds`,
			).json<{
				latestScheduleFeedDigest: string
				scheduleFeeds: { feedDigest: string }[]
			}>()
			strictEqual(scheduleFeeds.latestScheduleFeedDigest, scheduleFeedDigest)
			strictEqual(scheduleFeeds.scheduleFeeds.length, 1)
			const archivedZip = Buffer.from(
				await ky(
					`http://localhost:${port}/schedule-feeds/${scheduleFeedDigest}`,
				).arrayBuffer(),
			)
			strictEqual(archivedZip.equals(FOO_FEED), true)

			const { entity: feedEntities } = await fetchAndParseMatchedRealtimeFeed({
				port,
				realtimeFeedName,
				scheduleFeedDigest,
			})
			strictEqual(
				feedEntities[0]?.trip_update?.trip?.trip_id?.slice(
					0,
					FOO_TRIP_ID_PREFIX.length,
				),
				FOO_TRIP_ID_PREFIX,
				`TripUpdate's (feedMessage.entity[0].trip_update) trip_id should begin with "${FOO_TRIP_ID_PREFIX}"`,
			)
			strictEqual(
				feedEntities[0]?.trip_update?.stop_time_update?.[0]?.departure?.delay,
				18,
				`StopTimeUpdate's (feedMessage.entity[0].stop_time_update[0]) departure delay must be correct`,
			)
			strictEqual(
				feedEntities[1]?.vehicle?.trip?.trip_id?.slice(
					0,
					FOO_TRIP_ID_PREFIX.length,
				),
				FOO_TRIP_ID_PREFIX,
				`VehiclePosition's (feedMessage.entity[1].vehicle) trip_id should begin with "${FOO_TRIP_ID_PREFIX}"`,
			)
			const { entity: tripUpdateEntities } =
				await fetchAndParseMatchedRealtimeFeed({
					entityType: 'trip-updates',
					port,
					realtimeFeedName,
					scheduleFeedDigest,
				})
			strictEqual(tripUpdateEntities.length, 1)
			ok(tripUpdateEntities[0]?.trip_update)
			const { entity: vehiclePositionEntities } =
				await fetchAndParseMatchedRealtimeFeed({
					entityType: 'vehicle-positions',
					port,
					realtimeFeedName,
					scheduleFeedDigest,
				})
			strictEqual(vehiclePositionEntities.length, 1)
			ok(vehiclePositionEntities[0]?.vehicle)
			console.info(
				'Realtime feed (feedMessage0) matched against FOO_FEED looks good ✔︎',
			)

			const metrics = await fetchAndParseMetrics({
				port: metricsPort,
			})
			debugLogMatchingMetrics(metrics)

			const scheduleFeedImported = metricData(
				metrics.schedule_feed_imported_boolean,
			).find(({ labels: l }) => l.feed_name === scheduleFeedName)
			// imported for the first time
			strictEqual(
				scheduleFeedImported?.value,
				1,
				'schedule_feed_imported_boolean should be 1',
			)

			checkTripUpdatesMatchingSuccessesAndFailures(
				metrics,
				'trip_by_suffix_stop_id',
			)
			checkVehiclePositionsMatchingSuccessesAndFailures(
				metrics,
				'stop_times_by_suffix_stop_id_stop_seq',
			)
		}

		// check matching with BAR_FEED
		const fooScheduleFeedDigest = scheduleFeedDigest
		const unfinishedImportDbName = `${SCHEDULE_FEED_DB_NAME_PREFIX}${scheduleFeedName}_unfinished`
		{
			const db = await connectToPostgres()
			await db.query(`CREATE DATABASE "${unfinishedImportDbName}"`)
			await promisify(db.end.bind(db))()
		}
		setScheduleFeed(BAR_FEED)
		{
			const importedScheduleFeeds = await waitForImportedScheduleFeeds({
				expectedCount: 2,
				port,
			})
			strictEqual(
				importedScheduleFeeds.length,
				2,
				'should be exactly 2 imported Schedule feeds',
			)
			const importedFoo = importedScheduleFeeds.find(
				({ scheduleFeedDigest }) =>
					scheduleFeedDigest === fooScheduleFeedDigest,
			)
			ok(importedFoo, 'set of imported Schedule feeds should include FOO_FEED')
			const importedBar = importedScheduleFeeds.find(
				({ scheduleFeedDigest }) =>
					scheduleFeedDigest !== fooScheduleFeedDigest,
			)
			ok(importedBar, 'set of imported Schedule feeds should include BAR_FEED')
			scheduleFeedDigest = importedBar.scheduleFeedDigest

			const db = await connectToPostgres()
			const unfinishedImport = await db.query<{ exists: boolean }>(
				'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
				[unfinishedImportDbName],
			)
			await promisify(db.end.bind(db))()
			strictEqual(
				unfinishedImport.rows[0]?.exists,
				false,
				'next changed import should clean an unfinished database',
			)

			const { entity: feedEntities } = await fetchAndParseMatchedRealtimeFeed({
				port,
				realtimeFeedName,
				scheduleFeedDigest,
			})
			strictEqual(
				feedEntities[0]?.trip_update?.trip?.trip_id?.slice(
					0,
					BAR_TRIP_ID_PREFIX.length,
				),
				BAR_TRIP_ID_PREFIX,
				`TripUpdate's (feedMessage.entity[0].trip_update) trip_id should begin with "${BAR_TRIP_ID_PREFIX}"`,
			)
			strictEqual(
				feedEntities[1]?.vehicle?.trip?.trip_id?.slice(
					0,
					BAR_TRIP_ID_PREFIX.length,
				),
				BAR_TRIP_ID_PREFIX,
				`VehiclePosition's (feedMessage.entity[1].vehicle) trip_id should begin with "${BAR_TRIP_ID_PREFIX}"`,
			)
			console.info(
				'Realtime feed (feedMessage0) matched against BAR_FEED looks good ✔︎',
			)

			const metrics = await fetchAndParseMetrics({
				port: metricsPort,
			})
			debugLogMatchingMetrics(metrics)

			const scheduleFeedImported = metricData(
				metrics.schedule_feed_imported_boolean,
			).find(({ labels: l }) => l.feed_name === scheduleFeedName)
			// imported again because the Schedule feed's digest has changed
			strictEqual(
				scheduleFeedImported?.value,
				1,
				'schedule_feed_imported_boolean should be 1',
			)

			checkTripUpdatesMatchingSuccessesAndFailures(
				metrics,
				'trip_by_suffix_stop_id',
			)
			checkVehiclePositionsMatchingSuccessesAndFailures(
				metrics,
				'stop_times_by_suffix_stop_id_stop_seq',
			)
		}

		const feedsAfterLeaseExpiry = await waitForImportedScheduleFeeds({
			expectedCount: 1,
			port,
			timeoutMs: 20_000,
		})
		strictEqual(
			feedsAfterLeaseExpiry[0]?.scheduleFeedDigest,
			scheduleFeedDigest,
			'latest BAR schedule must remain after the prior FOO lease expires',
		)
		const expiredArchiveResponse = await ky(
			`http://localhost:${port}/schedule-feeds/${fooScheduleFeedDigest}`,
			{ throwHttpErrors: false },
		)
		strictEqual(
			expiredArchiveResponse.status,
			404,
			'expired prior digest archive should be pruned',
		)

		// modify realtime feed, check matching with BAR_FEED again
		setRealtimeFeed(encodeFeedMessage(feedMessage1))
		// todo: trigger & get notified about realtime fetching instead of waiting
		await new Promise((r) => setTimeout(r, 3_000))
		{
			const { entity: feedEntities } = await fetchAndParseMatchedRealtimeFeed({
				port,
				realtimeFeedName,
				scheduleFeedDigest,
			})
			strictEqual(
				feedEntities[0]?.trip_update?.trip?.trip_id?.slice(
					0,
					BAR_TRIP_ID_PREFIX.length,
				),
				BAR_TRIP_ID_PREFIX,
				`TripUpdate's (feedMessage.entity[0].trip_update) trip_id should begin with "${BAR_TRIP_ID_PREFIX}"`,
			)
			strictEqual(
				feedEntities[1]?.vehicle?.trip?.trip_id?.slice(
					0,
					BAR_TRIP_ID_PREFIX.length,
				),
				BAR_TRIP_ID_PREFIX,
				`VehiclePosition's (feedMessage.entity[1].vehicle) trip_id should begin with "${BAR_TRIP_ID_PREFIX}"`,
			)
			console.info(
				'Realtime feed (feedMessage1) matched against BAR_FEED looks good ✔︎',
			)

			const metrics = await waitForScheduleImportedMetric({
				feedName: scheduleFeedName,
				port: metricsPort,
				value: 0,
			})
			debugLogMatchingMetrics(metrics)

			const scheduleFeedImported = metricData(
				metrics.schedule_feed_imported_boolean,
			).find(({ labels: l }) => l.feed_name === scheduleFeedName)
			// not imported again because the Schedule feed's digest hasn't changed
			strictEqual(
				scheduleFeedImported?.value,
				0,
				'schedule_feed_imported_boolean should be 0',
			)
			ok(
				getNotModifiedRequestCount() > 0,
				'unchanged schedule requests should use conditional HTTP and receive 304',
			)

			checkTripUpdatesMatchingSuccessesAndFailures(
				metrics,
				'trip_by_suffix_stop_id',
			)
			checkVehiclePositionsMatchingSuccessesAndFailures(
				metrics,
				'stop_times_by_suffix_stop_id_stop_seq',
			)
		}

		// A previously seen digest can become current again. The new database must
		// replace the old one instead of leaving an unreachable duplicate behind.
		setScheduleFeed(FOO_FEED)
		await waitForImportedScheduleFeeds({ expectedCount: 2, port })
		{
			const db = await connectToPostgres({
				database: SCHEDULE_FEED_BOOKKEEPING_DB_NAME,
			})
			const duplicateDigestImports = await db.query<{ count: string }>(
				`SELECT count(*)::text AS count
				 FROM latest_successful_imports
				 WHERE feed_digest = $1`,
				[fooScheduleFeedDigest],
			)
			await promisify(db.end.bind(db))()
			strictEqual(
				duplicateDigestImports.rows[0]?.count,
				'1',
				'a re-imported digest should have exactly one schedule database',
			)
		}

		// todo: tests for …_exact_constructed matching too?

		pServiceProcess.kill()
	})()

	try {
		await Promise.all([
			pServiceProcess.catch((err: unknown) => {
				// if the process has been killed deliberately (see below), we silence the error
				if (
					typeof err === 'object' &&
					err !== null &&
					'isTerminated' in err &&
					err.isTerminated === true
				) {
					return
				}
				throw err
			}),
			pTest,
		])
	} finally {
		pServiceProcess.kill()
		await stopServingScheduleFeed()
		await stopServingRealtimeFeed()
	}
})
