import type { CompanyFocus, GoalProgress } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Flag, Target } from "lucide-react";
import { describeDaysLeft } from "../lib/goal-dates";
import { cn } from "../lib/utils";

function percentDone(progress: GoalProgress): number {
  return progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100);
}

function ProgressLine({ progress, label }: { progress: GoalProgress; label: string }) {
  const percent = percentDone(progress);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
      </div>
      <span className="text-xs text-muted-foreground">
        {progress.done}/{progress.total} done
      </span>
    </div>
  );
}

function DueLabel({ daysLeft }: { daysLeft: number | null }) {
  return (
    <span className={cn("text-xs", daysLeft !== null && daysLeft < 0 ? "text-destructive" : "text-muted-foreground")}>
      {describeDaysLeft(daysLeft)}
    </span>
  );
}

/**
 * The company's current focus: active short term goals and their open milestones.
 * Agents read the same data in their heartbeat context.
 */
export function GoalFocusPanel({ focus }: { focus: CompanyFocus }) {
  return (
    <section aria-label="Current focus" className="space-y-2 border border-border p-3">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <Target className="h-3.5 w-3.5" aria-hidden="true" />
        Current focus
      </div>
      {focus.goals.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No current focus. Set an active goal's horizon to short term, and agents will work on it first.
        </p>
      ) : (
        <ul className="space-y-3">
          {focus.goals.map((goal) => (
            <li key={goal.id} className="space-y-1">
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                <Link to={`/goals/${goal.id}`} className="min-w-0 truncate text-sm font-medium hover:underline">
                  {goal.title}
                </Link>
                <ProgressLine progress={goal.progress} label={`${goal.title} progress`} />
                <DueLabel daysLeft={goal.daysLeft} />
              </div>
              {goal.successCriteria ? (
                <p className="text-xs text-muted-foreground">Target: {goal.successCriteria}</p>
              ) : null}
              {goal.milestones.length > 0 ? (
                <ul className="space-y-1 pl-4">
                  {goal.milestones.map((milestone) => (
                    <li key={milestone.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                      <Flag className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <Link to={`/goals/${milestone.id}`} className="min-w-0 truncate text-xs hover:underline">
                        {milestone.title}
                      </Link>
                      <span className="text-xs text-muted-foreground">
                        {milestone.progress.done}/{milestone.progress.total} done
                      </span>
                      <DueLabel daysLeft={milestone.daysLeft} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
