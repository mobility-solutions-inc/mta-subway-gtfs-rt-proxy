import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'

import { parseEncodedFeed } from '../lib/match.js'

const pathToFeed =
	process.env.FEED ??
	fileURLToPath(
		new URL(
			'./mta-nyct-2024-02-28T18:15:26+01:00.gtfs-rt.pbf',
			import.meta.url,
		),
	)
console.debug('reading', pathToFeed)

const feedEncoded = readFileSync(pathToFeed)
console.trace('encoded', feedEncoded)

const feedMessage = parseEncodedFeed(feedEncoded)
console.log(inspect(feedMessage, { depth: null, colors: true }))
