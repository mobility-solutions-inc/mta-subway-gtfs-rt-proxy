# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
FROM node:24-alpine@sha256:6a1c190e17215d844926b0677f4bf87273ff7d5e54db06d3b5b5863ab0b09a3d AS builder

WORKDIR /app

# eMudhra's emSign intermediate CA keys were compromised in October 2026, see
# https://bugzilla.mozilla.org/show_bug.cgi?id=2083449.
# - Alpine's ca-certificates-bundle >= 20261020-r0 no longer trusts the affected emSign roots.
# - Node.js >= 24.22.1 no longer trusts emSign ECC Root CA - G3 in its bundled root store.

# install build dependencies
RUN apk add --update --no-cache \
	bash \
	'ca-certificates-bundle>=20261020-r0' \
	curl \
	git
RUN corepack enable
ADD package.json pnpm-lock.yaml pnpm-workspace.yaml /app/
RUN pnpm install --frozen-lockfile
# This expects the repo's submodules to be checked out already.
ADD --link . /app
RUN pnpm run build

# ---

FROM node:24-alpine@sha256:6a1c190e17215d844926b0677f4bf87273ff7d5e54db06d3b5b5863ab0b09a3d
LABEL org.opencontainers.image.title="mta-subway-gtfs-rt-proxy"
LABEL org.opencontainers.image.description="An HTTP service consolidating & normalizing the MTA (NYCT) Subway GTFS-Realtime feeds."
LABEL org.opencontainers.image.authors="Ontra Mobility"
LABEL org.opencontainers.image.documentation="https://github.com/mobility-solutions-inc/mta-subway-gtfs-rt-proxy"
# todo: does docker buildx add this automatically?
LABEL org.opencontainers.image.source="https://github.com/mobility-solutions-inc/mta-subway-gtfs-rt-proxy.git"
LABEL org.opencontainers.image.revision="main"
LABEL org.opencontainers.image.licenses="ISC"

WORKDIR /app
RUN corepack enable

# install tools
# - ca-certificates-bundle >= 20261020-r0 distrusts the compromised emSign roots, see the builder stage above.
# - bash, ncurses (tput), moreutils (sponge), PostgreSQL 18's psql, unzip & zstd are required by postgis-gtfs-importer.
# - curl is required by curl-mirror, which is required by postgis-gtfs-importer.
RUN apk add --update --no-cache \
	bash \
	'ca-certificates-bundle>=20261020-r0' \
	curl \
	ncurses \
	moreutils \
	postgresql18-client \
	unzip \
	zstd
RUN curl -fsSL \
	'https://truststore.pki.rds.amazonaws.com/us-east-2/us-east-2-bundle.pem' \
	-o /etc/ssl/certs/aws-rds-us-east-2-bundle.pem \
	&& echo 'd46e1bdfda05c8e7644e50930806a19b139a222542bf0348082fb59ece2b5fa5  /etc/ssl/certs/aws-rds-us-east-2-bundle.pem' \
		| sha256sum -c -
COPY --from=builder /app/curl-mirror.mjs ./
RUN ln -s $PWD/curl-mirror.mjs /usr/local/bin/curl-mirror && curl-mirror --help >/dev/null

ADD --link postgis-gtfs-importer ./postgis-gtfs-importer

# install JS dependencies
RUN cd postgis-gtfs-importer && pnpm install --prod --ignore-workspace --no-lockfile
ENV PATH="/app/postgis-gtfs-importer/node_modules/.bin:${PATH}"
RUN gtfs-to-sql --version
ADD package.json pnpm-lock.yaml pnpm-workspace.yaml /app
RUN pnpm install --prod --frozen-lockfile && pnpm store prune

# add source code
# todo: exclude google-transit & python-nyct-gtfs, using `syntax=docker/dockerfile:1.7-labs` & --exclude
# --exclude google-transit --exclude python-nyct-gtfs
ADD --link . /app
COPY --from=builder /app/dist ./dist

RUN adduser -u 1001 -G root -D app
USER 1001

EXPOSE 3000

ENV PORT=3000
ENV PGSSLROOTCERT=/etc/ssl/certs/aws-rds-us-east-2-bundle.pem

CMD ["node", "dist/start.js"]
