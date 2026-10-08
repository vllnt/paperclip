import type { Agent } from "@paperclipai/shared";

type AgentWaitView = Pick<Agent, "status" | "waitState">;

/**
 * The status to show for an agent. With no live run but at least one active
 * wait the agent is "waiting", not "idle"; a live run still shows "running".
 * The stored status is unchanged.
 */
export function agentDisplayStatus(agent: AgentWaitView): string {
  const idle = agent.status === "idle" || agent.status === "active";
  return idle && (agent.waitState?.activeWaitCount ?? 0) > 0 ? "waiting" : agent.status;
}

/** Tooltip for a waiting agent, e.g. "Waiting on 2 issues, next check at 01:20". */
export function agentWaitTitle(agent: AgentWaitView): string | undefined {
  if (agentDisplayStatus(agent) !== "waiting" || !agent.waitState) return undefined;
  const count = agent.waitState.activeWaitCount;
  const subject = `Waiting on ${count} ${count === 1 ? "issue" : "issues"}`;
  if (!agent.waitState.nextCheckAt) return subject;
  const nextCheck = new Date(agent.waitState.nextCheckAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${subject}, next check at ${nextCheck}`;
}
