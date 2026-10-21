import { Plus, X } from "lucide-react";
import {
  ISSUE_PRIORITIES,
  ROUTINE_STEP_CONDITIONS,
  ROUTINE_STEP_SKIPPED_COMMENT,
  routineStepPredecessorKeys,
  routineStepsHaveConditions,
  type RoutineStep,
} from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  addRoutineStep,
  canRoutineStepWaitFor,
  removeRoutineStep,
  renameRoutineStepKey,
  routineStepCondition,
  routineStepOutcomeLabel,
  routineStepsIssues,
  setRoutineStepCondition,
  toggleRoutineStepPredecessor,
  updateRoutineStep,
} from "../lib/routine-steps";
import { InlineEntitySelector, type InlineEntityOption } from "./InlineEntitySelector";
import { MarkdownEditor, type MentionOption } from "./MarkdownEditor";

const INHERIT_PRIORITY = "inherit";
/** The select value of an edge without a condition: wait until the other step is done. */
const PLAIN_EDGE = "plain";

export function RoutineStepsEditor({
  steps,
  onChange,
  agentOptions,
  defaultAgentName,
  mentionOptions,
}: {
  steps: RoutineStep[];
  onChange: (steps: RoutineStep[]) => void;
  agentOptions: InlineEntityOption[];
  /** The routine's own agent, which a step without an agent runs as; null when it has none. */
  defaultAgentName: string | null;
  mentionOptions: MentionOption[];
}) {
  const issues = routineStepsIssues(steps);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-md border border-border bg-muted/20 px-4 py-3 text-xs">
        <span className="flex-1 text-muted-foreground">
          Each run creates one task per step under the run&apos;s task. A step with nothing in
          &ldquo;Starts after&rdquo; begins at once; the others begin when the steps they wait for are
          done, or, with a condition, only when those steps end the way it asks. Steps can use{" "}
          <code className="font-mono">{"{{placeholders}}"}</code> like the instructions do.
        </span>
        <Button variant="secondary" size="sm" onClick={() => onChange(addRoutineStep(steps))}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Add step
        </Button>
      </div>

      {issues.length > 0 ? (
        <ul className="space-y-1 text-xs text-destructive" aria-label="Step problems">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : null}

      {steps.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No steps. Each run creates a single task from the instructions.
        </p>
      ) : (
        <ol className="space-y-4">
          {steps.map((step, index) => (
            <StepCard
              key={index}
              index={index}
              step={step}
              steps={steps}
              onChange={onChange}
              agentOptions={agentOptions}
              defaultAgentName={defaultAgentName}
              mentionOptions={mentionOptions}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

function StepCard({
  index,
  step,
  steps,
  onChange,
  agentOptions,
  defaultAgentName,
  mentionOptions,
}: {
  index: number;
  step: RoutineStep;
  steps: RoutineStep[];
  onChange: (steps: RoutineStep[]) => void;
  agentOptions: InlineEntityOption[];
  defaultAgentName: string | null;
  mentionOptions: MentionOption[];
}) {
  const others = steps.filter((other) => other.key !== step.key);
  const predecessorKeys = routineStepPredecessorKeys(step);
  const waitsFor = new Set(predecessorKeys);
  const needsAgent = !step.assigneeAgentId && defaultAgentName === null;
  const inputId = `routine-step-${index}`;

  return (
    <li className="space-y-3 rounded-md border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">Step {index + 1}</Badge>
        <Input
          aria-label={`Key of step ${index + 1}`}
          className="h-8 w-40 font-mono text-xs"
          value={step.key}
          onChange={(event) => onChange(renameRoutineStepKey(steps, step.key, event.target.value))}
        />
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto"
          aria-label={`Remove step ${index + 1}`}
          onClick={() => onChange(removeRoutineStep(steps, step.key))}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${inputId}-title`}>Title</Label>
        <Input
          id={`${inputId}-title`}
          value={step.title}
          onChange={(event) => onChange(updateRoutineStep(steps, step.key, { title: event.target.value }))}
        />
      </div>

      <div className="space-y-1.5">
        <Label>Instructions</Label>
        <div className="rounded-md border border-border px-3 py-2">
          <MarkdownEditor
            value={step.description ?? ""}
            onChange={(description) =>
              onChange(updateRoutineStep(steps, step.key, { description: description || undefined }))
            }
            placeholder="What this step should do..."
            bordered={false}
            contentClassName="min-h-(--sz-120px) text-sm leading-7"
            mentions={mentionOptions}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1.5">
          <Label>Agent</Label>
          <div>
            <InlineEntitySelector
              value={step.assigneeAgentId ?? ""}
              options={agentOptions}
              placeholder={defaultAgentName ? `Routine's agent (${defaultAgentName})` : "Choose an agent"}
              noneLabel={defaultAgentName ? `Routine's agent (${defaultAgentName})` : "No agent"}
              searchPlaceholder="Search agents..."
              emptyMessage="No agents found."
              onChange={(assigneeAgentId) =>
                onChange(updateRoutineStep(steps, step.key, { assigneeAgentId: assigneeAgentId || undefined }))
              }
              mobileTitle="Agent for this step"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>Priority</Label>
          <Select
            value={step.priority ?? INHERIT_PRIORITY}
            onValueChange={(priority) =>
              onChange(
                updateRoutineStep(steps, step.key, {
                  priority: priority === INHERIT_PRIORITY ? undefined : ISSUE_PRIORITIES.find((value) => value === priority),
                }),
              )
            }
          >
            <SelectTrigger aria-label={`Priority of step ${index + 1}`} className="min-w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={INHERIT_PRIORITY}>Routine&apos;s priority</SelectItem>
              {ISSUE_PRIORITIES.map((priority) => (
                <SelectItem key={priority} value={priority}>
                  {priority}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {needsAgent ? (
        <p className="text-xs text-destructive">
          Choose an agent for this step, or set a default agent on the routine.
        </p>
      ) : null}

      <div className="space-y-1.5">
        <Label>Starts after</Label>
        {others.length === 0 ? (
          <p className="text-xs text-muted-foreground">Add another step to make this one wait for it.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {others.map((other) => {
              const selected = waitsFor.has(other.key);
              const allowed = selected || canRoutineStepWaitFor(steps, step.key, other.key);
              return (
                <Button
                  key={other.key}
                  type="button"
                  size="sm"
                  variant={selected ? "secondary" : "outline"}
                  aria-pressed={selected}
                  disabled={!allowed}
                  className={cn("font-mono text-xs", !allowed && "opacity-50")}
                  onClick={() => onChange(toggleRoutineStepPredecessor(steps, step.key, other.key))}
                >
                  {other.key}
                </Button>
              );
            })}
          </div>
        )}
        {step.after.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing selected: this step starts with the run.</p>
        ) : null}
      </div>

      {predecessorKeys.length > 0 ? (
        <div className="space-y-1.5">
          <Label>Conditions</Label>
          <ul className="space-y-2">
            {predecessorKeys.map((predecessorKey) => {
              const predecessor = steps.find((other) => other.key === predecessorKey);
              const when = routineStepCondition(step, predecessorKey);
              return (
                <li key={predecessorKey} className="flex flex-wrap items-center gap-2">
                  <span className="min-w-24 font-mono text-xs">{predecessorKey}</span>
                  <Select
                    value={when ?? PLAIN_EDGE}
                    onValueChange={(value) =>
                      onChange(
                        setRoutineStepCondition(
                          steps,
                          step.key,
                          predecessorKey,
                          ROUTINE_STEP_CONDITIONS.find((condition) => condition === value) ?? null,
                        ),
                      )
                    }
                  >
                    <SelectTrigger
                      aria-label={`Condition on ${predecessorKey} for step ${index + 1}`}
                      className="min-w-56"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={PLAIN_EDGE}>
                        Wait until {routineStepOutcomeLabel(predecessor, "done")}
                      </SelectItem>
                      {ROUTINE_STEP_CONDITIONS.map((condition) => (
                        <SelectItem key={condition} value={condition}>
                          Only if {routineStepOutcomeLabel(predecessor, condition)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </li>
              );
            })}
          </ul>
          {routineStepsHaveConditions([step]) ? (
            <p className="text-xs text-muted-foreground">
              When no condition matches, this step is skipped (&ldquo;{ROUTINE_STEP_SKIPPED_COMMENT}&rdquo;), and so
              are the steps that only wait for it. &ldquo;Wait until&rdquo; keeps the step blocked if the other step is
              cancelled.
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
