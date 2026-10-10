import { describe, expect, it } from "vitest";
import { COMMAND_ACTIONS, commandActionGoChords, findCommandAction } from "./command-actions.js";

/** Single keys that list pages already own (Inbox, Decisions, task lists). */
const PAGE_LIST_KEYS = new Set(["j", "k", "x", "a", "r", "u", "U", "y", "g"]);

describe("COMMAND_ACTIONS", () => {
  it("has unique ids", () => {
    const ids = COMMAND_ACTIONS.map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has unique shortcuts", () => {
    const shortcuts = COMMAND_ACTIONS.flatMap((action) => (action.shortcut ? [action.shortcut.join(" ")] : []));
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
  });

  it("keeps global single-key shortcuts off the keys that list pages use", () => {
    const clashes = COMMAND_ACTIONS.filter(
      (action) => action.group !== "contextual" && action.shortcut?.length === 1 && PAGE_LIST_KEYS.has(action.shortcut[0] ?? ""),
    ).map((action) => action.id);
    expect(clashes).toEqual([]);
  });

  it("uses company-relative navigation paths", () => {
    for (const action of COMMAND_ACTIONS) {
      if (action.operation.kind !== "navigate") continue;
      expect(action.operation.path, action.id).toMatch(/^\/[a-z]/);
    }
  });

  it("finds actions by id", () => {
    expect(findCommandAction("nav.dashboard")?.title).toBe("Dashboard");
    expect(findCommandAction("missing")).toBeUndefined();
  });
});

describe("commandActionGoChords", () => {
  it("maps each g chord's second key to its action", () => {
    const chords = commandActionGoChords();
    expect(chords.get("d")).toBe("nav.dashboard");
    expect(chords.get("i")).toBe("nav.inbox");
    expect(chords.get("c")).toBe("issue.focus-comment");
    expect(chords.get("f")).toBe("issue.open-file");
    expect(chords.has("g")).toBe(false);
  });
});
