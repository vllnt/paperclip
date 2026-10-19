import type { GoalHorizon } from "@paperclipai/shared";

/** Formats a calendar date (`YYYY-MM-DD`) without shifting it into the viewer's time zone. */
export function formatTargetDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** "7 days left", "due today", "1 day overdue", or "No date". */
export function describeDaysLeft(daysLeft: number | null): string {
  if (daysLeft === null) return "No date";
  if (daysLeft === 0) return "Due today";
  const days = Math.abs(daysLeft);
  const unit = days === 1 ? "day" : "days";
  return daysLeft > 0 ? `${days} ${unit} left` : `${days} ${unit} overdue`;
}

export const GOAL_HORIZON_LABELS: Record<GoalHorizon, string> = {
  short: "Short term",
  medium: "Medium term",
  long: "Long term",
};
