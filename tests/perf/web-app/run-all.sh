#!/usr/bin/env bash
# Runs the whole web-app performance suite against a seeded local server and
# writes a combined log. Probes run one after another so they never compete for
# CPU. Usage: tests/perf/web-app/run-all.sh <label> [quick]
set -u
LABEL="${1:?label required, for example baseline or after-split}"
QUICK="${2:-}"
OUT="tmp/perf/${LABEL}.log"
mkdir -p tmp/perf
: > "$OUT"

IDLE_SECONDS=120
BUSY_SECONDS=90
VITALS_RUNS=3
INP_RUNS=3
if [ "$QUICK" = "quick" ]; then
  IDLE_SECONDS=40
  BUSY_SECONDS=40
  VITALS_RUNS=2
  INP_RUNS=1
fi

run() {
  echo "### $*" >> "$OUT"
  node "$@" >> "$OUT" 2>&1
}

for page in issue-long tasks-board dashboard; do
  run tests/perf/web-app/live-traffic.mjs --page "$page" --seconds "$IDLE_SECONDS" --rate 0 --label "$LABEL-$page-idle"
done
for page in tasks-board issue-long dashboard; do
  run tests/perf/web-app/live-traffic.mjs --page "$page" --seconds "$BUSY_SECONDS" --rate 12 --label "$LABEL-$page-busy12"
done
for page in tasks-board tasks-list issue-long dashboard; do
  run tests/perf/web-app/renders.mjs --page "$page" --seconds 60 --rate 12 --label "$LABEL-$page"
done
run tests/perf/web-app/interact.mjs --label "$LABEL" --profile desktop --runs "$INP_RUNS"
run tests/perf/web-app/interact.mjs --label "$LABEL" --profile slow --runs 2
run tests/perf/web-app/measure.mjs --label "$LABEL-wan" --runs "$VITALS_RUNS" --profiles wan --pages dashboard,tasks-board,tasks-list,issue-long,agents
echo "### ALL DONE" >> "$OUT"
