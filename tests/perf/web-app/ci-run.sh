#!/usr/bin/env bash
# Measures a base arm and a head arm on ONE machine, interleaved, then runs the gate.
# Plan section 7: base and head in the same session, interleaved (base, head, base, head),
# at least 5 runs per cell and 2 rounds.
#
#   tests/perf/web-app/ci-run.sh <base-url> <base-seed> <head-url> <head-seed> <slice>
#
#   <base-url>/<head-url>    the two servers prepared by ci-arm.sh
#   <base-seed>/<head-seed>  their seed-out.json files
#   <slice>                  a gate slice (M0, M1, ...) or `none`. With `none` the gate still
#                            prints its comparison, but only an unreadable input fails the run.
#
# Run it from the head tree (the probes and the gate come from there). Every round runs, in
# order and for base then head: measure.mjs, nav-timing.mjs; the first round then adds the
# probes that run once per arm: route-smoke.mjs, spa-mounts.mjs, ws-persistence.mjs. A probe
# whose file does not exist yet is skipped with a notice; a probe that fails is reported and
# the run goes on (the gate reports the missing cells).
#
# Results: tmp/perf/results/{base,head}/*.json, load.tsv (load average before and after every
# probe), gate.json and gate.md. With GITHUB_STEP_SUMMARY set, gate.md and the load log are
# appended to it.
#
# Environment (all optional):
#   PERF_ROUNDS          rounds of the interleaved probes (default 2)
#   PERF_RUNS            samples per cell for measure.mjs and nav-timing.mjs (default 5)
#   PERF_PROFILES        measure.mjs profiles (default wan,laptop)
#   PERF_DEADLINE_EPOCH  Unix time after which no probe starts and a running probe is stopped
#                        (a stopped probe leaves no file). Keeps the gate and the upload inside
#                        the job's time limit.
set -euo pipefail

BASE_URL="${1:?usage: ci-run.sh <base-url> <base-seed> <head-url> <head-seed> <slice>}"
BASE_SEED="${2:?usage: ci-run.sh <base-url> <base-seed> <head-url> <head-seed> <slice>}"
HEAD_URL="${3:?usage: ci-run.sh <base-url> <base-seed> <head-url> <head-seed> <slice>}"
HEAD_SEED="${4:?usage: ci-run.sh <base-url> <base-seed> <head-url> <head-seed> <slice>}"
SLICE="${5:?usage: ci-run.sh <base-url> <base-seed> <head-url> <head-seed> <slice>}"

ROUNDS="${PERF_ROUNDS:-2}"
RUNS="${PERF_RUNS:-5}"
PROFILES="${PERF_PROFILES:-wan,laptop}"
DEADLINE="${PERF_DEADLINE_EPOCH:-}"
MIN_SECONDS_TO_START=60

OUT="tmp/perf/results"
LOAD_LOG="$OUT/load.tsv"
BANDS="tests/perf/web-app/gate-bands.json"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
cd "$ROOT"

die() { echo "::error::ci-run: $*"; exit 1; }
case "$SLICE" in "" | *[!A-Za-z0-9]*) die "the slice must match ^[A-Za-z0-9]+\$ (got $(printf '%q' "$SLICE"))" ;; esac
case "$ROUNDS$RUNS$DEADLINE" in *[!0-9]*) die "PERF_ROUNDS, PERF_RUNS and PERF_DEADLINE_EPOCH must be numbers" ;; esac

mkdir -p "$OUT/base" "$OUT/head"
printf 'time\twhen\tarm\tlabel\ttool\tload1 load5 load15\n' >"$LOAD_LOG"

SKIPPED=0
FAILED=0

url_of() { case "$1" in base) echo "$BASE_URL" ;; head) echo "$HEAD_URL" ;; esac; }
seed_of() { case "$1" in base) echo "$BASE_SEED" ;; head) echo "$HEAD_SEED" ;; esac; }
label_of() { case "$1" in base) echo "b1-r$2" ;; head) echo "head-r$2" ;; esac; }

seconds_left() {
  if [ -z "$DEADLINE" ]; then echo 999999; else echo $((DEADLINE - $(date +%s))); fi
}

# note_load <before|after> <arm> <label> <tool>: one line in the load log and in the job log.
note_load() {
  local load line
  load="$(uptime | sed -E 's/.*load averages?: *//')"
  line="$(printf '%s\t%s\t%s\t%s\t%s\t%s' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$3" "$4" "$load")"
  echo "$line" >>"$LOAD_LOG"
  echo "[load] $line"
}

# probe <arm> <label> <script> [probe args...]: runs one probe against one arm. Never fails the run.
probe() {
  local arm=$1 label=$2 script=$3
  shift 3
  local file="tests/perf/web-app/$script" left status=0
  if [ ! -f "$file" ]; then
    echo "::notice::$script does not exist in this tree; skipped ($arm, $label)"
    return 0
  fi
  left="$(seconds_left)"
  if [ "$left" -le "$MIN_SECONDS_TO_START" ]; then
    echo "::warning::time budget used up; skipped $script ($arm, $label)"
    SKIPPED=$((SKIPPED + 1))
    return 0
  fi
  local guard=() limiter
  for limiter in timeout gtimeout; do
    if [ -n "$DEADLINE" ] && command -v "$limiter" >/dev/null 2>&1; then
      guard=("$limiter" "$left")
      break
    fi
  done

  note_load before "$arm" "$label" "$script"
  echo "::group::$arm $label $script"
  ${guard[@]+"${guard[@]}"} node "$file" \
    --base "$(url_of "$arm")" --seed "$(seed_of "$arm")" --label "$label" --out "$OUT/$arm" "$@" || status=$?
  echo "::endgroup::"
  note_load after "$arm" "$label" "$script"

  if [ "$status" -ne 0 ]; then
    echo "::warning::$script exited $status for $arm ($label); its cells will be missing"
    FAILED=$((FAILED + 1))
  fi
}

round=1
while [ "$round" -le "$ROUNDS" ]; do
  echo "=== round $round of $ROUNDS"
  for arm in base head; do
    probe "$arm" "$(label_of "$arm" "$round")" measure.mjs --runs "$RUNS" --profiles "$PROFILES"
  done
  for arm in base head; do
    probe "$arm" "$(label_of "$arm" "$round")" nav-timing.mjs --runs "$RUNS"
  done
  if [ "$round" -eq 1 ]; then
    for tool in route-smoke.mjs spa-mounts.mjs ws-persistence.mjs; do
      for arm in base head; do
        probe "$arm" "$(label_of "$arm" 1)" "$tool"
      done
    done
  fi
  round=$((round + 1))
done

# `none` has no entry in the bands file until the gate learns it: use the broadest slice, for its table only.
GATE_SLICE="$SLICE"
if [ "$SLICE" = none ] && ! { [ -f "$BANDS" ] && node -e 'process.exit(require(process.argv[1]).slices?.none ? 0 : 1)' "$ROOT/$BANDS"; }; then
  GATE_SLICE=MF
fi

gate_status=0
if [ -f tests/perf/web-app/gate.mjs ]; then
  echo "=== gate (slice $SLICE, compared as $GATE_SLICE)"
  node tests/perf/web-app/gate.mjs --slice "$GATE_SLICE" \
    --base "$OUT/base/*.json" --head "$OUT/head/*.json" --json "$OUT/gate.json" | tee "$OUT/gate.md" || gate_status=$?
else
  echo "::warning::tests/perf/web-app/gate.mjs does not exist in this tree; nothing was compared"
  printf '## gate\n\ngate.mjs does not exist in this tree; nothing was compared.\n' >"$OUT/gate.md"
  gate_status=3
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Web-app performance: base vs head"
    echo
    echo "Slice \`$SLICE\`, $ROUNDS round(s), $RUNS run(s) per cell, profiles \`$PROFILES\`. Probes skipped for lack of time: $SKIPPED. Probes that failed: $FAILED."
    echo
    cat "$OUT/gate.md"
    echo
    echo "<details><summary>Load average before and after every probe</summary>"
    echo
    echo '```'
    cat "$LOAD_LOG"
    echo '```'
    echo
    echo "</details>"
  } >>"$GITHUB_STEP_SUMMARY"
fi

echo "gate exit code $gate_status; probes skipped $SKIPPED, failed $FAILED"
if [ "$SLICE" = none ]; then
  # No slice, no verdict: a failed band (1) or an invalid load comparison (2) is only reported.
  # An unreadable input (3) or a missing gate is a broken harness and still fails the run.
  case "$gate_status" in 0 | 1 | 2) exit 0 ;; esac
fi
exit "$gate_status"
