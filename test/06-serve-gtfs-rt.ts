import { ok, strictEqual } from 'node:assert'
import { createServer, get } from 'node:http'
import { test } from 'node:test'
import type { AddressInfo } from 'node:net'

import type { FeedMessage } from '../lib/types.js'
import { serveFeed } from '../lib/serve-gtfs-rt.js'

const feedMessage = {
	header: {
		gtfs_realtime_version: '2.0',
		timestamp: 1790800000,
	},
	entity: [],
} as unknown as FeedMessage

test('serving a feed to a client that has gone away does not crash', async () => {
	const { setFeed, onRequest } = serveFeed({
		scheduleFeedDigest: '01234567',
		scheduleFeedDigestSlice: '0',
	})
	setFeed(feedMessage)

	const unhandledRejections: unknown[] = []
	const onUnhandledRejection = (reason: unknown) => {
		unhandledRejections.push(reason)
	}
	process.on('unhandledRejection', onUnhandledRejection)

	let served: () => void
	const servedPromise = new Promise<void>((resolve) => {
		served = resolve
	})
	const server = createServer((req, res) => {
		// as if the client's request had timed out before the body could be piped
		res.destroy()
		onRequest(req, res, 'trip-updates')
		served()
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const { port } = server.address() as AddressInfo

	try {
		get(`http://127.0.0.1:${port}/`).on('error', () => undefined)
		await servedPromise
		// let serve-buffer's asynchronous piping settle
		await new Promise<void>((resolve) => setTimeout(resolve, 200))
		strictEqual(unhandledRejections.length, 0, 'unhandled rejection')
	} finally {
		process.removeListener('unhandledRejection', onUnhandledRejection)
		await new Promise<void>((resolve, reject) => {
			server.close((error) => {
				if (error) reject(error)
				else resolve()
			})
		})
	}
})

test('serving a feed to a connected client still works', async () => {
	const { setFeed, onRequest } = serveFeed({
		scheduleFeedDigest: '01234567',
		scheduleFeedDigestSlice: '0',
	})
	setFeed(feedMessage)

	const server = createServer((req, res) => {
		onRequest(req, res, 'trip-updates')
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const { port } = server.address() as AddressInfo

	try {
		const { statusCode, body } = await new Promise<{
			statusCode: number | undefined
			body: Buffer
		}>((resolve, reject) => {
			get(`http://127.0.0.1:${port}/`, (res) => {
				const chunks: Buffer[] = []
				res.on('data', (chunk: Buffer) => chunks.push(chunk))
				res.on('end', () => {
					resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks) })
				})
				res.on('error', reject)
			}).on('error', reject)
		})
		strictEqual(statusCode, 200)
		ok(body.length > 0, 'empty response body')
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => {
				if (error) reject(error)
				else resolve()
			})
		})
	}
})
