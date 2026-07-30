#!/usr/bin/env node
import { readFile } from 'node:fs/promises'

const databaseSecretFile = process.env.DATABASE_SECRET_FILE
if (databaseSecretFile) {
	const secret = JSON.parse(await readFile(databaseSecretFile, 'utf8')) as {
		dbname: string
		host: string
		password: string
		port: number
		username: string
	}
	process.env.PGDATABASE ??= secret.dbname
	process.env.PGHOST ??= secret.host
	process.env.PGPASSWORD ??= secret.password
	process.env.PGPORT ??= String(secret.port)
	process.env.PGUSER ??= secret.username
}

const { createService } = await import('./index.js')
await createService()
