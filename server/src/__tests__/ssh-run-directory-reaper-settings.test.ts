import { afterEach, describe, expect, it, vi } from "vitest";
import {
  sshRunReaperKeepWindowMs,
  sshRunReaperMinAgeMs,
  sshRunReaperPressureMinAgeMs,
} from "../services/ssh-run-directory-reaper.ts";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

describe("SSH run directory reaper settings", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("removes a finished run's directory after 60 minutes by default, and 15 under disk pressure", () => {
    vi.stubEnv("PAPERCLIP_SSH_RUN_REAPER_MAX_AGE_MINUTES", undefined);
    vi.stubEnv("PAPERCLIP_SSH_RUN_REAPER_PRESSURE_MAX_AGE_MINUTES", undefined);
    expect(sshRunReaperMinAgeMs()).toBe(60 * MINUTE_MS);
    expect(sshRunReaperPressureMinAgeMs()).toBe(15 * MINUTE_MS);
  });

  it("reads an operator's age threshold", () => {
    vi.stubEnv("PAPERCLIP_SSH_RUN_REAPER_MAX_AGE_MINUTES", "360");
    expect(sshRunReaperMinAgeMs()).toBe(360 * MINUTE_MS);
  });

  it.each([
    [undefined, 24],
    ["", 24],
    ["0", 24],
    ["-3", 24],
    ["soon", 24],
    ["6", 6],
    ["0.5", 0.5],
  ] as const)("reads the keep window %j as %d hours", (value, hours) => {
    vi.stubEnv("PAPERCLIP_SSH_RUN_REAPER_KEEP_WINDOW_HOURS", value);
    expect(sshRunReaperKeepWindowMs()).toBe(hours * HOUR_MS);
  });
});
