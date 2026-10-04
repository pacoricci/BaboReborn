#!/bin/sh
set -eu
umask 077

# The binaries keep their existing environment contract; Docker can mount secrets.
for name in CENTRAL_DATABASE_URL GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET; do
  file=$(printenv "${name}_FILE" || true)
  if [ -n "$file" ]; then
    if [ -n "$(printenv "$name" || true)" ]; then
      echo "Set either $name or ${name}_FILE, not both" >&2
      exit 1
    fi
    value=$(cat "$file")
    export "$name=$value"
    unset value
  fi
done

exec central "$@"
