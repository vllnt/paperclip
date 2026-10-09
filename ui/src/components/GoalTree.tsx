import type { Goal, GoalProgress } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { StatusBadge } from "./StatusBadge";
import { ChevronRight, Flag } from "lucide-react";
import { GOAL_HORIZON_LABELS, formatTargetDate } from "../lib/goal-dates";
import { cn } from "../lib/utils";
import { useState } from "react";

interface GoalTreeProps {
  goals: Goal[];
  goalLink?: (goal: Goal) => string;
  onSelect?: (goal: Goal) => void;
  /** Task progress keyed by goal id. */
  progress?: Record<string, GoalProgress>;
}

interface GoalNodeProps {
  goal: Goal;
  children: Goal[];
  allGoals: Goal[];
  depth: number;
  goalLink?: (goal: Goal) => string;
  onSelect?: (goal: Goal) => void;
  progress?: Record<string, GoalProgress>;
}

function GoalNode({ goal, children, allGoals, depth, goalLink, onSelect, progress }: GoalNodeProps) {
  const goalProgress = progress?.[goal.id];
  const [expanded, setExpanded] = useState(true);
  const hasChildren = children.length > 0;
  const link = goalLink?.(goal);

  const inner = (
    <>
      {hasChildren ? (
        <button
          className="p-0.5"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setExpanded(!expanded);
          }}
          aria-label={`${goal.title} subtree`}
          aria-expanded={expanded}
        >
          <ChevronRight
            className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")}
          />
        </button>
      ) : (
        <span className="w-4" />
      )}
      <span className="text-xs text-muted-foreground capitalize">{goal.level}</span>
      {goal.kind === "milestone" ? (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Flag className="h-3 w-3" aria-hidden="true" />
          Milestone
        </span>
      ) : null}
      <span className="flex-1 truncate">{goal.title}</span>
      {goal.horizon ? <span className="text-xs text-muted-foreground">{GOAL_HORIZON_LABELS[goal.horizon]}</span> : null}
      {goal.targetDate ? <span className="text-xs text-muted-foreground">{formatTargetDate(goal.targetDate)}</span> : null}
      {goalProgress && goalProgress.total > 0 ? (
        <span className="text-xs text-muted-foreground" title="Tasks done">{goalProgress.done}/{goalProgress.total}</span>
      ) : null}
      <StatusBadge status={goal.status} />
    </>
  );

  const classes = cn(
    "flex items-center gap-2 px-3 py-1.5 text-sm transition-colors cursor-pointer hover:bg-accent/50",
  );

  return (
    <div>
      {link ? (
        <Link
          to={link}
          className={cn(classes, "no-underline text-inherit")}
          style={{ paddingLeft: `${depth * 16 + 12}px` }}
        >
          {inner}
        </Link>
      ) : (
        <div
          className={classes}
          style={{ paddingLeft: `${depth * 16 + 12}px` }}
          onClick={() => onSelect?.(goal)}
        >
          {inner}
        </div>
      )}
      {hasChildren && expanded && (
        <div>
          {children.map((child) => (
            <GoalNode
              key={child.id}
              goal={child}
              children={allGoals.filter((g) => g.parentId === child.id)}
              allGoals={allGoals}
              depth={depth + 1}
              goalLink={goalLink}
              onSelect={onSelect}
              progress={progress}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function GoalTree({ goals, goalLink, onSelect, progress }: GoalTreeProps) {
  const goalIds = new Set(goals.map((g) => g.id));
  const roots = goals.filter((g) => !g.parentId || !goalIds.has(g.parentId));

  if (goals.length === 0) {
    return <p className="text-sm text-muted-foreground">No goals.</p>;
  }

  return (
    <div className="border border-border py-1">
      {roots.map((goal) => (
        <GoalNode
          key={goal.id}
          goal={goal}
          children={goals.filter((g) => g.parentId === goal.id)}
          allGoals={goals}
          depth={0}
          goalLink={goalLink}
          onSelect={onSelect}
          progress={progress}
        />
      ))}
    </div>
  );
}
