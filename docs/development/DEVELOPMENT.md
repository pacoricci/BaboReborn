# Development

Run commands from the repository root. See [architecture](../architecture/README.md)
for module responsibilities and [deployment](../deployment/DEPLOYMENT.md) for hosting.

## Prerequisites

- Node.js matching [package.json](../../package.json); Docker builds use Node 24.
- Go matching [go.mod](../../go.mod).
- Make, a POSIX shell, `curl`, and `rg` (ripgrep).
- PostgreSQL tools on `PATH`: `initdb`, `pg_ctl`, `psql`, `createdb`, `pg_dump`,
  and `pg_restore`. Scripts also detect Homebrew PostgreSQL 18 at
  `/opt/homebrew/opt/postgresql@18/bin`; set `POSTGRES_BIN` for another installation.
  Run local clusters as a regular user.
- Chromium for browser tests; Docker with Compose for container tests.

## First run

```sh
make setup
npx playwright install chromium
make dev
```

`make setup` installs dependencies, quality tools, and Git hooks; use
`make dependencies` to omit hooks. Linux runners may also need Playwright's system
dependencies.

The pre-commit hook checks the staged snapshot: formatting, lint, typecheck,
`npm test` for non-documentation changes, and Go tests without the race detector
for changes to `backend/`, `content/`, or Go modules. Go tests reuse assets from the
last `make build-embedded`. Run `make precommit` to check without committing.

`make dev` builds the embedded frontend and Go binaries, then starts PostgreSQL,
a test identity provider, central, and two community servers. Open
<http://127.0.0.1:18090>, use the test login page, and select **Owner** to manage
both servers.

| Service        | Default address          |
| -------------- | ------------------------ |
| Central portal | `http://127.0.0.1:18090` |
| Community A    | `http://127.0.0.1:18080` |
| Community B    | `http://127.0.0.1:18081` |

Enter matches through the portal; community endpoints serve game APIs and
WebSockets. The test identity provider exists only in `devcentral`.
`Ctrl+C` stops the stack and preserves data.

## Edit and rebuild

After frontend or Go edits, stop and rerun `make dev` to rebuild embedded assets
and binaries. `make build-dev` rebuilds without restarting processes.

`npm run dev` starts Vite on port 5173; `npm run dev:tools` opens the workshop.
Neither starts backend services. Use `make dev` to verify login and multiplayer.

`make build` produces `output/central` and `output/server` with release assets.
Generated files live in `dist/`, `backend/web/dist/`, `backend/web/portal/`, and
`output/`.

## Local data and logs

The [launcher](../../scripts/dev/dev-stack.sh) cleans up processes and stores data
and logs in `.data/portal-dev/`. To run a separate fixture:

```sh
BABOREBORN_DEV_DIRECTORY="$PWD/.data/portal-dev-alt" BABOREBORN_DEV_PORT_OFFSET=100 make dev
```

This shifts all three HTTP ports by 100. Stop processes using a data directory
before maintenance. New fixtures initialize empty PostgreSQL and SQLite stores,
local identities, and server associations. Startup rejects incompatible schemas;
preserve the old directory and start with a fresh one.

## Verification

| Command              | Scope and prerequisites                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `make check`         | `make check-ci` plus browser tests; needs Chromium.                                                                                                                                              |
| `make check-ci`      | Build, formatting check, typecheck, lint, frontend/release tests, Go race tests, PostgreSQL integration, movement/prediction parity, Go vulnerability check. Needs quality tools and PostgreSQL. |
| `make format`        | Format source files, Markdown, Go, and protobuf.                                                                                                                                                 |
| `npm test`           | Frontend unit and architecture/contract tests.                                                                                                                                                   |
| `make test-go`       | Go race tests; run `make build-embedded` first.                                                                                                                                                  |
| `make test-postgres` | Temporary PostgreSQL cluster, storage/service tests, and backup/restore checks; run `make build-embedded` first.                                                                                 |
| `make test-parity`   | Cross-language movement and prediction conformance.                                                                                                                                              |
| `make test-browser`  | Rebuild binaries and test a disposable stack in Chromium.                                                                                                                                        |
| `make test-docker`   | Build images and test containers, browser play, and persistence. Needs Docker and Chromium.                                                                                                      |
| `make test-release`  | Release guards in temporary Git repositories. Needs Node.js and Git.                                                                                                                             |

GitHub Actions runs `make check` on pull requests and pushes to `main`. Releases
also run `make test-docker` before publishing; see [releasing](RELEASING.md).

Browser tests use disposable data under `/tmp` and port offset 10000, overridden
by `BABOREBORN_BROWSER_PORT_OFFSET`. Reports, traces, screenshots, and stack logs
remain in `output/playwright/`.

Choose checks for the affected behavior. Report automated results, browser
observations, and human playtesting separately; conformance does not establish
combat feel or public-network performance.

## Common failures

| Symptom                                    | First check                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| Startup exits before opening the portal    | PostgreSQL tools, `POSTGRES_BIN`, and `.data/portal-dev/*.log`.                    |
| Address already in use                     | Stop the owner or use a separate data directory and port offset.                   |
| UI does not reflect source edits           | Restart `make dev` to rebuild embedded assets.                                     |
| Go reports missing embedded frontend files | Run `make build-embedded`.                                                         |
| Browser executable missing                 | Run `npx playwright install chromium`.                                             |
| Database already in use                    | Stop the owner; leases and central's database lock prevent concurrent maintenance. |
| Protocol/profile mismatch                  | Rebuild matching components; see [networking](../architecture/NETWORKING.md).      |

## Contracts and generated assets

Edit [snapshot.proto](../../protocol/snapshot.proto), then run
`make generate-protocol` to update Go and TypeScript bindings. Review the generated
diff and run wire/contract tests.

Update gameplay tuning in both [Go](../../backend/gameconfig/rules.go) and
[TypeScript](../../frontend/src/gameconfig/tuning.ts), then run alignment and parity
checks. Protobuf does not generate these values.

Session close codes/reasons in [closure.go](../../backend/server/transport/closure.go)
and administration notice actions are mirrored in
[session.ts](../../frontend/src/contracts/session.ts). Update both languages, then
regenerate and check the fixture:

```sh
UPDATE_PROTOCOL_FIXTURES=1 go test ./backend/server/transport -run TestSessionContract
make format
npm test
```

`npm run assets:build` rebuilds visual-kit assets. Authoring tools live in
`devtools/assets/`; browser workshops live in `devtools/browser/`.

## Naming

Use "BaboReborn" for the product, `BaboReborn` for PascalCase, `baboReborn` for
camelCase, and `baboreborn` for lowercase technical identifiers, including storage
keys and database identity. Environment variables use `BABOREBORN_`. "Babo" names
the player character.
