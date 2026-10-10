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
 * - the start time (field 22 of `/proc/<pid>/stat`, fixed at fork) equals the
 *   recorded one, so a later process that reuses the id does not match;
 * - `/proc/<pid>/cmdline` equals the launch argv byte for byte.
 *
 * A group is signalled only when the launch made one and the process still
 * leads it. Anything that cannot be read or proven (for example a worker
 * without `/proc`) gets no signal. Ids can still be reused in the instant
 * between a check and its `kill`; only a process-handle API closes that, and a
 * shell has none.
 *
 * The scripts are POSIX shell and work in dash, bash and busybox ash.
 */

/** A remote process as its launch recorded it. */
export interface RemoteProcessIdentity {
  pid: number;
  /** The kernel start time, field 22 of `/proc/<pid>/stat`. */
  start: string;
  /** Whether the launch made the process lead its own process group. */
  group: boolean;
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Shell lines that print the launch record of the process in `$pid` as one
 * JSON line. Run them right after the launch, with `group` set to `1` when the
 * launch used `setsid` and `0` otherwise.
 *
 * @returns Lines for a launch script.
 */
export function buildRemoteProcessRecordLines(): string[] {
  return [
    "start=\"$(sed -n 's/^.*) //p' \"/proc/$pid/stat\" 2>/dev/null | cut -d' ' -f20)\"",
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
    if (typeof start !== "string" || !/^[0-9]+$/.test(start)) return null;
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
 * @returns Lines for a stop script.
 */
export function buildRemoteProcessStopLines(input: {
  identity: RemoteProcessIdentity | null;
  argv: string[];
  label: string;
  termWaitSeconds?: number;
}): string[] {
  const { identity } = input;
  const termWaitSteps = Math.max(1, Math.round((input.termWaitSeconds ?? 2) * 20));
  return [
    `pid=${identity ? identity.pid : "''"}`,
    `expected_start=${shellQuote(identity?.start ?? "")}`,
    `group=${identity?.group ? 1 : 0}`,
    `expected_argv="$(printf '%s\\000' ${input.argv.map((arg) => shellQuote(arg)).join(" ")} | od -An -v -tx1)"`,
    "pid_max=\"$(cat /proc/sys/kernel/pid_max 2>/dev/null || echo 4194304)\"",
    "valid_pid() {",
    "  case \"$1\" in ''|0*|*[!0-9]*) return 1 ;; esac",
    "  [ \"$1\" -ge 2 ] 2>/dev/null && [ \"$1\" -le \"$pid_max\" ] 2>/dev/null",
    "}",
    "stat_field() {",
    "  sed -n 's/^.*) //p' \"/proc/$1/stat\" 2>/dev/null | cut -d' ' -f\"$2\"",
    "}",
    "is_launched() {",
    "  [ -n \"$expected_start\" ] && [ -r \"/proc/$1/stat\" ] || return 1",
    "  [ \"$(stat_field \"$1\" 20)\" = \"$expected_start\" ] || return 1",
    "  [ \"$(od -An -v -tx1 < \"/proc/$1/cmdline\" 2>/dev/null)\" = \"$expected_argv\" ]",
    "}",
    "signal_target() {",
    "  if [ \"$group\" = 1 ] && [ \"$(stat_field \"$1\" 3)\" = \"$1\" ]; then echo \"-$1\"; else echo \"$1\"; fi",
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
