import { useId, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import type { EventNormalizer, EventSigningMode, EventSource } from "@/api/eventSources";
import {
  GATUS_ENDPOINT_MAP_EXAMPLE,
  REPLAY_WINDOW_RANGE,
  SOURCE_DEFAULTS,
  emptyFormState,
  formFromSource,
  newPinnedRow,
  validateSourceForm,
  type EventSourceFormState,
} from "@/lib/event-source-form";

const selectClass = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-xs text-destructive">
      {message}
    </p>
  );
}

/** Create a source (no `source`) or edit one. Signing mode is fixed once a source exists. */
export function SourceFormDialog({
  source,
  open,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  source?: EventSource;
  open: boolean;
  busy: boolean;
  error: string;
  onSubmit: (state: EventSourceFormState) => void;
  onClose: () => void;
}) {
  const ids = useId();
  const editing = Boolean(source);
  const [state, setState] = useState<EventSourceFormState>(() =>
    source ? formFromSource(source) : emptyFormState(),
  );
  const [showErrors, setShowErrors] = useState(false);
  const { errors } = validateSourceForm(state);
  const shown = showErrors ? errors : {};
  const patch = (values: Partial<EventSourceFormState>) =>
    setState((current) => ({ ...current, ...values }));

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="max-h-(--sz-85vh) overflow-y-auto sm:max-w-xl">
        <form
          noValidate
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!validateSourceForm(state).valid) {
              setShowErrors(true);
              return;
            }
            onSubmit(state);
          }}
        >
          <DialogHeader>
            <DialogTitle>{editing ? `Edit “${source?.name}”` : "New event source"}</DialogTitle>
            <DialogDescription>
              {editing
                ? "Changes apply to new events straight away. The URL and secret stay the same."
                : "An event source is one signed ingest URL. Several routines can listen to it."}
            </DialogDescription>
          </DialogHeader>

          <fieldset disabled={busy} className="min-w-0 space-y-5">
            <div className="space-y-2">
              <Label htmlFor={`${ids}-name`}>Name</Label>
              <Input
                id={`${ids}-name`}
                value={state.name}
                placeholder="Gatus, Wazuh relay, upkeep scripts…"
                aria-invalid={Boolean(shown.name) || undefined}
                aria-describedby={`${ids}-name-error`}
                onChange={(event) => patch({ name: event.target.value })}
              />
              <FieldError id={`${ids}-name-error`} message={shown.name} />
            </div>

            {!editing && (
              <div className="space-y-2">
                <p className="text-sm font-medium">How senders authenticate</p>
                <RadioCardGroup
                  ariaLabel="Signing mode"
                  value={state.signingMode}
                  onValueChange={(value) => patch({ signingMode: value as EventSigningMode })}
                  options={[
                    {
                      value: "hmac_sha256",
                      title: "Signed requests (HMAC-SHA256)",
                      description:
                        "Recommended. Each request is signed and replays are rejected after the replay window.",
                    },
                    {
                      value: "bearer",
                      title: "Bearer token",
                      description:
                        "For senders that can’t sign, such as Gatus. Anyone holding the token can send events.",
                    },
                  ]}
                />
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor={`${ids}-normalizer`}>Payload format</Label>
              <select
                id={`${ids}-normalizer`}
                className={selectClass}
                value={state.normalizer}
                onChange={(event) => patch({ normalizer: event.target.value as EventNormalizer })}
              >
                <option value="generic_v1">Paperclip event (generic_v1)</option>
                <option value="gatus">Gatus alerts</option>
              </select>
              <p className="text-xs text-muted-foreground">
                Our own relays send <code>generic_v1</code>. Choose Gatus only for a Gatus custom
                alert.
              </p>
            </div>

            {state.normalizer === "gatus" && (
              <div className="space-y-2">
                <Label htmlFor={`${ids}-endpoints`}>Endpoint map (optional)</Label>
                <Textarea
                  id={`${ids}-endpoints`}
                  rows={6}
                  className="font-mono text-xs"
                  value={state.endpointMapText}
                  placeholder={GATUS_ENDPOINT_MAP_EXAMPLE}
                  aria-invalid={Boolean(shown.endpointMap) || undefined}
                  aria-describedby={`${ids}-endpoints-help ${ids}-endpoints-error`}
                  onChange={(event) => patch({ endpointMapText: event.target.value })}
                />
                <p id={`${ids}-endpoints-help`} className="text-xs text-muted-foreground">
                  Gatus can’t send labels, so map each “group/name” endpoint to an event type and
                  labels such as <code>host_id</code>. Unmapped endpoints arrive as{" "}
                  <code>gatus.endpoint</code> and reach fallback triggers.
                </p>
                <FieldError id={`${ids}-endpoints-error`} message={shown.endpointMap} />
              </div>
            )}

            <div className="space-y-2">
              <p className="text-sm font-medium">Pinned labels</p>
              <p className="text-xs text-muted-foreground">
                Forced onto every event from this source, overwriting what the sender says. They tie
                this credential to an identity, so one sender can’t pose as another’s hosts.
              </p>
              {state.pinned.map((row, index) => (
                <div
                  key={row.id}
                  role="group"
                  aria-label={`Pinned label ${index + 1}`}
                  className="flex flex-col gap-2 sm:flex-row sm:items-center"
                >
                  <Input
                    aria-label={`Pinned label ${index + 1} name`}
                    placeholder="relay"
                    value={row.key}
                    className="font-mono"
                    onChange={(event) =>
                      patch({
                        pinned: state.pinned.map((item) =>
                          item.id === row.id ? { ...item, key: event.target.value } : item,
                        ),
                      })
                    }
                  />
                  <Input
                    aria-label={`Pinned label ${index + 1} value`}
                    placeholder="security-host"
                    value={row.value}
                    className="font-mono"
                    onChange={(event) =>
                      patch({
                        pinned: state.pinned.map((item) =>
                          item.id === row.id ? { ...item, value: event.target.value } : item,
                        ),
                      })
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove pinned label ${index + 1}`}
                    onClick={() => patch({ pinned: state.pinned.filter((item) => item.id !== row.id) })}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
              <FieldError id={`${ids}-pinned-error`} message={shown.pinned} />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => patch({ pinned: [...state.pinned, newPinnedRow()] })}
              >
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Add pinned label
              </Button>
            </div>

            <details className="rounded-md border border-border p-3">
              <summary className="cursor-pointer text-sm font-medium">Limits and retention</summary>
              <div className="grid gap-4 pt-4 sm:grid-cols-2">
                {state.signingMode === "hmac_sha256" && (
                  <NumberField
                    id={`${ids}-replay`}
                    label="Replay window (seconds)"
                    value={state.replayWindowSec}
                    placeholder={String(REPLAY_WINDOW_RANGE.default)}
                    error={shown.replayWindowSec}
                    help={`${REPLAY_WINDOW_RANGE.min}–${REPLAY_WINDOW_RANGE.max}. Requests with older timestamps are rejected.`}
                    onChange={(replayWindowSec) => patch({ replayWindowSec })}
                  />
                )}
                <NumberField
                  id={`${ids}-rate`}
                  label="Events per minute"
                  value={state.rateLimitPerMinute}
                  placeholder={String(SOURCE_DEFAULTS.rateLimitPerMinute)}
                  error={shown.rateLimitPerMinute}
                  help="Authenticated budget for this source. Over it, senders get 429."
                  onChange={(rateLimitPerMinute) => patch({ rateLimitPerMinute })}
                />
                <NumberField
                  id={`${ids}-storm`}
                  label="New issues per hour"
                  value={state.maxNewIssuesPerHour}
                  placeholder={String(SOURCE_DEFAULTS.maxNewIssuesPerHour)}
                  error={shown.maxNewIssuesPerHour}
                  help="Storm breaker. Beyond it, new alerts fold into one storm issue per routine."
                  onChange={(maxNewIssuesPerHour) => patch({ maxNewIssuesPerHour })}
                />
                <NumberField
                  id={`${ids}-retention`}
                  label="Keep deliveries (days)"
                  value={state.retentionDays}
                  placeholder={String(SOURCE_DEFAULTS.retentionDays)}
                  error={shown.retentionDays}
                  help="How long the delivery log is kept."
                  onChange={(retentionDays) => patch({ retentionDays })}
                />
              </div>
            </details>
          </fieldset>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {editing ? "Save changes" : "Create event source"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NumberField({
  id,
  label,
  value,
  placeholder,
  error,
  help,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  error?: string;
  help: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={1}
        value={value}
        placeholder={placeholder}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={`${id}-help ${id}-error`}
        onChange={(event) => onChange(event.target.value)}
      />
      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        {help}
      </p>
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}
