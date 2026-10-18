import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.ts";
import {
  startPaperclipTempSweeper,
  type PaperclipTempSweepLogRecord,
  type PaperclipTempSweepTrigger,
} from "../services/paperclip-temp-sweeper.js";

const HOUR_MS = 60 * 60 * 1000;

describe("temp sweep config parsing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to a 15 minute run grace and a 60 minute interval", () => {
    vi.stubEnv("PAPERCLIP_TMP_SWEEP_RUN_GRACE_MINUTES", undefined);
    vi.stubEnv("PAPERCLIP_TMP_SWEEP_INTERVAL_MINUTES", "  ");
    expect(loadConfig()).toMatchObject({ tempSweepRunGraceMinutes: 15, tempSweepIntervalMinutes: 60 });
  });

  it("raises a run grace below 1 minute to 1 minute and keeps an interval of 0", () => {
    vi.stubEnv("PAPERCLIP_TMP_SWEEP_RUN_GRACE_MINUTES", "0.25");
    vi.stubEnv("PAPERCLIP_TMP_SWEEP_INTERVAL_MINUTES", "0");
    expect(loadConfig()).toMatchObject({ tempSweepRunGraceMinutes: 1, tempSweepIntervalMinutes: 0 });
  });

  it("falls back to the defaults for non-positive or non-numeric values", () => {
    vi.stubEnv("PAPERCLIP_TMP_SWEEP_RUN_GRACE_MINUTES", "0");
    vi.stubEnv("PAPERCLIP_TMP_SWEEP_INTERVAL_MINUTES", "-5");
    expect(loadConfig()).toMatchObject({ tempSweepRunGraceMinutes: 15, tempSweepIntervalMinutes: 60 });
    vi.stubEnv("PAPERCLIP_TMP_SWEEP_RUN_GRACE_MINUTES", "soon");
    vi.stubEnv("PAPERCLIP_TMP_SWEEP_INTERVAL_MINUTES", "hourly");
    expect(loadConfig()).toMatchObject({ tempSweepRunGraceMinutes: 15, tempSweepIntervalMinutes: 60 });
  });

  it("keeps a nonzero interval between 1 minute and 1 day", () => {
    vi.stubEnv("PAPERCLIP_TMP_SWEEP_INTERVAL_MINUTES", "0.001");
    expect(loadConfig()).toMatchObject({ tempSweepIntervalMinutes: 1 });
    // 100000 minutes overflows setInterval, which would then fire every 1 ms.
    vi.stubEnv("PAPERCLIP_TMP_SWEEP_INTERVAL_MINUTES", "100000");
    expect(loadConfig()).toMatchObject({ tempSweepIntervalMinutes: 1440 });
  });

  it("reads explicit values", () => {
    vi.stubEnv("PAPERCLIP_TMP_SWEEP_RUN_GRACE_MINUTES", "30");
    vi.stubEnv("PAPERCLIP_TMP_SWEEP_INTERVAL_MINUTES", "15");
    expect(loadConfig()).toMatchObject({ tempSweepRunGraceMinutes: 30, tempSweepIntervalMinutes: 15 });
  });
});

describe("startPaperclipTempSweeper", () => {
  let stop: (() => void) | null = null;

  afterEach(() => {
    stop?.();
    stop = null;
    vi.useRealTimers();
  });

  function record(trigger: PaperclipTempSweepTrigger): PaperclipTempSweepLogRecord {
    return { event: "paperclip_tmp_sweep", trigger, runGraceMs: 15 * 60 * 1000, removed: 1, freedBytes: 10, kept: {}, deferred: 0, stops: [] };
  }

  it("sweeps on startup and every interval, and logs each pass", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const sweep = vi.fn(async (trigger: PaperclipTempSweepTrigger) => record(trigger));
    const records: PaperclipTempSweepLogRecord[] = [];
    const sweeper = startPaperclipTempSweeper({
      sweep,
      intervalMs: HOUR_MS,
      log: (entry) => records.push(entry),
      onError: (error) => { throw error; },
    });
    stop = sweeper.stop;

    await sweeper.startup;
    expect(records).toEqual([record("startup")]);

    vi.advanceTimersByTime(HOUR_MS);
    await vi.waitFor(() => expect(records).toHaveLength(2));
    expect(records[1]).toEqual(record("interval"));

    sweeper.stop();
    vi.advanceTimersByTime(2 * HOUR_MS);
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it("skips a tick while a pass runs, logs nothing when another process swept, and reports errors", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let finish: (value: PaperclipTempSweepLogRecord | null) => void = () => undefined;
    const sweep = vi.fn(() => new Promise<PaperclipTempSweepLogRecord | null>((resolve) => { finish = resolve; }));
    const records: PaperclipTempSweepLogRecord[] = [];
    const errors: unknown[] = [];
    const sweeper = startPaperclipTempSweeper({
      sweep,
      intervalMs: HOUR_MS,
      log: (entry) => records.push(entry),
      onError: (error) => errors.push(error),
    });
    stop = sweeper.stop;

    vi.advanceTimersByTime(HOUR_MS);
    expect(sweep).toHaveBeenCalledTimes(1);
    finish(null);
    await sweeper.startup;
    expect(records).toEqual([]);

    sweep.mockImplementationOnce(async () => { throw new Error("database down"); });
    vi.advanceTimersByTime(HOUR_MS);
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(records).toEqual([]);
  });

  it("aborts a running pass when stopped", async () => {
    let signal: AbortSignal | null = null;
    const sweeper = startPaperclipTempSweeper({
      sweep: (_trigger, passSignal) => {
        signal = passSignal;
        return new Promise((resolve) => passSignal.addEventListener("abort", () => resolve(null)));
      },
      intervalMs: HOUR_MS,
      log: () => undefined,
      onError: () => undefined,
    });

    expect(signal?.aborted).toBe(false);
    sweeper.stop();
    await sweeper.startup;
    expect(signal?.aborted).toBe(true);
  });

  it("sweeps only on startup when the interval is 0", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const sweep = vi.fn(async (trigger: PaperclipTempSweepTrigger) => record(trigger));
    const sweeper = startPaperclipTempSweeper({ sweep, intervalMs: 0, log: () => undefined, onError: () => undefined });
    stop = sweeper.stop;
    await sweeper.startup;
    vi.advanceTimersByTime(24 * HOUR_MS);
    expect(sweep).toHaveBeenCalledTimes(1);
  });
});
