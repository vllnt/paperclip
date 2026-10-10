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
// Shell function shared by the launch gate and the stop: prints a launch
// record's `pid start group uid markerSha256`, or less when either line is not
// exactly what `buildRemoteRunRecordLines` writes on a worker with `/proc`.
const RECORD_FIELDS_LINES = [
  "record_fields() {",
  "  sed -n -e '1s/^{\"pid\":\\([1-9][0-9]*\\),\"start\":\"\\([0-9][0-9]*\\)\",\"group\":\\([01]\\)}$/\\1 \\2 \\3/p' -e '2s/^{\"uid\":\\([0-9][0-9]*\\),\"marker\":\"\\([0-9a-f]\\{64\\}\\)\"}$/\\1 \\2/p' \"$1\" 2>/dev/null",
  "}",
];

// Shell function shared by the launch and the stop: enters the run's record
// directory, `<root>/.paperclip-runtime/processes/<run>`, only when each of
// the three parts is a real directory (never a link) owned by the worker user,
// creating a missing part, and the physical path is the expected one. Callers
// then use relative names only, so a path swapped after the check redirects
// nothing.
const PIN_RECORD_DIR_LINES = [
  "pin_record_dir() {",
  "  cd -P -- \"$1\" 2>/dev/null || return 1",
  "  pr_base=\"$(pwd -P)\"",
  "  [ \"$pr_base\" != / ] || pr_base=",
  "  pr_me=\"$(id -u 2>/dev/null)\"",
  "  [ -n \"$pr_me\" ] || return 1",
  "  for pr_part in .paperclip-runtime processes \"$2\"; do",
  "    [ -e \"$pr_part\" ] || [ -L \"$pr_part\" ] || mkdir -- \"$pr_part\" 2>/dev/null || :",
  "    [ -d \"$pr_part\" ] && [ ! -L \"$pr_part\" ] || return 1",
  "    [ \"$(ls -dn -- \"$pr_part\" 2>/dev/null | awk '{print $3}')\" = \"$pr_me\" ] || return 1",
  "    cd -P -- \"$pr_part\" 2>/dev/null || return 1",
  "  done",
  "  [ \"$(pwd -P)\" = \"$pr_base/.paperclip-runtime/processes/$2\" ]",
  "}",
];

function assertRunId(runId: string) {
  if (!/^[0-9A-Za-z-]+$/.test(runId)) throw new Error("invalid run id");
}

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

/** The file a stop leaves in a run's record directory; a launch that finds it does not start. */
export const REMOTE_RUN_STOPPED_MARK = "stopped";

/**
 * Shell lines that write the launch record of the process in `pidExpression`
 * to `<launchId>.json` in the run's record directory: the identity line of
 * {@link buildRemoteProcessRecordLines}, then `{"uid":…,"marker":"<entrySha256>"}`.
 * They work in a subshell inside the pinned directory (see
 * `pin_record_dir`): they exit with 143 at once when the run was already
 * stopped (any `stopped` entry counts, a dangling link included), write a
 * temporary file create-exclusive and publish it with `link`, on names that
 * must be free. They exit with 125 when the directory cannot be pinned, a name
 * is taken, `link` is missing, or the record is not a regular file afterwards
 * or, on a worker with `/proc`, does not read back as the stop reads it. When
 * the run was stopped meanwhile, they delete their own record and exit 143.
 *
 * The order is the handshake with {@link buildRemoteProcessTreeStopLines},
 * which leaves its stop mark before it reads the records: either the stop
 * reads this record and finds the process, or this check finds the mark.
 *
 * @param input.remoteRoot - A shell word naming the environment's remote workspace root.
 * @param input.runId - The heartbeat run id; letters, digits and dashes only.
 * @param input.launchId - Names this launch's record; letters and digits only.
 * @param input.markerSha256 - {@link RemoteRunMarker.entrySha256}.
 * @param input.group - Whether the launch made the process lead its own session (`setsid`).
 * @param input.pidExpression - The process; `$$` (the running shell) by default.
 * @returns Lines for a launch script.
 */
export function buildRemoteRunRecordLines(input: {
  remoteRoot: string;
  runId: string;
  launchId: string;
  markerSha256: string;
  group: boolean;
  pidExpression?: string;
}): string[] {
  assertRunId(input.runId);
  if (!/^[0-9a-zA-Z]+$/.test(input.launchId)) throw new Error("invalid launch id");
  const record = `${input.launchId}.json`;
  return [
    `pid=${input.pidExpression ?? "$$"}`,
    `group=${input.group ? 1 : 0}`,
    ...PIN_RECORD_DIR_LINES,
    ...RECORD_FIELDS_LINES,
    "(",
    `  pin_record_dir ${input.remoteRoot} ${shellQuote(input.runId)} || { echo "[paperclip] The run's process record directory on the worker is not a real directory owned by the worker user, so the run was not started." >&2; exit 125; }`,
    // A run that was already stopped gets no record at all.
    `  if [ -e ${REMOTE_RUN_STOPPED_MARK} ] || [ -L ${REMOTE_RUN_STOPPED_MARK} ]; then exit 143; fi`,
    // The launch id is visible in the remote command, so anything may already
    // be at the record's names: refuse rather than write through it.
    `  if [ -e ${record} ] || [ -L ${record} ] || [ -e ${record}.tmp ] || [ -L ${record}.tmp ]; then echo "[paperclip] The run's process record name was already taken on the worker, so the run was not started." >&2; exit 125; fi`,
    `  command -v link >/dev/null 2>&1 || { echo "[paperclip] The worker has no link utility to publish the run's process record, so the run was not started." >&2; exit 125; }`,
    // Readers never see a half-written record: write a tmp file, then publish
    // it with link(2), which fails on any existing name and never follows one
    // or puts the file inside a directory (mv and ln both do).
    "  paperclip_record_written=",
    "  ( set -C",
    "  {",
    ...buildRemoteProcessRecordLines(),
    `  printf '{"uid":%s,"marker":"%s"}\\n' "$(id -u)" ${shellQuote(input.markerSha256)}`,
    `  } > ${record}.tmp ) 2>/dev/null && link ${record}.tmp ${record} 2>/dev/null && paperclip_record_written=1`,
    `  rm -f -- ${record}.tmp 2>/dev/null`,
    // A launch that no stop could find must not start. Where the stop can
    // work (with /proc), the record must read back exactly as the stop reads
    // it; elsewhere the stop fails closed whatever the record holds.
    "  paperclip_record_ok=",
    `  if [ -z "$paperclip_record_written" ] || [ ! -f ${record} ] || [ -L ${record} ] || [ ! -s ${record} ]; then :; elif [ -d /proc/self ]; then set -f; set -- $(record_fields ${record}); set +f; [ "$#" -eq 5 ] && [ "$1" = "$pid" ] && paperclip_record_ok=1; else paperclip_record_ok=1; fi`,
    `  [ -n "$paperclip_record_ok" ] || { [ -z "$paperclip_record_written" ] || rm -f -- ${record} 2>/dev/null; echo "[paperclip] The run's process record could not be written on the worker, so the run was not started." >&2; exit 125; }`,
    // A launch that will not start leaves no record, so the stop mark can age out.
    `  if [ -e ${REMOTE_RUN_STOPPED_MARK} ] || [ -L ${REMOTE_RUN_STOPPED_MARK} ]; then rm -f -- ${record} 2>/dev/null; exit 143; fi`,
    ") || exit $?",
  ];
}

/** What a stop of a launch's process tree did, as its script printed it. */
export interface RemoteProcessTreeStopSummary {
  /** Launch records found. */
  records: number;
  /** Processes the first scan found to be the launch's. */
  matched: number;
  /** Of those, the ones that joined by their marker. */
  matchedByMarker: number;
  /** Of those, the ones that joined only through the verified group. */
  matchedByGroup: number;
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
 * Shell lines that stop every process of the launches recorded for `runId`
 * and print one summary line. A process is signalled only when all of these
 * hold, checked again right before each signal:
 *
 * - its real uid is the uid recorded at launch, which is also the stopper's;
 * - its id is an integer from 2 to the platform maximum, and it is not the
 *   stopper or the stopper's parent;
 * - the first scan found it: in the process group of a recorded leader that
 *   is proven, right before that scan, by its start time, by still leading its
 *   group and by carrying the marker, or with a `/proc/<pid>/environ` entry
 *   whose SHA-256 is a recorded marker hash (one NUL-separated entry, matched
 *   whole). The `SIGKILL` pass and the final count use that set only;
 * - right before `SIGTERM`, right before `SIGKILL` and in the final count, it
 *   is the same process: same start time, same real uid, not a zombie. The
 *   marker only decides who joins the set at the first scan, so a member that
 *   clears it during the wait is still signalled and counted.
 *
 * Nothing is signalled without a valid record, when the record directory
 * cannot be pinned (`unsafe_record_dir`), or when `/proc`, `awk`, `grep`, `tr`
 * or `sha256sum` is missing; the summary names the reason. It never matches
 * command lines. Inside the pinned directory it leaves a stop mark first,
 * create-exclusive (see {@link buildRemoteRunRecordLines}); a mark it cannot
 * leave makes the stop partial (`no_stop_mark`). It deletes the records it
 * read, and drops stop marks older than a week whose run has no record left.
 *
 * @param input.remoteRoot - A shell word naming the environment's remote workspace root.
 * @param input.runId - The heartbeat run id; letters, digits and dashes only.
 * @param input.termWaitSeconds - How long to wait after `SIGTERM`; 2 by default.
 * @param input.testOnlyBeforeSignal - Test seam: a shell function body run with the pid and `TERM` or `KILL` before each recheck.
 * @returns Lines for a stop script.
 */
export function buildRemoteProcessTreeStopLines(input: {
  remoteRoot: string;
  runId: string;
  termWaitSeconds?: number;
  testOnlyBeforeSignal?: string;
}): string[] {
  assertRunId(input.runId);
  const termWaitSteps = Math.max(1, Math.round((input.termWaitSeconds ?? 2) * 20));
  return [
    `name=${REMOTE_RUN_MARKER_ENV}`,
    "self=$$",
    "parent=$PPID",
    "me=\"$(id -u 2>/dev/null)\"",
    "partial=",
    "records=0; matched=0; bymarker=0; bygroup=0; killed=0; skipped=0; survived=0",
    "groups=",
    "hashes=",
    ...VALID_PID_LINES,
    ...PIN_RECORD_DIR_LINES,
    ...RECORD_FIELDS_LINES,
    "note() { [ -n \"$partial\" ] || partial=$1; }",
    `before_signal() { ${input.testOnlyBeforeSignal ?? ":"}; }`,
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
    // Sets rid to the real uid of $1, without a fork.
    "real_uid() {",
    "  rid=",
    "  { while IFS= read -r ru_line; do case \"$ru_line\" in Uid:*) set -f; set -- $ru_line; set +f; rid=$2; break ;; esac; done < \"/proc/$1/status\"; } 2>/dev/null",
    "  [ -n \"$rid\" ]",
    "}",
    // The rule checked right before each signal: same start time, not a
    // zombie, and still the worker's real uid.
    "same_proc() {",
    "  read_stat \"$1\" && [ \"$st_start\" = \"$2\" ] && [ \"$st_state\" != Z ] && real_uid \"$1\" && [ \"$rid\" = \"$me\" ]",
    "}",
    // Prints the `pid start basis` triples of $1 that are still the same
    // processes. The basis (`m` marker, `g<pgid>` group) says why each joined.
    "still_running() {",
    "  set -f; set -- $1; set +f",
    "  while [ \"$#\" -ge 3 ]; do",
    "    if same_proc \"$1\" \"$2\"; then echo \"$1 $2 $3\"; fi",
    "    shift 3",
    "  done",
    "}",
    "scan() {",
    "  candidates | while read -r sc_pid sc_pgrp sc_start; do",
    "    valid_pid \"$sc_pid\" || continue",
    "    case \"$sc_pid\" in \"$self\"|\"$parent\") continue ;; esac",
    "    if marker_matches \"$sc_pid\"; then echo \"$sc_pid $sc_start m\"; continue; fi",
    "    for sc_group in $groups; do [ \"$sc_pgrp\" = \"$sc_group\" ] && { echo \"$sc_pid $sc_start g$sc_pgrp\"; break; }; done",
    "  done",
    "}",
    // Work only inside the pinned record directory, by relative names.
    `pinned=; if pin_record_dir ${input.remoteRoot} ${shellQuote(input.runId)}; then pinned=1; else note unsafe_record_dir; fi`,
    // Leave the stop mark before reading any record: a launch that has not
    // written its record yet will find the mark and not start. A subshell
    // keeps a failed redirection from ending the script.
    `[ -z "$pinned" ] || { rm -f -- ${REMOTE_RUN_STOPPED_MARK} 2>/dev/null; ( set -C; : > ${REMOTE_RUN_STOPPED_MARK} ) 2>/dev/null || note no_stop_mark; }`,
    "if [ -z \"$pinned\" ]; then :",
    "elif [ ! -r /proc/self/stat ]; then note no_proc",
    "elif [ -z \"$me\" ] || ! command -v awk >/dev/null 2>&1 || ! command -v grep >/dev/null 2>&1 || ! command -v tr >/dev/null 2>&1; then note no_tools",
    "elif ! command -v sha256sum >/dev/null 2>&1; then note no_sha256sum",
    "else",
    "  for f in *.json; do",
    "    [ -f \"$f\" ] && [ ! -L \"$f\" ] || continue",
    "    records=$((records + 1))",
    "    set -f; set -- $(record_fields \"$f\"); set +f",
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
    "    while [ \"$#\" -ge 3 ]; do",
    "      t_pid=$1; t_start=$2; t_basis=$3; shift 3",
    "      matched=$((matched + 1))",
    "      before_signal \"$t_pid\" TERM",
    "      case \"$t_basis\" in m) bymarker=$((bymarker + 1)) ;; *) bygroup=$((bygroup + 1)) ;; esac",
    "      if same_proc \"$t_pid\" \"$t_start\"; then kill -TERM \"$t_pid\" 2>/dev/null || :; else skipped=$((skipped + 1)); fi",
    "    done",
    "    i=0",
    `    while [ "$i" -lt ${termWaitSteps} ] && [ -n "$(still_running "$first")" ]; do`,
    "      i=$((i + 1))",
    "      sleep 0.05",
    "    done",
    // Only the first scan's processes that are still the same ones.
    "    targets=\"$(still_running \"$first\")\"",
    "    set -f; set -- $targets; set +f",
    "    while [ \"$#\" -ge 3 ]; do",
    "      t_pid=$1; t_start=$2; t_basis=$3; shift 3",
    "      before_signal \"$t_pid\" KILL",
    "      if same_proc \"$t_pid\" \"$t_start\"; then",
    "        kill -KILL \"$t_pid\" 2>/dev/null && killed=$((killed + 1))",
    "      else",
    "        skipped=$((skipped + 1))",
    "      fi",
    "    done",
    "    sleep 0.1",
    "    survived=\"$(still_running \"$first\" | grep -c .)\"",
    "  fi",
    // The records only serve this stop; the lease that started the launches
    // is being released. The stop mark stays.
    "  [ \"$records\" -eq 0 ] || rm -f -- *.json *.json.tmp 2>/dev/null",
    "fi",
    // No launch of a run starts a week after its stop: from the pinned
    // `processes` directory, drop older marks and their directories, but keep
    // a mark while its run still has a record.
    `[ -z "$pinned" ] || ! cd -P .. 2>/dev/null || find . -mindepth 2 -maxdepth 2 -type f -name ${REMOTE_RUN_STOPPED_MARK} -mtime +7 -exec sh -c 'for f; do d=\${f%/*}; for r in "$d"/*.json "$d"/*.json.tmp; do [ -e "$r" ] && continue 2; done; rm -f -- "$f"; rmdir -- "$d" 2>/dev/null; done' sh {} + 2>/dev/null`,
    `printf '${STOP_SUMMARY_PREFIX} records=%s matched=%s bymarker=%s bygroup=%s killed=%s skipped=%s survived=%s partial=%s\\n' "$records" "$matched" "$bymarker" "$bygroup" "$killed" "$skipped" "$survived" "\${partial:--}"`,
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
    ? /^paperclip-remote-stop records=(\d+) matched=(\d+) bymarker=(\d+) bygroup=(\d+) killed=(\d+) skipped=(\d+) survived=(\d+) partial=([a-z_]+|-)$/.exec(line)
    : null;
  if (!match) return null;
  const [records, matched, matchedByMarker, matchedByGroup, killed, skipped, survived] = match.slice(1, 8).map(Number) as
    [number, number, number, number, number, number, number];
  return { records, matched, matchedByMarker, matchedByGroup, killed, skipped, survived, partial: match[8] === "-" ? null : match[8]! };
}
