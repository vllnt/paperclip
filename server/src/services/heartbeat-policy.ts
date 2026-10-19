import { agents } from "@paperclipai/db";
import { automationWakeSettingsSchema, type AutomationWakeSettings } from "@paperclipai/shared";
import { asBoolean, parseObject } from "../adapters/utils.js";

/** Reads the agent layer of the automation-wake window; invalid settings mean off. */
export function readAgentAutomationWakeSettings(heartbeat: Record<string, unknown>): AutomationWakeSettings {
  const parsed = automationWakeSettingsSchema.safeParse({
    minSecondsBetweenAutomationWakes: heartbeat.minSecondsBetweenAutomationWakes,
    byWakeReason: heartbeat.byWakeReason,
  });
  return parsed.success ? parsed.data : {};
}

export function isHeartbeatWakeOnDemandEnabled(
  agent: Pick<typeof agents.$inferSelect, "runtimeConfig">,
) {
  const runtimeConfig = parseObject(agent.runtimeConfig);
  const heartbeat = parseObject(runtimeConfig.heartbeat);
  return asBoolean(
    heartbeat.wakeOnDemand ??
      heartbeat.wakeOnAssignment ??
      heartbeat.wakeOnOnDemand ??
      heartbeat.wakeOnAutomation,
    true,
  );
}
