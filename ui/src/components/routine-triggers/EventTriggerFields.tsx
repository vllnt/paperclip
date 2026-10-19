import { useId } from "react";
import { AlertTriangle, Plus, Trash2 } from "lucide-react";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioCardGroup } from "@/components/ui/radio-card";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  EVENT_ON_RECOVERY_MODES,
  EVENT_SEVERITIES,
  type EventOnRecovery,
  type EventSource,
  type EventSeverity,
} from "@/api/eventSources";
import {
  DEFAULT_GROUP_KEY,
  GROUP_KEY_FIELD_PLACEHOLDERS,
  MAX_LABEL_PAIRS,
  ON_RECOVERY_LABELS,
  describeEventMatch,
  buildEventMatch,
  newLabelPair,
  severityLabel,
  type EventTriggerDraft,
  type EventTriggerErrors,
  type GroupKeyCheck,
} from "@/lib/event-trigger";
import { TagInput } from "./TagInput";

const selectClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

export type EventSourcesState = {
  sources: EventSource[];
  status: "loading" | "error" | "ready";
};

type FieldsProps = {
  draft: EventTriggerDraft;
  onChange: (patch: Partial<EventTriggerDraft>) => void;
  /** Show validation messages. Errors stay quiet until the user has tried to continue. */
  showErrors: boolean;
  errors: EventTriggerErrors;
  disabled?: boolean;
};

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-xs text-destructive">
      {message}
    </p>
  );
}

/** Source picker, match builder and the fallback toggle. */
export function EventMatchFields({
  draft,
  onChange,
  showErrors,
  errors,
  disabled,
  eventSources,
}: FieldsProps & { eventSources: EventSourcesState }) {
  const ids = useId();
  const selectable = eventSources.sources.filter(
    (source) => !source.archived && (source.enabled || source.id === draft.sourceId),
  );
  const selected = eventSources.sources.find((source) => source.id === draft.sourceId);
  const selectedMissing = Boolean(draft.sourceId) && eventSources.status === "ready" && !selected;
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor={`${ids}-source`}>Event source</Label>
        <select
          id={`${ids}-source`}
          className={selectClass}
          value={draft.sourceId}
          disabled={disabled || eventSources.status === "loading"}
          aria-invalid={Boolean(showErrors && errors.source) || undefined}
          aria-describedby={`${ids}-source-help ${ids}-source-error`}
          onChange={(event) => onChange({ sourceId: event.target.value })}
        >
          <option value="">
            {eventSources.status === "loading" ? "Loading event sources…" : "Choose an event source"}
          </option>
          {selectable.map((source) => (
            <option key={source.id} value={source.id}>
              {source.name}
              {!source.enabled ? " (disabled)" : ""}
            </option>
          ))}
          {selectedMissing && <option value={draft.sourceId}>Unavailable source</option>}
        </select>
        <p id={`${ids}-source-help`} className="text-xs text-muted-foreground">
          The ingest endpoint that receives the events. A source can feed many routines.
        </p>
        {eventSources.status === "error" && (
          <p role="alert" className="text-xs text-destructive">
            Couldn’t load event sources. Reload the page to try again.
          </p>
        )}
        {eventSources.status === "ready" && selectable.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No event sources yet.{" "}
            <Link className="underline underline-offset-2" to="/company/settings/event-sources">
              Create one in Company settings → Event sources
            </Link>
            , then come back to finish this trigger.
          </p>
        )}
        <FieldError id={`${ids}-source-error`} message={showErrors ? errors.source : undefined} />
      </div>

      <fieldset className="space-y-4">
        <legend className="text-sm font-medium">Which events start this routine?</legend>
        <p className="-mt-2 text-xs text-muted-foreground">
          Every field you fill in must match. Leave a field empty to match anything.
        </p>
        <div className="space-y-2">
          <Label htmlFor={`${ids}-emitters`}>Emitters</Label>
          <TagInput
            id={`${ids}-emitters`}
            values={draft.sources}
            onChange={(sources) => onChange({ sources })}
            placeholder="gatus, upkeep"
            ariaDescribedBy={`${ids}-emitters-help ${ids}-emitters-error`}
            invalid={Boolean(errors.sources)}
            disabled={disabled}
          />
          <p id={`${ids}-emitters-help`} className="text-xs text-muted-foreground">
            The <code>source</code> name the sender puts in each event. Press Enter or comma to add one.
          </p>
          <FieldError id={`${ids}-emitters-error`} message={errors.sources} />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${ids}-types`}>Event types</Label>
          <TagInput
            id={`${ids}-types`}
            values={draft.types}
            onChange={(types) => onChange({ types })}
            placeholder="disk.*, host.down"
            ariaDescribedBy={`${ids}-types-help ${ids}-types-error`}
            invalid={Boolean(errors.types)}
            disabled={disabled}
          />
          <p id={`${ids}-types-help`} className="text-xs text-muted-foreground">
            Use <code>*</code> as a wildcard, for example <code>disk.*</code>.
          </p>
          <FieldError id={`${ids}-types-error`} message={errors.types} />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${ids}-severity`}>Minimum severity</Label>
          <select
            id={`${ids}-severity`}
            className={selectClass}
            value={draft.minSeverity}
            disabled={disabled}
            onChange={(event) =>
              onChange({ minSeverity: event.target.value as EventTriggerDraft["minSeverity"] })
            }
          >
            <option value="any">Any severity</option>
            {EVENT_SEVERITIES.map((severity: EventSeverity) => (
              <option key={severity} value={severity}>
                {severityLabel(severity)} and above
              </option>
            ))}
          </select>
        </div>
        <LabelPairsEditor
          idPrefix={ids}
          draft={draft}
          onChange={onChange}
          error={errors.labels}
          disabled={disabled}
        />
      </fieldset>

      <div className="flex items-start gap-3 rounded-md border border-border p-4">
        <ToggleSwitch
          id={`${ids}-fallback`}
          checked={draft.fallback}
          disabled={disabled}
          onCheckedChange={(fallback) => onChange({ fallback })}
          aria-labelledby={`${ids}-fallback-label`}
          aria-describedby={`${ids}-fallback-help`}
        />
        <div className="space-y-1">
          <p id={`${ids}-fallback-label`} className="text-sm font-medium">
            Fallback trigger
          </p>
          <p id={`${ids}-fallback-help`} className="text-xs text-muted-foreground">
            Fires only when no other routine on this source took the event, so an alert never goes
            unrouted. The filters above still apply.
          </p>
        </div>
      </div>
    </div>
  );
}

function LabelPairsEditor({
  idPrefix,
  draft,
  onChange,
  error,
  disabled,
}: {
  idPrefix: string;
  draft: EventTriggerDraft;
  onChange: (patch: Partial<EventTriggerDraft>) => void;
  error?: string;
  disabled?: boolean;
}) {
  function updatePair(id: string, patch: Partial<{ key: string; values: string[] }>) {
    onChange({
      labels: draft.labels.map((pair) => (pair.id === id ? { ...pair, ...patch } : pair)),
    });
  }
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Labels</p>
      <p id={`${idPrefix}-labels-help`} className="text-xs text-muted-foreground">
        Every label filter must match. Several values match any of them, and <code>*</code> is a
        wildcard.
      </p>
      {draft.labels.map((pair, index) => (
        <div
          key={pair.id}
          role="group"
          aria-label={`Label filter ${index + 1}`}
          className="flex flex-col gap-2 sm:flex-row sm:items-start"
        >
          <Input
            aria-label={`Label ${index + 1} name`}
            placeholder="host_id"
            value={pair.key}
            disabled={disabled}
            className="font-mono sm:w-48 sm:shrink-0"
            onChange={(event) => updatePair(pair.id, { key: event.target.value })}
          />
          <div className="min-w-0 flex-1">
            <TagInput
              ariaLabel={`Label ${index + 1} values`}
              values={pair.values}
              onChange={(values) => updatePair(pair.id, { values })}
              placeholder="example-host, vm142"
              disabled={disabled}
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={disabled}
            aria-label={`Remove label filter ${index + 1}`}
            onClick={() => onChange({ labels: draft.labels.filter((item) => item.id !== pair.id) })}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      <FieldError id={`${idPrefix}-labels-error`} message={error} />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || draft.labels.length >= MAX_LABEL_PAIRS}
        onClick={() => onChange({ labels: [...draft.labels, newLabelPair()] })}
      >
        <Plus className="mr-1.5 h-3.5 w-3.5" />
        Add label filter
      </Button>
    </div>
  );
}

/** groupKey template, cooldown, recovery handling and issue mode. */
export function EventGroupingFields({
  draft,
  onChange,
  showErrors,
  errors,
  groupKey,
  disabled,
}: FieldsProps & { groupKey: GroupKeyCheck }) {
  const ids = useId();
  const groupKeyError = showErrors || draft.groupKey !== DEFAULT_GROUP_KEY ? errors.groupKey : undefined;
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor={`${ids}-group-key`}>Group key</Label>
        <Input
          id={`${ids}-group-key`}
          value={draft.groupKey}
          disabled={disabled}
          className="font-mono"
          aria-invalid={Boolean(groupKeyError) || undefined}
          aria-describedby={`${ids}-group-key-help ${ids}-group-key-error ${ids}-group-key-warn`}
          onChange={(event) => onChange({ groupKey: event.target.value })}
        />
        <p id={`${ids}-group-key-help`} className="text-xs text-muted-foreground">
          Events with the same key share one issue. Repeats are counted on it instead of opening
          duplicates.
        </p>
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Insert placeholder">
          {[...GROUP_KEY_FIELD_PLACEHOLDERS.map((name) => name as string), "labels.<key>"].map((name) => (
            <Button
              key={name}
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              className="font-mono text-xs"
              onClick={() => {
                const placeholder =
                  name === "labels.<key>" ? "{{labels.host_id}}" : `{{${name}}}`;
                onChange({ groupKey: `${draft.groupKey}${placeholder}` });
              }}
            >
              {`{{${name}}}`}
            </Button>
          ))}
          {draft.groupKey !== DEFAULT_GROUP_KEY && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => onChange({ groupKey: DEFAULT_GROUP_KEY })}
            >
              Reset to default
            </Button>
          )}
        </div>
        <FieldError id={`${ids}-group-key-error`} message={groupKeyError} />
        {!groupKeyError && groupKey.warnings.length > 0 && (
          <p
            id={`${ids}-group-key-warn`}
            role="status"
            className="flex items-start gap-1.5 text-xs text-muted-foreground"
          >
            <AlertTriangle
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-(--status-agent-paused)"
              aria-hidden="true"
            />
            <span>{groupKey.warnings.join(" ")}</span>
          </p>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${ids}-cooldown`}>Repeat comment cooldown (minutes)</Label>
          <Input
            id={`${ids}-cooldown`}
            type="number"
            min={0}
            step="any"
            inputMode="decimal"
            value={draft.cooldownMinutes}
            disabled={disabled}
            aria-invalid={Boolean(showErrors && errors.cooldown) || undefined}
            aria-describedby={`${ids}-cooldown-help ${ids}-cooldown-error`}
            onChange={(event) => onChange({ cooldownMinutes: event.target.value })}
          />
          <p id={`${ids}-cooldown-help`} className="text-xs text-muted-foreground">
            Repeats inside the window are counted silently. After it, one comment and a wake say how
            often it repeated.
          </p>
          <FieldError id={`${ids}-cooldown-error`} message={errors.cooldown} />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${ids}-recovery`}>When the problem recovers</Label>
          <select
            id={`${ids}-recovery`}
            className={selectClass}
            value={draft.onRecovery}
            disabled={disabled}
            onChange={(event) => onChange({ onRecovery: event.target.value as EventOnRecovery })}
          >
            {EVENT_ON_RECOVERY_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {ON_RECOVERY_LABELS[mode]}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            The agent closes the issue. Events never close or reopen one.
          </p>
        </div>
      </div>

      <div className="flex items-start gap-3">
        <ToggleSwitch
          id={`${ids}-rewake`}
          checked={draft.rewakeOnSeverityIncrease}
          disabled={disabled}
          onCheckedChange={(rewakeOnSeverityIncrease) => onChange({ rewakeOnSeverityIncrease })}
          aria-labelledby={`${ids}-rewake-label`}
        />
        <p id={`${ids}-rewake-label`} className="text-sm">
          Wake the agent again when severity increases, even inside the cooldown
        </p>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">Issues</p>
        <RadioCardGroup
          ariaLabel="Issue handling"
          value={draft.issueMode}
          disabled={disabled}
          onValueChange={(issueMode) => onChange({ issueMode: issueMode as EventTriggerDraft["issueMode"] })}
          options={[
            {
              value: "group",
              title: "One issue per alert group",
              description: "Open an issue the first time a group appears and keep updating it.",
            },
            {
              value: "append",
              title: "Append to a standing issue",
              description: "Add every event to one existing issue instead of creating new ones.",
            },
          ]}
        />
        {draft.issueMode === "append" && (
          <div className="space-y-2 pt-1">
            <Label htmlFor={`${ids}-append`}>Issue ID</Label>
            <Input
              id={`${ids}-append`}
              value={draft.appendToIssueId}
              disabled={disabled}
              className="font-mono"
              placeholder="00000000-0000-0000-0000-000000000000"
              aria-invalid={Boolean(showErrors && errors.appendToIssueId) || undefined}
              aria-describedby={`${ids}-append-help ${ids}-append-error`}
              onChange={(event) => onChange({ appendToIssueId: event.target.value })}
            />
            <p id={`${ids}-append-help`} className="text-xs text-muted-foreground">
              The issue must be in this company and assigned to this routine’s agent. If it is closed
              or reassigned later, events fall back to one issue per alert group.
            </p>
            <FieldError id={`${ids}-append-error`} message={errors.appendToIssueId} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Plain-language recap shown on the last step, before the trigger is added. */
export function EventTriggerSummary({
  draft,
  sourceName,
}: {
  draft: EventTriggerDraft;
  sourceName?: string;
}) {
  const cooldown = Number(draft.cooldownMinutes);
  return (
    <section aria-label="Trigger summary" className="space-y-2 rounded-md bg-muted/40 p-4">
      <h2 className="text-sm font-medium">What this trigger will do</h2>
      <dl className="space-y-1.5 text-sm">
        {[
          ["Source", sourceName ?? "Not chosen"],
          ["Listens for", describeEventMatch(buildEventMatch(draft), draft.fallback)],
          ["Groups by", draft.groupKey.trim() || "—"],
          [
            "Repeats",
            Number.isFinite(cooldown) && cooldown > 0
              ? `One comment every ${cooldown} min at most`
              : "A comment on every repeat",
          ],
          ["Recovery", ON_RECOVERY_LABELS[draft.onRecovery]],
        ].map(([term, detail]) => (
          <div key={term} className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
            <dt className="shrink-0 text-muted-foreground sm:w-28">{term}</dt>
            <dd className={cn("min-w-0 break-words", term === "Groups by" && "font-mono text-xs")}>{detail}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">
        A new alert group opens an issue assigned to this routine’s agent. Later events for the same
        group are added to it.
      </p>
    </section>
  );
}
