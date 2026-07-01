import { createServer as createHttpServer } from 'node:http'
import { collectDefaultMetrics, register } from 'prom-client'

import type { HttpRequest, HttpResponse } from './types.js'

const DEFAULT_PORT = process.env.METRICS_SERVER_PORT
	? parseInt(process.env.METRICS_SERVER_PORT)
	: 0 // find an available port

// The http-metrics-middleware package does too much, so we implement the
// HTTP metrics server by ourselves here.
interface MetricsServerOptions {
	defaultLabels?: Record<string, string>
	serverPort?: number
}

type MetricsServer = ReturnType<typeof createHttpServer> & {
	start: () => Promise<void>
}

const createMetricsServer = (opt: MetricsServerOptions = {}): MetricsServer => {
	const options = {
		defaultLabels: {},
		serverPort: DEFAULT_PORT,
		...opt,
	}

	register.setDefaultLabels(options.defaultLabels)
	collectDefaultMetrics({ register })

	const handleRequest = (req: HttpRequest, res: HttpResponse) => {
		if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/metrics') {
			res.writeHead(404)
			res.end()
			return
		}
		if (req.method !== 'GET' && req.method !== 'POST') {
			res.writeHead(405)
			res.end()
			return
		}

		register
			.metrics()
			.then((metrics) => {
				res.setHeader('Content-Type', register.contentType)
				res.end(metrics)
			})
			.catch((err: unknown) => {
				res.statusCode = 500
				res.setHeader('Content-Type', 'text/plain')
				const message =
					err instanceof Error ? `${err}\n${err.stack}` : String(err)
				res.end(message)
			})
	}

	const server = createHttpServer(handleRequest) as MetricsServer
	server.start = () => {
		return new Promise<void>((resolve) => {
			server.listen(options.serverPort, () => {
				resolve()
			})
		})
	}

	return server
}

export { register, createMetricsServer }
