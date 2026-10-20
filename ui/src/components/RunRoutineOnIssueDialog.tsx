import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { RoutineListItem, RoutineStepWarning } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { ApiError } from "@/api/client";
import { routinesApi } from "@/api/routines";
import { RoutineStepWarnings } from "@/components/RoutineStepWarnings";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RadioCardGroup } from "@/components/ui/radio-card";
import { useToastActions } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { agentNameMap } from "@/lib/routine-step-warnings";

/** Routines a task can be run through: not archived, and with steps to attach. */
export function routinesWithSteps(routines: readonly RoutineListItem[] | undefined): RoutineListItem[] {
  return (routines ?? []).filter((routine) => routine.status !== "archived" && (routine.steps?.length ?? 0) > 0);
}

function describeRoutine(routine: RoutineListItem): string {
  const count = routine.steps?.length ?? 0;
  const steps = count === 1 ? "1 step" : `${count} steps`;
  return routine.status === "paused" ? `${steps} · paused` : steps;
}

/** What the board reads when the server refuses: the server's own explanation, else a fallback. */
export function runOnIssueErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.message) return error.message;
  return error instanceof Error && error.message
    ? error.message
    : "Paperclip could not attach the routine to this task.";
}

/**
 * "Run routine on this task": attaches the steps of a routine to an existing task as subtasks. The
 * server refuses a task that is in progress, has a live run or already has open steps (409), and
 * a routine without steps (422); the reason is shown in the dialog so the board can pick again.
 */
export function RunRoutineOnIssueDialog({
  open,
  onOpenChange,
  companyId,
  issue,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  issue: { id: string; identifier: string | null; title: string };
  onStarted?: () => void;
}) {
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const [routineId, setRoutineId] = useState("");
  const [warnings, setWarnings] = useState<RoutineStepWarning[]>([]);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRoutineId("");
    setWarnings([]);
    setStarted(false);
  }, [open]);

  const routinesQuery = useQuery({
    queryKey: queryKeys.routines.list(companyId),
    queryFn: () => routinesApi.list(companyId),
    enabled: open,
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: open,
  });
  const candidates = routinesWithSteps(routinesQuery.data);

  const run = useMutation({
    mutationFn: () => routinesApi.runOnIssue(routineId, issue.id),
    onSuccess: async (result) => {
      const resultWarnings = result.warnings ?? [];
      setStarted(true);
      setWarnings(resultWarnings);
      pushToast({ title: "Routine started on this task", tone: "success" });
      onStarted?.();
      void queryClient.invalidateQueries({ queryKey: queryKeys.routines.runs(routineId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routineId) });
      if (resultWarnings.length === 0) onOpenChange(false);
    },
  });

  const label = issue.identifier ? `${issue.identifier} ${issue.title}` : issue.title;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Run routine on this task</DialogTitle>
          <DialogDescription>
            Attach a routine’s steps to “{label}” as subtasks. A task assigned to an agent becomes blocked until the
            steps finish. A task assigned to a person keeps its status.
          </DialogDescription>
        </DialogHeader>

        {started ? (
          <RoutineStepWarnings outcome="run" warnings={warnings} agentNames={agentNameMap(agentsQuery.data)} />
        ) : routinesQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading routines…</p>
        ) : routinesQuery.isError ? (
          <p role="alert" className="text-sm text-destructive">
            Couldn’t load the routines. Close this dialog and try again.
          </p>
        ) : candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No routine has steps yet. Add steps to a routine on its{" "}
            <Link className="underline underline-offset-2" to="/routines">
              routine page
            </Link>
            , then run it here.
          </p>
        ) : (
          <RadioCardGroup
            ariaLabel="Routine to run"
            value={routineId}
            disabled={run.isPending}
            onValueChange={(next) => {
              run.reset();
              setRoutineId(next);
            }}
            options={candidates.map((routine) => ({
              value: routine.id,
              title: routine.title,
              description: describeRoutine(routine),
            }))}
          />
        )}

        {run.isError && (
          <p role="alert" className="text-sm text-destructive">
            {runOnIssueErrorMessage(run.error)}
          </p>
        )}

        <DialogFooter>
          {started ? (
            <Button size="sm" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button size="sm" disabled={!routineId || run.isPending} onClick={() => run.mutate()}>
                {run.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                Run routine
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
