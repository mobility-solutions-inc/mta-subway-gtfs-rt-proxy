# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS builder

WORKDIR /app

# install build dependencies
RUN apk add --update --no-cache \
	bash \
	curl \
	git
RUN corepack enable
ADD package.json pnpm-lock.yaml pnpm-workspace.yaml /app/
RUN pnpm install --frozen-lockfile
# This expects the repo's submodules to be checked out already.
ADD --link . /app
RUN pnpm run build

# ---

FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd
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
# - bash, ncurses (tput), moreutils (sponge), postgresql-client (psql), unzip & zstd are required by postgis-gtfs-importer.
# - curl is required by curl-mirror, which is required by postgis-gtfs-importer.
RUN apk add --update --no-cache \
	bash \
	curl \
	ncurses \
	moreutils \
	postgresql-client \
	unzip \
	zstd
COPY --from=builder /app/curl-mirror.mjs ./
RUN ln -s $PWD/curl-mirror.mjs /usr/local/bin/curl-mirror && curl-mirror --help >/dev/null

ADD --link postgis-gtfs-importer ./postgis-gtfs-importer

# install JS dependencies
RUN cd postgis-gtfs-importer && pnpm install --prod --ignore-workspace --no-lockfile
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

CMD ["node", "dist/start.js"]
