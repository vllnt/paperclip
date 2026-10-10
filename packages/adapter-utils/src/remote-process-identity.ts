/**
 * Proving a remote process's identity before signalling it.
 *
 * A process started on a worker (over SSH or a sandbox exec) is recorded at
 * launch: its id, its kernel start time, and whether it leads its own process
 * group. A later stop signals it only after it proves, right before each
 * signal, that the process is still the one launched:
 *
 * - the id is an integer from 2 to the platform maximum (never 0, 1 or a
 *   negative id, which would name a process group or every process);
 * - the start time equals the recorded one, so a later process that reuses
 *   the id does not match. With `/proc` (Linux) it is field 22 of
 *   `/proc/<pid>/stat`, fixed at fork; without `/proc` (macOS) it is
 *   `ps -o lstart=`, to the second;
 * - with `/proc`, `/proc/<pid>/cmdline` equals the launch argv byte for byte;
 *   without it, `ps -ww -o command=` holds the launch's unique `nonceArg` as
 *   one whole space-separated token (a shell cannot read argv elements there).
 *
 * A host with `/proc` is never inspected with `ps`. A group is signalled only
 * when the launch made one and the process still leads it. Anything that
 * cannot be read or proven gets no signal. Ids can still be reused in the
 * instant between a check and its `kill`; only a process-handle API closes
 * that, and a shell has none.
 *
 * The scripts are POSIX shell and work in dash, bash and busybox ash.
 */

import { createHash, randomBytes } from "node:crypto";

/** A remote process as its launch recorded it. */
export interface RemoteProcessIdentity {
  pid: number;
  /** The start time: field 22 of `/proc/<pid>/stat`, or `ps -o lstart=` without `/proc`. */
  start: string;
  /** Whether the launch made the process lead its own process group. */
  group: boolean;
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

// Shell function shared by the stop scripts: `valid_pid` accepts only an
// integer id from 2 to the platform maximum.
const VALID_PID_LINES = [
  "pid_max=\"$(cat /proc/sys/kernel/pid_max 2>/dev/null || echo 4194304)\"",
  "valid_pid() {",
  "  case \"$1\" in ''|0*|*[!0-9]*) return 1 ;; esac",
  "  [ \"$1\" -ge 2 ] 2>/dev/null && [ \"$1\" -le \"$pid_max\" ] 2>/dev/null",
  "}",
];

/**
 * Shell lines that print the launch record of the process in `$pid` as one
 * JSON line. Run them right after the launch, with `group` set to `1` when the
 * launch used `setsid` and `0` otherwise.
 *
 * @returns Lines for a launch script.
 */
export function buildRemoteProcessRecordLines(): string[] {
  return [
    "if [ -d /proc/self ]; then",
    "  start=\"$(sed -n 's/^.*) //p' \"/proc/$pid/stat\" 2>/dev/null | cut -d' ' -f20)\"",
    "else",
    "  start=\"$(ps -o lstart= -p \"$pid\" 2>/dev/null | sed 's/^ *//;s/ *$//')\"",
    "fi",
    "printf '{\"pid\":%s,\"start\":\"%s\",\"group\":%s}\\n' \"$pid\" \"$start\" \"$group\"",
  ];
}

/**
 * Reads the launch record that {@link buildRemoteProcessRecordLines} printed
 * on the last line of `stdout`.
 *
 * @param stdout - The launch script's output.
 * @returns The record, or `null` when it is missing or not provable (no start time, an id below 2).
 */
export function parseRemoteProcessIdentity(stdout: string): RemoteProcessIdentity | null {
  const line = stdout.trim().split("\n").at(-1) ?? "";
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object") return null;
    const pid: unknown = Reflect.get(parsed, "pid");
    const start: unknown = Reflect.get(parsed, "start");
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 2) return null;
    // Digits from /proc, or a `ps -o lstart=` date such as "Fri Oct 10 02:30:01 2026".
    if (typeof start !== "string" || !/^[0-9A-Za-z: ]{1,64}$/.test(start) || !/[0-9]/.test(start)) return null;
    return { pid, start, group: Reflect.get(parsed, "group") === 1 };
  } catch {
    return null;
  }
}

/**
 * Shell lines that stop the recorded process: `SIGTERM`, a wait of
 * `termWaitSeconds`, then `SIGKILL`, each only after the process is proven to
 * be the one launched with `argv`. They leave `$pid` set for lines that
 * follow, and print a note to stderr when they leave a process unsignalled.
 *
 * @param input.identity - The launch record; `null` signals nothing.
 * @param input.argv - The exact argv the process was launched with.
 * @param input.label - Names the process in the note.
 * @param input.termWaitSeconds - How long to wait after `SIGTERM`; 2 by default.
 * @param input.nonceArg - An element of `argv` unique to this launch, with no
 *   whitespace. Needed to prove the process on a host without `/proc`; without
 *   it such a host signals nothing.
 * @returns Lines for a stop script.
 * @throws When `nonceArg` is not a whitespace-free element of `argv`.
 */
export function buildRemoteProcessStopLines(input: {
  identity: RemoteProcessIdentity | null;
  argv: string[];
  label: string;
  termWaitSeconds?: number;
  nonceArg?: string;
}): string[] {
  const { identity, nonceArg } = input;
  if (nonceArg !== undefined && (!input.argv.includes(nonceArg) || !/^\S+$/.test(nonceArg))) {
    throw new Error("nonceArg must be a whitespace-free element of argv");
  }
  const termWaitSteps = Math.max(1, Math.round((input.termWaitSeconds ?? 2) * 20));
  return [
    `pid=${identity ? identity.pid : "''"}`,
    `expected_start=${shellQuote(identity?.start ?? "")}`,
    `group=${identity?.group ? 1 : 0}`,
    `expected_argv="$(printf '%s\\000' ${input.argv.map((arg) => shellQuote(arg)).join(" ")} | od -An -v -tx1)"`,
    `nonce_arg=${shellQuote(nonceArg ?? "")}`,
    // Inspect with /proc where it exists, else with ps when a nonce can prove
    // the process, else not at all. Never both.
    "if [ -d /proc/self ]; then inspect=proc; elif [ -n \"$nonce_arg\" ]; then inspect=ps; else inspect=none; fi",
    ...VALID_PID_LINES,
    "stat_field() {",
    "  sed -n 's/^.*) //p' \"/proc/$1/stat\" 2>/dev/null | cut -d' ' -f\"$2\"",
    "}",
    "start_of() {",
    "  if [ \"$inspect\" = proc ]; then stat_field \"$1\" 20; else ps -o lstart= -p \"$1\" 2>/dev/null | sed 's/^ *//;s/ *$//'; fi",
    "}",
    "group_of() {",
    "  if [ \"$inspect\" = proc ]; then stat_field \"$1\" 3; else ps -o pgid= -p \"$1\" 2>/dev/null | tr -d ' '; fi",
    "}",
    "is_launched() {",
    "  [ \"$inspect\" != none ] && [ -n \"$expected_start\" ] || return 1",
    "  [ \"$(start_of \"$1\")\" = \"$expected_start\" ] || return 1",
    "  if [ \"$inspect\" = proc ]; then",
    "    [ \"$(od -An -v -tx1 < \"/proc/$1/cmdline\" 2>/dev/null)\" = \"$expected_argv\" ]",
    "  else",
    "    case \" $(ps -ww -o command= -p \"$1\" 2>/dev/null) \" in *\" $nonce_arg \"*) return 0 ;; *) return 1 ;; esac",
    "  fi",
    "}",
    "signal_target() {",
    "  if [ \"$group\" = 1 ] && [ \"$(group_of \"$1\")\" = \"$1\" ]; then echo \"-$1\"; else echo \"$1\"; fi",
    "}",
    "if valid_pid \"$pid\" && is_launched \"$pid\"; then",
    "  kill -TERM \"$(signal_target \"$pid\")\" 2>/dev/null || true",
    "  i=0",
    `  while [ "$i" -lt ${termWaitSteps} ] && is_launched "$pid"; do`,
    "    i=$((i + 1))",
    "    sleep 0.05",
    "  done",
    // Prove it again right before SIGKILL: a changed start time means the
    // process exited and another one took its id.
    "  if is_launched \"$pid\"; then",
    "    kill -KILL \"$(signal_target \"$pid\")\" 2>/dev/null || true",
    "    i=0",
    "    while [ \"$i\" -lt 20 ] && is_launched \"$pid\"; do",
    "      i=$((i + 1))",
    "      sleep 0.05",
    "    done",
    "  fi",
    "elif [ -n \"$pid\" ]; then",
    `  echo "[paperclip] Left ${input.label} process $pid unsignalled: it could not be proven to be the launched process." >&2`,
    "fi",
  ];
}

/**
 * The environment variable that carries a launch's run marker. Every child of
 * the launch inherits it, including children that start a session of their
 * own, so it finds them where the process group does not. The environment is
 * readable only by the same user; argv is readable by every user through `ps`,
 * so the value never goes in argv, a log, a run event or a record.
 */
export const REMOTE_RUN_MARKER_ENV = "PAPERCLIP_RUN_MARKER";

/** A per-launch secret that every process of the launch carries in its environment. */
export interface RemoteRunMarker {
  /** 32 hex characters (128 random bits). Deliver it on stdin, never in argv. */
  value: string;
  /** SHA-256 of the exact environment entry `NAME=value`; safe to store. */
  entrySha256: string;
}

/**
 * Creates the marker for one launch.
 *
 * @returns The value to deliver on stdin and the hash to record.
 */
export function createRemoteRunMarker(): RemoteRunMarker {
  const value = randomBytes(16).toString("hex");
  const entrySha256 = createHash("sha256").update(`${REMOTE_RUN_MARKER_ENV}=${value}`).digest("hex");
  return { value, entrySha256 };
}

/**
 * Shell lines that write the launch record of the process in `pidExpression`
 * to `recordFile`: the identity line of {@link buildRemoteProcessRecordLines},
 * then `{"uid":…,"marker":"<entrySha256>"}`. They write a temporary file and
 * rename it, and a failed write never fails the launch.
 *
 * @param input.recordFile - A shell word naming the record file.
 * @param input.markerSha256 - {@link RemoteRunMarker.entrySha256}.
 * @param input.group - Whether the launch made the process lead its own session (`setsid`).
 * @param input.pidExpression - The process; `$$` (the running shell) by default.
 * @returns Lines for a launch script.
 */
export function buildRemoteRunRecordLines(input: {
  recordFile: string;
  markerSha256: string;
  group: boolean;
  pidExpression?: string;
}): string[] {
  return [
    `pid=${input.pidExpression ?? "$$"}`,
    `group=${input.group ? 1 : 0}`,
    "{",
    ...buildRemoteProcessRecordLines(),
    `printf '{"uid":%s,"marker":"%s"}\\n' "$(id -u)" ${shellQuote(input.markerSha256)}`,
    `} > ${input.recordFile}.tmp 2>/dev/null && mv -f ${input.recordFile}.tmp ${input.recordFile} 2>/dev/null`,
  ];
}

/** What a stop of a launch's process tree did, as its script printed it. */
export interface RemoteProcessTreeStopSummary {
  /** Launch records found. */
  records: number;
  /** Processes the first scan found to be the launch's. */
  matched: number;
  /** Processes sent `SIGKILL` after the `SIGTERM` wait. */
  killed: number;
  /** Processes left unsignalled because their start time changed. */
  skipped: number;
  /** Processes of the launch still running at the end. */
  survived: number;
  /** Why the stop could not cover every process, or `null`. */
  partial: string | null;
}

const STOP_SUMMARY_PREFIX = "paperclip-remote-stop";

/**
 * Shell lines that stop every process of the launches recorded in `recordDir`
 * and print one summary line. A process is signalled only when all of these
 * hold, checked again right before each signal:
 *
 * - its real uid is the uid recorded at launch, which is also the stopper's;
 * - its id is an integer from 2 to the platform maximum, and it is not the
 *   stopper or the stopper's parent;
 * - it is in the process group of a recorded leader that is proven, right
 *   before the first scan, by its start time, by still leading its group and
 *   by carrying the marker, or its `/proc/<pid>/environ` holds an entry whose
 *   SHA-256 is a recorded marker hash (one NUL-separated entry, matched
 *   whole). The `SIGKILL` pass and the final count use the first scan's
 *   processes and marker carriers only, never a group proven earlier;
 * - its start time, read by the scan, is unchanged right before `SIGTERM` and
 *   again right before `SIGKILL`.
 *
 * Nothing is signalled without a valid record, or when `/proc`, `awk`, `grep`,
 * `tr` or `sha256sum` is missing; the summary names the reason. It never
 * matches command lines. After a stop that found records, it deletes them.
 *
 * @param input.recordDir - A shell word naming the directory of launch records.
 * @param input.termWaitSeconds - How long to wait after `SIGTERM`; 2 by default.
 * @param input.testOnlyBeforeKill - Test seam: a shell function body run with the pid before each `SIGKILL` recheck.
 * @returns Lines for a stop script.
 */
export function buildRemoteProcessTreeStopLines(input: {
  recordDir: string;
  termWaitSeconds?: number;
  testOnlyBeforeKill?: string;
}): string[] {
  const termWaitSteps = Math.max(1, Math.round((input.termWaitSeconds ?? 2) * 20));
  return [
    `dir=${input.recordDir}`,
    `name=${REMOTE_RUN_MARKER_ENV}`,
    "self=$$",
    "parent=$PPID",
    "me=\"$(id -u 2>/dev/null)\"",
    "partial=",
    "records=0; matched=0; killed=0; skipped=0; survived=0",
    "groups=",
    "hashes=",
    ...VALID_PID_LINES,
    "note() { [ -n \"$partial\" ] || partial=$1; }",
    `before_kill() { ${input.testOnlyBeforeKill ?? ":"}; }`,
    // Sets st_state, st_pgrp and st_start without a fork: the scan calls it often.
    "read_stat() {",
    "  st_line=",
    "  { IFS= read -r st_line < \"/proc/$1/stat\"; } 2>/dev/null || return 1",
    "  st_rest=${st_line##*) }",
    "  set -f; set -- $st_rest; set +f",
    "  [ \"$#\" -ge 20 ] || return 1",
    "  st_state=$1; st_pgrp=$3; st_start=${20}",
    "}",
    "marker_matches() {",
    "  [ -n \"$hashes\" ] || return 1",
    // Real newlines become \\001 first, so each line is exactly one entry.
    "  mm_entries=\"$(tr '\\n\\000' '\\001\\n' 2>/dev/null < \"/proc/$1/environ\" | grep -x \"$name=[0-9a-f]\\{32\\}\")\" || return 1",
    "  for mm_entry in $mm_entries; do",
    "    mm_hash=\"$(printf '%s' \"$mm_entry\" | sha256sum 2>/dev/null)\" || continue",
    "    mm_hash=${mm_hash%% *}",
    "    for mm_want in $hashes; do [ \"$mm_hash\" = \"$mm_want\" ] && return 0; done",
    "  done",
    "  return 1",
    "}",
    // One awk pass over every process: `pid pgrp start` for live processes of uid $me.
    "candidates() {",
    "  { grep -H '^Uid:' /proc/[0-9]*/status; cat /proc/[0-9]*/stat; } 2>/dev/null | awk -v me=\"$me\" '",
    "    index($0, \"/proc/\") == 1 { split($0, a, \"/\"); n = split($0, f, /[ \\t]+/); for (i = 1; i < n; i++) if (f[i] ~ /Uid:$/) { uid[a[3]] = f[i + 1]; break }; next }",
    "    { k = 0; rest = $0; while ((j = index(rest, \") \")) > 0) { k += j + 1; rest = substr(rest, j + 2) }",
    "      if (k == 0) next",
    "      n = split(substr($0, k + 1), f, \" \"); if (n < 20) next",
    "      st[$1] = f[1]; pg[$1] = f[3]; start[$1] = f[20] }",
    "    END { for (p in st) if ((p in uid) && uid[p] == me && st[p] !~ /^[ZXx]$/) print p, pg[p], start[p] }'",
    "}",
    // Prints the `pid start` pairs of $1 that still run with the same start time.
    "still_running() {",
    "  set -f; set -- $1; set +f",
    "  while [ \"$#\" -ge 2 ]; do",
    "    if read_stat \"$1\" && [ \"$st_start\" = \"$2\" ] && [ \"$st_state\" != Z ]; then echo \"$1 $2\"; fi",
    "    shift 2",
    "  done",
    "}",
    "scan() {",
    "  candidates | while read -r sc_pid sc_pgrp sc_start; do",
    "    valid_pid \"$sc_pid\" || continue",
    "    case \"$sc_pid\" in \"$self\"|\"$parent\") continue ;; esac",
    "    sc_hit=0",
    "    for sc_group in $groups; do [ \"$sc_pgrp\" = \"$sc_group\" ] && sc_hit=1; done",
    "    [ \"$sc_hit\" = 1 ] || marker_matches \"$sc_pid\" || continue",
    "    echo \"$sc_pid $sc_start\"",
    "  done",
    "}",
    "if [ ! -r /proc/self/stat ]; then note no_proc",
    "elif [ -z \"$me\" ] || ! command -v awk >/dev/null 2>&1 || ! command -v grep >/dev/null 2>&1 || ! command -v tr >/dev/null 2>&1 || ! command -v sort >/dev/null 2>&1; then note no_tools",
    "elif ! command -v sha256sum >/dev/null 2>&1; then note no_sha256sum",
    "else",
    "  for f in \"$dir\"/*.json; do",
    "    [ -f \"$f\" ] || continue",
    "    records=$((records + 1))",
    "    rc_id=\"$(sed -n '1s/^{\"pid\":\\([1-9][0-9]*\\),\"start\":\"\\([0-9][0-9]*\\)\",\"group\":\\([01]\\)}$/\\1 \\2 \\3/p' \"$f\" 2>/dev/null)\"",
    "    rc_own=\"$(sed -n '2s/^{\"uid\":\\([0-9][0-9]*\\),\"marker\":\"\\([0-9a-f]\\{64\\}\\)\"}$/\\1 \\2/p' \"$f\" 2>/dev/null)\"",
    "    set -f; set -- $rc_id $rc_own; set +f",
    "    if [ \"$#\" -ne 5 ] || ! valid_pid \"$1\"; then note bad_record; continue; fi",
    "    if [ \"$4\" != \"$me\" ]; then note uid_mismatch; continue; fi",
    "    hashes=\"$hashes $5\"",
    "    if [ \"$3\" != 1 ]; then note no_session; continue; fi",
    // A leader that has exited leaves its group unprovable; its children
    // that kept the marker are still found by it.
    "    [ -r \"/proc/$1/stat\" ] || continue",
    "    if read_stat \"$1\" && [ \"$st_start\" = \"$2\" ] && [ \"$st_pgrp\" = \"$1\" ] && marker_matches \"$1\"; then",
    "      groups=\"$groups $1\"",
    "    else",
    "      note unverified_group",
    "    fi",
    "  done",
    "  [ \"$records\" -gt 0 ] || note no_process_record",
    "  if [ -n \"$hashes\" ]; then",
    "    first=\"$(scan)\"",
    // A group is proven by its leader only right before this first scan. A
    // leader that exits later leaves its id free for reuse, so later scans
    // find processes by their marker alone.
    "    groups=",
    "    set -f; set -- $first; set +f",
    "    while [ \"$#\" -ge 2 ]; do",
    "      matched=$((matched + 1))",
    "      if read_stat \"$1\" && [ \"$st_start\" = \"$2\" ]; then kill -TERM \"$1\" 2>/dev/null || :; else skipped=$((skipped + 1)); fi",
    "      shift 2",
    "    done",
    "    i=0",
    `    while [ "$i" -lt ${termWaitSteps} ] && [ -n "$(still_running "$first")" ]; do`,
    "      i=$((i + 1))",
    "      sleep 0.05",
    "    done",
    // The first scan's processes that still run, and any marker carrier,
    // including a child forked during the wait.
    "    targets=\"$( { still_running \"$first\"; scan; } | sort -u)\"",
    "    set -f; set -- $targets; set +f",
    "    while [ \"$#\" -ge 2 ]; do",
    "      t_pid=$1; t_start=$2; shift 2",
    "      before_kill \"$t_pid\"",
    "      if read_stat \"$t_pid\" && [ \"$st_start\" = \"$t_start\" ]; then",
    "        kill -KILL \"$t_pid\" 2>/dev/null && killed=$((killed + 1))",
    "      else",
    "        skipped=$((skipped + 1))",
    "      fi",
    "    done",
    "    sleep 0.1",
    "    survived=\"$( { still_running \"$first\"; scan; } | cut -d' ' -f1 | sort -u | grep -c .)\"",
    "  fi",
    // The records only serve this stop; the lease that started the launches is being released.
    "  [ \"$records\" -eq 0 ] || { rm -f -- \"$dir\"/*.json \"$dir\"/*.json.tmp 2>/dev/null; rmdir -- \"$dir\" 2>/dev/null; }",
    "fi",
    `printf '${STOP_SUMMARY_PREFIX} records=%s matched=%s killed=%s skipped=%s survived=%s partial=%s\\n' "$records" "$matched" "$killed" "$skipped" "$survived" "\${partial:--}"`,
    "exit 0",
  ];
}

/**
 * Reads the summary line that {@link buildRemoteProcessTreeStopLines} printed.
 *
 * @param stdout - The stop script's output.
 * @returns The summary, or `null` when the line is missing or malformed.
 */
export function parseRemoteProcessTreeStopSummary(stdout: string): RemoteProcessTreeStopSummary | null {
  const line = stdout.split("\n").reverse().find((candidate) => candidate.startsWith(`${STOP_SUMMARY_PREFIX} `));
  const match = line
    ? /^paperclip-remote-stop records=(\d+) matched=(\d+) killed=(\d+) skipped=(\d+) survived=(\d+) partial=([a-z_]+|-)$/.exec(line)
    : null;
  if (!match) return null;
  const [records, matched, killed, skipped, survived] = match.slice(1, 6).map(Number) as [number, number, number, number, number];
  return { records, matched, killed, skipped, survived, partial: match[6] === "-" ? null : match[6]! };
}
