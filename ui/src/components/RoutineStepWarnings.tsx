import { AlertTriangle } from "lucide-react";
import type { RoutineStepWarning } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { describeStepWarning, stepWarningsHeading } from "@/lib/routine-step-warnings";
import { cn } from "@/lib/utils";

/**
 * Non-blocking warnings that a routine save or run returns for steps whose agent cannot start
 * work now. The save or run succeeded; this only says which step may not start.
 */
export function RoutineStepWarnings({
  warnings,
  agentNames,
  outcome = "save",
  className,
  onDismiss,
}: {
  warnings: readonly RoutineStepWarning[];
  agentNames?: ReadonlyMap<string, string>;
  /** What already succeeded, so the note says "saved" or "started" truthfully. */
  outcome?: "save" | "run";
  className?: string;
  onDismiss?: () => void;
}) {
  if (warnings.length === 0) return null;
  return (
    <div
      role="status"
      aria-label="Step warnings"
      className={cn("space-y-1.5 rounded-md border border-border bg-muted/40 p-3", className)}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-(--status-agent-paused)" aria-hidden="true" />
          {stepWarningsHeading(warnings)}
        </p>
        {onDismiss ? (
          <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
        ) : null}
      </div>
      <ul className="list-disc space-y-0.5 pl-6 text-xs text-muted-foreground">
        {warnings.map((warning) => (
          <li key={`${warning.stepKey}:${warning.agentId}`}>{describeStepWarning(warning, agentNames)}</li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        {outcome === "run" ? "The run started." : "The change was saved."} A step starts once its agent can
        run again.
      </p>
    </div>
  );
}
