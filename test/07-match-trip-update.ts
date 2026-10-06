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

test('TripUpdate matching prefers a later stop with a sequence', async (t) => {
	const queries = await queryForStops(t, [
		{ stop_id: '705S' },
		{ stop_id: '706S', stop_sequence: 2 },
	])
	strictEqual(queries.length, 2)
	for (const query of queries) {
		strictEqual(query.values?.[1], '706S')
		strictEqual(query.values?.[5], 2)
		strictEqual(query.name?.endsWith('_stop_id_stop_seq'), true)
	}
})

test('TripUpdate matching preserves a first stop with sequence zero', async (t) => {
	const queries = await queryForStops(t, [
		{ stop_id: '705S', stop_sequence: 0 },
		{ stop_id: '706S', stop_sequence: 1 },
	])
	strictEqual(queries.length, 2)
	for (const query of queries) {
		strictEqual(query.values?.[1], '705S')
		strictEqual(query.values?.[5], 0)
		strictEqual(query.name?.endsWith('_stop_id_stop_seq'), true)
	}
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
