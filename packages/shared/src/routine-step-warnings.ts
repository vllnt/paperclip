/**
 * A non-blocking warning about a routine's steps. Saving or running still succeeds; the board and
 * agents are told that a step may not start.
 */
export const ROUTINE_STEP_WARNING_CODES = ["step_agent_unavailable"] as const;
export type RoutineStepWarningCode = (typeof ROUTINE_STEP_WARNING_CODES)[number];

export interface RoutineStepWarning {
  code: RoutineStepWarningCode;
  stepKey: string;
  agentId: string;
  /**
   * Why the agent cannot start work now: the reason the agent invokability check reports, for example
   * `paused`, `pending_approval`, `terminated`, `missing` or `manager_terminated`.
   */
  reason: string;
}

/** A response body that carries the step warnings of the save or run it answers; empty when there are none. */
export type WithRoutineStepWarnings<T> = T & { warnings: RoutineStepWarning[] };
