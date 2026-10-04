.DEFAULT_GOAL := help
# These workflows share generated assets; keep them ordered even with make -j.
.NOTPARALLEL:
.PHONY: help setup dependencies tools-install hooks-install dev build-dev build build-embedded check check-ci format-check format lint lint-go test-go test-postgres test-parity test-browser measure-compression security-go precommit server central docker-build test-docker

DOCKER ?= docker
CENTRAL_IMAGE ?= baboreborn/central:local
SERVER_IMAGE ?= baboreborn/server:local
RELEASE_LDFLAGS = -X baboreborn/backend/release.Version=$(or $(shell go run ./backend/cmd/release-version),$(error Cannot read stable version from package.json))

help:
	@printf '%s\n' 'make setup         Install dependencies, tools and Git hooks' 'make dev           Start the complete local identity/server stack' 'make build         Build server and central with the release frontend' 'make check         Run all quality checks, including Go vulnerabilities' 'make format        Format JavaScript/TypeScript and Go' 'make precommit     Validate staged changes' 'make dependencies  Install dependencies and tools without Git hooks'
	@printf '%s\n' 'make docker-build  Build central and community server container images' 'make test-docker   Verify containers, browser play and persistence (Docker + Chromium)'
	@printf '%s\n' 'make check-ci      Run quality checks without browser tests' 'make test-release  Verify release validation against temporary Git repositories'

docker-build:
	$(DOCKER) build -f deploy/docker/Dockerfile --target server -t $(SERVER_IMAGE) .
	$(DOCKER) build -f deploy/docker/Dockerfile --target central -t $(CENTRAL_IMAGE) .

test-docker: docker-build
	CENTRAL_IMAGE=$(CENTRAL_IMAGE) SERVER_IMAGE=$(SERVER_IMAGE) node deploy/docker/smoke.mjs

setup: dependencies hooks-install

dependencies:
	npm ci
	$(MAKE) tools-install

tools-install:
	npm ci --prefix scripts/checks
	node scripts/checks/go-tools.mjs install

hooks-install:
	node scripts/hooks/install.mjs

dev: build-dev
	sh scripts/dev/dev-stack.sh

build-dev: build-embedded
	mkdir -p output/identity-dev
	go build -ldflags "$(RELEASE_LDFLAGS)" -o output/identity-dev/server ./backend/cmd/server
	go build -ldflags "$(RELEASE_LDFLAGS)" -o output/identity-dev/central ./backend/cmd/central
	go build -ldflags "$(RELEASE_LDFLAGS)" -o output/identity-dev/devcentral ./backend/cmd/devcentral

build: build-embedded
	go build -ldflags "$(RELEASE_LDFLAGS)" -trimpath -o output/server ./backend/cmd/server
	go build -ldflags "$(RELEASE_LDFLAGS)" -trimpath -o output/central ./backend/cmd/central

build-embedded:
	npm run build:release
	node scripts/build/embed-assets.mjs
	node scripts/build/check-release.mjs backend/web/dist

# Non-browser checks; GitHub Actions runs make check to include browser play.
# Go embeds the frontend, so prepare it before any Go validation runs.
check-ci: build format-check
	npm run typecheck
	$(MAKE) lint
	npm test
	$(MAKE) test-release
	$(MAKE) test-go test-postgres test-parity security-go

check: check-ci test-browser

.PHONY: test-release
test-release:
	node --test tests/release/*.test.mjs

format-check:
	npm run format:check
	node scripts/checks/go-tools.mjs format-check
	XDG_CACHE_HOME="$(CURDIR)/output/tools/cache" node_modules/.bin/buf format protocol --diff --exit-code

format:
	npm run format
	node scripts/checks/go-tools.mjs format
	XDG_CACHE_HOME="$(CURDIR)/output/tools/cache" node_modules/.bin/buf format protocol --write

lint:
	npm run lint:ts
	$(MAKE) lint-go

lint-go:
	node scripts/checks/go-tools.mjs lint

test-go:
	go test -race ./...

test-postgres:
	sh scripts/dev/test-postgres.sh

test-browser: build-dev
	npm run test:browser

measure-compression: build-embedded
	go test ./backend/server/transport -run '^$$' -bench 'BenchmarkSnapshot(WebSocket|Deflate)' -benchtime=300x -count=3

test-parity:
	npm run test:parity:movement
	npm run test:parity:prediction

security-go:
	node scripts/checks/go-tools.mjs vuln

precommit:
	node scripts/hooks/pre-commit.mjs

server: build-embedded
	go run -ldflags "$(RELEASE_LDFLAGS)" ./backend/cmd/server

central: build-embedded
	go run -ldflags "$(RELEASE_LDFLAGS)" ./backend/cmd/central

.PHONY: measure-replication
measure-replication: build-embedded
	node benchmarks/measure-replication.mjs $(MEASURE_ARGS)

.PHONY: generate-protocol
generate-protocol:
	node scripts/protobuf/generate.mjs

# Corpus capture refuses to overwrite an existing baseline.
PRECISION_DIR ?= $(CURDIR)/output/benchmarks/precision
.PHONY: capture-snapshot-precision
capture-snapshot-precision: build-embedded
	PRECISION_CORPUS="$(PRECISION_DIR)/corpus" go test ./backend/server/transport -run '^TestSnapshotPrecisionCorpus$$' -count=1 -v
