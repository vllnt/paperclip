import { HttpError } from "../errors.js";

const BASE_DELAY_MS = 5 * 60_000;
const MAX_DELAY_MS = 60 * 60_000;
const MAX_DOUBLINGS = 4;

function readDetails(error: HttpError): Record<string, unknown> {
  return error.details && typeof error.details === "object" ? (error.details as Record<string, unknown>) : {};
}

/**
 * True when a monitor wake was refused for a reason that can clear: a budget
 * hard stop, or an agent that is not invokable right now (pending approval,
 * error, paused). The monitor then stays armed. A terminated agent never comes
 * back, so its monitor is cleared and stranded-issue recovery takes over.
 */
export function isRetryableMonitorWakeBlock(error: unknown): boolean {
  if (!(error instanceof HttpError) || error.status !== 409) return false;
  const details = readDetails(error);
  if (typeof details.scopeType === "string") return true;
  return typeof details.status === "string" && details.status !== "terminated";
}

/** Delay before the next try after n refused wakes: 5, 10, 20, 40, then 60 minutes. */
export function monitorWakeRetryDelayMs(refusedWakes: number): number {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(Math.max(0, refusedWakes), MAX_DOUBLINGS));
}
