import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.ts";
import {
  startPaperclipTempSweeper,
  type PaperclipTempSweepLogRecord,
} from "../services/paperclip-temp-sweeper.js";

const HOUR_MS = 60 * 60 * 1000;

describe("temp sweep config parsing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to a 2 hour age limit and a 60 minute interval", () => {
    vi.stubEnv("PAPERCLIP_TMP_SWEEP_MAX_AGE_HOURS", undefined);
    vi.stubEnv("PAPERCLIP_TMP_SWEEP_INTERVAL_MINUTES", "  ");
    expect(loadConfig()).toMatchObject({ tempSweepMaxAgeHours: 2, tempSweepIntervalMinutes: 60 });
  });

  it("raises an age limit below 1 hour to 1 hour and keeps an interval of 0", () => {
    vi.stubEnv("PAPERCLIP_TMP_SWEEP_MAX_AGE_HOURS", "0.25");
    vi.stubEnv("PAPERCLIP_TMP_SWEEP_INTERVAL_MINUTES", "0");
    expect(loadConfig()).toMatchObject({ tempSweepMaxAgeHours: 1, tempSweepIntervalMinutes: 0 });
  });

  it("falls back to the defaults for non-positive or non-numeric values", () => {
    vi.stubEnv("PAPERCLIP_TMP_SWEEP_MAX_AGE_HOURS", "0");
    vi.stubEnv("PAPERCLIP_TMP_SWEEP_INTERVAL_MINUTES", "-5");
    expect(loadConfig()).toMatchObject({ tempSweepMaxAgeHours: 2, tempSweepIntervalMinutes: 60 });
    vi.stubEnv("PAPERCLIP_TMP_SWEEP_MAX_AGE_HOURS", "soon");
    vi.stubEnv("PAPERCLIP_TMP_SWEEP_INTERVAL_MINUTES", "hourly");
    expect(loadConfig()).toMatchObject({ tempSweepMaxAgeHours: 2, tempSweepIntervalMinutes: 60 });
  });

  it("reads explicit values", () => {
    vi.stubEnv("PAPERCLIP_TMP_SWEEP_MAX_AGE_HOURS", "6");
    vi.stubEnv("PAPERCLIP_TMP_SWEEP_INTERVAL_MINUTES", "15");
    expect(loadConfig()).toMatchObject({ tempSweepMaxAgeHours: 6, tempSweepIntervalMinutes: 15 });
  });
});

describe("startPaperclipTempSweeper", () => {
  let tmpDir = "";
  let stop: (() => void) | null = null;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-temp-sweeper-test-"));
  });

  afterEach(async () => {
    stop?.();
    stop = null;
    vi.useRealTimers();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function staleEntry(name: string): Promise<string> {
    const entry = path.join(tmpDir, name);
    await fs.mkdir(entry);
    await fs.writeFile(path.join(entry, "payload"), "1234567890");
    return entry;
  }

  it("sweeps on startup and every interval, and logs count and bytes freed", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const first = await staleEntry("paperclip-ssh-sync-back-aaaaaa");
    const records: PaperclipTempSweepLogRecord[] = [];
    const sweeper = startPaperclipTempSweeper({
      maxAgeMs: 2 * HOUR_MS,
      intervalMs: HOUR_MS,
      tmpDir,
      now: () => Date.now() + 3 * HOUR_MS,
      log: (record) => records.push(record),
      onError: (error) => { throw error; },
    });
    stop = sweeper.stop;

    await sweeper.startup;
    expect(existsSync(first)).toBe(false);
    expect(records).toEqual([{
      event: "paperclip_tmp_sweep",
      trigger: "startup",
      maxAgeMs: 2 * HOUR_MS,
      removed: 1,
      freedBytes: 10,
      held: 0,
      recent: 0,
      failed: 0,
    }]);

    const second = await staleEntry("paperclip-ssh-key-bbbbbb");
    vi.advanceTimersByTime(HOUR_MS);
    await vi.waitFor(() => expect(records).toHaveLength(2));
    expect(records[1]).toMatchObject({ trigger: "interval", removed: 1, freedBytes: 10 });
    expect(existsSync(second)).toBe(false);

    sweeper.stop();
    await staleEntry("paperclip-ssh-key-cccccc");
    vi.advanceTimersByTime(2 * HOUR_MS);
    expect(records).toHaveLength(2);
  });
});
