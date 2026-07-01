import groupBy from 'lodash/groupBy.js'
import { Gauge, Summary } from 'prom-client'

import type {
	FeedMessage,
	MatchConfig,
	MatchOptions,
	PreviousStopTimeUpdate,
	ProtobufLong,
	StopTimeEvent,
	StopTimeUpdate,
} from './types.js'
import { register as metricsRegister } from './metrics.js'
import gtfsRtBindings from './mta-gtfs-realtime.pb.js'
import { protobufLongToBigInt } from './protobuf.js'

const { ScheduleRelationship } = gtfsRtBindings.transit_realtime.TripDescriptor

const MAX_AGE = process.env.STOP_TIME_UPDATES_MAX_AGE_SECONDS
	? parseInt(process.env.STOP_TIME_UPDATES_MAX_AGE_SECONDS)
	: 3 * 60 * 60 // 3h
const CLEAN_INTERVAL = process.env.STOP_TIME_UPDATES_CLEAN_INTERVAL_SECONDS
	? parseInt(process.env.STOP_TIME_UPDATES_CLEAN_INTERVAL_SECONDS)
	: 1 * 60 * 60 // 1h

const _restoreStopTimeEvent = (
	field: 'arrival' | 'departure',
	sTU: StopTimeUpdate,
	timestamp: ProtobufLong,
	prevSTU: PreviousStopTimeUpdate,
) => {
	// todo: think about this logic again! what about {arrival,departure}.delay?
	const previousTime = prevSTU[`${field}_time`]

	if (
		previousTime !== null &&
		(!sTU[field]?.time ||
			protobufLongToBigInt(timestamp) < protobufLongToBigInt(prevSTU.timestamp))
	) {
		// todo: trace-log
		// todo: add .uncertainty based on how old the measurement is?
		// todo: what about .delay? based on schedule?
		sTU[field] = {
			time: BigInt(previousTime),
		} satisfies StopTimeEvent
	}
}
const _restoreStopTimeUpdate = (
	sTU: StopTimeUpdate,
	timestamp: ProtobufLong,
	prevSTU: PreviousStopTimeUpdate,
) => {
	_restoreStopTimeEvent('arrival', sTU, timestamp, prevSTU)
	_restoreStopTimeEvent('departure', sTU, timestamp, prevSTU)
}

const storeQueryTimeSeconds = new Summary({
	name: 'previous_stoptimeupdates_store_query_time_seconds',
	help: 'time needed to write all StopTimeUpdates seen in the current Realtime feed into the DB',
	registers: [metricsRegister],
	labelNames: ['schedule_feed_digest'],
})

const restoreQueryTimeSeconds = new Summary({
	name: 'previous_stoptimeupdates_restore_query_time_seconds',
	help: 'time needed to query all previously seen StopTimeUpdates matching the current Realtime feed from the DB',
	registers: [metricsRegister],
	labelNames: ['schedule_feed_digest'],
})

const cleanQueryTimeSeconds = new Summary({
	name: 'previous_stoptimeupdates_clean_query_time_seconds',
	help: 'time needed to delete old/obsolete previously seen StopTimeUpdates from the DB',
	registers: [metricsRegister],
	labelNames: ['schedule_feed_digest'],
})
const noCleaned = new Gauge({
	name: 'previous_stoptimeupdates_cleaned_total',
	help: 'number of old/obsolete previously seen StopTimeUpdates cleaned from the DB during the last cleanup',
	registers: [metricsRegister],
	labelNames: ['schedule_feed_digest'],
})

const createStoreAndRestoreStopTimeUpdatesFromDb = (cfg: MatchConfig) => {
	const {
		scheduleFeedDigest,
		scheduleFeedDigestSlice,
		db,
		logger,
		// todo: expect realtimeFeedName, add to logCtx
	} = cfg

	const _logCtx = {
		scheduleFeedDigest,
	}

	const storeStopTimeUpdatesInDb = async (
		feedMessage: FeedMessage,
		opt: MatchOptions = {},
	) => {
		const { realtimeFeedName } = {
			realtimeFeedName: null,
			...opt,
		}

		const logCtx = {
			..._logCtx,
			realtimeFeedName,
		}

		const headerTimestamp = feedMessage.header.timestamp
		if (headerTimestamp === undefined || headerTimestamp === null) {
			throw new Error('missing FeedMessage.header.timestamp')
		}
		const feedTimestamp = protobufLongToBigInt(headerTimestamp)

		const trip_ids: string[] = []
		const start_dates: string[] = []
		const stop_ids: string[] = []
		const timestamps: bigint[] = []
		const arrival_times: (bigint | null)[] = []
		const arrival_delays: (bigint | null)[] = []
		const departure_times: (bigint | null)[] = []
		const departure_delays: (bigint | null)[] = []
		for (const feedEntity of feedMessage.entity) {
			// Restoring – and therefore storing – StopTimeUpdates only really makes sense for TripUpdates.
			if (!feedEntity.trip_update) continue
			const tripUpdate = feedEntity.trip_update

			if (!tripUpdate.stop_time_update) {
				const { schedule_relationship } = tripUpdate.trip
				if (
					schedule_relationship !== undefined &&
					schedule_relationship !== null &&
					schedule_relationship !== ScheduleRelationship.SCHEDULED
				) {
					logger.warn(
						{
							...logCtx,
							tripUpdate,
						},
						'TripUpdate without stop_time_update[] even though its schedule_relationship is SCHEDULED, skipping storing',
					)
				} else {
					logger.debug(
						{
							...logCtx,
							tripUpdate,
						},
						'TripUpdate without stop_time_update[], skipping storing',
					)
				}
				continue
			}

			for (const stopTimeUpdate of tripUpdate.stop_time_update) {
				if (
					!tripUpdate.trip?.trip_id ||
					!tripUpdate.trip?.start_date ||
					!stopTimeUpdate.stop_id
				)
					continue // todo: log?

				trip_ids.push(tripUpdate.trip.trip_id)
				start_dates.push(tripUpdate.trip.start_date)
				stop_ids.push(stopTimeUpdate.stop_id)
				timestamps.push(
					tripUpdate.timestamp
						? protobufLongToBigInt(tripUpdate.timestamp)
						: feedTimestamp,
				)

				// We prefer {arrival,departure}_time over {arrival,departure}_delay.
				const arrival_time = stopTimeUpdate.arrival?.time
					? protobufLongToBigInt(stopTimeUpdate.arrival.time)
					: null
				arrival_times.push(arrival_time)
				const departure_time = stopTimeUpdate.departure?.time
					? protobufLongToBigInt(stopTimeUpdate.departure.time)
					: null
				const arrivalDelay = stopTimeUpdate.arrival?.delay ?? null
				arrival_delays.push(
					arrival_time === null
						? arrivalDelay === null
							? null
							: BigInt(arrivalDelay)
						: null,
				)
				departure_times.push(departure_time)
				const departureDelay = stopTimeUpdate.departure?.delay ?? null
				departure_delays.push(
					departure_time === null
						? departureDelay === null
							? null
							: BigInt(departureDelay)
						: null,
				)
			}
		}
		const nrOfStopTimeUpdates = timestamps.length

		const t0 = performance.now()
		// https://github.com/brianc/node-postgres/issues/957#issuecomment-295583050
		await db.query(
			`\
			INSERT INTO previous_stoptimeupdates (
				trip_id, start_date, stop_id,
				"timestamp",
				arrival_time, arrival_delay,
				departure_time, departure_delay
			)
			SELECT * FROM UNNEST (
				$1::text[], $2::timestamp without time zone[], $3::text[],
				$4::integer[],
				$5::integer[], $6::integer[],
				$7::integer[], $8::integer[]
			)
			-- todo: define a trigger on the table instead? seems cleaner
			ON CONFLICT ON CONSTRAINT previous_stoptimeupdates_unique DO UPDATE
				SET
					"timestamp" = excluded."timestamp",
					-- todo: with an update providing only arrival_{time,delay}, do we want to keep departure_{time,delay}?
					arrival_time = excluded.arrival_time,
					arrival_delay = excluded.arrival_delay,
					departure_time = excluded.departure_time,
					departure_delay = excluded.departure_delay
				WHERE excluded."timestamp" >= previous_stoptimeupdates."timestamp";
		`,
			[
				trip_ids,
				start_dates,
				stop_ids,
				timestamps,
				arrival_times,
				arrival_delays,
				departure_times,
				departure_delays,
			],
		)
		const queryTime = (performance.now() - t0) / 1000
		storeQueryTimeSeconds.observe(
			{
				schedule_feed_digest: scheduleFeedDigestSlice,
			},
			queryTime,
		)
		logger.debug(
			{
				...logCtx,
				queryTime,
				nrOfStopTimeUpdates,
			},
			'queried TripReplacementPeriods',
		)
		// todo: add metric for number of newly stored StopTimeUpdates?
	}

	const restoreStopTimeUpdatesFromDb = async (
		feedMessage: FeedMessage,
		opt: MatchOptions = {},
	) => {
		const { realtimeFeedName } = {
			realtimeFeedName: null,
			...opt,
		}

		const logCtx = {
			..._logCtx,
			realtimeFeedName,
		}

		// todo: use stop_sequence!
		let query = `\
			SELECT
				trip_id,
				(start_date::date)::text AS start_date,
				stop_id,
				"timestamp",
				arrival_time, arrival_delay,
				departure_time, departure_delay
			FROM previous_stoptimeupdates
			WHERE False -- "OR"s follow
`
		const values: string[] = []
		let valuesI = 1,
			nrOfTrips = 0
		for (const feedEntity of feedMessage.entity) {
			// Restoring – and therefore storing – StopTimeUpdates only really makes sense for TripUpdates.
			if (!feedEntity.trip_update) continue
			const tripUpdate = feedEntity.trip_update
			const { start_date: startDate, trip_id: tripId } = tripUpdate.trip
			if (!startDate || !tripId) continue

			query += `\
				OR (trip_id = $${valuesI++} AND start_date = $${valuesI++})
			`

			// convert to ISO 8601 (PostgreSQL-compatible)
			const isoStartDate = [
				startDate.slice(0, 4),
				startDate.slice(4, 6),
				startDate.slice(6, 8),
			].join('-')
			values.push(tripId, isoStartDate)
			nrOfTrips++
		}
		query += `\
			ORDER BY trip_id ASC, start_date ASC
`

		const t0 = performance.now()
		const { rows: _previousStopTimeUpdates } =
			await db.query<PreviousStopTimeUpdate>(query, values)
		const queryTime = (performance.now() - t0) / 1000
		restoreQueryTimeSeconds.observe(
			{
				schedule_feed_digest: scheduleFeedDigestSlice,
			},
			queryTime,
		)
		logger.debug(
			{
				...logCtx,
				queryTime,
				nrOfTrips,
				nrOfStopTimeUpdates: _previousStopTimeUpdates.length,
			},
			'queried TripReplacementPeriods',
		)

		// use a Map to get from `n^2` to `n*log(n)` runtime
		// trip_id:start_date -> [previousStopTimeUpdate]
		// todo: add stop_sequence to key
		const previousStopTimeUpdatesByTrip = new Map<
			string,
			PreviousStopTimeUpdate[]
		>(
			Object.entries(
				groupBy(_previousStopTimeUpdates, (sTU) =>
					[sTU.trip_id, sTU.start_date.split('-').join('')].join(':'),
				),
			),
		)

		// todo: add metric for ratio of trips with >=1 restored STU?
		for (const feedEntity of feedMessage.entity) {
			// We only restoring StopTimeUpdates for TripUpdates, see also the storing logic.
			if (!feedEntity.trip_update) continue
			const tripUpdate = feedEntity.trip_update

			const { route_id, trip_id, start_date } = tripUpdate.trip
			const _logCtx = {
				...logCtx,
				route_id,
				trip_id,
				start_date,
			}

			const mapKey = `${trip_id}:${start_date}`
			if (!previousStopTimeUpdatesByTrip.has(mapKey)) {
				logger.trace(_logCtx, 'no previously seen StopTimeUpdates')
				continue
			}
			const previousStopTimeUpdates = previousStopTimeUpdatesByTrip.get(mapKey)
			if (!previousStopTimeUpdates) {
				continue
			}

			const timestamp = tripUpdate.timestamp ?? feedMessage.header.timestamp
			if (timestamp === undefined || timestamp === null) {
				throw new Error('missing timestamp to restore StopTimeUpdates')
			}

			if (!tripUpdate.stop_time_update) {
				const { schedule_relationship } = tripUpdate.trip
				if (
					schedule_relationship !== undefined &&
					schedule_relationship !== null &&
					schedule_relationship !== ScheduleRelationship.SCHEDULED
				) {
					logger.warn(
						{
							...logCtx,
							tripUpdate,
						},
						'TripUpdate without stop_time_update[] even though its schedule_relationship is SCHEDULED, skipping restoring',
					)
					continue
				}

				tripUpdate.stop_time_update = previousStopTimeUpdates
			} else {
				for (const stopTimeUpdate of tripUpdate.stop_time_update) {
					const {
						stop_id,
						// todo: (also?) use stop_sequence to compare
					} = stopTimeUpdate
					const previousStopTimeUpdate = previousStopTimeUpdates.find(
						({ stop_id: scheduleStopId }) => scheduleStopId === stop_id,
					)
					if (!previousStopTimeUpdate) {
						// todo: trace-log?
						continue
					}

					_restoreStopTimeUpdate(
						stopTimeUpdate,
						timestamp,
						previousStopTimeUpdate,
					)
					// todo: trace-log?
				}
			}
		}
	}

	const storeAndRestoreStopTimeUpdatesFromDb = async (
		feedMessage: FeedMessage,
		opt: MatchOptions = {},
	) => {
		// todo: make sure restore() doesn't already mutate `feedMessage` while the store() still accesses it
		await Promise.all([
			restoreStopTimeUpdatesFromDb(feedMessage, opt),
			// storeStopTimeUpdatesInDb(feedMessage, opt),
		])
	}

	const cleanOldStoredStopTimeUpdates = async () => {
		const timestampMin = ((Date.now() / 1000) | 0) - MAX_AGE
		const logCtx = {
			timestampMin,
			..._logCtx,
		}

		logger.trace(logCtx, 'deleting old stored StopTimeUpdates')
		const t0 = performance.now()
		const { rowCount: nrOfStopTimeUpdates } = await db.query({
			text: `\
				DELETE FROM previous_stoptimeupdates
				WHERE timestamp < $1
`,
			values: [timestampMin],
		})
		const queryTime = (performance.now() - t0) / 1000
		cleanQueryTimeSeconds.observe(
			{
				schedule_feed_digest: scheduleFeedDigestSlice,
			},
			queryTime,
		)
		noCleaned.set(
			{
				schedule_feed_digest: scheduleFeedDigestSlice,
			},
			nrOfStopTimeUpdates ?? 0,
		)
		logger.debug(
			{
				...logCtx,
				queryTime,
				nrOfStopTimeUpdates,
			},
			`deleted ${nrOfStopTimeUpdates} old stored StopTimeUpdates`,
		)
	}
	const startCleaningOldStoredStopTimeUpdates = () => {
		const run = async () => {
			try {
				await cleanOldStoredStopTimeUpdates()
			} catch (err) {
				logger.warn({ err }, 'failed to clean old stored StopTimeUpdates')
			} finally {
				timer = setTimeout(() => {
					void run()
				}, CLEAN_INTERVAL * 1000)
			}
		}

		// If the process crashes soon after start for some reason, no cleanup will ever run.
		// todo: use a proper task scheduler with a back-off logic, e.g. Kubernetes CronJob [1]
		// [1] https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/
		let timer: NodeJS.Timeout | null = setTimeout(() => {
			void run()
		}, 100) // todo
		const stop = () => {
			if (timer === null) return
			clearTimeout(timer)
			timer = null
		}
		return stop
	}

	return {
		storeStopTimeUpdatesInDb,
		restoreStopTimeUpdatesFromDb,
		storeAndRestoreStopTimeUpdatesFromDb,
		startCleaningOldStoredStopTimeUpdates,
	}
}

export { createStoreAndRestoreStopTimeUpdatesFromDb, _restoreStopTimeUpdate }
