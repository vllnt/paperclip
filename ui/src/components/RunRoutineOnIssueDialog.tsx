import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import {
  WORKSPACE_BRANCH_ROUTINE_VARIABLE,
  isBuiltinRoutineVariable,
  type RoutineListItem,
  type RoutineStepWarning,
  type RoutineVariable,
} from "@paperclipai/shared";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioCardGroup } from "@/components/ui/radio-card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToastActions } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { agentNameMap } from "@/lib/routine-step-warnings";

/** Routines a task can be run through: not archived, and with steps to attach. */
export function routinesWithSteps(routines: readonly RoutineListItem[] | undefined): RoutineListItem[] {
  return (routines ?? []).filter((routine) => routine.status !== "archived" && (routine.steps?.length ?? 0) > 0);
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

/**
 * The variables the board has to fill in before the routine can run: required, without a default,
 * and not a value Paperclip supplies itself. The server refuses a run that lacks one.
 */
export function variablesToAsk(routine: RoutineListItem | undefined): RoutineVariable[] {
  return (routine?.variables ?? []).filter(
    (variable) =>
      variable.required &&
      isBlank(variable.defaultValue) &&
      !isBuiltinRoutineVariable(variable.name) &&
      variable.name !== WORKSPACE_BRANCH_ROUTINE_VARIABLE,
  );
}

/** The entered text as the values to send: numbers and booleans in their own type, blanks left out. */
export function enteredVariableValues(
  variables: readonly RoutineVariable[],
  entered: Readonly<Record<string, string>>,
): Record<string, string | number | boolean> {
  const values: Record<string, string | number | boolean> = {};
  for (const variable of variables) {
    const text = entered[variable.name] ?? "";
    if (isBlank(text)) continue;
    if (variable.type === "number") {
      const number = Number(text);
      if (Number.isFinite(number)) values[variable.name] = number;
    } else {
      values[variable.name] = variable.type === "boolean" ? text === "true" : text;
    }
  }
  return values;
}

function VariableField({
  variable,
  value,
  disabled,
  onChange,
}: {
  variable: RoutineVariable;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const id = `run-on-task-variable-${variable.name}`;
  const choices = variable.type === "boolean" ? ["true", "false"] : variable.options;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{variable.label?.trim() || variable.name}</Label>
      {variable.type === "select" || variable.type === "boolean" ? (
        <Select value={value} onValueChange={onChange} disabled={disabled}>
          <SelectTrigger id={id} className="w-full">
            <SelectValue placeholder="Choose a value" />
          </SelectTrigger>
          <SelectContent>
            {choices.map((choice) => (
              <SelectItem key={choice} value={choice}>
                {choice}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : variable.type === "textarea" ? (
        <Textarea id={id} rows={3} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <Input
          id={id}
          type={variable.type === "number" ? "number" : variable.type === "date" ? "date" : "text"}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </div>
  );
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
  const [entered, setEntered] = useState<Record<string, string>>({});
  const [warnings, setWarnings] = useState<RoutineStepWarning[]>([]);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRoutineId("");
    setEntered({});
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
  const asked = variablesToAsk(candidates.find((routine) => routine.id === routineId));
  const values = enteredVariableValues(asked, entered);
  const complete = asked.every((variable) => variable.name in values);

  const run = useMutation({
    mutationFn: () => routinesApi.runOnIssue(routineId, issue.id, values),
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
              setEntered({});
              setRoutineId(next);
            }}
            options={candidates.map((routine) => ({
              value: routine.id,
              title: routine.title,
              description: describeRoutine(routine),
            }))}
          />
        )}

        {!started && asked.length > 0 && (
          <fieldset className="space-y-3" aria-label="Values for this run">
            <p className="text-sm text-muted-foreground">This routine needs these values to run.</p>
            {asked.map((variable) => (
              <VariableField
                key={variable.name}
                variable={variable}
                value={entered[variable.name] ?? ""}
                disabled={run.isPending}
                onChange={(next) => {
                  run.reset();
                  setEntered((current) => ({ ...current, [variable.name]: next }));
                }}
              />
            ))}
          </fieldset>
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
              <Button size="sm" disabled={!routineId || !complete || run.isPending} onClick={() => run.mutate()}>
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
