#!/bin/sh
# The launcher owns processes; this wrapper owns disposable data and retained diagnostics.
set -eu
suite_directory=$(mktemp -d /tmp/baboreborn-browser.XXXXXX)
stack_pid=''
cleanup() {
  if [ -n "$stack_pid" ]; then
    kill -TERM "$stack_pid" 2>/dev/null || true
    wait "$stack_pid" 2>/dev/null || true
  fi
  mkdir -p output/playwright/stack
  for log in "$suite_directory"/*.log; do
    [ ! -f "$log" ] || cp "$log" output/playwright/stack/
  done
  rm -rf "$suite_directory"
}
trap cleanup EXIT
trap 'exit 0' HUP INT TERM
export BABOREBORN_DEV_DIRECTORY="$suite_directory"
export BABOREBORN_DEV_SERVER_HOST=127.0.0.1
export BABOREBORN_DEV_PORT_OFFSET=${BABOREBORN_BROWSER_PORT_OFFSET:-10000}
# Exercise the CDN boundary with a second origin backed by the same public content handler.
export BABOREBORN_DEV_CONTENT_ORIGIN="http://localhost:$((18090 + BABOREBORN_DEV_PORT_OFFSET))"
sh scripts/dev/dev-stack.sh &
stack_pid=$!
wait "$stack_pid"
