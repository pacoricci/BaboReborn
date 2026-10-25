# Deployment

Deploy one **central portal** and one or more **community servers**. See
[architecture](../architecture/README.md) for ownership and
[development](../development/DEVELOPMENT.md) for the local fixture.

The checked-in Compose setup requires public DNS, certificates, and Google OAuth
configuration from the operator.

## Prepare images and configuration

From the repository root, skipping the build for published images:

```sh
make docker-build
cd deploy/docker
cp .env.example .env
mkdir -p secrets/central secrets/server backups
```

The build produces `baboreborn/central:local` and `baboreborn/server:local`, the
`.env` defaults. Stable releases publish Docker Hub images named
`<namespace>/baboreborn-central:X.Y.Z` and `<namespace>/baboreborn-server:X.Y.Z`.
Set `CENTRAL_IMAGE` and `SERVER_IMAGE` to matching releases. Prefer the
`namespace/image@sha256:...` references in each
[GitHub Release](https://github.com/pacoricci/BaboReborn/releases)'s `images.txt`,
which also records the source commit.

Set `.env` domains and ports. The defaults are `https://portal.example.org` and
`https://game.example.org:8443`; registered origins must match the public scheme,
hostname, and port. `CENTRAL_BIND` and `SERVER_BIND` select host interfaces,
defaulting to `0.0.0.0`. Configure DNS and inbound access for both endpoints.

## Choose the database

Central reads its connection URL from `secrets/central/database-url`. Choose one
of the following helpers from `deploy/docker/` and use it for **all** startup,
update, backup, restore, and shutdown commands for that installation.

For **local PostgreSQL**, add the optional database file:

```sh
dc() { docker compose --env-file .env -f compose.yaml -f compose.postgres.yaml "$@"; }
```

This starts PostgreSQL 17 with a persistent volume and makes central wait for its
healthcheck. Create `secrets/postgres-password` and set the URL to:

```text
postgresql://baboreborn:ENCODED_PASSWORD@postgres:5432/baboreborn?sslmode=disable
```

Use the same password, URL-encoded. PostgreSQL is reachable only on the Compose
network; its port is not published to the host.

For **external PostgreSQL**, including a managed service, use only the base file:

```sh
dc() { docker compose --env-file .env -f compose.yaml "$@"; }
```

This creates no PostgreSQL container, database volume, or local database password
secret. Put the provider's connection URL in `secrets/central/database-url`, for
example:

```text
postgresql://baboreborn:ENCODED_PASSWORD@db.example.org:5432/baboreborn?sslmode=verify-full&sslrootcert=/run/config/postgres-ca.pem&connect_timeout=10
```

Place the provider's CA certificate in `secrets/central/postgres-ca.pem` so both
central and its backup/restore tools can verify the database certificate.
Certificate paths in the URL refer to paths **inside** the container. Client
certificates, when required, use `sslcert` and `sslkey` in the same mounted
directory. Keep the URL, including its password, in the secret file rather than
in `.env` or command arguments.

Provision a dedicated empty database for a new installation, with a role that
can connect, create and own the application's tables in `public`, and read/write
them. Backup/restore also needs access to those objects and permission to
recreate them. Allow connections from the deployment host in the provider's
network rules. Use a direct database endpoint or session pooling: central holds
a session advisory lock, so transaction/statement pooling is unsupported.

PostgreSQL 17 is the tested database version. The image includes PostgreSQL 17
backup clients; `pg_dump` cannot back up a newer major server version. Check the
provider's version and URL options before deployment, and rehearse backup and
restore. Supported URL query options are `host`, `port`, `sslmode`, `sslrootcert`,
`sslcert`, `sslkey`, and `connect_timeout`; other options are rejected.

An existing installation using the old all-in-one `compose.yaml` must now include
`compose.postgres.yaml` to retain local PostgreSQL management. Keep the same
`COMPOSE_PROJECT_NAME`, configuration, and volumes: their names are unchanged.
Changing the URL alone does **not** migrate a database. To move existing data,
stop central, back up the source, restore to the destination using the maintenance
procedure below, and preserve central's signing keys. Retain the source database
until the destination is verified; never use `down -v` for this transition.

For a standalone community host, use:

```sh
ds() { docker compose --env-file .env -f compose.server.yaml "$@"; }
```

Use `ds` with its own `.env` and `secrets/server/`, or `dc --profile community` to
include a server on central's host with either database mode.

## Central secrets and first startup

Prepare these files; bind mounts reject missing configuration directories:

| Host path, relative to `deploy/docker/` | Contents                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| `secrets/postgres-password`             | Local PostgreSQL password; not needed for an external database.                 |
| `secrets/central/database-url`          | Connection URL for the selected local or external database, as described above. |
| `secrets/central/postgres-ca.pem`       | External database CA certificate, only when referenced by `sslrootcert`.        |
| `secrets/central/google-client-id`      | Google OAuth client ID.                                                         |
| `secrets/central/google-client-secret`  | Google OAuth client secret.                                                     |
| `secrets/central/fullchain.pem`         | Certificate chain for central's public hostname.                                |
| `secrets/central/privkey.pem`           | Matching TLS private key.                                                       |

Register `CENTRAL_ORIGIN/auth/callback` as the OAuth redirect URL. Supply both
Google credentials or neither. For guest-only play with this Compose setup, leave
both credential files empty; account-based ownership management is unavailable.

Containers use UID/GID **10001:10001**. Grant that identity directory traversal
and read access to mounted configuration and private keys without exposing secrets.
Named application volumes mount at `/data`. With the selected `dc` helper:

```sh
dc config --quiet
dc run --rm --no-deps central -data-dir /data -storage keygen
dc up -d --wait --wait-timeout 120 central
dc ps
dc logs --tail=100 central
```

Local PostgreSQL starts automatically as a dependency of central. For an external
database, provision it before starting central; Compose does not manage its
lifecycle. Central fails startup if it cannot connect or initialize/validate the
schema. The HTTP healthcheck is a liveness check, not a continuous database check.

First startup requires an empty PostgreSQL database and fresh central/community
data volumes. Startup initializes the
[PostgreSQL](../../backend/central/storage/migrations/postgres/001_initial.sql) and
[SQLite](../../backend/server/storage/migrations/sqlite/001_initial.sql) baselines
or validates existing schemas; incompatible schemas are rejected. A fresh
community volume creates a new installation identity requiring central association.

Run `keygen` only for a new central volume. Preserve `/data/signing.pem` and
`/data/keys.json`; central needs these keys to serve and recover its identity.

The [entrypoint](../../deploy/docker/central-entrypoint.sh) reads `*_FILE` settings
into the binary's environment and rejects a value supplied both directly and by
file. Override Compose paths with `CENTRAL_CONFIG_DIR`, `SERVER_CONFIG_DIR`, and
`POSTGRES_PASSWORD_FILE` (local PostgreSQL only).

Central, community, and browser must share the registry, API, gameplay, content,
and tuning contracts in the [compatibility descriptor](../../backend/compatibility/current.go).

## Community release advice

Manage servers shows the installed release, the recommended release (the running
central's version), and its release notes. Signed probes carry optional release
metadata alongside the compatibility descriptor:

- Older stable release with matching contracts: update available; still playable.
- Older stable release with different contracts: update required; excluded from
  the public catalog.
- Newer, same-version, custom or unknown release with different contracts:
  incompatible version; inspect the expected/received contract details.
- Unknown/custom release with matching contracts: compatible; its version alone
  does not trigger an update requirement.
- Missing, failed or expired verification: unknown; never infer incompatibility
  from a network failure.

Catalog admission requires valid presence, association, and room publication.
Release observations are held in central memory and expire after the registry
presence window (90 seconds). A central restart clears them; heartbeats rebuild
them. An expired observation
may retain its last reported version and `checkedAt`, but exposes no current
contract verdict. The management API returns this information in `release`,
including `status`, `installed`, `recommended`, `checkedAt`, `differences` and
`notesUrl`. Release metadata is diagnostic; admission depends on the verified
contracts.

## Associate a community server

1. Prepare `secrets/server/fullchain.pem` and `secrets/server/privkey.pem` for the
   community hostname. Set `CENTRAL_ORIGIN` to the portal.
2. Log in as the intended owner and register the server's name, region, and exact
   public origin, including non-default ports.
3. Save the single-use pairing code as `secrets/server/pairing-code`. Set
   `PAIRING_CODE_FILE=/run/config/pairing-code` in `.env`; this path is **inside**
   the container.
4. Start the standalone service:

   ```sh
   ds config --quiet
   ds up -d server
   ds logs --tail=100 server
   ```

5. Wait for association, public endpoint verification, and compatible publication
   in the portal, then configure rooms through management.
6. Clear `PAIRING_CODE_FILE`, recreate with `ds up -d server`, and remove the
   consumed host file. Association persists in SQLite.

For invalid/expired codes or installation recovery, generate a new code, replace
the file, and restart with its path configured. An associated data directory cannot
be redirected to another central.

The server fetches its catalog and selected maps from central at startup and room
preparation; the community image has no independent map/client bundle.

## Health and public verification

Check your public endpoints with certificate verification:

```sh
curl --fail --show-error https://portal.example.org/healthz
curl --fail --show-error https://game.example.org:8443/health
```

Compose checks bypass certificate verification on loopback for local liveness.
Verify registration, room listing, login/guest entry, and a browser match from
outside the host network to check public reachability and WSS admission.

TLS terminates in each Go process and is required outside loopback development.
Proxies must preserve HTTPS/WSS, WebSocket upgrades, and canonical origins. Renew
certificates externally and restart affected services to load them.

`/metrics` is public and exposes aggregate room counters. `/diagnostics` requires
`-diagnostics` and accepts only loopback requests without an `Origin` inside the
container namespace. Keep it disabled behind same-host proxies, whose forwarded
requests arrive from loopback.

## Backup and restore

Stop the owning application before maintenance; keep the selected local or
external PostgreSQL database available for central's dump/restore commands.
Use the same `dc` helper and database URL as the running installation. Both
services acquire exclusive leases, and central locks its database. Backups reject
existing destinations.

These commands use `dc` for central and `ds` for a standalone community. Replace
`ds` with `dc --profile community` for a community managed by the main Compose
file. Use new backup filenames each time.

```sh
dc stop central
dc run --rm --no-deps central -data-dir /data -storage backup -backup-file /data/central-backup.dump
dc cp central:/data/central-backup.dump backups/central-backup.dump
dc cp central:/data/signing.pem backups/signing.pem
dc cp central:/data/keys.json backups/keys.json
dc up -d central

ds stop server
ds run --rm --no-deps server -data-dir /data -storage backup -backup-file /data/server-backup.sqlite
ds cp server:/data/server-backup.sqlite backups/server-backup.sqlite
ds up -d server
```

`cp` uses the stopped service containers and their shared volumes. Keep private,
off-host copies of backups, central keys, and configuration secrets; record the
producing release. Central dumps exclude signing keys. Community backups include
association, roles, sanctions, and room configuration, but not live combat.

To restore, stop the service, copy the backup to its container's
`/data/restore.dump` or `/data/restore.sqlite` with `dc cp` or `ds cp`, and make it
readable by UID 10001. Run the corresponding operation:

```sh
dc run --rm --no-deps central -data-dir /data -storage restore -backup-file /data/restore.dump
ds run --rm --no-deps server -data-dir /data -storage restore -backup-file /data/restore.sqlite
```

Central takes a pre-restore dump and restores transactionally. Community validates
SQLite integrity/schema before replacement and keeps a recovery copy. For a lost
central volume, restore signing/public keys from the same installation with their
ownership preserved. Restart restored services; check health, association, rooms,
and browser entry. Rehearse recovery on a separate installation before relying on
backups.

## Updates and troubleshooting

Back up state and record image digests before updating. Build or fetch matching
central/community images, update image settings, and recreate affected services.
Reload clients after contract changes. Recovery requires compatible images,
database schemas, and central keys. Preserve volumes; `down -v` deletes them.

| Symptom                             | Check                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| Central exits immediately           | Secrets, UID permissions, database readiness/URL, signing keys, and TLS pair.         |
| Google login fails                  | Client credentials and exact public `/auth/callback` redirect.                        |
| Community is healthy but not listed | Registration, pairing errors, public DNS/TLS/WSS, compatibility, and published rooms. |
| Community cannot prepare rooms      | Central availability, content revision/catalog, and map compatibility.                |
| Storage is locked                   | Stop the owner before backup/restore; do not bypass leases.                           |
| Protocol/profile mismatch           | Components must share contracts and tuning.                                           |

`make test-deploy` from the repository root validates the local, external, and
community Compose configurations without a running Docker daemon or real secrets.
It also runs in `make check` / `make check-ci` and requires the Docker Compose CLI.

`make test-docker` builds the images and runs browser play, recreation, and
backup/restore with both a local database and a database owned by a separate
Compose project. The external fixture verifies that application shutdown leaves
the database running. Both fixtures use PostgreSQL 17 on an isolated Docker
network without database TLS; they do not certify a particular managed provider.
Verify database TLS, provider permissions, public domains, identity configuration,
certificates, and network access on the deployed installation.
