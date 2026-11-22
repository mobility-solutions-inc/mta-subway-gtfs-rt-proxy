import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import { createServer, get } from 'node:http'
import { test } from 'node:test'
import { brotliDecompressSync, gunzipSync, zstdDecompressSync } from 'node:zlib'
import type { IncomingHttpHeaders } from 'node:http'
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

test('serving feeds preserves compression and conditional requests', async (t) => {
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

	const request = (headers: Record<string, string>) =>
		new Promise<{
			statusCode: number | undefined
			headers: IncomingHttpHeaders
			body: Buffer
		}>((resolve, reject) => {
			get(`http://127.0.0.1:${port}/`, { headers }, (res) => {
				const chunks: Buffer[] = []
				res.on('data', (chunk: Buffer) => chunks.push(chunk))
				res.on('end', () => {
					resolve({
						statusCode: res.statusCode,
						headers: res.headers,
						body: Buffer.concat(chunks),
					})
				})
				res.on('error', reject)
			}).on('error', reject)
		})

	try {
		const plain = await request({ 'accept-encoding': 'identity' })
		strictEqual(plain.statusCode, 200)
		ok(plain.body.length > 0, 'empty response body')

		for (const [encoding, decompress] of [
			['identity', (body: Buffer) => body],
			['gzip', gunzipSync],
			['br', brotliDecompressSync],
			['zstd', zstdDecompressSync],
		] as const) {
			await t.test(encoding, async () => {
				const headers = { 'accept-encoding': encoding }
				const response = await request(headers)
				strictEqual(response.statusCode, 200)
				strictEqual(
					response.headers['content-encoding'],
					encoding === 'identity' ? undefined : encoding,
				)
				deepStrictEqual(decompress(response.body), plain.body)
				ok(response.headers.etag, 'missing ETag')

				const cached = await request(headers)
				deepStrictEqual(cached.body, response.body)
				strictEqual(cached.headers.etag, response.headers.etag)

				const notModified = await request({
					...headers,
					'if-none-match': response.headers.etag,
				})
				strictEqual(notModified.statusCode, 304)
				strictEqual(notModified.body.length, 0)
			})
		}

		const partial = await request({
			'accept-encoding': 'identity',
			range: 'bytes=0-3',
		})
		strictEqual(partial.statusCode, 206)
		deepStrictEqual(partial.body, plain.body.subarray(0, 4))

		setFeed({
			...feedMessage,
			header: { ...feedMessage.header, timestamp: 1790800001 },
		})
		ok(plain.headers.etag)
		const changed = await request({
			'accept-encoding': 'identity',
			'if-none-match': plain.headers.etag,
		})
		strictEqual(changed.statusCode, 200)
		ok(changed.headers.etag !== plain.headers.etag, 'stale ETag')
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => {
				if (error) reject(error)
				else resolve()
			})
		})
	}
})
