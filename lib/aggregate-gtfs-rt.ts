import { ok } from 'node:assert'
import { Counter, Gauge } from 'prom-client'

import type { FeedEntity, FeedMessage } from './types.js'
import { register as metricsRegister } from './metrics.js'
import gtfsRtBindings from './mta-gtfs-realtime.pb.js'
import { protobufLongToNumber } from './protobuf.js'

const { FULL_DATASET } =
	gtfsRtBindings.transit_realtime.FeedHeader.Incrementality

const aggregateFeedReady = new Gauge({
	name: 'aggregate_feed_ready_boolean',
	help: 'whether every configured source has initialized the aggregate feed',
	labelNames: ['feed_name', 'schedule_feed_digest'],
	registers: [metricsRegister],
})

const aggregateFeedSourceLastUpdateTimestamp = new Gauge({
	name: 'aggregate_feed_source_last_update_timestamp_seconds',
	help: 'UNIX timestamp of the latest source update included in aggregate state',
	labelNames: ['feed_name', 'schedule_feed_digest', 'source_feed_name'],
	registers: [metricsRegister],
})

const aggregateFeedEntities = new Gauge({
	name: 'aggregate_feed_entities',
	help: 'number of GTFS-Realtime entities in aggregate state',
	labelNames: [
		'feed_name',
		'schedule_feed_digest',
		'source_feed_name',
		'entity_type',
	],
	registers: [metricsRegister],
})

const aggregateFeedDuplicateEntities = new Counter({
	name: 'aggregate_feed_duplicate_semantic_entities_total',
	help: 'number of semantic entity collisions found across aggregate sources',
	labelNames: ['feed_name', 'entity_type'],
	registers: [metricsRegister],
})

class DuplicateAggregateEntityError extends Error {
	constructor(entityType: string, key: string, sourceNames: string[]) {
		super(
			`duplicate ${entityType} "${key}" in aggregate sources ${sourceNames.join(', ')}`,
		)
		this.name = 'DuplicateAggregateEntityError'
	}
}

interface AggregateFeedConfig {
	aggregateFeedName: string
	expectedSourceNames: string[]
	now?: () => number
	scheduleFeedDigestSlice: string
}

const tripKey = (entity: FeedEntity): string | null => {
	const trip = entity.trip_update?.trip
	if (!trip?.trip_id) return null
	return [trip.trip_id, trip.start_date ?? '', trip.route_id ?? ''].join('|')
}

const vehicleKey = (entity: FeedEntity): string | null => {
	const vehicle = entity.vehicle
	if (!vehicle) return null
	if (vehicle.vehicle?.id) return vehicle.vehicle.id
	const trip = vehicle.trip
	if (!trip?.trip_id) return null
	return [trip.trip_id, trip.start_date ?? '', trip.route_id ?? ''].join('|')
}

const assertNoSemanticDuplicates = (
	aggregateFeedName: string,
	feedsBySourceName: Map<string, FeedMessage>,
) => {
	for (const [entityType, getKey] of [
		['trip-update', tripKey],
		['vehicle-position', vehicleKey],
	] as const) {
		const sourceNamesByKey = new Map<string, string[]>()
		for (const [sourceName, feed] of feedsBySourceName) {
			for (const entity of feed.entity) {
				const key = getKey(entity)
				if (key === null) continue
				const sourceNames = sourceNamesByKey.get(key) ?? []
				if (!sourceNames.includes(sourceName)) sourceNames.push(sourceName)
				sourceNamesByKey.set(key, sourceNames)
			}
		}
		for (const [key, sourceNames] of sourceNamesByKey) {
			if (sourceNames.length < 2) continue
			aggregateFeedDuplicateEntities.inc({
				feed_name: aggregateFeedName,
				entity_type: entityType,
			})
			throw new DuplicateAggregateEntityError(entityType, key, sourceNames)
		}
	}
}

const entityType = (entity: FeedEntity) => {
	if (entity.trip_update != null) return 'trip-update'
	if (entity.vehicle != null) return 'vehicle-position'
	if (entity.alert != null) return 'alert'
	return 'other'
}

const mergeFeeds = (
	aggregateFeedName: string,
	expectedSourceNames: string[],
	feedsBySourceName: Map<string, FeedMessage>,
	now: number,
): FeedMessage => {
	assertNoSemanticDuplicates(aggregateFeedName, feedsBySourceName)

	const sourceFeeds = expectedSourceNames.map((sourceName) => {
		const feed = feedsBySourceName.get(sourceName)
		ok(feed, `missing initialized aggregate source ${sourceName}`)
		return { feed, sourceName }
	})
	const newestSource = sourceFeeds.reduce((newest, candidate) => {
		const newestTimestamp = newest.feed.header.timestamp
			? protobufLongToNumber(newest.feed.header.timestamp)
			: 0
		const candidateTimestamp = candidate.feed.header.timestamp
			? protobufLongToNumber(candidate.feed.header.timestamp)
			: 0
		return candidateTimestamp > newestTimestamp ? candidate : newest
	})
	const nyctHeaders = sourceFeeds
		.map(({ feed }) => feed.header['.nyct_feed_header'])
		.filter((header) => header != null)
	const newestNyctHeader = newestSource.feed.header['.nyct_feed_header']
	const mergedNyctHeader =
		nyctHeaders.length === 0
			? undefined
			: {
					...(newestNyctHeader ?? nyctHeaders[0]),
					trip_replacement_period: nyctHeaders.flatMap(
						(header) => header?.trip_replacement_period ?? [],
					),
				}

	return {
		header: {
			...newestSource.feed.header,
			gtfs_realtime_version:
				newestSource.feed.header.gtfs_realtime_version ?? '2.0',
			incrementality: FULL_DATASET,
			timestamp: Math.floor(now / 1000),
			'.nyct_feed_header': mergedNyctHeader,
		},
		entity: sourceFeeds.flatMap(({ feed, sourceName }) =>
			feed.entity.map((entity) => ({
				...entity,
				id: `${sourceName}:${entity.id}`,
			})),
		),
	}
}

const createAggregateFeed = (cfg: AggregateFeedConfig) => {
	const {
		aggregateFeedName,
		expectedSourceNames,
		now = Date.now,
		scheduleFeedDigestSlice,
	} = cfg
	ok(aggregateFeedName, 'missing aggregateFeedName')
	ok(expectedSourceNames.length > 0, 'aggregate feed requires source feeds')
	ok(
		new Set(expectedSourceNames).size === expectedSourceNames.length,
		'aggregate source feed names must be unique',
	)

	const feedsBySourceName = new Map<string, FeedMessage>()
	let ready = false
	const metricLabels = {
		feed_name: aggregateFeedName,
		schedule_feed_digest: scheduleFeedDigestSlice,
	}
	aggregateFeedReady.set(metricLabels, 0)

	const setSourceFeed = (
		sourceName: string,
		feedMessage: FeedMessage,
	): FeedMessage | null => {
		ok(
			expectedSourceNames.includes(sourceName),
			`unexpected aggregate source ${sourceName}`,
		)
		feedsBySourceName.set(sourceName, feedMessage)
		aggregateFeedSourceLastUpdateTimestamp.set(
			{
				...metricLabels,
				source_feed_name: sourceName,
			},
			now() / 1000,
		)
		for (const type of ['trip-update', 'vehicle-position', 'alert', 'other']) {
			aggregateFeedEntities.set(
				{
					...metricLabels,
					source_feed_name: sourceName,
					entity_type: type,
				},
				feedMessage.entity.filter((entity) => entityType(entity) === type)
					.length,
			)
		}

		const isReady = expectedSourceNames.every((name) =>
			feedsBySourceName.has(name),
		)
		if (!isReady) {
			ready = false
			aggregateFeedReady.set(metricLabels, 0)
			return null
		}

		try {
			const aggregate = mergeFeeds(
				aggregateFeedName,
				expectedSourceNames,
				feedsBySourceName,
				now(),
			)
			ready = true
			aggregateFeedReady.set(metricLabels, 1)
			return aggregate
		} catch (error: unknown) {
			ready = false
			aggregateFeedReady.set(metricLabels, 0)
			throw error
		}
	}

	return {
		getMissingSourceNames: () =>
			expectedSourceNames.filter((name) => !feedsBySourceName.has(name)),
		isReady: () => ready,
		setSourceFeed,
	}
}

export type { AggregateFeedConfig }
export { createAggregateFeed, DuplicateAggregateEntityError, mergeFeeds }
