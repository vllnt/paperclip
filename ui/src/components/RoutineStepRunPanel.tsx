import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Undo2 } from "lucide-react";
import type { RoutineStepRun, RoutineStepSendBack } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { issuesApi } from "../api/issues";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { issueUrl } from "../lib/utils";
import { StatusIcon } from "./StatusIcon";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Textarea } from "./ui/textarea";

/**
 * The run a routine step belongs to, on the step's page: every step with its status, the run's
 * send-backs, and a board form to send this step's work back to an earlier step it names in
 * `sendBackTo`.
 */
export function RoutineStepRunPanel({
  issueId,
  companyId,
  onSentBack,
}: {
  issueId: string;
  companyId: string;
  /** Fired after a send-back lands, so the page can refetch the step itself. */
  onSentBack?: () => void;
}) {
  const runQuery = useQuery({
    queryKey: queryKeys.issues.routineStep(issueId),
    queryFn: () => issuesApi.routineStep(issueId),
  });

  if (runQuery.error) {
    return (
      <p role="alert" className="rounded-lg border border-border px-3 py-2 text-xs text-destructive">
        Could not load the run of this step: {runQuery.error.message}
      </p>
    );
  }
  const run = runQuery.data;
  if (!run) return null;

  return (
    <section aria-label="Routine run" className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Routine run</h3>
        <Link to={`/routines/${run.routineId}`} className="text-xs text-muted-foreground hover:underline">
          Open routine
        </Link>
      </div>
      <ol className="space-y-1.5" aria-label="Steps of this run">
        {run.steps.map((step) => (
          <li key={step.key} className="flex min-w-0 items-center gap-2 text-sm">
            {step.status ? <StatusIcon status={step.status} size="sm" /> : null}
            <span className="shrink-0 font-mono text-xs text-muted-foreground">{step.key}</span>
            {step.issueId ? (
              <Link
                to={issueUrl({ id: step.issueId, identifier: step.identifier })}
                className="min-w-0 truncate hover:underline"
              >
                {step.title}
              </Link>
            ) : (
              <span className="min-w-0 truncate text-muted-foreground">{step.title}</span>
            )}
            {step.key === run.stepKey ? (
              <Badge variant="outline" className="shrink-0 font-normal">
                This step
              </Badge>
            ) : null}
          </li>
        ))}
      </ol>
      {run.sendBacks.length > 0 ? <SendBackHistory sendBacks={run.sendBacks} /> : null}
      {run.sendBackTo.length > 0 ? (
        <SendBackForm issueId={issueId} companyId={companyId} run={run} onSentBack={onSentBack} />
      ) : null}
    </section>
  );
}

function SendBackHistory({ sendBacks }: { sendBacks: RoutineStepSendBack[] }) {
  return (
    <div className="space-y-1">
      <h4 className="text-xs font-medium text-muted-foreground">Send-backs</h4>
      <ul className="space-y-1 text-xs" aria-label="Send-backs of this run">
        {sendBacks.map((entry) => (
          <li key={`${entry.at}-${entry.commentId ?? entry.fromStepKey}`} className="flex flex-wrap gap-x-1.5">
            <span className="font-mono">{entry.fromStepKey}</span>
            <span>
              {entry.outcome === "sent_back" ? "sent work back to" : "reached its limit for"}
            </span>
            <span className="font-mono">{entry.toStepKey}</span>
            <span className="text-muted-foreground">
              · {entry.actorType === "user" ? "by the board" : "by its agent"} · {timeAgo(entry.at)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SendBackForm({
  issueId,
  companyId,
  run,
  onSentBack,
}: {
  issueId: string;
  companyId: string;
  run: RoutineStepRun;
  onSentBack?: () => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [toStepKey, setToStepKey] = useState(run.sendBackTo[0]?.stepKey ?? "");
  const [comment, setComment] = useState("");
  const target = run.sendBackTo.find((entry) => entry.stepKey === toStepKey) ?? run.sendBackTo[0];
  const commentId = `routine-step-send-back-${issueId}`;

  const sendBack = useMutation({
    mutationFn: () => issuesApi.sendBackRoutineStep(issueId, { toStepKey, comment: comment.trim() }),
    onSuccess: (result) => {
      setComment("");
      queryClient.invalidateQueries({ queryKey: ["issues", "routine-step"] });
      for (const ref of [result.toIssueId, run.steps.find((step) => step.key === result.toStepKey)?.identifier]) {
        if (!ref) continue;
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(ref) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(ref) });
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
      pushToast({ title: `Sent back to ${result.toStepKey}`, tone: "success" });
      onSentBack?.();
    },
  });
  if (!target) return null;

  return (
    <form
      className="space-y-2 border-t border-border pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        sendBack.mutate();
      }}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium">Send this step&apos;s work back to</span>
        {run.sendBackTo.length > 1 ? (
          <Select value={toStepKey} onValueChange={setToStepKey}>
            <SelectTrigger aria-label="Step to send the work back to" size="sm" className="min-w-32 font-mono text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {run.sendBackTo.map((entry) => (
                <SelectItem key={entry.stepKey} value={entry.stepKey} className="font-mono text-xs">
                  {entry.stepKey}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="font-mono">{target.stepKey}</span>
        )}
        <span className="text-muted-foreground">
          · its agent has used {target.rounds} of {target.maxSendBacks} rounds
        </span>
      </div>
      <Label htmlFor={commentId} className="sr-only">
        What to fix
      </Label>
      <Textarea
        id={commentId}
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        placeholder="What the earlier step must fix…"
        className="min-h-16 text-sm"
        disabled={sendBack.isPending}
      />
      {sendBack.error ? (
        <p role="alert" className="text-xs text-destructive">
          {sendBack.error.message}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          The earlier step reopens with its agent; the steps after it wait for it again.
        </p>
        <Button type="submit" size="sm" variant="outline" disabled={sendBack.isPending || comment.trim().length === 0}>
          {sendBack.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Undo2 className="h-3.5 w-3.5" aria-hidden />
          )}
          Send back
        </Button>
      </div>
    </form>
  );
}
