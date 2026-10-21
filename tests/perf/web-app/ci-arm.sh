#!/usr/bin/env bash
# Prepares ONE arm of the CI performance comparison: installs, builds and starts the
# server of one checkout, then seeds it with the perf fixture.
#
#   tests/perf/web-app/ci-arm.sh <tree> <port> <db-port> <instance>
#
#   <tree>      root of the checkout to measure: the head checkout, or the base commit added
#               with `git worktree add`
#   <port>      HTTP port of the server
#   <db-port>   port of the embedded Postgres
#   <instance>  isolated instance id: lowercase letters, digits and dashes (perf-head, perf-base)
#
# Always run the copy of this script that lives in the HEAD tree, for both arms: the base commit
# may not have it. Seeding uses the head tree's make-fixture.mjs and node_modules, so prepare the
# head arm first.
#
# Writes under <tree>/tmp/perf: server.log, server.pid, seed-out.json (read by the probes).
# CI only. It starts a background server that nothing stops (the runner is thrown away) and it
# writes instance data under ~/.paperclip-worktrees, so do not run it on a developer machine.
# Each tree is built with its own build script, so a Vite tree writes ui/dist and a later
# Next.js tree writes ui/.next, and the server finds its own output.
set -euo pipefail

TREE_ARG="${1:?usage: ci-arm.sh <tree> <port> <db-port> <instance>}"
PORT="${2:?usage: ci-arm.sh <tree> <port> <db-port> <instance>}"
DB_PORT="${3:?usage: ci-arm.sh <tree> <port> <db-port> <instance>}"
INSTANCE="${4:?usage: ci-arm.sh <tree> <port> <db-port> <instance>}"

READY_TIMEOUT_SEC=300

HEAD_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
TREE="$(cd "$TREE_ARG" && pwd -P)"
OUT_DIR="$TREE/tmp/perf"
SERVER_LOG="$OUT_DIR/server.log"
PID_FILE="$OUT_DIR/server.pid"
SEED_OUT="$OUT_DIR/seed-out.json"
BASE_URL="http://127.0.0.1:$PORT"

log() { printf '[ci-arm %s] %s\n' "$INSTANCE" "$*"; }
die() { echo "::error::ci-arm ($INSTANCE): $*"; exit 1; }

on_exit() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    echo "::error::ci-arm.sh failed for $INSTANCE (exit $status)"
    if [ -f "$SERVER_LOG" ]; then
      echo "--- last 120 lines of $SERVER_LOG"
      tail -n 120 "$SERVER_LOG" || true
    fi
  fi
}
trap on_exit EXIT

case "$PORT$DB_PORT" in *[!0-9]*) die "ports must be numbers (got $PORT and $DB_PORT)" ;; esac
case "$INSTANCE" in "" | *[!a-z0-9-]*) die "instance must use lowercase letters, digits and dashes (got $INSTANCE)" ;; esac
[ -f "$TREE/package.json" ] || die "$TREE is not a checkout root (no package.json)"

status_of() { curl -sL -o /dev/null -w '%{http_code}' --max-time 10 "$1" || true; }

# wait_for_200 <url>: polls until the URL answers 200, the server process dies, or the time is up.
wait_for_200() {
  local url=$1 deadline=$((SECONDS + READY_TIMEOUT_SEC))
  until [ "$(status_of "$url")" = 200 ]; do
    kill -0 "$(cat "$PID_FILE")" 2>/dev/null || die "the server exited before $url answered 200"
    [ "$SECONDS" -lt "$deadline" ] || die "$url did not answer 200 within ${READY_TIMEOUT_SEC}s"
    sleep 2
  done
  log "$url answers 200"
}

log "tree $TREE, port $PORT, db port $DB_PORT"
cd "$TREE"
mkdir -p "$OUT_DIR"
: >"$SERVER_LOG"

echo "::group::install"
pnpm install --frozen-lockfile
echo "::endgroup::"

echo "::group::plugin SDK"
pnpm --filter @paperclipai/plugin-sdk ensure-build-deps
pnpm --filter @paperclipai/plugin-sdk build
echo "::endgroup::"

echo "::group::worktree init"
node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts worktree init \
  --instance "$INSTANCE" --no-seed --server-port "$PORT" --db-port "$DB_PORT"
echo "::endgroup::"

# `worktree init` moves to a free port when the preferred one is claimed: seed the port it chose.
ACTUAL_DB_PORT="$(node -p "require('$TREE/.paperclip/config.json').database.embeddedPostgresPort")"
if [ "$ACTUAL_DB_PORT" != "$DB_PORT" ]; then
  echo "::warning::worktree init chose database port $ACTUAL_DB_PORT instead of $DB_PORT; seeding that one"
  DB_PORT="$ACTUAL_DB_PORT"
fi

echo "::group::UI build"
pnpm --filter @paperclipai/ui build
echo "::endgroup::"

log "starting the server"
(
  cd "$TREE/server"
  PORT="$PORT" PAPERCLIP_UI_DEV_MIDDLEWARE=false PAPERCLIP_MIGRATION_AUTO_APPLY=true \
    PAPERCLIP_TELEMETRY_DISABLED=1 NEXT_TELEMETRY_DISABLED=1 \
    nohup npx tsx src/index.ts >"$SERVER_LOG" 2>&1 &
  echo $! >"$PID_FILE"
)
log "server pid $(cat "$PID_FILE"), log $SERVER_LOG"

wait_for_200 "$BASE_URL/api/health"
# The UI must be served too: a build in the wrong place passes the health check and fails every probe.
wait_for_200 "$BASE_URL/"

[ -e "$HEAD_ROOT/packages/db/node_modules/postgres" ] ||
  die "the head tree has no installed dependencies; prepare the head arm before the base arm"

echo "::group::seed"
(
  cd "$HEAD_ROOT"
  PERF_BASE="$BASE_URL" \
    PERF_DB_URL="postgres://paperclip:paperclip@127.0.0.1:$DB_PORT/paperclip" \
    PERF_INSTANCE="$INSTANCE" \
    PERF_OUT="$SEED_OUT" \
    node tests/perf/web-app/make-fixture.mjs
)
echo "::endgroup::"

[ -s "$SEED_OUT" ] || die "the fixture script left no $SEED_OUT"
log "ready: $BASE_URL, seed $SEED_OUT, counts $(node -p "JSON.stringify(require('$SEED_OUT').counts)")"
