import { parseCron, type ParsedCron } from "./cron.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** The widest UTC offset a zone has is +14:00; a local day starts no earlier than this before its UTC reading. */
const MAX_OFFSET_MS = 14 * HOUR_MS;

// One formatter per zone: building one costs about a millisecond of ICU work, see the scheduler's own cache.
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    // `h23` keeps midnight at 0; `hour12: false` can print 24 in some ICU versions.
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall clock of `instant` in `timeZone`, read as if it were UTC (ms since the epoch). */
function localClockMs(instant: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const part of zonedFormatter(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!);
}

function floorToMinute(ms: number): number {
  return ms - (((ms % MINUTE_MS) + MINUTE_MS) % MINUTE_MS);
}

/** Zone offset at `instant` in ms (local clock minus UTC), at minute resolution. */
function offsetAt(instant: number, timeZone: string): number {
  return localClockMs(instant, timeZone) - floorToMinute(instant);
}

export interface ProjectCronFiresInput {
  expression: string;
  timeZone: string;
  /** Fires are strictly after this instant. */
  after: Date;
  /** Fires are at or before this instant. */
  until: Date;
  /** Most fires returned; the earliest win. */
  limit: number;
}

export interface ProjectedCronFires {
  fires: Date[];
  /** True when more fires existed in the window than `limit`. */
  truncated: boolean;
}

/**
 * The minutes a cron schedule fires in a time zone, in order. A minute fires when its wall clock in the zone
 * matches all five cron fields, which is the rule the scheduler applies minute by minute; this walks the
 * calendar days of the zone instead, so a sparse schedule over a month costs a few dozen zone lookups instead
 * of tens of thousands. A wall-clock time that a DST change skips never fires; one that it repeats fires twice.
 * An invalid expression or zone has no fires.
 */
export function projectCronFires(input: ProjectCronFiresInput): ProjectedCronFires {
  const none: ProjectedCronFires = { fires: [], truncated: false };
  const afterMs = input.after.getTime();
  const untilMs = input.until.getTime();
  if (input.limit <= 0 || !(untilMs > afterMs)) return none;

  let cron: ParsedCron;
  let firstLocalMs: number;
  try {
    cron = parseCron(input.expression);
    firstLocalMs = localClockMs(afterMs, input.timeZone);
  } catch {
    return none;
  }

  const found = new Set<number>();
  // One more than the limit tells whether the window held more.
  const wanted = input.limit + 1;
  // Start a day early: a DST change that sets the clock back at midnight puts a later instant on the day before.
  let dayStartMs = Math.floor(firstLocalMs / DAY_MS) * DAY_MS - DAY_MS;
  let daysAfterFull = 0;
  // A local day starts no earlier than MAX_OFFSET_MS before its UTC reading.
  while (dayStartMs - MAX_OFFSET_MS <= untilMs) {
    const day = new Date(dayStartMs);
    const matchesDay =
      cron.months.includes(day.getUTCMonth() + 1) &&
      cron.daysOfMonth.includes(day.getUTCDate()) &&
      cron.daysOfWeek.includes(day.getUTCDay());
    if (matchesDay) collectDay(cron, dayStartMs, input.timeZone, afterMs, untilMs, found);
    dayStartMs += DAY_MS;
    // Days overlap by a DST shift at most, so the day after the limit is reached settles the order.
    if (found.size >= wanted && (daysAfterFull += 1) > 1) break;
  }

  const ordered = [...found].sort((a, b) => a - b);
  return {
    fires: ordered.slice(0, input.limit).map((ms) => new Date(ms)),
    truncated: ordered.length > input.limit,
  };
}

/** Adds the instants of one local day (given as its midnight read as UTC) that fall in `(afterMs, untilMs]`. */
function collectDay(
  cron: ParsedCron,
  dayStartMs: number,
  timeZone: string,
  afterMs: number,
  untilMs: number,
  into: Set<number>,
): void {
  // The offset before and after any DST change that touches this day. They are equal on an ordinary day.
  const early = offsetAt(dayStartMs - MAX_OFFSET_MS, timeZone);
  const late = offsetAt(dayStartMs + DAY_MS + MAX_OFFSET_MS, timeZone);
  const offsets = early === late ? [early] : [early, late];
  for (const hour of cron.hours) {
    for (const minute of cron.minutes) {
      const localMs = dayStartMs + (hour * 60 + minute) * MINUTE_MS;
      for (const offset of offsets) {
        const instant = localMs - offset;
        if (instant <= afterMs || instant > untilMs) continue;
        // On a DST day each guess must show the wall clock it was made for; a skipped time matches neither.
        if (offsets.length > 1 && localClockMs(instant, timeZone) !== localMs) continue;
        into.add(instant);
      }
    }
  }
}
