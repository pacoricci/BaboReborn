#!/bin/sh
# An explicitly local test environment; production central never uses this provider.
# make dev prepares embedded assets and binaries before this script owns their lifecycle.
set -eu
server_host=${BABOREBORN_DEV_SERVER_HOST:-127.0.0.1}
case "$server_host" in 127.0.0.1|localhost) ;; *) echo "Loopback server hostname required" >&2; exit 1 ;; esac
if [ -n "${POSTGRES_BIN:-}" ]; then PATH="$POSTGRES_BIN:$PATH"; elif [ -d /opt/homebrew/opt/postgresql@18/bin ]; then PATH="/opt/homebrew/opt/postgresql@18/bin:$PATH"; fi
export PATH
port_offset=${BABOREBORN_DEV_PORT_OFFSET:-0}
case "$port_offset" in ''|*[!0-9]*) echo "Numeric port offset required" >&2; exit 1 ;; esac
if [ "$port_offset" -gt 47441 ]; then echo "Port offset must be 0..47441" >&2; exit 1; fi
central_port=$((18090 + port_offset))
server_a_port=$((18080 + port_offset))
server_b_port=$((18081 + port_offset))
central_origin="http://127.0.0.1:$central_port"
command -v initdb >/dev/null
stack_directory=${BABOREBORN_DEV_DIRECTORY:-"$(pwd)/.data/portal-dev"}
mkdir -p "$stack_directory/socket" "$stack_directory/central"
chmod 700 "$stack_directory" "$stack_directory/socket" "$stack_directory/central"
central_pid=''
server_a_pid=''
server_b_pid=''
started_pg=0
cleanup() {
  for child in "$server_a_pid" "$server_b_pid" "$central_pid"; do
    if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null || true; fi
  done
  for child in "$server_a_pid" "$server_b_pid" "$central_pid"; do
    if [ -n "$child" ]; then wait "$child" 2>/dev/null || true; fi
  done
  if [ "$started_pg" = 1 ]; then pg_ctl -D "$stack_directory/pg" -m fast -w stop >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
trap 'exit 0' HUP INT TERM
if [ ! -f "$stack_directory/pg/PG_VERSION" ]; then initdb -D "$stack_directory/pg" --auth=trust --encoding=UTF8 --no-locale >"$stack_directory/init.log"; fi
# On macOS the postmaster exits during startup without a valid LC_ALL.
LC_ALL=C pg_ctl -D "$stack_directory/pg" -l "$stack_directory/postgres.log" -o "-h '' -k '$stack_directory/socket'" -w start >/dev/null
started_pg=1
if ! psql -h "$stack_directory/socket" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='baboreborn_identity_dev'" | rg -q '^1$'; then createdb -h "$stack_directory/socket" baboreborn_identity_dev; fi
CENTRAL_DATABASE_URL=$(node -e 'process.stdout.write("postgresql:///baboreborn_identity_dev?host="+encodeURIComponent(process.argv[1])+"&sslmode=disable")' "$stack_directory/socket")
export CENTRAL_DATABASE_URL
if [ ! -f "$stack_directory/central/signing.pem" ]; then output/identity-dev/central -data-dir "$stack_directory/central" -storage keygen; fi
output/identity-dev/devcentral -content-origin "${BABOREBORN_DEV_CONTENT_ORIGIN:-}" -port-offset "$port_offset" -server-host "$server_host" -data-dir "$stack_directory/central" >"$stack_directory/central.log" 2>&1 &
central_pid=$!
attempt=0
until curl -fsS "$central_origin/healthz" >/dev/null 2>&1; do
  attempt=$((attempt+1)); if [ "$attempt" -ge 30 ] || ! kill -0 "$central_pid" 2>/dev/null; then cat "$stack_directory/central.log"; exit 1; fi
  sleep 1
done
for server in a b; do
  if [ "$server" = a ]; then game_port="$server_a_port"; else game_port="$server_b_port"; fi
  set -- -data-dir "$stack_directory/server-$server" -development -diagnostics -central "$central_origin" -addr "127.0.0.1:$game_port"
  if [ -f "$stack_directory/central/server-$server.pairing" ]; then set -- "$@" -pairing-code-file "$stack_directory/central/server-$server.pairing"; fi
  output/identity-dev/server "$@" >"$stack_directory/server-$server.log" 2>&1 &
  if [ "$server" = a ]; then server_a_pid=$!; else server_b_pid=$!; fi
done
printf 'Local fixture: central %s; servers http://%s:%s and http://%s:%s\nOpen the portal and choose Owner in the explicit OIDC test page. Both servers belong to that account. Ctrl+C stops this stack. Data persists in %s.\n' "$central_origin" "$server_host" "$server_a_port" "$server_host" "$server_b_port" "$stack_directory"
while kill -0 "$central_pid" 2>/dev/null && kill -0 "$server_a_pid" 2>/dev/null && kill -0 "$server_b_pid" 2>/dev/null; do sleep 1; done
exit 1
