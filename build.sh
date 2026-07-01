#!/bin/bash

set -euo pipefail
cd "$(dirname "$(realpath "$0")")"
set -x

mkdir -p lib

cp google-transit/gtfs-realtime/proto/gtfs-realtime.proto lib/gtfs-realtime.proto

# todo: find a canonical source for this?
cp python-nyct-gtfs/doc/nyct-subway.proto lib/mta-gtfs-realtime.proto

# https://github.com/protobufjs/protobuf.js/issues/1862#issuecomment-1660014799
# Below, we combine this with an a patched `import` statement.
dependency_workaround='--dependency protobufjs/minimal.js'
pbjs \
	--t static-module $dependency_workaround -w es6 --es6 \
	--keep-case --force-number \
	-o lib/mta-gtfs-realtime.pb.js \
	lib/mta-gtfs-realtime.proto

# fix the broken import statement
node -e 'const fs = require("node:fs"); const p = "lib/mta-gtfs-realtime.pb.js"; fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/import \* as \$protobuf from (.+)/, "import * as _$protobuf from $1\nconst $protobuf = _$protobuf.default;"))'

pbts \
	-o lib/mta-gtfs-realtime.pb.d.ts \
	lib/mta-gtfs-realtime.pb.js

# `pbjs` emits an ESM default export after our import patch above, but `pbts`
# only declares the named exports. Add the matching default root export.
node -e 'const fs = require("node:fs"); const p = "lib/mta-gtfs-realtime.pb.d.ts"; fs.appendFileSync(p, "\ndeclare const _default: {\n    TripReplacementPeriod: typeof TripReplacementPeriod;\n    NyctFeedHeader: typeof NyctFeedHeader;\n    NyctTripDescriptor: typeof NyctTripDescriptor;\n    NyctStopTimeUpdate: typeof NyctStopTimeUpdate;\n    transit_realtime: typeof transit_realtime;\n};\nexport default _default;\n")'

# make sure the generated file is at least runnable
node lib/mta-gtfs-realtime.pb.js

curl -fsSL \
	'https://gist.github.com/derhuerst/745cf09fe5f3ea2569948dd215bbfe1a/raw/9d145086ba239f05b20b6b984fa49563bd781194/mirror.mjs' \
	-H 'User-Agent: mobility-solutions-inc/mta-subway-gtfs-rt-proxy build script' \
	-o curl-mirror.mjs
chmod +x curl-mirror.mjs
