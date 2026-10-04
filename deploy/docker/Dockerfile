# syntax=docker/dockerfile:1
FROM node:24-trixie-slim AS frontend
WORKDIR /src
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY tsconfig.json ./
COPY frontend ./frontend
COPY content/maps ./content/maps
COPY scripts/build/*.mjs ./scripts/build/
RUN npm run build:release && node scripts/build/embed-assets.mjs

FROM golang:1.27-trixie AS go-build
ARG RELEASE_VERSION=dev
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY backend ./backend

# This branch has no dependency on the frontend build or bundled content.
FROM go-build AS server-build
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -ldflags "-X baboreborn/backend/release.Version=$RELEASE_VERSION" -trimpath -o /out/server ./backend/cmd/server

FROM go-build AS central-build
COPY content ./content
COPY --from=frontend /src/backend/web/dist ./backend/web/dist
COPY --from=frontend /src/backend/web/portal ./backend/web/portal
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -ldflags "-X baboreborn/backend/release.Version=$RELEASE_VERSION" -trimpath -o /out/central ./backend/cmd/central

FROM debian:trixie-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 baboreborn \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /data baboreborn \
    && install -d -o 10001 -g 10001 -m 0700 /data
WORKDIR /data
EXPOSE 8443

FROM runtime AS server
COPY --from=server-build /out/server /usr/local/bin/server
USER 10001:10001
ENTRYPOINT ["server"]
CMD ["-data-dir", "/data", "-addr", ":8443"]

FROM runtime AS central
# Match the Compose database major, including offline backup/restore operations.
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client-17 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=central-build /out/central /usr/local/bin/central
COPY --chmod=755 deploy/docker/central-entrypoint.sh /usr/local/bin/central-entrypoint
USER 10001:10001
ENTRYPOINT ["central-entrypoint"]
CMD ["-data-dir", "/data", "-addr", ":8443"]
