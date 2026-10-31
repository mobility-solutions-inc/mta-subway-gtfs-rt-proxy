import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import type { QueryConfig } from 'pg'
import { Pool } from 'pg'

import type { StopTimeUpdate, TripUpdate } from '../lib/types.js'
import { createLogger } from '../lib/logger.js'
import { createMatchTripUpdate } from '../lib/match-trip-update.js'

const queryForStops = async (
	t: TestContext,
	stopTimeUpdates: StopTimeUpdate[],
) => {
	const db = new Pool()
	t.after(() => db.end())
	const queries: QueryConfig[] = []
	// Exercise the real query builder without opening a database connection.
	t.mock.method(db, 'query', (query: QueryConfig) => {
		queries.push(query)
		return Promise.resolve({ rows: [] })
	})
	const { matchTripUpdate } = createMatchTripUpdate({
		db,
		logger: createLogger('test-match-trip-update', 'silent'),
		scheduleFeedDigest: 'stop-selection-test',
		scheduleFeedDigestSlice: 'stop-selection-test',
	})
	const tripUpdate: TripUpdate = {
		trip: {
			trip_id: '103550_7..S',
			start_date: '20260925',
			route_id: '7',
		},
		stop_time_update: stopTimeUpdates,
	}
	const original = structuredClone(tripUpdate)
	strictEqual(await matchTripUpdate(tripUpdate), null)
	deepStrictEqual(tripUpdate, original)
	return queries
}

// Without a match, a stop_sequence query (exact, by suffix & by prefix) is retried without stop_sequence.
const assertQueriesWithThenWithoutSequence = (
	queries: QueryConfig[],
	stopId: string,
	stopSequence: number,
) => {
	strictEqual(queries.length, 6)
	for (const query of queries.slice(0, 3)) {
		strictEqual(query.values?.[1], stopId)
		strictEqual(query.values?.[5], stopSequence)
		strictEqual(query.name?.endsWith('_stop_id_stop_seq'), true)
	}
	for (const query of queries.slice(3)) {
		strictEqual(query.values?.[1], stopId)
		strictEqual(query.name?.endsWith('_stop_id'), true)
	}
}

test('TripUpdate matching prefers a later stop with a sequence', async (t) => {
	const queries = await queryForStops(t, [
		{ stop_id: '705S' },
		{ stop_id: '706S', stop_sequence: 2 },
	])
	assertQueriesWithThenWithoutSequence(queries, '706S', 2)
})

test('TripUpdate matching preserves a first stop with sequence zero', async (t) => {
	const queries = await queryForStops(t, [
		{ stop_id: '705S', stop_sequence: 0 },
		{ stop_id: '706S', stop_sequence: 1 },
	])
	assertQueriesWithThenWithoutSequence(queries, '705S', 0)
})

test('TripUpdate matching falls back to stop_id when stop_sequence does not match the schedule', async (t) => {
	const db = new Pool()
	t.after(() => db.end())
	// A rerouted trip: the Realtime feed numbers its stops from 1, the Schedule trip starts one stop earlier.
	const scheduleStopTimes = ['704S', '705S', '706S'].map((stop_id, i) => ({
		date: '2026-09-25',
		trip_id: 'BFA26GEN-7001-Weekday-00_103550_7..S',
		stop_id,
		stop_sequence: i + 1,
		t_arrival: `2026-09-25T17:${String(16 + i).padStart(2, '0')}:00-04:00`,
		t_departure: `2026-09-25T17:${String(16 + i).padStart(2, '0')}:00-04:00`,
	}))
	t.mock.method(db, 'query', (query: QueryConfig) =>
		Promise.resolve({
			rows:
				query.name?.endsWith('_stop_seq') || !query.name?.includes('by_suffix')
					? []
					: scheduleStopTimes,
		}),
	)
	const { matchTripUpdate } = createMatchTripUpdate({
		db,
		logger: createLogger('test-match-trip-update', 'silent'),
		scheduleFeedDigest: 'stop-sequence-fallback-test',
		scheduleFeedDigestSlice: 'stop-sequence-fallback-test',
	})
	const tripUpdate: TripUpdate = {
		trip: {
			trip_id: '103550_7..S',
			start_date: '20260925',
			route_id: '7',
		},
		stop_time_update: [
			{ stop_id: '705S', stop_sequence: 1 },
			{ stop_id: '706S', stop_sequence: 2 },
		],
	}
	await matchTripUpdate(tripUpdate)
	strictEqual(tripUpdate.trip.trip_id, 'BFA26GEN-7001-Weekday-00_103550_7..S')
	deepStrictEqual(
		tripUpdate.stop_time_update?.map((sTU) => sTU.stop_sequence),
		[2, 3],
	)
})

test('TripUpdate matching falls back when no stop has both ID and sequence', async (t) => {
	const queries = await queryForStops(t, [
		{ stop_sequence: 1 },
		{ stop_id: '705S' },
		{ stop_id: '706S' },
	])
	strictEqual(queries.length, 3)
	for (const query of queries) {
		strictEqual(query.values?.[1], '705S')
		strictEqual(query.name?.endsWith('_stop_id'), true)
	}
})

test('TripUpdate matching does not query without a stop ID', async (t) => {
	const queries = await queryForStops(t, [{ stop_sequence: 1 }])
	deepStrictEqual(queries, [])
})

// The L's Realtime trip IDs lack the path identifier that the Schedule's trip IDs end with.
const L_REALTIME_TRIP_ID = '078800_L..S'
const L_SCHEDULE_TRIP_ID = 'BFA26GEN-L028-Saturday-00_078800_L..S01R'

const matchLTripUpdate = async (
	t: TestContext,
	candidateTripIds: string[],
	realtimeTripId = L_REALTIME_TRIP_ID,
) => {
	const db = new Pool()
	t.after(() => db.end())
	const scheduleStopTimes = ['L06S', 'L08S', 'L10S'].map((stop_id, i) => ({
		date: '2026-10-31',
		trip_id: L_SCHEDULE_TRIP_ID,
		stop_id,
		stop_sequence: i + 1,
		t_arrival: `2026-10-31T13:${String(8 + i * 2).padStart(2, '0')}:00-04:00`,
		t_departure: `2026-10-31T13:${String(8 + i * 2).padStart(2, '0')}:00-04:00`,
	}))
	const queries: QueryConfig[] = []
	t.mock.method(db, 'query', (query: QueryConfig) => {
		queries.push(query)
		let rows: unknown[] = []
		if (query.name?.includes('by_prefix_candidates')) {
			rows = candidateTripIds.map((trip_id) => ({
				date: '2026-10-31',
				trip_id,
			}))
		} else if (query.values?.[3] === L_SCHEDULE_TRIP_ID) {
			rows = scheduleStopTimes
		}
		return Promise.resolve({ rows })
	})
	const { matchTripUpdate } = createMatchTripUpdate({
		db,
		logger: createLogger('test-match-trip-update', 'silent'),
		scheduleFeedDigest: 'prefix-test',
		scheduleFeedDigestSlice: 'prefix-test',
	})
	const tripUpdate: TripUpdate = {
		trip: {
			trip_id: realtimeTripId,
			start_date: '20261031',
			route_id: 'L',
		},
		stop_time_update: [
			{ stop_id: 'L08S', stop_sequence: 2 },
			{ stop_id: 'L10S', stop_sequence: 3 },
		],
	}
	await matchTripUpdate(tripUpdate)
	return { tripUpdate, queries }
}

test('TripUpdate matching falls back to a unique trip_id prefix match', async (t) => {
	const { tripUpdate, queries } = await matchLTripUpdate(t, [
		L_SCHEDULE_TRIP_ID,
	])
	strictEqual(tripUpdate.trip.trip_id, L_SCHEDULE_TRIP_ID)
	deepStrictEqual(
		tripUpdate.stop_time_update?.map((sTU) => sTU.stop_sequence),
		[2, 3],
	)

	// exact, by suffix, by prefix (candidates), by prefix (unique candidate)
	strictEqual(queries.length, 4)
	const [candidatesQuery, prefixQuery] = queries.slice(2)
	ok(candidatesQuery.text.includes('SELECT DISTINCT'))
	ok(candidatesQuery.text.includes('strpos(trip_id, $4) > 0'))
	strictEqual(candidatesQuery.values?.[0], 'L')
	strictEqual(candidatesQuery.values?.[1], 'L08S')
	strictEqual(candidatesQuery.values?.[2], '2026-10-31')
	strictEqual(candidatesQuery.values?.[3], '_078800_L..S')
	// 2 candidates suffice to detect ambiguity.
	strictEqual(candidatesQuery.values?.[4], 2)
	strictEqual(candidatesQuery.values?.[5], 2)
	strictEqual(prefixQuery.values?.[3], L_SCHEDULE_TRIP_ID)
	strictEqual(prefixQuery.values?.[1], 'L08S')
	strictEqual(prefixQuery.values?.[5], 2)
})

test('TripUpdate matching does not match an ambiguous trip_id prefix', async (t) => {
	const { tripUpdate, queries } = await matchLTripUpdate(t, [
		L_SCHEDULE_TRIP_ID,
		'BFA26GEN-L028-Saturday-00_078800_L..S02R',
	])
	strictEqual(tripUpdate.trip.trip_id, L_REALTIME_TRIP_ID)
	// The candidates are never queried individually, neither with nor without stop_sequence.
	strictEqual(
		queries.filter((q) => q.values?.[3] === L_SCHEDULE_TRIP_ID).length,
		0,
	)
	strictEqual(
		queries.filter((q) => q.name?.includes('by_prefix_candidates')).length,
		2,
	)
})

test('TripUpdate matching does not prefix-match a trip_id with a path', async (t) => {
	const { tripUpdate, queries } = await matchLTripUpdate(
		t,
		[L_SCHEDULE_TRIP_ID],
		'078800_L..S01',
	)
	strictEqual(tripUpdate.trip.trip_id, '078800_L..S01')
	strictEqual(queries.filter((q) => q.name?.includes('by_prefix')).length, 0)
})
