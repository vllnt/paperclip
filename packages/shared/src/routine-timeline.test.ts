import { describe, expect, it } from "vitest";
import {
  ROUTINE_TIMELINE_MAX_WINDOW_DAYS,
  resolveRoutineTimelineWindow,
  routineTimelineQuerySchema,
} from "./routine-timeline.js";

const NOW = new Date("2026-10-21T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

describe("resolveRoutineTimelineWindow", () => {
  it("is a day back and a day ahead of now when no bound is given", () => {
    expect(resolveRoutineTimelineWindow({}, NOW)).toEqual({
      from: "2026-10-20T12:00:00.000Z",
      to: "2026-10-22T12:00:00.000Z",
    });
  });

  it("gives a lone bound the default span on the other side", () => {
    expect(resolveRoutineTimelineWindow({ from: "2026-10-01T00:00:00.000Z" }, NOW)).toEqual({
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-10-03T00:00:00.000Z",
    });
    expect(resolveRoutineTimelineWindow({ to: "2026-10-03T00:00:00.000Z" }, NOW)).toEqual({
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-10-03T00:00:00.000Z",
    });
  });

  it("keeps both bounds as sent, normalised to UTC", () => {
    expect(
      resolveRoutineTimelineWindow({ from: "2026-10-21T10:00:00+02:00", to: "2026-10-21T20:00:00+02:00" }, NOW),
    ).toEqual({ from: "2026-10-21T08:00:00.000Z", to: "2026-10-21T18:00:00.000Z" });
  });

  it("refuses a window that is empty or runs backwards", () => {
    const at = "2026-10-21T00:00:00.000Z";
    expect(() => resolveRoutineTimelineWindow({ from: at, to: at }, NOW)).toThrow("`to` must be after `from`");
    expect(() => resolveRoutineTimelineWindow({ from: "2026-10-22T00:00:00.000Z", to: at }, NOW)).toThrow();
  });

  it("allows exactly the longest window and refuses one millisecond more", () => {
    const from = new Date("2026-10-01T00:00:00.000Z");
    const edge = new Date(from.getTime() + ROUTINE_TIMELINE_MAX_WINDOW_DAYS * DAY_MS);
    expect(resolveRoutineTimelineWindow({ from: from.toISOString(), to: edge.toISOString() }, NOW).to).toBe(edge.toISOString());
    expect(() =>
      resolveRoutineTimelineWindow({ from: from.toISOString(), to: new Date(edge.getTime() + 1).toISOString() }, NOW),
    ).toThrow(`at most ${ROUTINE_TIMELINE_MAX_WINDOW_DAYS} days`);
  });
});

describe("routineTimelineQuerySchema", () => {
  it("accepts instants with an offset and none at all", () => {
    expect(routineTimelineQuerySchema.safeParse({}).success).toBe(true);
    expect(routineTimelineQuerySchema.safeParse({ from: "2026-10-21T00:00:00Z", to: "2026-10-22T00:00:00+01:00" }).success).toBe(true);
  });

  it("refuses a date without a time or an offset", () => {
    expect(routineTimelineQuerySchema.safeParse({ from: "2026-10-21" }).success).toBe(false);
    expect(routineTimelineQuerySchema.safeParse({ to: "2026-10-21T00:00:00" }).success).toBe(false);
  });
});
