import { useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import type { Goal } from "@paperclipai/shared";
import { GOAL_STATUSES, GOAL_LEVELS, GOAL_KINDS, GOAL_HORIZONS } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { goalsApi } from "../api/goals";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "./StatusBadge";
import { InlineEditor } from "./InlineEditor";
import { GOAL_HORIZON_LABELS, formatTargetDate } from "../lib/goal-dates";
import { formatDate, cn, agentUrl } from "../lib/utils";
import { Separator } from "@/components/ui/separator";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";

interface GoalPropertiesProps {
  goal: Goal;
  onUpdate?: (data: Record<string, unknown>) => void;
}

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="text-xs text-muted-foreground shrink-0 w-20 mt-0.5">{label}</span>
      <div className="flex items-center gap-1.5 min-w-0 flex-1 flex-wrap">{children}</div>
    </div>
  );
}

function label(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function horizonLabel(value: string): string {
  return value === "short" || value === "medium" || value === "long" ? GOAL_HORIZON_LABELS[value] : "No horizon";
}

function PickerButton({
  current,
  options,
  onChange,
  children,
  optionLabel = label,
}: {
  current: string;
  options: readonly string[];
  onChange: (value: string) => void;
  children: React.ReactNode;
  optionLabel?: (value: string) => string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="cursor-pointer hover:opacity-80 transition-opacity">
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-40 p-1" align="end">
        {options.map((opt) => (
          <Button
            key={opt}
            variant="ghost"
            size="sm"
            className={cn("w-full justify-start text-xs", opt === current && "bg-accent")}
            onClick={() => {
              onChange(opt);
              setOpen(false);
            }}
          >
            {optionLabel(opt)}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

export function GoalProperties({ goal, onUpdate }: GoalPropertiesProps) {
  const { selectedCompanyId } = useCompany();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: allGoals } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: progressByGoal } = useQuery({
    queryKey: queryKeys.goals.progress(selectedCompanyId!),
    queryFn: () => goalsApi.progress(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const progress = progressByGoal?.[goal.id];

  const ownerAgent = goal.ownerAgentId
    ? agents?.find((a) => a.id === goal.ownerAgentId)
    : null;

  const parentGoal = goal.parentId
    ? allGoals?.find((g) => g.id === goal.parentId)
    : null;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <PropertyRow label="Status">
          {onUpdate ? (
            <PickerButton
              current={goal.status}
              options={GOAL_STATUSES}
              onChange={(status) => onUpdate({ status })}
            >
              <StatusBadge status={goal.status} />
            </PickerButton>
          ) : (
            <StatusBadge status={goal.status} />
          )}
        </PropertyRow>

        <PropertyRow label="Level">
          {onUpdate ? (
            <PickerButton
              current={goal.level}
              options={GOAL_LEVELS}
              onChange={(level) => onUpdate({ level })}
            >
              <span className="text-sm capitalize">{goal.level}</span>
            </PickerButton>
          ) : (
            <span className="text-sm capitalize">{goal.level}</span>
          )}
        </PropertyRow>

        <PropertyRow label="Kind">
          {onUpdate ? (
            <PickerButton current={goal.kind} options={GOAL_KINDS} onChange={(kind) => onUpdate({ kind })}>
              <span className="text-sm">{label(goal.kind)}</span>
            </PickerButton>
          ) : (
            <span className="text-sm">{label(goal.kind)}</span>
          )}
        </PropertyRow>

        <PropertyRow label="Horizon">
          {onUpdate ? (
            <PickerButton
              current={goal.horizon ?? "none"}
              options={[...GOAL_HORIZONS, "none"]}
              optionLabel={horizonLabel}
              onChange={(horizon) => onUpdate({ horizon: horizon === "none" ? null : horizon })}
            >
              <span className="text-sm">{horizonLabel(goal.horizon ?? "none")}</span>
            </PickerButton>
          ) : (
            <span className="text-sm">{horizonLabel(goal.horizon ?? "none")}</span>
          )}
        </PropertyRow>

        <PropertyRow label="Target date">
          {onUpdate ? (
            <input
              type="date"
              aria-label="Target date"
              className="h-7 rounded-md border border-border bg-background px-2 text-xs"
              value={goal.targetDate ?? ""}
              onChange={(event) => onUpdate({ targetDate: event.target.value || null })}
            />
          ) : (
            <span className="text-sm">{goal.targetDate ? formatTargetDate(goal.targetDate) : "None"}</span>
          )}
        </PropertyRow>

        <PropertyRow label="Target">
          {onUpdate ? (
            <InlineEditor
              value={goal.successCriteria ?? ""}
              onSave={(successCriteria) => onUpdate({ successCriteria: successCriteria.trim() || null })}
              className="text-sm"
              placeholder="How you know it is done"
              nullable
            />
          ) : (
            <span className="text-sm">{goal.successCriteria ?? "None"}</span>
          )}
        </PropertyRow>

        <PropertyRow label="Progress">
          <span className="text-sm">
            {progress ? `${progress.done}/${progress.total} done` : "No tasks yet"}
          </span>
        </PropertyRow>

        <PropertyRow label="Owner">
          {ownerAgent ? (
            <Link
              to={agentUrl(ownerAgent)}
              className="text-sm hover:underline"
            >
              {ownerAgent.name}
            </Link>
          ) : (
            <span className="text-sm text-muted-foreground">None</span>
          )}
        </PropertyRow>

        {goal.parentId && (
          <PropertyRow label="Parent Goal">
            <Link
              to={`/goals/${goal.parentId}`}
              className="text-sm hover:underline"
            >
              {parentGoal?.title ?? goal.parentId.slice(0, 8)}
            </Link>
          </PropertyRow>
        )}
      </div>

      <Separator />

      <div className="space-y-1">
        <PropertyRow label="Created">
          <span className="text-sm">{formatDate(goal.createdAt)}</span>
        </PropertyRow>
        <PropertyRow label="Updated">
          <span className="text-sm">{formatDate(goal.updatedAt)}</span>
        </PropertyRow>
      </div>
    </div>
  );
}
