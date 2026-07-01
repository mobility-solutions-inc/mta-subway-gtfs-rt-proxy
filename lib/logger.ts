import type { Logger } from 'pino'
import { pino, stdSerializers } from 'pino'

const DEFAULT_LOG_LEVEL = (process.env.LOG_LEVEL ?? 'info').toLowerCase()

const createLogger = (name: string, level = DEFAULT_LOG_LEVEL): Logger => {
	return pino({
		name,
		level,
		base: { pid: process.pid },
		serializers: {
			// default, which we're overriding here: {err: stdSerializers.err}
			error: stdSerializers.err,
		},
	})
}

export { createLogger }
