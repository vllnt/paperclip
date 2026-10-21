import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, Loader2, Settings2, X } from "lucide-react";
import type { AttentionItem } from "@paperclipai/shared";
import { decisionQueuesApi } from "../api/decisionQueues";
import { useToastActions } from "../context/ToastContext";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

/**
 * Auto-seed card for one decision queue: explains in place what seeding does —
 * the queue's seed rules (from `DECISION_QUEUE_SEEDS`) that pull matching
 * decisions in automatically — and what the toggle changes. Disabling stops
 * only the automatic adds; anything already in the queue stays, and manual adds
 * keep working.
 */
export function SeedRulesCard({
  enabled,
  rules,
  pending,
  onToggle,
}: {
  enabled: boolean;
  rules: string[];
  pending: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-muted/20 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <Settings2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium text-foreground">Auto-seeding is {enabled ? "on" : "off"}</p>
            <p className="text-xs text-muted-foreground">
              {enabled
                ? "This queue fills itself automatically. Decisions are added the moment they match any of its rules:"
                : "Automatic adds are paused. These rules would add decisions to the queue when on:"}
            </p>
            <ul className="mt-0.5 space-y-0.5">
              {rules.map((rule) => (
                <li key={rule} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                  <Check className="mt-0.5 h-3 w-3 shrink-0" />
                  {rule}
                </li>
              ))}
            </ul>
            <p className="text-(length:--text-nano) text-muted-foreground">
              {enabled
                ? "Turning it off stops new automatic adds only — decisions already here stay, and you can still add or remove decisions by hand."
                : "Adding or removing decisions by hand still works while automatic seeding is off."}
            </p>
          </div>
        </div>
        <Button type="button" variant="outline" size="xs" className="h-7 shrink-0" disabled={pending} onClick={onToggle}>
          {pending && <Loader2 className="h-3 w-3 animate-spin" />}
          {enabled ? "Disable" : "Enable"}
        </Button>
      </div>
    </div>
  );
}

/** Removes one item from a decision queue, with an optional reason. */
export function QueueExcludeButton({
  item,
  companyId,
  queueKey,
  onExcluded,
}: {
  item: AttentionItem;
  companyId: string;
  queueKey: string;
  onExcluded: () => void;
}) {
  const { pushToast } = useToastActions();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const exclude = useMutation({
    mutationFn: async () => {
      await decisionQueuesApi.removeItem(
        companyId,
        queueKey,
        item.sourceKind,
        item.subject.id,
        reason.trim() || undefined,
      );
    },
    onSuccess: () => {
      setOpen(false);
      setReason("");
      pushToast({ title: "Removed from queue", body: item.subject.title ?? undefined, tone: "info" });
      onExcluded();
    },
    onError: (err) =>
      pushToast({
        title: "Could not exclude",
        body: err instanceof Error ? err.message : "Please try again.",
        tone: "error",
      }),
  });

  return (
    <div className="flex items-center justify-end px-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="ghost" size="xs" className="h-7 gap-1 text-muted-foreground">
            <X className="h-3.5 w-3.5" />
            Exclude
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 space-y-2 p-3">
          <p className="text-xs font-medium text-foreground">Remove from this queue</p>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Reason (optional)…"
            className="min-h-16 w-full rounded-sm border border-border bg-background px-2 py-1 text-xs"
          />
          <div className="flex justify-end gap-1">
            <Button type="button" variant="ghost" size="xs" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="xs"
              className={cn(exclude.isPending && "opacity-80")}
              disabled={exclude.isPending}
              onClick={() => exclude.mutate()}
            >
              {exclude.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
              Exclude
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
