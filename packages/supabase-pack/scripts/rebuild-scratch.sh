#!/usr/bin/env bash
# Rebuilds kizunasync_scratch from nothing: drop, create, the vendor stub a bare
# `create database` does not carry, then every migration in name order. The
# scratch database is where pack SQL under development is verified, so it is
# disposable by definition and this script never touches the database
# SUPABASE_DB_URL names: it only borrows that server and its `postgres`
# database to create a second one beside it.
set -euo pipefail

PACK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$PACK_DIR/../.." && pwd)"

SCRATCH_DATABASE="kizunasync_scratch"
DB_URL="${SUPABASE_DB_URL:-postgresql://postgres:postgres@127.0.0.1:55322/postgres}"

# The same server, without the database name it ends in: `create database`
# runs on the maintenance database, never on the one it creates.
BASE="${DB_URL%%\?*}"
BASE="${BASE%/*}"

url_for() {
  printf '%s/%s' "$BASE" "$1"
}

# psql is the client here, from PATH when the machine has it and from the
# local stack's own container when it does not. The container path ignores the
# host and port of SUPABASE_DB_URL, because inside the container the server is
# the local socket; it exists so a machine with no libpq can still rebuild the
# local scratch database. The container is KSYNC_DB_CONTAINER when set, else the
# classic stack's supabase_db_kizunasync when docker finds it, else the single
# running container labelled com.supabase.service=database (the experimental
# stack names it per instance).
resolve_container() {
  if [[ -n "${KSYNC_DB_CONTAINER:-}" ]]; then
    printf '%s' "$KSYNC_DB_CONTAINER"
  elif docker inspect supabase_db_kizunasync >/dev/null 2>&1; then
    printf '%s' supabase_db_kizunasync
  else
    local names
    names="$(docker ps --filter label=com.supabase.service=database --format '{{.Names}}' 2>/dev/null || true)"
    if [[ -n "$names" && "$names" != *$'\n'* ]]; then
      printf '%s' "$names"
    fi
  fi
}

CONTAINER=""
if command -v psql >/dev/null 2>&1; then
  IN_CONTAINER=0
else
  CONTAINER="$(resolve_container)"
  if [[ -n "$CONTAINER" ]]; then
    IN_CONTAINER=1
    echo "psql is not on PATH: running it inside $CONTAINER." >&2
  else
    echo "rebuild-scratch needs psql on PATH, or the local stack's database container running." >&2
    exit 1
  fi
fi

run_sql() {
  local database="$1" statement="$2"
  if [[ "$IN_CONTAINER" -eq 1 ]]; then
    docker exec -i "$CONTAINER" psql -U postgres -d "$database" -v ON_ERROR_STOP=1 -tAq -c "$statement"
  else
    psql "$(url_for "$database")" -v ON_ERROR_STOP=1 -tAq -c "$statement"
  fi
}

apply_file() {
  local database="$1" path="$2"
  if [[ "$IN_CONTAINER" -eq 1 ]]; then
    docker exec -i "$CONTAINER" psql -U postgres -d "$database" -v ON_ERROR_STOP=1 -q -f - <"$path"
  else
    psql "$(url_for "$database")" -v ON_ERROR_STOP=1 -q -f "$path"
  fi
}

run_sql postgres "drop database if exists $SCRATCH_DATABASE with (force);"
run_sql postgres "create database $SCRATCH_DATABASE;"

echo "applying pg-vendor-stub.sql"
apply_file "$SCRATCH_DATABASE" "$ROOT/scripts/pg-vendor-stub.sql"

for migration in "$PACK_DIR"/supabase/migrations/*.sql; do
  echo "applying $(basename "$migration")"
  apply_file "$SCRATCH_DATABASE" "$migration"
done

count="$(run_sql "$SCRATCH_DATABASE" "select count(*) from kizunasync._provisions;")"
echo "$SCRATCH_DATABASE carries $count provisioned objects"
