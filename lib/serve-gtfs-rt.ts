import computeEtag from 'etag'
import { Gauge } from 'prom-client'
import serveBuffer from 'serve-buffer'

import type { FeedMessage, HttpRequest, HttpResponse } from './types.js'
import { register as metricsRegister } from './metrics.js'
import gtfsRtBindings from './mta-gtfs-realtime.pb.js'

const { FeedMessage } = gtfsRtBindings.transit_realtime

class FeedMessageVerificationError extends Error {
	feedMessage: FeedMessage

	constructor(message: string, feedMessage: FeedMessage) {
		super(message)
		this.feedMessage = feedMessage
	}
}

const encodeFeedMessage = (feedMessage: FeedMessage): Buffer => {
	// `Message.verify(message: Object): null|string`
	// verifies that a **plain JavaScript object** satisfies the requirements of a valid message and thus can be encoded without issues. Instead of throwing, it returns the error message as a string, if any.
	// `Message.encode(message: Message|Object [, writer: Writer]): Writer`
	// encodes a **message instance** or valid **plain JavaScript object**. This method does not implicitly verify the message and it's up to the user to make sure that the payload is a valid message.
	const message = feedMessage as Parameters<typeof FeedMessage.encode>[0]
	const errMsg = FeedMessage.verify(message)
	if (errMsg) {
		throw new FeedMessageVerificationError(errMsg, feedMessage)
	}
	const feedEncoded = Buffer.from(FeedMessage.encode(message).finish())
	return feedEncoded
}

const encodedFeedSizeBytes = new Gauge({
	name: 'encoded_feed_size_bytes',
	help: 'size of the Protocol-Buffers-encoded GTFS-Realtime feed',
	registers: [metricsRegister],
	labelNames: ['schedule_feed_digest'],
})

interface ServeFeedConfig {
	scheduleFeedDigest: string
	scheduleFeedDigestSlice: string
}

const serveFeed = (cfg: ServeFeedConfig) => {
	const { scheduleFeedDigestSlice } = cfg

	// modeled after https://github.com/derhuerst/hafas-gtfs-rt-feed/blob/8.2.3/lib/serve.js#L144-L152
	let feed: Buffer | null = null
	let timeModified = new Date(0)
	let etag: string | null = null
	const setFeed = (feedMessage: FeedMessage) => {
		// todo: debug-log
		feed = encodeFeedMessage(feedMessage)
		timeModified = new Date()
		encodedFeedSizeBytes.set(
			{
				schedule_feed_digest: scheduleFeedDigestSlice,
			},
			feed.length,
		)
		etag = computeEtag(feed)
	}

	// modeled after https://github.com/derhuerst/hafas-gtfs-rt-feed/blob/8.2.3/lib/serve.js#L172-L177
	const onRequest = (req: HttpRequest, res: HttpResponse) => {
		if (feed === null) {
			res.writeHead(404, 'feed not initialized yet').end()
			return
		}
		serveBuffer(req, res, feed, {
			timeModified,
			etag,
			// serve-buffer readme:
			// > If you *never mutate* the buffer(s) that you pass into `serveBuffer`, you can tell it to *cache* each buffer's compressed version as long as the instance exists […].
			unmutatedBuffers: true,
		})
	}

	return {
		setFeed,
		onRequest,
	}
}

export { encodeFeedMessage, serveFeed }
