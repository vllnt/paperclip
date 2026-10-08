import { z } from "zod";

/** Shortest delay an agent may wait before its issue is re-checked. */
export const ISSUE_WAIT_MIN_DELAY_MS = 60_000;
/** Longest delay an agent may wait before its issue is re-checked. */
export const ISSUE_WAIT_MAX_DELAY_MS = 24 * 60 * 60_000;
/** Longest wait reason; the reason is shown on the issue and in the wake. */
export const ISSUE_WAIT_REASON_MAX_LENGTH = 400;

const DURATION_RE = /^(?:\d+[smh])+$/;
const DURATION_PART_RE = /(\d+)([smh])/g;

/**
 * Parses a wait duration such as `90s`, `10m`, `2h` or `1h30m`. A number is
 * read as seconds.
 *
 * @param input - Duration text, or a number of seconds.
 * @returns The duration in milliseconds, or null when it is not a positive duration.
 * @example parseIssueWaitDurationMs("1h30m") // 5_400_000
 */
export function parseIssueWaitDurationMs(input: string | number): number | null {
  if (typeof input === "number") {
    return Number.isInteger(input) && input > 0 ? input * 1_000 : null;
  }
  const text = input.trim().toLowerCase();
  if (!DURATION_RE.test(text)) return null;
  let total = 0;
  for (const [, amount, unit] of text.matchAll(DURATION_PART_RE)) {
    const unitMs = unit === "h" ? 60 * 60_000 : unit === "m" ? 60_000 : 1_000;
    total += Number(amount) * unitMs;
  }
  return total > 0 ? total : null;
}

export const issueWaitRequestSchema = z.object({
  in: z
    .union([z.string(), z.number()])
    .refine((value) => {
      const ms = parseIssueWaitDurationMs(value);
      return ms !== null && ms >= ISSUE_WAIT_MIN_DELAY_MS && ms <= ISSUE_WAIT_MAX_DELAY_MS;
    }, { message: "Wait between 1m and 24h, e.g. 10m, 90s or 1h30m" }),
  reason: z.string().trim().min(1).max(ISSUE_WAIT_REASON_MAX_LENGTH),
});

export type IssueWaitRequest = z.infer<typeof issueWaitRequestSchema>;
