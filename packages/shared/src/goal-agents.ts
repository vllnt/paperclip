import { OPEN_ISSUE_STATUSES } from "./constants.js";

/** Why an agent counts as working on a goal. */
export type GoalAgentReason = "owner" | "task" | "routine";

/** One agent linked to a goal, with every reason it is linked. */
export interface GoalAgentLink {
  agentId: string;
  reasons: GoalAgentReason[];
}

/** The work of one goal that links agents to it. */
export interface GoalAgentLinkInput {
  ownerAgentId: string | null;
  tasks: ReadonlyArray<{ assigneeAgentId: string | null; status: string }>;
  routines: ReadonlyArray<{ assigneeAgentId: string | null; status: string }>;
}

const openTaskStatuses: ReadonlySet<string> = new Set(OPEN_ISSUE_STATUSES);

/**
 * The agents linked to a goal. Agents are not stored on a goal: an agent is linked when it owns the
 * goal, is assigned an open task of the goal, or is the default agent of a routine of the goal that
 * is not archived. Pass the goal's own tasks and routines; sub-goals are not included.
 * @param input The goal's owner, tasks and routines.
 * @returns One entry per agent, owner first, then in the order the work names them.
 * @example goalAgentLinks({ ownerAgentId: "a1", tasks: [{ assigneeAgentId: "a2", status: "todo" }], routines: [] })
 * // [{ agentId: "a1", reasons: ["owner"] }, { agentId: "a2", reasons: ["task"] }]
 */
export function goalAgentLinks(input: GoalAgentLinkInput): GoalAgentLink[] {
  const links = new Map<string, GoalAgentReason[]>();
  const add = (agentId: string | null, reason: GoalAgentReason) => {
    if (!agentId) return;
    const reasons = links.get(agentId) ?? [];
    if (!reasons.includes(reason)) reasons.push(reason);
    links.set(agentId, reasons);
  };
  add(input.ownerAgentId, "owner");
  for (const task of input.tasks) {
    if (openTaskStatuses.has(task.status)) add(task.assigneeAgentId, "task");
  }
  for (const routine of input.routines) {
    if (routine.status !== "archived") add(routine.assigneeAgentId, "routine");
  }
  return [...links].map(([agentId, reasons]) => ({ agentId, reasons }));
}
