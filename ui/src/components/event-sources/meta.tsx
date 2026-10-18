import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type {
  EventDeliveryStatus,
  EventSeverity,
  EventSigningMode,
  EventTestAction,
} from "@/api/eventSources";

type Tone = "ok" | "muted" | "warn" | "bad" | "active";

const TONE_DOT: Record<Tone, string> = {
  ok: "bg-(--status-task-icon-done)",
  muted: "bg-muted-foreground",
  warn: "bg-(--status-agent-paused)",
  bad: "bg-destructive",
  active: "bg-(--status-agent-running)",
};

/** A badge with a coloured dot. The label carries the meaning; colour only reinforces it. */
export function ToneBadge({ tone, children }: { tone: Tone; children: string }) {
  return (
    <Badge variant="outline" className="gap-1.5 font-normal">
      <span aria-hidden="true" className={cn("h-1.5 w-1.5 shrink-0 rounded-full", TONE_DOT[tone])} />
      {children}
    </Badge>
  );
}

export const DELIVERY_STATUS_META: Record<
  EventDeliveryStatus,
  { label: string; tone: Tone; description: string }
> = {
  processing: {
    label: "Processing",
    tone: "active",
    description: "Being routed right now. A sender retry inside the lease gets a 409.",
  },
  dispatched: {
    label: "Dispatched",
    tone: "ok",
    description: "Reached at least one routine: an issue was opened or commented on.",
  },
  grouped_silent: {
    label: "Grouped",
    tone: "muted",
    description: "A repeat of an open alert, counted without a comment or wake.",
  },
  invalid: {
    label: "Invalid",
    tone: "bad",
    description: "The payload failed validation and was rejected with a 422.",
  },
  unrouted: {
    label: "Unrouted",
    tone: "warn",
    description: "No routine matched and there is no fallback trigger. Nobody was woken.",
  },
  storm_folded: {
    label: "Storm folded",
    tone: "warn",
    description: "The new-issue limit was reached, so the event went into a storm issue.",
  },
  recovery_without_issue: {
    label: "Recovery, no issue",
    tone: "muted",
    description: "A recovery arrived but there was no open issue to comment on.",
  },
  failed: {
    label: "Failed",
    tone: "bad",
    description: "Dispatch failed. The sender is told to retry.",
  },
};

export function DeliveryStatusBadge({ status }: { status: EventDeliveryStatus }) {
  const meta = DELIVERY_STATUS_META[status] ?? {
    label: status,
    tone: "muted" as const,
    description: "",
  };
  return <ToneBadge tone={meta.tone}>{meta.label}</ToneBadge>;
}

export const TEST_ACTION_META: Record<EventTestAction, { label: string; tone: Tone }> = {
  new_issue: { label: "Opens a new issue and wakes the agent", tone: "ok" },
  comment: { label: "Comments on the open issue and wakes the agent", tone: "ok" },
  silent: { label: "Counted silently, no comment or wake", tone: "muted" },
  recovery_comment: { label: "Adds a recovery comment", tone: "ok" },
  recovery_without_issue: { label: "Recovery with no open issue, nothing happens", tone: "muted" },
  storm_folded: { label: "Folded into the storm issue", tone: "warn" },
  append_target_unavailable: {
    label: "Append target unavailable, falls back to a group issue",
    tone: "warn",
  },
};

export function signingModeLabel(mode: EventSigningMode): string {
  return mode === "bearer" ? "Bearer token" : "HMAC-SHA256";
}

export function severityTone(severity: EventSeverity): Tone {
  return severity === "critical" ? "bad" : severity === "warning" ? "warn" : "muted";
}

export function formatLatency(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
