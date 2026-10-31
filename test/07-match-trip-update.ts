import { deepStrictEqual, strictEqual } from 'node:assert'
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

// Without a match, a stop_sequence query (exact & by suffix) is retried without stop_sequence.
const assertQueriesWithThenWithoutSequence = (
	queries: QueryConfig[],
	stopId: string,
	stopSequence: number,
) => {
	strictEqual(queries.length, 4)
	for (const query of queries.slice(0, 2)) {
		strictEqual(query.values?.[1], stopId)
		strictEqual(query.values?.[5], stopSequence)
		strictEqual(query.name?.endsWith('_stop_id_stop_seq'), true)
	}
	for (const query of queries.slice(2)) {
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
	strictEqual(queries.length, 2)
	for (const query of queries) {
		strictEqual(query.values?.[1], '705S')
		strictEqual(query.name?.endsWith('_stop_id'), true)
	}
})

test('TripUpdate matching does not query without a stop ID', async (t) => {
	const queries = await queryForStops(t, [{ stop_sequence: 1 }])
	deepStrictEqual(queries, [])
})
