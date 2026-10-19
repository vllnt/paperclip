import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EVENT_ON_RECOVERY_MODES,
  EVENT_SEVERITIES,
  type EventGrouping,
  type EventSeverity,
  type EventState,
} from "@paperclipai/shared";
import {
  decideEventGroupAction,
  eventGroupFingerprint,
  eventStormGroupKey,
  higherEventSeverity,
  type EventGroupDecision,
  type EventGroupState,
} from "../services/event-sources/grouping.js";

const NOW = new Date("2026-03-04T12:00:00.000Z");
const MINUTE_MS = 60_000;

type Grouping = Pick<EventGrouping, "repeatCommentCooldownSec" | "rewakeOnSeverityIncrease" | "onRecovery">;

function grouping(overrides: Partial<Grouping> = {}): Grouping {
  return { repeatCommentCooldownSec: 900, rewakeOnSeverityIncrease: true, onRecovery: "comment_and_wake", ...overrides };
}

function minutesAgo(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * MINUTE_MS);
}

function group(overrides: Partial<EventGroupState> = {}): EventGroupState {
  return {
    firstSeenAt: minutesAgo(60),
    lastCommentAt: minutesAgo(1),
    lastSeverity: "warning",
    lastState: "problem",
    repeatCount: 0,
    ...overrides,
  };
}

function decide(input: {
  state?: EventState;
  severity?: EventSeverity;
  grouping?: Partial<Grouping>;
  group: EventGroupState | null;
  now?: Date;
}): EventGroupDecision {
  return decideEventGroupAction({
    event: { state: input.state ?? "problem", severity: input.severity ?? "warning" },
    grouping: grouping(input.grouping),
    group: input.group,
    now: input.now ?? NOW,
  });
}

describe("decideEventGroupAction: problems and info events", () => {
  describe("no open group", () => {
    it.each<EventState>(["problem", "info"])("opens a new issue for a %s event", (state) => {
      expect(decide({ state, group: null })).toEqual({ kind: "new_issue" });
    });

    it.each(EVENT_SEVERITIES)("opens a new issue for %s severity", (severity) => {
      expect(decide({ severity, group: null })).toEqual({ kind: "new_issue" });
    });
  });

  describe("inside the cooldown", () => {
    it("stays silent for a repeat at the same severity", () => {
      expect(decide({ group: group({ lastCommentAt: minutesAgo(5) }) })).toEqual({ kind: "silent" });
    });

    it("stays silent for a repeat at a lower severity", () => {
      expect(decide({ severity: "info", group: group({ lastSeverity: "critical" }) })).toEqual({ kind: "silent" });
    });

    it("measures the cooldown from the last comment, not the first sighting", () => {
      const recentlyCommented = group({ firstSeenAt: minutesAgo(600), lastCommentAt: minutesAgo(2) });
      expect(decide({ group: recentlyCommented })).toEqual({ kind: "silent" });
    });

    it("measures the cooldown from the first sighting when nothing has been commented yet", () => {
      expect(decide({ group: group({ firstSeenAt: minutesAgo(3), lastCommentAt: null }) })).toEqual({ kind: "silent" });
      expect(decide({ group: group({ firstSeenAt: minutesAgo(30), lastCommentAt: null }) })).toMatchObject({
        kind: "comment",
        reason: "cooldown_elapsed",
      });
    });

    it("stays silent for an info event repeating inside the cooldown", () => {
      expect(decide({ state: "info", severity: "info", group: group({ lastSeverity: "info" }) })).toEqual({ kind: "silent" });
    });
  });

  describe("after the cooldown", () => {
    it("comments with reason cooldown_elapsed", () => {
      expect(decide({ group: group({ lastCommentAt: minutesAgo(16) }) })).toEqual({
        kind: "comment",
        reason: "cooldown_elapsed",
        severityIncreasedFrom: null,
      });
    });

    it("comments exactly when the cooldown has fully elapsed and not one millisecond earlier", () => {
      const lastCommentAt = new Date(NOW.getTime() - 900_000);
      expect(decide({ group: group({ lastCommentAt }) })).toMatchObject({ kind: "comment", reason: "cooldown_elapsed" });
      const almost = new Date(NOW.getTime() - 899_999);
      expect(decide({ group: group({ lastCommentAt: almost }) })).toEqual({ kind: "silent" });
    });

    it("honours a custom cooldown", () => {
      const lastCommentAt = minutesAgo(2);
      expect(decide({ grouping: { repeatCommentCooldownSec: 60 }, group: group({ lastCommentAt }) })).toMatchObject({
        kind: "comment",
        reason: "cooldown_elapsed",
      });
      expect(decide({ grouping: { repeatCommentCooldownSec: 3600 }, group: group({ lastCommentAt }) })).toEqual({
        kind: "silent",
      });
    });

    it("comments on every repeat when the cooldown is zero", () => {
      expect(
        decide({ grouping: { repeatCommentCooldownSec: 0 }, group: group({ lastCommentAt: NOW }) }),
      ).toMatchObject({ kind: "comment", reason: "cooldown_elapsed" });
    });

    it("comments for an info event once the cooldown has elapsed", () => {
      expect(
        decide({ state: "info", severity: "info", group: group({ lastSeverity: "info", lastCommentAt: minutesAgo(60) }) }),
      ).toMatchObject({ kind: "comment", reason: "cooldown_elapsed" });
    });
  });

  describe("severity increase", () => {
    it("beats the cooldown", () => {
      expect(decide({ severity: "critical", group: group({ lastSeverity: "warning", lastCommentAt: minutesAgo(1) }) })).toEqual({
        kind: "comment",
        reason: "severity_increase",
        severityIncreasedFrom: "warning",
      });
    });

    it.each<[EventSeverity, EventSeverity]>([
      ["info", "warning"],
      ["info", "critical"],
      ["warning", "critical"],
    ])("detects %s -> %s", (from, to) => {
      expect(decide({ severity: to, group: group({ lastSeverity: from }) })).toEqual({
        kind: "comment",
        reason: "severity_increase",
        severityIncreasedFrom: from,
      });
    });

    it("reports the group's recorded severity as the previous one", () => {
      const decision = decide({ severity: "critical", group: group({ lastSeverity: "info" }) });
      expect(decision).toMatchObject({ severityIncreasedFrom: "info" });
    });

    it("is not an increase when the severity stays the same or drops", () => {
      expect(decide({ severity: "warning", group: group({ lastSeverity: "warning" }) })).toEqual({ kind: "silent" });
      expect(decide({ severity: "warning", group: group({ lastSeverity: "critical" }) })).toEqual({ kind: "silent" });
    });

    it("is ignored when rewakeOnSeverityIncrease is off, so the cooldown decides", () => {
      const off = { rewakeOnSeverityIncrease: false };
      expect(decide({ severity: "critical", grouping: off, group: group({ lastSeverity: "info" }) })).toEqual({ kind: "silent" });
      expect(
        decide({
          severity: "critical",
          grouping: off,
          group: group({ lastSeverity: "info", lastCommentAt: minutesAgo(30) }),
        }),
      ).toEqual({ kind: "comment", reason: "cooldown_elapsed", severityIncreasedFrom: null });
    });

    it("prefers severity_increase over cooldown_elapsed when both apply", () => {
      expect(
        decide({ severity: "critical", group: group({ lastSeverity: "warning", lastCommentAt: minutesAgo(120) }) }),
      ).toMatchObject({ reason: "severity_increase" });
    });
  });

  describe("problem returning after a recovery", () => {
    it("comments with reason after_recovery even inside the cooldown", () => {
      expect(decide({ group: group({ lastState: "recovery", lastCommentAt: minutesAgo(1) }) })).toEqual({
        kind: "comment",
        reason: "after_recovery",
        severityIncreasedFrom: null,
      });
    });

    it("applies at the same or a lower severity", () => {
      expect(
        decide({ severity: "info", group: group({ lastState: "recovery", lastSeverity: "critical" }) }),
      ).toMatchObject({ reason: "after_recovery" });
    });

    it("takes precedence over a severity increase", () => {
      expect(
        decide({ severity: "critical", group: group({ lastState: "recovery", lastSeverity: "info" }) }),
      ).toEqual({ kind: "comment", reason: "after_recovery", severityIncreasedFrom: null });
    });

    it("ignores the rewake setting", () => {
      expect(
        decide({ grouping: { rewakeOnSeverityIncrease: false }, group: group({ lastState: "recovery" }) }),
      ).toMatchObject({ reason: "after_recovery" });
    });

    it("also applies to an info event arriving after a recovery", () => {
      expect(decide({ state: "info", severity: "info", group: group({ lastState: "recovery" }) })).toMatchObject({
        reason: "after_recovery",
      });
    });

    it("does not apply when the group's last state was a problem or info", () => {
      for (const lastState of ["problem", "info"] as const) {
        expect(decide({ group: group({ lastState }) })).toEqual({ kind: "silent" });
      }
    });
  });
});

describe("decideEventGroupAction: recoveries", () => {
  it.each(EVENT_ON_RECOVERY_MODES)("reports a recovery without an issue when there is no open group (onRecovery=%s)", (onRecovery) => {
    expect(decide({ state: "recovery", grouping: { onRecovery }, group: null })).toEqual({ kind: "recovery_without_issue" });
  });

  it("comments and wakes on a recovery with comment_and_wake", () => {
    expect(decide({ state: "recovery", grouping: { onRecovery: "comment_and_wake" }, group: group() })).toEqual({
      kind: "recovery_comment",
      wake: true,
    });
  });

  it("comments without waking on a recovery with comment_only", () => {
    expect(decide({ state: "recovery", grouping: { onRecovery: "comment_only" }, group: group() })).toEqual({
      kind: "recovery_comment",
      wake: false,
    });
  });

  it("ignores a recovery for an open group with ignore", () => {
    expect(decide({ state: "recovery", grouping: { onRecovery: "ignore" }, group: group() })).toEqual({
      kind: "recovery_ignored",
    });
  });

  it("is not affected by the cooldown, severity or previous state of the group", () => {
    const groups = [
      group({ lastCommentAt: NOW }),
      group({ lastCommentAt: null, firstSeenAt: NOW }),
      group({ lastSeverity: "critical" }),
      group({ lastState: "recovery" }),
    ];
    for (const open of groups) {
      expect(decide({ state: "recovery", severity: "info", group: open })).toEqual({ kind: "recovery_comment", wake: true });
    }
  });

  it("is not affected by a zero cooldown or by rewake being off", () => {
    expect(
      decide({
        state: "recovery",
        grouping: { repeatCommentCooldownSec: 0, rewakeOnSeverityIncrease: false },
        group: group(),
      }),
    ).toEqual({ kind: "recovery_comment", wake: true });
  });
});

describe("eventGroupFingerprint", () => {
  it("is event: followed by the sha256 hex digest of the group key", () => {
    const expected = `event:${crypto.createHash("sha256").update("gatus:core/api").digest("hex")}`;
    expect(eventGroupFingerprint("gatus:core/api")).toBe(expected);
    expect(eventGroupFingerprint("gatus:core/api")).toMatch(/^event:[0-9a-f]{64}$/);
  });

  it("is stable for the same key and differs for different keys", () => {
    expect(eventGroupFingerprint("a")).toBe(eventGroupFingerprint("a"));
    expect(eventGroupFingerprint("a")).not.toBe(eventGroupFingerprint("b"));
    expect(eventGroupFingerprint("a")).not.toBe(eventGroupFingerprint("A"));
    expect(eventGroupFingerprint("a")).not.toBe(eventGroupFingerprint("a "));
  });

  it("handles an empty and a non-ASCII key", () => {
    expect(eventGroupFingerprint("")).toBe(
      "event:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(eventGroupFingerprint("café")).toMatch(/^event:[0-9a-f]{64}$/);
  });
});

describe("eventStormGroupKey", () => {
  it("is namespaced by source", () => {
    expect(eventStormGroupKey("gatus")).toBe("storm:gatus");
    expect(eventStormGroupKey("gatus")).not.toBe(eventStormGroupKey("grafana"));
  });

  it("produces a fingerprint distinct from a regular group of the same source", () => {
    expect(eventGroupFingerprint(eventStormGroupKey("gatus"))).not.toBe(eventGroupFingerprint("gatus"));
  });
});

describe("higherEventSeverity", () => {
  it.each<[EventSeverity, EventSeverity, EventSeverity]>([
    ["info", "warning", "warning"],
    ["warning", "info", "warning"],
    ["warning", "critical", "critical"],
    ["critical", "warning", "critical"],
    ["info", "critical", "critical"],
    ["critical", "info", "critical"],
    ["info", "info", "info"],
    ["warning", "warning", "warning"],
    ["critical", "critical", "critical"],
  ])("higher of %s and %s is %s", (a, b, expected) => {
    expect(higherEventSeverity(a, b)).toBe(expected);
  });
});
