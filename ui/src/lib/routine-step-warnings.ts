import type { RoutineStepWarning } from "@paperclipai/shared";

/**
 * Plain-language text for the non-blocking `step_agent_unavailable` warnings that routine saves and
 * routine runs return. Saving or running still succeeded; these say which step may not start.
 */

/** One entry per reason the server's agent-invokability check reports. */
const REASON_TEXT: Record<string, string> = {
  missing: "no longer exists",
  paused: "is paused",
  terminated: "was terminated",
  pending_approval: "is waiting for approval",
  unknown_status: "has a status that cannot take work",
  manager_missing: "reports to a manager that no longer exists",
  manager_company_mismatch: "reports to a manager in another company",
  manager_terminated: "reports to a terminated manager",
  reporting_cycle: "is in a reporting loop",
  reporting_chain_too_deep: "has a reporting chain that is too deep",
};

/** The agent the board sees: its name when known, else a short ID. */
function agentLabel(agentId: string, agentNames?: ReadonlyMap<string, string>): string {
  return agentNames?.get(agentId) ?? `agent ${agentId.slice(0, 8)}`;
}

/** One line per warning, for example `Step "build": Builder is paused.` */
export function describeStepWarning(
  warning: RoutineStepWarning,
  agentNames?: ReadonlyMap<string, string>,
): string {
  const reason = REASON_TEXT[warning.reason] ?? `cannot run (${warning.reason})`;
  return `Step “${warning.stepKey}”: ${agentLabel(warning.agentId, agentNames)} ${reason}.`;
}

/** Heading above the list of warnings. */
export function stepWarningsHeading(warnings: readonly RoutineStepWarning[]): string {
  return warnings.length === 1 ? "1 step may not start" : `${warnings.length} steps may not start`;
}

/** Toast content for a successful save or run that came back with warnings, or `null` for none. */
export function stepWarningsToast(
  warnings: readonly RoutineStepWarning[] | undefined,
  agentNames?: ReadonlyMap<string, string>,
): { title: string; body: string; tone: "warn" } | null {
  if (!warnings || warnings.length === 0) return null;
  return {
    title: stepWarningsHeading(warnings),
    body: warnings.map((warning) => describeStepWarning(warning, agentNames)).join(" "),
    tone: "warn",
  };
}

/** Agent ID to name lookup for the warning text. */
export function agentNameMap(agents: ReadonlyArray<{ id: string; name: string }> | undefined): Map<string, string> {
  return new Map((agents ?? []).map((agent) => [agent.id, agent.name]));
}
