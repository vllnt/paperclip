// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  getCommandActionUsageStorageKey,
  readCommandActionUsage,
  writeCommandActionUsage,
} from "./command-action-usage";

describe("command action usage storage", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("keys usage by company and user, with a local-board fallback", () => {
    expect(getCommandActionUsageStorageKey("company-1", "user-1")).toBe("paperclip.commandActionUsage.v1:company-1:user-1");
    expect(getCommandActionUsageStorageKey("company-1", null)).toBe("paperclip.commandActionUsage.v1:company-1:__local_board__");
  });

  it("round-trips valid entries and drops malformed ones", () => {
    const key = getCommandActionUsageStorageKey("company-1", "user-1");
    window.localStorage.setItem(key, JSON.stringify({
      "nav.dashboard": { count: 3, lastUsedAt: 1000 },
      "nav.bad-count": { count: "3", lastUsedAt: 1000 },
      "nav.bad-time": { count: 1, lastUsedAt: null },
    }));
    expect(readCommandActionUsage(key)).toEqual({ "nav.dashboard": { count: 3, lastUsedAt: 1000 } });

    writeCommandActionUsage(key, { "nav.tasks": { count: 1, lastUsedAt: 2000 } });
    expect(readCommandActionUsage(key)).toEqual({ "nav.tasks": { count: 1, lastUsedAt: 2000 } });
  });

  it("returns an empty record for missing or corrupt storage", () => {
    const key = getCommandActionUsageStorageKey("company-1", "user-1");
    expect(readCommandActionUsage(key)).toEqual({});
    window.localStorage.setItem(key, "{not json");
    expect(readCommandActionUsage(key)).toEqual({});
    window.localStorage.setItem(key, "[]");
    expect(readCommandActionUsage(key)).toEqual({});
  });
});
