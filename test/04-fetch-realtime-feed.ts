import { ok } from 'node:assert'
import { createServer } from 'node:http'
import { test } from 'node:test'
import type { AddressInfo } from 'node:net'

import { startFetchingRealtimeFeed } from '../lib/fetch-realtime-feed.js'

test('realtime polling recovers after an exhausted fetch retry cycle', async () => {
	let requests = 0
	const server = createServer((_req, res) => {
		requests++
		if (requests <= 4) {
			res.writeHead(500).end('temporary upstream failure')
			return
		}
		res.end(Buffer.from('recovered'))
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const { port } = server.address() as AddressInfo

	const { abortFetching, events } = startFetchingRealtimeFeed({
		realtimeFeedApiKey: null,
		realtimeFeedName: 'test_realtime_feed',
		realtimeFeedUrl: `http://127.0.0.1:${port}/feed.pb`,
	})

	try {
		const feedEncoded = await new Promise<Buffer>((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error('timed out waiting for realtime polling to recover'))
			}, 10_000)
			events.once('update', (update) => {
				clearTimeout(timeout)
				resolve(update.feedEncoded)
			})
		})
		ok(requests >= 5, 'polling should retry after the first fetch cycle fails')
		ok(Buffer.isBuffer(feedEncoded))
	} finally {
		abortFetching()
		await new Promise<void>((resolve, reject) => {
			server.close((error) => {
				if (error) reject(error)
				else resolve()
			})
		})
	}
})
