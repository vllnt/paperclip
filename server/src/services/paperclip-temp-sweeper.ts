import {
  sweepPaperclipTempEntries,
  type PaperclipTempSweepResult,
} from "@paperclipai/adapter-utils/paperclip-temp";

// The restart-safe backstop for per-run temp entries in the OS temp directory.
// Each creator removes its entry in `finally`, but a process that dies (a
// restart, a lost run) never reaches it. The sweep runs on startup and then on
// a fixed interval, so a process that never restarts is covered too. It never
// removes an entry a live process of this server holds.

export type PaperclipTempSweepTrigger = "startup" | "interval";

/** The structured log record of one sweep. `event` is stable for log queries. */
export interface PaperclipTempSweepLogRecord extends PaperclipTempSweepResult {
  event: "paperclip_tmp_sweep";
  trigger: PaperclipTempSweepTrigger;
  maxAgeMs: number;
}

/**
 * Sweeps once now and then every `intervalMs`. A tick that lands while a sweep
 * still runs is skipped.
 *
 * @param options.intervalMs - The period; `0` sweeps on startup only.
 * @returns `startup`, which settles when the startup sweep has logged, and `stop`.
 */
export function startPaperclipTempSweeper(options: {
  maxAgeMs: number;
  intervalMs: number;
  log: (record: PaperclipTempSweepLogRecord) => void;
  onError: (error: unknown) => void;
  tmpDir?: string;
  now?: () => number;
}): { startup: Promise<void>; stop: () => void } {
  let running: Promise<void> | null = null;
  const sweep = (trigger: PaperclipTempSweepTrigger): Promise<void> => {
    running ??= sweepPaperclipTempEntries({ maxAgeMs: options.maxAgeMs, tmpDir: options.tmpDir, now: options.now?.() })
      .then((result) => options.log({ event: "paperclip_tmp_sweep", trigger, maxAgeMs: options.maxAgeMs, ...result }))
      .catch(options.onError)
      .finally(() => { running = null; });
    return running;
  };
  const startup = sweep("startup");
  const timer = options.intervalMs > 0 ? setInterval(() => void sweep("interval"), options.intervalMs) : null;
  timer?.unref();
  return {
    startup,
    stop: () => {
      if (timer) clearInterval(timer);
    },
  };
}
