import { describe, expect, it } from "vitest";
import { projectCronFires } from "./routine-fire-projection.js";
import { nextCronTickInTimeZone } from "./routines.js";

const iso = (dates: Date[]) => dates.map((date) => date.toISOString());

function project(expression: string, timeZone: string, after: string, until: string, limit = 500) {
  return projectCronFires({ expression, timeZone, after: new Date(after), until: new Date(until), limit });
}

/** The fires the scheduler itself would make: its own minute-by-minute tick, applied repeatedly. */
function schedulerFires(expression: string, timeZone: string, after: string, until: string): string[] {
  const out: string[] = [];
  let cursor = new Date(after);
  for (;;) {
    const next = nextCronTickInTimeZone(expression, timeZone, cursor);
    if (!next || next > new Date(until)) return out;
    out.push(next.toISOString());
    cursor = next;
  }
}

describe("projectCronFires", () => {
  it("lists a daily UTC schedule inside the window, after the start and up to the end", () => {
    const result = project("0 9 * * *", "UTC", "2026-10-21T09:00:00Z", "2026-10-24T09:00:00Z");
    expect(iso(result.fires)).toEqual([
      "2026-10-22T09:00:00.000Z",
      "2026-10-23T09:00:00.000Z",
      "2026-10-24T09:00:00.000Z",
    ]);
    expect(result.truncated).toBe(false);
  });

  it("reads the expression in the trigger's zone and follows its DST change", () => {
    // Europe/Paris leaves summer time on 2026-10-25: 09:00 is 07:00Z before and 08:00Z after.
    const result = project("0 9 * * *", "Europe/Paris", "2026-10-24T00:00:00Z", "2026-10-26T23:59:00Z");
    expect(iso(result.fires)).toEqual([
      "2026-10-24T07:00:00.000Z",
      "2026-10-25T08:00:00.000Z",
      "2026-10-26T08:00:00.000Z",
    ]);
  });

  it("handles a zone with a half-hour offset", () => {
    const result = project("30 8 * * *", "Asia/Kolkata", "2026-10-21T00:00:00Z", "2026-10-22T23:59:00Z");
    expect(iso(result.fires)).toEqual(["2026-10-21T03:00:00.000Z", "2026-10-22T03:00:00.000Z"]);
  });

  it("applies the day-of-week and day-of-month fields together, as the scheduler does", () => {
    // 2026-10-26 is a Monday; the 1st of November 2026 is a Sunday.
    const monday = project("0 9 * * 1", "UTC", "2026-10-21T00:00:00Z", "2026-11-05T00:00:00Z");
    expect(iso(monday.fires)).toEqual(["2026-10-26T09:00:00.000Z", "2026-11-02T09:00:00.000Z"]);
    const bothFields = project("0 9 1 * 1", "UTC", "2026-10-01T00:00:00Z", "2026-12-31T00:00:00Z");
    expect(bothFields.fires).toEqual([]);
  });

  it("never fires a wall-clock time that a DST change skips, and fires a repeated one twice", () => {
    // America/New_York: 02:30 does not exist on 2026-03-08; 01:30 happens twice on 2026-11-01.
    const skipped = project("30 2 * * *", "America/New_York", "2026-03-07T00:00:00Z", "2026-03-10T00:00:00Z");
    expect(iso(skipped.fires)).toEqual(["2026-03-07T07:30:00.000Z", "2026-03-09T06:30:00.000Z"]);
    const repeated = project("30 1 * * *", "America/New_York", "2026-10-31T00:00:00Z", "2026-11-02T12:00:00Z");
    expect(iso(repeated.fires)).toEqual([
      "2026-10-31T05:30:00.000Z",
      "2026-11-01T05:30:00.000Z",
      "2026-11-01T06:30:00.000Z",
      "2026-11-02T06:30:00.000Z",
    ]);
  });

  it("keeps the earliest fires when the limit is reached and says so", () => {
    const result = project("* * * * *", "UTC", "2026-10-21T00:00:00Z", "2026-10-28T00:00:00Z", 500);
    expect(result.fires).toHaveLength(500);
    expect(result.fires[0]!.toISOString()).toBe("2026-10-21T00:01:00.000Z");
    expect(result.fires[499]!.toISOString()).toBe("2026-10-21T08:20:00.000Z");
    expect(result.truncated).toBe(true);
  });

  it("is not truncated when the window holds exactly the limit", () => {
    const result = project("0 * * * *", "UTC", "2026-10-21T00:00:00Z", "2026-10-21T05:00:00Z", 5);
    expect(result.fires).toHaveLength(5);
    expect(result.truncated).toBe(false);
  });

  it("returns nothing for an invalid expression, an unknown zone or an empty window", () => {
    expect(project("not a cron", "UTC", "2026-10-21T00:00:00Z", "2026-10-22T00:00:00Z").fires).toEqual([]);
    expect(project("0 9 * * *", "Mars/Olympus", "2026-10-21T00:00:00Z", "2026-10-22T00:00:00Z").fires).toEqual([]);
    expect(project("0 9 * * *", "UTC", "2026-10-22T00:00:00Z", "2026-10-21T00:00:00Z").fires).toEqual([]);
    expect(project("0 9 * * *", "UTC", "2026-10-21T00:00:00Z", "2026-10-22T00:00:00Z", 0).fires).toEqual([]);
  });

  it("matches the scheduler's own minute-by-minute tick for a spread of schedules and zones", () => {
    const cases: Array<[string, string, string, string]> = [
      ["*/15 9-17 * * 1-5", "America/New_York", "2026-10-30T00:00:00Z", "2026-11-04T00:00:00Z"],
      ["0 0 * * *", "Australia/Lord_Howe", "2026-10-01T00:00:00Z", "2026-10-09T00:00:00Z"],
      ["45 23 * * 6", "Asia/Kathmandu", "2026-10-01T00:00:00Z", "2026-10-31T00:00:00Z"],
      ["0 */6 * * *", "Europe/London", "2026-10-24T00:00:00Z", "2026-10-28T00:00:00Z"],
      ["30 1 * * *", "America/New_York", "2026-10-31T00:00:00Z", "2026-11-03T00:00:00Z"],
      ["30 2 * * *", "America/New_York", "2026-03-06T00:00:00Z", "2026-03-11T00:00:00Z"],
      ["15 3 15 * *", "Pacific/Auckland", "2026-08-01T00:00:00Z", "2026-12-31T00:00:00Z"],
    ];
    for (const [expression, timeZone, after, until] of cases) {
      expect(iso(project(expression, timeZone, after, until).fires), `${expression} ${timeZone}`).toEqual(
        schedulerFires(expression, timeZone, after, until),
      );
    }
  });
});
