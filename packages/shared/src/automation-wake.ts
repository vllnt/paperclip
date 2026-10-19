import { z } from "zod";

/** Wakes the server raises on its own to recover, retry or monitor an issue. */
export const AUTOMATION_WAKE_REASONS = [
  "issue_assignment_recovery",
  "issue_continuation_needed",
  "issue_graph_liveness_backstop",
  "issue_monitor_due",
  "issue_monitor_recovery",
  "issue_monitor_recovery_issue",
  "provider_quota_recovery",
  "ai_connection_busy_retry",
] as const;
export type AutomationWakeReason = (typeof AUTOMATION_WAKE_REASONS)[number];

export const MAX_MIN_SECONDS_BETWEEN_AUTOMATION_WAKES = 86_400;

const windowSecondsSchema = z.number().int().min(0).max(MAX_MIN_SECONDS_BETWEEN_AUTOMATION_WAKES);

/**
 * Automation-wake window settings, stored at company, agent and routine level.
 * `minSecondsBetweenAutomationWakes` is that level's window for every automation wake;
 * `byWakeReason` overrides it per wake type and, as the most specific layer, beats the
 * level-wide value of every level. Unset or 0 means off (the pre-feature behavior).
 */
export const automationWakeSettingsSchema = z.object({
  minSecondsBetweenAutomationWakes: windowSecondsSchema.optional(),
  byWakeReason: z.partialRecord(z.enum(AUTOMATION_WAKE_REASONS), windowSecondsSchema).optional(),
});
export type AutomationWakeSettings = z.infer<typeof automationWakeSettingsSchema>;
