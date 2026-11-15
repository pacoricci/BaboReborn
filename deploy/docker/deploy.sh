#!/usr/bin/env bash
# Deploy a published release to the Compose installation next to this script:
# fetch its image digests and Compose files, back up, switch, verify, and roll
# back to the previous release on failure.
#   ./deploy.sh vMAJOR.MINOR.PATCH  deploys that release now.
#   ./deploy.sh --follow            on a standalone community host, deploys the
#                                   release CENTRAL_ORIGIN runs once rooms are empty.
set -euo pipefail
umask 077

readonly REPOSITORY=${DEPLOY_REPOSITORY:-pacoricci/BaboReborn}
readonly COMPOSE_FILES=(compose.yaml compose.server.yaml compose.postgres.yaml)
readonly WAIT_TIMEOUT_SECONDS=120
readonly HEALTH_ATTEMPTS=10
readonly HEALTH_INTERVAL_SECONDS=3
readonly STATE=.deploy

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() {
  log "$*"
  exit 1
}

readonly STABLE_TAG='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
follow=false
tag=${1:-}
if [[ $tag == --follow ]]; then
  follow=true
elif ! [[ $tag =~ $STABLE_TAG ]]; then
  die 'Usage: deploy.sh vMAJOR.MINOR.PATCH | --follow'
fi
cd "$(dirname "$0")"

# Last assignment wins, as in Compose; surrounding quotes are stripped.
env_value() {
  local value
  value=$(sed -n "s/^$1=//p" .env | tail -n 1)
  value=${value#\"} value=${value%\"} value=${value#\'} value=${value%\'}
  printf '%s' "$value"
}

# Rewrite in place so the operator's ownership and mode survive.
set_env() {
  local tmp file=${3:-.env}
  tmp=$(mktemp "$STATE/env.XXXXXX")
  awk -v key="$1" -v value="$2" '
    index($0, key "=") == 1 { print key "=" value; found = 1; next }
    { print }
    END { if (!found) print key "=" value }
  ' "$file" >"$tmp"
  cat "$tmp" >"$file"
  rm -f "$tmp"
}

fetch() { curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 --max-time 120 -o "$2" "$1"; }

has_service() { [[ " $services " == *" $1 "* ]]; }
image_of() { if [[ $1 == central ]]; then echo "$central_image"; else echo "$server_image"; fi; }
backup_extension() { if [[ $1 == central ]]; then echo dump; else echo sqlite; fi; }
exists() { [[ -n $(docker compose ps --all --quiet "$1") ]]; }
is_running() { [[ -n $(docker compose ps --status running --quiet "$1") ]]; }
start_release() { docker compose up -d --no-build --pull never --wait --wait-timeout "$WAIT_TIMEOUT_SECONDS"; }
update_admission() {
  docker compose exec -T server curl --silent --show-error --insecure --max-time 5 \
    --request "$1" --header @/data/updater-auth --output /dev/null --write-out '%{http_code}' \
    https://127.0.0.1:8443/maintenance/drain
}
verify_public() {
  local origin attempt
  origin=$(env_value CENTRAL_ORIGIN)
  if has_service central && [[ -n $origin ]]; then
    # The public check also covers DNS, TLS and port publication.
    for ((attempt = 1; ; attempt++)); do
      curl --fail --silent --show-error --max-time 10 -o /dev/null "$origin/healthz" && return 0
      ((attempt < HEALTH_ATTEMPTS)) || die "$origin/healthz did not become healthy"
      sleep "$HEALTH_INTERVAL_SECONDS"
    done
  fi
}

[[ -f .env ]] || die "Missing .env in $PWD"
# Plain `docker compose` must select the same files for operators and this script.
[[ -n $(env_value COMPOSE_FILE) ]] || die 'Set COMPOSE_FILE in .env (see .env.example)'
case $(env_value COMPOSE_FILE) in
  compose.yaml | compose.yaml:compose.postgres.yaml | compose.server.yaml) ;;
  *) die 'COMPOSE_FILE must select the documented central or standalone community files' ;;
esac

# Follow the running central, not the newest release: only its contracts are admitted.
if $follow; then
  [[ $(env_value COMPOSE_FILE) == compose.server.yaml ]] || die '--follow updates standalone community hosts only'
  origin=$(env_value CENTRAL_ORIGIN)
  [[ -n $origin ]] || die 'Set CENTRAL_ORIGIN in .env'
  version=$(curl --fail --silent --show-error --max-time 15 "$origin/api/v1/release" |
    sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
  tag=v$version
  [[ $tag =~ $STABLE_TAG ]] || die "$origin reports no stable release"
fi

mkdir -p "$STATE"
mkdir "$STATE/lock" 2>/dev/null || die "Another deployment holds $PWD/$STATE/lock"
work=$(mktemp -d "$STATE/stage.XXXXXX")
stopped=false
switched=false
drain_attempted=false
backup_dir=

record() { printf '%s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$tag" "$1" >>"$STATE/history"; }

finish() {
  local status=$? resume_status
  set +e
  if ((status != 0)); then
    if $switched; then
      log 'Restoring the previous configuration'
      # Stop candidate writers before switching their configuration back.
      for service in central server; do
        has_service "$service" && docker compose stop "$service"
      done
      cp -p "$work/previous/.env" .env
      for file in "${COMPOSE_FILES[@]}"; do
        if [[ -f $work/previous/$file ]]; then
          cp -p "$work/previous/$file" "$file"
        else
          rm -f "$file"
        fi
      done
    fi
    if $stopped; then
      if docker compose up -d --no-build --pull never --wait --wait-timeout "$WAIT_TIMEOUT_SECONDS" "${running[@]}"; then
        log 'Previous release restored'
        record rolled-back
      else
        log "Previous release failed to start; backups are in ${backup_dir:-no directory}"
        record failed
      fi
    elif $switched; then
      # Nothing ran before this deployment, so leave nothing running after it.
      docker compose stop
      record failed
    else
      record aborted
    fi
  fi
  # Also release a drain whose acknowledgement was lost. After a stop/rollback,
  # the new serving process has already reopened admission with a fresh token.
  if $drain_attempted && is_running server; then
    if ! resume_status=$(update_admission DELETE) || [[ $resume_status != 204 ]]; then
      log 'Could not reopen admission; restart the server before accepting players'
    fi
  fi
  rm -rf "$work"
  rmdir "$STATE/lock"
  exit "$status"
}
trap finish EXIT
# A cancelled job or dropped SSH session must still roll back and release the lock.
trap 'exit 130' INT TERM HUP

$follow || log "Fetching $tag from $REPOSITORY"
fetch "https://github.com/$REPOSITORY/releases/download/$tag/images.txt" "$work/images.txt"
central_image=$(grep -E '/baboreborn-central@sha256:[0-9a-f]{64}$' "$work/images.txt" || true)
server_image=$(grep -E '/baboreborn-server@sha256:[0-9a-f]{64}$' "$work/images.txt" || true)
[[ $central_image != *$'\n'* && -n $central_image && $server_image != *$'\n'* && -n $server_image ]] ||
  die "images.txt for $tag must list one central and one server digest"
source_commit=$(sed -n 's/^Source: //p' "$work/images.txt")
[[ $source_commit =~ ^[0-9a-f]{40}$ ]] || die 'images.txt must identify one source commit'
for file in "${COMPOSE_FILES[@]}"; do
  fetch "https://raw.githubusercontent.com/$REPOSITORY/$source_commit/deploy/docker/$file" "$work/$file"
done

services=" $(docker compose config --services | tr '\n' ' ') "
unchanged=true
for file in "${COMPOSE_FILES[@]}"; do
  cmp -s "$work/$file" "$file" || unchanged=false
done
if $unchanged && [[ $(env_value CENTRAL_IMAGE) == "$central_image" && $(env_value SERVER_IMAGE) == "$server_image" ]]; then
  # Timer runs stay silent while the host is current.
  $follow && exit 0
  start_release
  verify_public
  record verified
  log "$tag is already deployed"
  exit 0
fi

# Validate the candidate with the installation's paths before stopping anything.
cp -p .env "$work/.env"
set_env CENTRAL_IMAGE "$central_image" "$work/.env"
set_env SERVER_IMAGE "$server_image" "$work/.env"
candidate=(docker compose --project-directory "$PWD" --env-file "$work/.env")
IFS=: read -r -a selected_files <<<"$(env_value COMPOSE_FILE)"
for file in "${selected_files[@]}"; do candidate+=(-f "$work/$file"); done
"${candidate[@]}" config --quiet

existing=()
running=()
for service in central server; do
  has_service "$service" || continue
  docker pull "$(image_of "$service")"
  if exists "$service"; then existing+=("$service"); fi
  if is_running "$service"; then running+=("$service"); fi
done

# The server atomically checks live connections and closes admission. Unknown
# outcomes defer to the next run; older servers require a manual bootstrap update.
if $follow; then
  if ! server_id=$(docker compose ps --status running --quiet server); then
    log "$tag waits: could not determine whether the server is running"
    exit 0
  fi
fi
if $follow && [[ -n $server_id ]]; then
  drain_attempted=true
  if ! drain_status=$(update_admission POST); then
    log "$tag waits: could not verify empty rooms"
    exit 0
  fi
  case $drain_status in
    204) ;;
    409)
      drain_attempted=false
      log "$tag waits for connected players to leave"
      exit 0
      ;;
    *)
      drain_attempted=false
      log "$tag waits: safe drain unavailable (HTTP $drain_status); update older servers manually"
      exit 0
      ;;
  esac
fi

# Keep configuration alongside every data backup, not only the latest attempt.
mkdir "$work/previous"
cp -p .env "$work/previous/.env"
for file in "${COMPOSE_FILES[@]}"; do
  [[ ! -f $file ]] || cp -p "$file" "$work/previous/$file"
done

# Back up with the current release while it is stopped, as the storage leases require.
if ((${#existing[@]})); then
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  backup_dir=backups/$stamp-before-$tag
  mkdir -p backups
  mkdir "$backup_dir"
  cp -p "$work/previous/"* "$work/previous/.env" "$backup_dir/"
  if ((${#running[@]})); then
    stopped=true
    docker compose stop "${running[@]}"
  fi
  for service in "${existing[@]}"; do
    extension=$(backup_extension "$service")
    dump=/data/deploy-backup-$stamp.$extension
    log "Backing up $service to $backup_dir"
    docker compose run --rm --no-deps "$service" -data-dir /data -storage backup -backup-file "$dump"
    docker compose cp "$service:$dump" "$backup_dir/$service.$extension"
    docker compose run --rm --no-deps --entrypoint rm "$service" -f "$dump"
    if [[ $service == central ]]; then
      # Central dumps exclude its signing keys; keep a complete recovery set.
      docker compose cp central:/data/signing.pem "$backup_dir/signing.pem"
      docker compose cp central:/data/keys.json "$backup_dir/keys.json"
    fi
  done
fi

switched=true
for file in "${COMPOSE_FILES[@]}"; do
  mv "$work/$file" "$file"
done
set_env CENTRAL_IMAGE "$central_image"
set_env SERVER_IMAGE "$server_image"

log "Starting $tag"
start_release
verify_public

# Keep the timer's updater at the deployed release; its failure is not the release's.
if $follow; then
  if fetch "https://raw.githubusercontent.com/$REPOSITORY/$source_commit/deploy/docker/deploy.sh" "$work/deploy.sh" &&
    chmod 700 "$work/deploy.sh" && mv "$work/deploy.sh" "$(basename "$0")"; then
    log "Updated deploy.sh to $tag"
  else
    log 'Kept the current deploy.sh'
  fi
fi

record deployed
log "Deployed $tag${backup_dir:+; backup in $backup_dir}"
