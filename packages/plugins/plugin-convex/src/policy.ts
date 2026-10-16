import { HOUR_MS } from "./contracts.js";

/** An expiry sooner than this would make Convex delete a guarded preview before the next hourly pass could see a redeploy, so the reaper never schedules it. */
export const MIN_PLANNED_LEAD_MS = 2 * HOUR_MS;
/** Expiries within this distance count as the same moment (Convex may round them). */
export const EXPIRY_TOLERANCE_MS = 5 * 60_000;

/**
 * The deadline the reaper gives a kept preview: lastDeployTime + ttl. When that is too close (or already past, for a guarded preview that
 * has been idle), a preview without an expiry gets now + ttl instead. The expiry guard for agents uses this same moment as part of its floor.
 */
export function reaperDeadline(now: number, lastActivity: number, ttlHours: number): number {
  const target = lastActivity + ttlHours * HOUR_MS;
  return target - now >= MIN_PLANNED_LEAD_MS ? target : now + ttlHours * HOUR_MS;
}
