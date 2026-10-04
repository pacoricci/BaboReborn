#!/bin/sh
# Own an isolated, temporary PostgreSQL cluster; never select a global context.
set -eu
if [ -n "${POSTGRES_BIN:-}" ]; then
  PATH="$POSTGRES_BIN:$PATH"
elif [ -d /opt/homebrew/opt/postgresql@18/bin ]; then
  PATH="/opt/homebrew/opt/postgresql@18/bin:$PATH"
fi
export PATH
command -v initdb >/dev/null
command -v pg_dump >/dev/null
test_directory=$(mktemp -d "${TMPDIR:-/tmp}/baboreborn-postgres.XXXXXX")
cleanup() {
  pg_ctl -D "$test_directory/pg" -m immediate -w stop >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM
# Unix socket only, in a private directory, avoids public listeners and port races.
initdb -D "$test_directory/pg" --auth=trust --encoding=UTF8 --no-locale >"$test_directory/init.log"
# On macOS the postmaster exits during startup without a valid LC_ALL.
LC_ALL=C pg_ctl -D "$test_directory/pg" -l "$test_directory/postgres.log" -o "-h '' -k '$test_directory'" -w start >/dev/null
createdb -h "$test_directory" baboreborn_identity_test
export BABOREBORN_TEST_POSTGRES="postgresql:///baboreborn_identity_test?host=$test_directory&sslmode=disable"
go test -race ./backend/central/storage -run TestPostgres -count=1
go test -race ./backend/central -count=1
mkdir "$test_directory/bin"
go build -o "$test_directory/bin/" ./backend/cmd/central ./backend/cmd/server
export CENTRAL_DATABASE_URL="$BABOREBORN_TEST_POSTGRES"
"$test_directory/bin/central" -data-dir "$test_directory/central" -storage initialize
"$test_directory/bin/central" -data-dir "$test_directory/central" -storage backup -backup-file "$test_directory/executable.dump"
"$test_directory/bin/central" -data-dir "$test_directory/central" -storage restore -backup-file "$test_directory/executable.dump"
"$test_directory/bin/central" -data-dir "$test_directory/central" -storage initialize
for instance in a b; do
  "$test_directory/bin/server" -data-dir "$test_directory/server-$instance" -storage initialize
  "$test_directory/bin/server" -data-dir "$test_directory/server-$instance" -storage backup -backup-file "$test_directory/server-$instance.sqlite"
  "$test_directory/bin/server" -data-dir "$test_directory/server-$instance" -storage restore -backup-file "$test_directory/server-$instance.sqlite"
  "$test_directory/bin/server" -data-dir "$test_directory/server-$instance" -storage initialize
done
printf 'PostgreSQL verification logs: %s\n' "$test_directory"
