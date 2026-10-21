import { useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import {
  OPEN_ISSUE_STATUSES,
  goalAgentLinks,
  type Goal,
  type GoalAgentLink,
  type ProjectGoalRef,
} from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { agentsApi } from "../api/agents";
import { goalsApi } from "../api/goals";
import { issuesApi } from "../api/issues";
import { routinesApi } from "../api/routines";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "./StatusBadge";

/** One goal of a project, with the project's own work for that goal. */
export interface ProjectGoalSummary {
  goalId: string;
  title: string;
  status: Goal["status"] | null;
  openTaskCount: number;
  routineCount: number;
  agents: GoalAgentLink[];
}

/** The work of one project, grouped by goal. */
export interface ProjectGoalSummaryInput {
  goalRefs: ReadonlyArray<ProjectGoalRef>;
  goals: ReadonlyArray<Pick<Goal, "id" | "title" | "status" | "ownerAgentId">>;
  tasks: ReadonlyArray<{ goalId: string | null; assigneeAgentId: string | null; status: string }>;
  routines: ReadonlyArray<{ goalId: string | null; assigneeAgentId: string | null; status: string }>;
}

/**
 * Groups a project's open tasks and routines under each goal the project links. Only work whose own
 * goal is that goal counts; archived routines do not count. A goal missing from `goals` keeps the
 * title of the project's goal reference.
 * @param input The project's goal references, the company goals, and the project's tasks and routines.
 * @returns One summary per linked goal, in the project's goal order.
 * @example projectGoalSummaries({ goalRefs: [{ id: "g1", title: "Beta" }], goals: [], tasks: [], routines: [] })
 * // [{ goalId: "g1", title: "Beta", status: null, openTaskCount: 0, routineCount: 0, agents: [] }]
 */
export function projectGoalSummaries(input: ProjectGoalSummaryInput): ProjectGoalSummary[] {
  const goalById = new Map(input.goals.map((goal) => [goal.id, goal]));
  return input.goalRefs.map((ref) => {
    const goal = goalById.get(ref.id);
    const tasks = input.tasks.filter((task) => task.goalId === ref.id);
    const routines = input.routines.filter((routine) => routine.goalId === ref.id && routine.status !== "archived");
    return {
      goalId: ref.id,
      title: goal?.title ?? ref.title,
      status: goal?.status ?? null,
      openTaskCount: tasks.length,
      routineCount: routines.length,
      agents: goalAgentLinks({ ownerAgentId: goal?.ownerAgentId ?? null, tasks, routines }),
    };
  });
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export interface ProjectGoalsSectionProps {
  companyId: string;
  projectId: string;
  goalRefs: ReadonlyArray<ProjectGoalRef>;
  /** Saves the project's new goal list; absent for a project that cannot change, such as an archived one. */
  onGoalIdsChange?: (goalIds: string[]) => Promise<unknown>;
}

/**
 * The project Configuration tab's goals: link and unlink the goals the project serves, and see the
 * project's open tasks and routines for each goal and the agents of that work. The goal page lists
 * the goal's work across every project.
 */
export function ProjectGoalsSection({ companyId, projectId, goalRefs, onGoalIdsChange }: ProjectGoalsSectionProps) {
  const hasGoals = goalRefs.length > 0;
  const goalsQuery = useQuery({
    queryKey: queryKeys.goals.list(companyId),
    queryFn: () => goalsApi.list(companyId),
    enabled: hasGoals || Boolean(onGoalIdsChange),
  });
  const tasksQuery = useQuery({
    queryKey: queryKeys.issues.listOpenByProject(companyId, projectId),
    queryFn: () => issuesApi.listAll(companyId, { projectId, status: OPEN_ISSUE_STATUSES.join(",") }),
    enabled: hasGoals,
  });
  // Shares the routines section's query, so the page reads the project's routines once.
  const routinesQuery = useQuery({
    queryKey: queryKeys.routines.list(companyId, { projectId }),
    queryFn: () => routinesApi.list(companyId, { projectId }),
    enabled: hasGoals,
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: hasGoals,
  });
  const saveGoals = useMutation({
    mutationFn: (goalIds: string[]) => onGoalIdsChange!(goalIds),
  });

  const summaries = useMemo(
    () =>
      projectGoalSummaries({
        goalRefs,
        goals: goalsQuery.data ?? [],
        tasks: tasksQuery.data ?? [],
        routines: routinesQuery.data ?? [],
      }),
    [goalRefs, goalsQuery.data, tasksQuery.data, routinesQuery.data],
  );
  const linkedIds = goalRefs.map((ref) => ref.id);
  const linkableGoals = (goalsQuery.data ?? []).filter((goal) => goal.status !== "cancelled" && !linkedIds.includes(goal.id));
  const agentNameById = useMemo(() => new Map((agents ?? []).map((agent) => [agent.id, agent.name])), [agents]);
  const loadError = goalsQuery.error ?? tasksQuery.error ?? routinesQuery.error;
  const loading = hasGoals && (goalsQuery.isLoading || tasksQuery.isLoading || routinesQuery.isLoading);
  const canChange = Boolean(onGoalIdsChange) && !saveGoals.isPending;

  return (
    <section className="space-y-3" aria-labelledby="project-goals-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="project-goals-heading" className="text-xs text-muted-foreground">Goals</h3>
        {onGoalIdsChange && linkableGoals.length > 0 ? (
          <Select value="" onValueChange={(goalId) => saveGoals.mutate([...linkedIds, goalId])} disabled={!canChange}>
            <SelectTrigger size="sm" aria-label="Link a goal" className="w-auto">
              <SelectValue placeholder="Link goal" />
            </SelectTrigger>
            <SelectContent>
              {linkableGoals.map((goal) => (
                <SelectItem key={goal.id} value={goal.id}>{goal.title}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>

      {saveGoals.error ? (
        <p role="alert" className="text-sm text-destructive">Failed to change the project's goals: {saveGoals.error.message}</p>
      ) : null}
      {loadError ? (
        <p role="alert" className="text-sm text-destructive">Failed to load the project's goals: {loadError.message}</p>
      ) : null}

      {!hasGoals ? (
        <p className="rounded-lg border border-border px-3 py-4 text-sm text-muted-foreground">This project serves no goal yet.</p>
      ) : loading ? (
        <p className="text-sm text-muted-foreground">Loading goals...</p>
      ) : (
        <div className="rounded-lg border border-border">
          {summaries.map((summary) => {
            const agentNames = summary.agents.map((link) => agentNameById.get(link.agentId) ?? link.agentId);
            const details = [
              countLabel(summary.openTaskCount, "open task"),
              countLabel(summary.routineCount, "routine"),
              agentNames.length > 0 ? `Agents: ${agentNames.join(", ")}` : "No agents yet",
            ].join(" · ");
            return (
              <div key={summary.goalId} className="flex items-center gap-3 border-b border-border px-4 py-2 text-sm last:border-b-0">
                <div className="min-w-0 flex-1">
                  <Link to={`/goals/${summary.goalId}`} className="block truncate hover:underline">
                    {summary.title}
                  </Link>
                  <p className="mt-0.5 text-xs text-muted-foreground">{details}</p>
                </div>
                {summary.status ? <StatusBadge status={summary.status} /> : null}
                {onGoalIdsChange ? (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Unlink goal ${summary.title}`}
                    disabled={!canChange}
                    onClick={() => saveGoals.mutate(linkedIds.filter((id) => id !== summary.goalId))}
                  >
                    <X />
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
