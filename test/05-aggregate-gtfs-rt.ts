import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert'
import { test } from 'node:test'

import type { FeedEntity, FeedMessage } from '../lib/types.js'
import {
	createAggregateFeed,
	DuplicateAggregateEntityError,
} from '../lib/aggregate-gtfs-rt.js'
import { NYCT_SUBWAY_FEED } from '../lib/feeds.js'

const tripEntity = (id: string, routeId: string): FeedEntity => ({
	id,
	trip_update: {
		trip: {
			trip_id: id,
			route_id: routeId,
			start_date: '20260813',
		},
		stop_time_update: [],
	},
})

const vehicleEntity = (id: string, routeId: string): FeedEntity => ({
	id,
	vehicle: {
		trip: {
			trip_id: id,
			route_id: routeId,
			start_date: '20260813',
		},
		vehicle: { id: `vehicle-${id}` },
	},
})

const feed = (
	entity: FeedEntity[],
	timestamp: number,
	routeId: string,
): FeedMessage => ({
	header: {
		gtfs_realtime_version: '1.0',
		timestamp,
		'.nyct_feed_header': {
			nyct_subway_version: '1.0',
			trip_replacement_period: [
				{
					route_id: routeId,
					replacement_period: { start: timestamp, end: timestamp + 60 },
				},
			],
		},
	},
	entity,
})

test('subway configuration uses the combined numeric source for 7 service', () => {
	deepStrictEqual(
		NYCT_SUBWAY_FEED.realtimeFeeds.map(({ realtimeFeedName }) =>
			realtimeFeedName.replace('nyct_subway_', ''),
		),
		['1234567', 'ace', 'bdfm', 'g', 'jz', 'l', 'nqrw', 'si'],
	)
})

test('aggregate waits for every source and publishes one full dataset', () => {
	const aggregate = createAggregateFeed({
		aggregateFeedName: 'nyct_subway',
		expectedSourceNames: ['numbers', 'letters', 'empty'],
		now: () => 1_700_000_000_000,
		scheduleFeedDigestSlice: 'a',
	})

	strictEqual(
		aggregate.setSourceFeed(
			'numbers',
			feed([tripEntity('trip-1', '1')], 100, '1'),
		),
		null,
	)
	deepStrictEqual(aggregate.getMissingSourceNames(), ['letters', 'empty'])
	strictEqual(
		aggregate.setSourceFeed(
			'letters',
			feed([vehicleEntity('trip-a', 'A')], 200, 'A'),
		),
		null,
	)

	const result = aggregate.setSourceFeed('empty', feed([], 300, 'SIR'))
	ok(result)
	strictEqual(aggregate.isReady(), true)
	strictEqual(result.header.incrementality, 0)
	strictEqual(result.header.timestamp, 1_700_000_000)
	deepStrictEqual(
		result.entity.map(({ id }) => id),
		['numbers:trip-1', 'letters:trip-a'],
	)
	deepStrictEqual(
		result.header['.nyct_feed_header']?.trip_replacement_period?.map(
			({ route_id }) => route_id,
		),
		['1', 'A', 'SIR'],
	)
})

test('a source refresh replaces only that source slice', () => {
	let now = 1_700_000_000_000
	const aggregate = createAggregateFeed({
		aggregateFeedName: 'nyct_subway',
		expectedSourceNames: ['numbers', 'letters'],
		now: () => now,
		scheduleFeedDigestSlice: 'b',
	})
	aggregate.setSourceFeed(
		'numbers',
		feed([tripEntity('old-number-trip', '1')], 100, '1'),
	)
	const initial = aggregate.setSourceFeed(
		'letters',
		feed([tripEntity('letter-trip', 'A')], 200, 'A'),
	)
	ok(initial)

	now += 30_000
	const refreshed = aggregate.setSourceFeed(
		'numbers',
		feed([tripEntity('new-number-trip', '2')], 300, '2'),
	)
	ok(refreshed)
	deepStrictEqual(
		refreshed.entity.map(({ id }) => id),
		['numbers:new-number-trip', 'letters:letter-trip'],
	)
})

test('semantic duplicates across source feeds fail aggregation', () => {
	const aggregate = createAggregateFeed({
		aggregateFeedName: 'nyct_subway',
		expectedSourceNames: ['first', 'second'],
		scheduleFeedDigestSlice: 'c',
	})
	aggregate.setSourceFeed(
		'first',
		feed([tripEntity('duplicate-trip', '7')], 100, '7'),
	)
	throws(
		() =>
			aggregate.setSourceFeed(
				'second',
				feed([tripEntity('duplicate-trip', '7')], 200, '7'),
			),
		DuplicateAggregateEntityError,
	)
	strictEqual(aggregate.isReady(), false)
})
