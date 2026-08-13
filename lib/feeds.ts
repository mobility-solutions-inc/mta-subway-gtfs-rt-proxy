const MTA_API_ACCESS_KEY = process.env.MTA_API_ACCESS_KEY ?? null
// todo: MTA BusTime API key

interface RealtimeFeedConfig {
	realtimeFeedApiKey: string | null
	realtimeFeedName: string
	realtimeFeedUrl: string
}

interface ScheduleFeedConfig {
	realtimeFeeds: RealtimeFeedConfig[]
	scheduleFeedName: string
	scheduleFeedUrl: string
}

// Note: We use the "supplemented" instead of the "regular" GTFS feed.
// > Every day, the feed will contain a seven-day lookahead, so in principle a developer can download that and use it for the next seven days, then refresh the feed to get the next seven days – but we recommend updating more frequently (ideally daily) to get the latest updates and have valid data for the next seven days.
// – https://groups.google.com/g/mtadeveloperresources/c/14d8DV4hnj4/m/vSpVGSgdAwAJ
// > Outside of the seven-day window, the new supplemented feed will contain the same information as the existing static GTFS feed.
// – https://groups.google.com/g/mtadeveloperresources/c/14d8DV4hnj4/m/cL0njuZdAwAJ
const NYCT_SUBWAY_FEED_NAME = 'nyct_subway'
const NYCT_SUBWAY_SCHEDULE_FEED_URL =
	process.env.NYCT_SUBWAY_SCHEDULE_FEED_URL ??
	'https://rrgtfsfeeds.s3.amazonaws.com/gtfs_supplemented.zip'

const realtimeFeed = (
	name: string,
	envName: string,
	upstreamName: string,
): RealtimeFeedConfig | null => {
	const configured =
		process.env[envName] ??
		`https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2F${upstreamName}`
	if (configured === '-') return null
	return {
		realtimeFeedName: `nyct_subway_${name}`,
		realtimeFeedUrl: configured,
		realtimeFeedApiKey: MTA_API_ACCESS_KEY,
	}
}

const NYCT_SUBWAY_FEED: ScheduleFeedConfig = {
	scheduleFeedName: NYCT_SUBWAY_FEED_NAME,
	scheduleFeedUrl: NYCT_SUBWAY_SCHEDULE_FEED_URL,
	realtimeFeeds: [
		realtimeFeed('1234567', 'NYCT_SUBWAY_1234567_REALTIME_FEED_URL', 'gtfs'),
		realtimeFeed('7', 'NYCT_SUBWAY_7_REALTIME_FEED_URL', 'gtfs-7'),
		realtimeFeed('ace', 'NYCT_SUBWAY_ACE_REALTIME_FEED_URL', 'gtfs-ace'),
		realtimeFeed('bdfm', 'NYCT_SUBWAY_BDFM_REALTIME_FEED_URL', 'gtfs-bdfm'),
		realtimeFeed('g', 'NYCT_SUBWAY_G_REALTIME_FEED_URL', 'gtfs-g'),
		realtimeFeed('jz', 'NYCT_SUBWAY_JZ_REALTIME_FEED_URL', 'gtfs-jz'),
		realtimeFeed('l', 'NYCT_SUBWAY_L_REALTIME_FEED_URL', 'gtfs-l'),
		realtimeFeed('nqrw', 'NYCT_SUBWAY_NQRW_REALTIME_FEED_URL', 'gtfs-nqrw'),
		realtimeFeed('si', 'NYCT_SUBWAY_SI_REALTIME_FEED_URL', 'gtfs-si'),
	].filter((feed): feed is RealtimeFeedConfig => feed !== null),
}

const ALL_FEEDS: ScheduleFeedConfig[] = [
	NYCT_SUBWAY_FEED,
	// todo: bus, etc.
]

export { NYCT_SUBWAY_FEED, ALL_FEEDS }
