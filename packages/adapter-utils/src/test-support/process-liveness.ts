import { existsSync, readFileSync } from "node:fs";

const HAS_PROC = existsSync("/proc/self/stat");

/**
 * Whether `pid` names a process that is still running.
 *
 * `kill(pid, 0)` also succeeds for a zombie: a process that has exited but not
 * yet been reaped by its parent. A test that stops a process and asserts it is
 * gone races that reap whenever the parent is slow to wait. An orphan's parent
 * is PID 1, and in a Docker build PID 1 is `sh -c`, not an init. The stop
 * scripts under test already treat a zombie as gone (its `/proc/<pid>/cmdline`
 * is empty), so the assertion must too. Where `/proc` exists the state in
 * `/proc/<pid>/stat` decides: `Z` (zombie) and `X` (dead) are not running.
 * Without `/proc` (macOS) there is nothing to read and `kill` is the answer.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (!HAS_PROC) return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name sits in parentheses and may hold spaces or parentheses,
    // so the state is the first field after the last `)`.
    const state = stat.charAt(stat.lastIndexOf(")") + 2);
    return state !== "Z" && state !== "X";
  } catch (error) {
    // Gone between the signal check and the read. Any other failure (a hidden
    // /proc entry) leaves the signal check's answer standing.
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ENOENT" && code !== "ESRCH";
  }
}
