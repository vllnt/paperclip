import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.ts";

// The terminal-workspace reaper reads
// PAPERCLIP_WORKSPACE_REAPER_NO_LOCAL_WORK_RETENTION_HOURS for workspaces with
// no local-only work. The default is 24 hours, an explicit 0 archives them on
// the same sweep, and empty, whitespace-only, negative, or non-numeric values
// fall back to the default rather than to 0.

describe("workspace reaper no-local-work retention config parsing", () => {
  const name = "PAPERCLIP_WORKSPACE_REAPER_NO_LOCAL_WORK_RETENTION_HOURS";

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    [undefined, 24],
    ["", 24],
    ["   ", 24],
    ["-1", 24],
    ["soon", 24],
    ["0", 0],
    ["6", 6],
    ["  48  ", 48],
  ] as const)("reads %j as %d hours", (value, hours) => {
    vi.stubEnv(name, value);
    expect(loadConfig().workspaceReaperNoLocalWorkRetentionHours).toBe(hours);
  });
});
