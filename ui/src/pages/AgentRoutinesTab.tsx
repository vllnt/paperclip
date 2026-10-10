import { useMemo, type ReactNode } from "react";
import { Routines } from "./Routines";

export interface AgentRoutinesTabProps {
  agentId: string;
  /** A built-in agent's managed routine controls, shown above its other routines. */
  builtInRoutine?: ReactNode;
  /** The managed routine's id, so the list below does not show it a second time. */
  managedRoutineId?: string | null;
}

/**
 * The agent page's Routines tab: the company's routine list fixed to this agent (search, filters,
 * group-by and New routine included), with a built-in agent's managed routine in the same place.
 */
export function AgentRoutinesTab({ agentId, builtInRoutine, managedRoutineId }: AgentRoutinesTabProps) {
  const excludeRoutineIds = useMemo(() => (managedRoutineId ? [managedRoutineId] : undefined), [managedRoutineId]);
  return (
    <div className="space-y-6">
      {builtInRoutine}
      <Routines embedded fixedAssigneeAgentId={agentId} excludeRoutineIds={excludeRoutineIds} />
    </div>
  );
}
