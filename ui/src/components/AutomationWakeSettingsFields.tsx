import {
  AUTOMATION_WAKE_REASONS,
  automationWakeSettingsSchema,
  MAX_MIN_SECONDS_BETWEEN_AUTOMATION_WAKES,
  type AutomationWakeReason,
  type AutomationWakeSettings,
} from "@paperclipai/shared";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const WAKE_REASON_LABELS: Record<AutomationWakeReason, string> = {
  issue_assignment_recovery: "Assignment recovery",
  issue_continuation_needed: "Continuation needed",
  issue_graph_liveness_backstop: "Graph liveness backstop",
  issue_monitor_due: "Monitor due",
  issue_monitor_recovery: "Monitor recovery",
  issue_monitor_recovery_issue: "Monitor recovery issue",
  provider_quota_recovery: "Provider quota recovery",
  ai_connection_busy_retry: "AI connection busy retry",
};

export const AUTOMATION_WAKE_SETTINGS_HELP =
  "Minimum seconds between recovery, retry and monitor runs for an agent. Wakes inside the window are merged and delivered afterwards, never dropped. Assignments are unaffected. Order of precedence: company, then agent, then routine, then wake type (most specific wins). Empty inherits; 0 turns it off.";

/** Reads a stored settings object; anything invalid shows as unset. */
export function readAutomationWakeSettings(raw: unknown): AutomationWakeSettings {
  const parsed = automationWakeSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

function parseSeconds(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const parsed = Math.floor(Number(raw));
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(Math.max(parsed, 0), MAX_MIN_SECONDS_BETWEEN_AUTOMATION_WAKES);
}

function SecondsInput({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: number | undefined;
  onChange: (next: number | undefined) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor={id} className="text-xs font-medium">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        min={0}
        max={MAX_MIN_SECONDS_BETWEEN_AUTOMATION_WAKES}
        inputMode="numeric"
        placeholder="inherit"
        className="w-28"
        value={value ?? ""}
        onChange={(event) => onChange(parseSeconds(event.target.value))}
      />
    </div>
  );
}

/**
 * Edits one level (company, agent or routine) of the automation-wake window.
 * Unset values inherit from the less specific level; nothing is set by default.
 */
export function AutomationWakeSettingsFields({
  idPrefix,
  value,
  onChange,
}: {
  idPrefix: string;
  value: AutomationWakeSettings;
  onChange: (next: AutomationWakeSettings) => void;
}) {
  const byWakeReason = value.byWakeReason ?? {};

  function setDefault(seconds: number | undefined) {
    const next = { ...value };
    if (seconds === undefined) delete next.minSecondsBetweenAutomationWakes;
    else next.minSecondsBetweenAutomationWakes = seconds;
    onChange(next);
  }

  function setReason(reason: AutomationWakeReason, seconds: number | undefined) {
    const map = { ...byWakeReason };
    if (seconds === undefined) delete map[reason];
    else map[reason] = seconds;
    const next = { ...value };
    if (Object.keys(map).length === 0) delete next.byWakeReason;
    else next.byWakeReason = map;
    onChange(next);
  }

  return (
    <div className="space-y-3">
      <SecondsInput
        id={`${idPrefix}-automation-wake-window`}
        label="Min seconds between automation wakes"
        value={value.minSecondsBetweenAutomationWakes}
        onChange={setDefault}
      />
      <details className="space-y-2">
        <summary className="cursor-pointer text-xs text-muted-foreground">Per wake type</summary>
        <div className="space-y-2 pt-2">
          {AUTOMATION_WAKE_REASONS.map((reason) => (
            <SecondsInput
              key={reason}
              id={`${idPrefix}-automation-wake-${reason}`}
              label={WAKE_REASON_LABELS[reason]}
              value={byWakeReason[reason]}
              onChange={(seconds) => setReason(reason, seconds)}
            />
          ))}
        </div>
      </details>
    </div>
  );
}
