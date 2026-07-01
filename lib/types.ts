import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Pool } from 'pg'
import type pino from 'pino'
import type { Registry } from 'prom-client'

import type {
	INyctFeedHeader,
	INyctStopTimeUpdate,
	INyctTripDescriptor,
	ITripReplacementPeriod,
	transit_realtime,
} from './mta-gtfs-realtime.pb.js'

export type Logger = pino.Logger
export type Db = Pool

export type HttpRequest = IncomingMessage
export type HttpResponse = ServerResponse<IncomingMessage>

export type ProtobufLong =
	| bigint
	| number
	| {
			high: number
			low: number
			unsigned?: boolean
	  }

export type NyctFeedHeader = Omit<
	INyctFeedHeader,
	'trip_replacement_period'
> & {
	trip_replacement_period?: TripReplacementPeriod[] | null
}

export type FeedHeader = Omit<
	transit_realtime.IFeedHeader,
	'.nyct_feed_header' | 'timestamp'
> & {
	'.nyct_feed_header'?: NyctFeedHeader | null
	timestamp?: ProtobufLong | null
}

export type TripReplacementPeriod = Omit<
	ITripReplacementPeriod,
	'replacement_period'
> & {
	replacement_period?: TimeRange | null
}

export type TimeRange = Omit<transit_realtime.ITimeRange, 'end' | 'start'> & {
	end?: ProtobufLong | null
	start?: ProtobufLong | null
}

export type StopTimeEvent = Omit<
	transit_realtime.TripUpdate.IStopTimeEvent,
	'time'
> & {
	delay?: number | null
	time?: ProtobufLong | null
}

export type StopTimeUpdate = Omit<
	transit_realtime.TripUpdate.IStopTimeUpdate,
	'.nyct_stop_time_update' | 'arrival' | 'departure'
> & {
	'.nyct_stop_time_update'?: INyctStopTimeUpdate | null
	arrival?: StopTimeEvent | null
	departure?: StopTimeEvent | null
}

export type TripDescriptor = Omit<
	transit_realtime.ITripDescriptor,
	'.nyct_trip_descriptor'
> & {
	'.nyct_trip_descriptor'?: INyctTripDescriptor | null
}

export type TripUpdate = Omit<
	transit_realtime.ITripUpdate,
	'stop_time_update' | 'timestamp' | 'trip' | 'vehicle'
> & {
	delay?: number | null
	stop_time_update?: StopTimeUpdate[] | null
	timestamp?: ProtobufLong | null
	trip: TripDescriptor
	vehicle?: transit_realtime.IVehicleDescriptor | null
}

export type VehiclePosition = Omit<
	transit_realtime.IVehiclePosition,
	'timestamp' | 'trip'
> & {
	timestamp?: ProtobufLong | null
	trip: TripDescriptor
}

export type EntitySelector = Omit<transit_realtime.IEntitySelector, 'trip'> & {
	trip?: TripDescriptor | null
}

export type Alert = Omit<transit_realtime.IAlert, 'informed_entity'> & {
	informed_entity: EntitySelector[]
}

export type FeedEntity = Omit<
	transit_realtime.IFeedEntity,
	'alert' | 'trip_update' | 'vehicle'
> & {
	alert?: Alert | null
	id: string
	trip_update?: TripUpdate | null
	vehicle?: VehiclePosition | null
}

export type FeedMessage = Omit<
	transit_realtime.IFeedMessage,
	'entity' | 'header'
> & {
	entity: FeedEntity[]
	header: FeedHeader
}

export type RealtimeFeedName = string | null

export interface MatchOptions {
	now?: number
	realtimeFeedName?: RealtimeFeedName
}

export interface MatchConfig {
	db: Db
	logger: Logger
	metricsRegister?: Registry
	scheduleFeedDigest: string
	scheduleFeedDigestSlice: string
}

export interface ScheduleStopTime {
	date?: string
	stop_id: string
	stop_sequence: number | null
	t_arrival?: string | null
	t_departure?: string | null
	trip_id: string
}

export interface PreviousStopTimeUpdate {
	arrival_delay: bigint | number | null
	arrival_time: bigint | number | null
	departure_delay: bigint | number | null
	departure_time: bigint | number | null
	start_date: string
	stop_id: string
	timestamp: ProtobufLong
	trip_id: string
}

export interface ScheduleFeedDatabase {
	feedDigest: string
	importedAt: number
	name: string
}
