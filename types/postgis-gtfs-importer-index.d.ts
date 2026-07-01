import type { PoolConfig } from 'pg'

export interface SuccessfulImport {
	dbName: string
	feedDigest: string
	importedAt: number
}

export function queryImports(cfg: {
	databaseNamePrefix: string
	pgOpts: PoolConfig
}): Promise<{
	allDbs: string[]
	latestSuccessfulImports: SuccessfulImport[]
}>
