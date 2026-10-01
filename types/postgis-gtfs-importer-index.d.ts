import type { Pool, PoolClient, PoolConfig } from 'pg'

export interface SuccessfulImport {
	dbName: string
	feedDigest: string
	importedAt: number
}

// With `pgOpts`, queryImports() opens a client that it never closes; pass `db` to reuse (and close) a connection of your own.
export function queryImports(
	cfg: { databaseNamePrefix: string } & (
		{ pgOpts: PoolConfig } | { db: Pool | PoolClient }
	),
): Promise<{
	allDbs: string[]
	latestSuccessfulImports: SuccessfulImport[]
}>
