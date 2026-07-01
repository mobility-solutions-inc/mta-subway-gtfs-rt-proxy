import type { PoolConfig } from 'pg'

import type { Logger } from '../lib/types.js'
import type { SuccessfulImport } from './postgis-gtfs-importer-index.d.ts'

export function importGtfsAtomically(cfg: {
	connectDownloadScriptToStdout: boolean
	connectImportScriptToStdout: boolean
	databaseNamePrefix: string
	determineDbsToRetain: (
		latestSuccessfulImports: SuccessfulImport[],
		allDbs: string[],
	) => string[]
	downloadScriptVerbose: boolean
	gtfsDownloadUrl: string
	gtfsDownloadUserAgent: string
	gtfsPostprocessingDPath: string
	gtfstidyBeforeImport: boolean
	importScriptVerbose: boolean
	logger: Logger
	pgOpts: PoolConfig
}): Promise<{
	downloadDurationMs: number
	importDurationMs: number
	importSkipped: boolean
}>
