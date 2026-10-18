import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AgentSetupPrompt } from "@/components/AgentSetupPrompt";
import { CopyField } from "@/components/routine-triggers/WebhookFields";
import type { EventSourceSecretMaterial } from "@/api/eventSources";

export type RevealedSecret = {
  sourceName: string;
  reason: "created" | "rotated";
  material: EventSourceSecretMaterial;
};

const EXAMPLE_EVENT = `{
  "schema": "paperclip.event.v1",
  "source": "upkeep",
  "type": "disk.usage",
  "severity": "critical",
  "state": "problem",
  "dedupeKey": "vm141/disk.usage:/",
  "title": "worker-ops: / at 93%",
  "labels": { "host_id": "vm141" },
  "occurredAt": "2026-10-18T12:00:00Z"
}`;

export function eventSenderInstructions(sourceName: string, material: EventSourceSecretMaterial): string {
  const auth =
    material.signingMode === "bearer"
      ? [
          `Send the header Authorization: Bearer ${material.secret}`,
          "Bearer mode has no replay protection unless each event carries a unique eventId.",
        ]
      : [
          `Signing secret: ${material.secret}`,
          "Compute HMAC-SHA256 over the string \"<timestamp>.<raw request body>\" with the secret as the key.",
          "Send X-Paperclip-Timestamp (Unix seconds) and X-Paperclip-Signature: sha256=<hex digest>.",
          "Requests whose timestamp is outside the replay window are rejected.",
        ];
  return [
    `Send events to the Paperclip event source ${JSON.stringify(sourceName)}.`,
    `Ingest URL (HTTP POST): ${material.ingestUrl}`,
    "Content-Type: application/json, body at most 64 KB, a single JSON object.",
    ...auth,
    "Retry on 429 and 5xx with exponential backoff and honour Retry-After. Do not retry other 4xx responses.",
    "Send codes, not free text, for host-derived values, and use stable host IDs in labels.host_id.",
    "Store the secret securely; do not put it in source control or logs.",
    "Example body:",
    EXAMPLE_EVENT,
  ].join("\n");
}

/**
 * Shows the URL and secret of a new or rotated source exactly once. The secret
 * only ever lives in the caller's component state: it is not cached, not
 * persisted, and cannot be dismissed by a stray click or Escape.
 */
export function SecretDialog({
  revealed,
  onClose,
}: {
  revealed: RevealedSecret | null;
  onClose: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  if (!revealed) return null;
  const { material, sourceName, reason } = revealed;
  const bearer = material.signingMode === "bearer";
  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent
        showCloseButton={false}
        className="max-h-(--sz-85vh) overflow-y-auto sm:max-w-xl"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            {reason === "created" ? `“${sourceName}” is ready` : `New secret for “${sourceName}”`}
          </DialogTitle>
          <DialogDescription>
            {reason === "created"
              ? "Point your sender at the URL below and use the secret to authenticate."
              : "The previous secret stopped working. Update every sender with the new one."}
          </DialogDescription>
        </DialogHeader>
        <div
          role="alert"
          className="flex items-start gap-3 rounded-md border border-border bg-muted/40 p-3 text-sm"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-(--status-agent-paused)" aria-hidden="true" />
          <p>
            <strong className="font-medium">Copy the secret now.</strong> It is shown only once and
            Paperclip can’t show it again. If you lose it, rotate the secret to get a new one.
          </p>
        </div>
        <div className="space-y-4">
          <CopyField label="Ingest URL" value={material.ingestUrl} />
          <CopyField
            label={bearer ? "Authorization header value" : "Signing secret"}
            value={bearer ? `Bearer ${material.secret}` : material.secret}
            help={
              bearer
                ? "Send this as the Authorization header on every request."
                : "Sign each request with HMAC-SHA256 over “timestamp.body”. Send X-Paperclip-Timestamp and X-Paperclip-Signature: sha256=<hex>."
            }
          />
          <AgentSetupPrompt
            prompt={eventSenderInstructions(sourceName, material)}
            label="Copy sender instructions"
            title="Event sender setup"
            description="Paste this into your agent or script author. It includes the secret."
          />
        </div>
        <DialogFooter className="flex-col items-stretch gap-3 sm:flex-col">
          <div className="flex items-center gap-2">
            <Checkbox
              id="event-source-secret-saved"
              checked={confirmed}
              onCheckedChange={(checked) => setConfirmed(checked === true)}
            />
            <Label htmlFor="event-source-secret-saved" className="cursor-pointer text-sm font-normal">
              I’ve saved the secret somewhere safe
            </Label>
          </div>
          <Button
            disabled={!confirmed}
            onClick={() => {
              setConfirmed(false);
              onClose();
            }}
          >
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
