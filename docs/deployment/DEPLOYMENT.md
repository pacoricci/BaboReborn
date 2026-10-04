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

Run remaining Compose commands from `deploy/docker/` with these helpers:

```sh
dc() { docker compose --env-file .env -f compose.yaml "$@"; }
ds() { docker compose --env-file .env -f compose.server.yaml "$@"; }
```

`dc` manages PostgreSQL and central. Use `ds` for a standalone community host with
its own `.env` and `secrets/server/`, or `dc --profile community` to include a server
on central's host. Keep the same management method for maintenance.

## Central secrets and first startup

Prepare these files; bind mounts reject missing configuration directories:

| Host path, relative to `deploy/docker/` | Contents                                                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `secrets/postgres-password`             | PostgreSQL password.                                                                                                       |
| `secrets/central/database-url`          | `postgresql://baboreborn:ENCODED_PASSWORD@postgres:5432/baboreborn?sslmode=disable`, using the same password, URL-encoded. |
| `secrets/central/google-client-id`      | Google OAuth client ID.                                                                                                    |
| `secrets/central/google-client-secret`  | Google OAuth client secret.                                                                                                |
| `secrets/central/fullchain.pem`         | Certificate chain for central's public hostname.                                                                           |
| `secrets/central/privkey.pem`           | Matching TLS private key.                                                                                                  |

Register `CENTRAL_ORIGIN/auth/callback` as the OAuth redirect URL. Supply both
Google credentials or neither. For guest-only play with this Compose setup, leave
both credential files empty; account-based ownership management is unavailable.

Containers use UID/GID **10001:10001**. Grant that identity directory traversal
and read access to mounted configuration and private keys without exposing secrets.
Named volumes mount at `/data`. Central includes PostgreSQL 17 clients to match
the Compose database.

```sh
dc config --quiet
dc up -d postgres
dc run --rm --no-deps central -data-dir /data -storage keygen
dc up -d central
dc ps
dc logs --tail=100 central
```

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
`POSTGRES_PASSWORD_FILE`.

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

Stop the owning application before maintenance; keep PostgreSQL running for
central's dump/restore commands. Both services acquire exclusive leases, and
central locks its database. Backups reject existing destinations.

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

`make test-docker` from the repository root tests containers, browser play, and
persistence. Verify public domains, identity configuration, certificates, and
network access on the deployed installation.
