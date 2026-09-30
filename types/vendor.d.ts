declare module 'serve-buffer' {
	import type { IncomingMessage, ServerResponse } from 'node:http'

	interface ServeBufferOptions {
		etag?: string | null
		timeModified?: Date
		unmutatedBuffers?: boolean
	}

	export default function serveBuffer(
		req: IncomingMessage,
		res: ServerResponse<IncomingMessage>,
		buffer: Buffer,
		options?: ServeBufferOptions,
		// Without a callback, serve-buffer rethrows any error other than ERR_STREAM_PREMATURE_CLOSE as an unhandled rejection.
		callback?: (err?: Error) => void,
	): void
}
