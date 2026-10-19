import { useState } from "react";
import {
  RUN_CONTEXT_DEFAULTS,
  RUN_CONTEXT_LIMITS,
  RUN_CONTEXT_WINDOWS,
  type RunContextPolicy,
  type RunContextSettings,
} from "@paperclipai/shared";
import { Field } from "./agent-config-primitives";

const INHERIT = "";
const NUMBER_FIELDS = [
  { key: "maxComments", label: "Max comments", limits: RUN_CONTEXT_LIMITS.maxComments },
  { key: "maxCommentChars", label: "Max characters per comment", limits: RUN_CONTEXT_LIMITS.maxCommentChars },
  { key: "maxTotalCommentChars", label: "Max characters in total", limits: RUN_CONTEXT_LIMITS.maxTotalCommentChars },
] as const;

/** Drop unset fields and empty overrides so a cleared editor stores nothing. */
function compact(policy: RunContextPolicy): RunContextPolicy | null {
  const { byWakeReason, ...base } = policy;
  const overrides = Object.fromEntries(
    Object.entries(byWakeReason ?? {}).filter(([, settings]) => Object.keys(settings).length > 0),
  );
  const next: RunContextPolicy = {
    ...base,
    ...(Object.keys(overrides).length > 0 ? { byWakeReason: overrides } : {}),
  };
  return Object.keys(next).length > 0 ? next : null;
}

function SettingsFields({
  value,
  onChange,
  testId,
}: {
  value: RunContextSettings;
  onChange: (next: RunContextSettings) => void;
  testId: string;
}) {
  const set = (patch: Partial<RunContextSettings>) => {
    const next: RunContextSettings = { ...value, ...patch };
    for (const key of Object.keys(next) as Array<keyof RunContextSettings>) {
      if (next[key] === undefined) delete next[key];
    }
    onChange(next);
  };
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {NUMBER_FIELDS.map(({ key, label, limits }) => (
        <Field key={`${key}-${value[key] ?? INHERIT}`} label={label}>
          <input
            className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
            type="number"
            min={limits.min}
            max={limits.max}
            placeholder={`Inherit (${RUN_CONTEXT_DEFAULTS[key]})`}
            defaultValue={value[key] ?? INHERIT}
            data-testid={`${testId}-${key}`}
            onBlur={(event) => {
              const raw = event.target.value.trim();
              const parsed = Number(raw);
              if (raw === INHERIT) set({ [key]: undefined });
              else if (Number.isInteger(parsed) && parsed >= limits.min && parsed <= limits.max) set({ [key]: parsed });
              else event.target.value = String(value[key] ?? INHERIT);
            }}
          />
        </Field>
      ))}
      <Field label="Comment window">
        <select
          className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
          value={value.window ?? INHERIT}
          data-testid={`${testId}-window`}
          onChange={(event) => {
            const next = RUN_CONTEXT_WINDOWS.find((window) => window === event.target.value);
            set({ window: next });
          }}
        >
          <option value={INHERIT}>Inherit ({RUN_CONTEXT_DEFAULTS.window})</option>
          {RUN_CONTEXT_WINDOWS.map((window) => (
            <option key={window} value={window}>{window}</option>
          ))}
        </select>
      </Field>
      <Field label="Truncation marker">
        <select
          className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
          value={value.truncationMarker === undefined ? INHERIT : String(value.truncationMarker)}
          data-testid={`${testId}-truncationMarker`}
          onChange={(event) =>
            set({ truncationMarker: event.target.value === INHERIT ? undefined : event.target.value === "true" })
          }
        >
          <option value={INHERIT}>Inherit ({String(RUN_CONTEXT_DEFAULTS.truncationMarker)})</option>
          <option value="true">on</option>
          <option value="false">off</option>
        </select>
      </Field>
    </div>
  );
}

/**
 * Edits one level's run-context policy. Blank fields inherit from the less
 * specific level (company, agent, routine, then wake type); wake-type
 * overrides are the most specific and win over every level's base settings.
 */
export function RunContextPolicyEditor({
  value,
  onChange,
  testId,
}: {
  value: RunContextPolicy | null | undefined;
  onChange: (next: RunContextPolicy | null) => void;
  testId: string;
}) {
  const { byWakeReason = {}, ...base } = value ?? {};
  const [newReason, setNewReason] = useState("");
  const [draftReasons, setDraftReasons] = useState<string[]>([]);
  const addReason = () => {
    const reason = newReason.trim();
    if (!reason) return;
    setNewReason("");
    setDraftReasons((current) => [...current, reason]);
  };
  const reasons = [...new Set([...Object.keys(byWakeReason), ...draftReasons])];
  return (
    <div className="space-y-4" data-testid={testId}>
      <SettingsFields
        value={base}
        testId={`${testId}-base`}
        onChange={(next) => onChange(compact({ ...next, byWakeReason }))}
      />
      <div className="space-y-3">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Overrides by wake type
        </div>
        {reasons.map((reason) => (
          <div key={reason} className="space-y-2 rounded-md border border-border p-3">
            <div className="flex items-center justify-between text-sm">
              <span className="font-mono">{reason}</span>
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => {
                  const rest = Object.fromEntries(Object.entries(byWakeReason).filter(([key]) => key !== reason));
                  setDraftReasons((current) => current.filter((item) => item !== reason));
                  onChange(compact({ ...base, byWakeReason: rest }));
                }}
              >
                Remove
              </button>
            </div>
            <SettingsFields
              value={byWakeReason[reason] ?? {}}
              testId={`${testId}-reason-${reason}`}
              onChange={(next) => onChange(compact({ ...base, byWakeReason: { ...byWakeReason, [reason]: next } }))}
            />
          </div>
        ))}
        <div className="flex gap-2">
          <input
            className="flex-1 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
            placeholder="Wake reason, e.g. issue_commented"
            value={newReason}
            data-testid={`${testId}-new-reason`}
            onChange={(event) => setNewReason(event.target.value)}
          />
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
            onClick={addReason}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
