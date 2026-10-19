import {
  EVENT_ON_RECOVERY_MODES,
  EVENT_SEVERITIES,
  type EventGrouping,
  type EventMatch,
  type EventOnRecovery,
  type EventRoutineTrigger,
  type EventSeverity,
} from "@/api/eventSources";

/**
 * Pure helpers behind the Event trigger wizard and editor (design-event-wake
 * §3.3): the draft model, validation that mirrors the server's, and the
 * conversion to and from the trigger wire shape. Keeping this free of React
 * lets the wizard stay presentational and the rules stay unit-testable.
 */

export const DEFAULT_GROUP_KEY = "{{source}}:{{dedupeKey}}";
export const DEFAULT_COOLDOWN_MINUTES = "15";
export const MAX_LABEL_PAIRS = 32;

/** Placeholders the server's dedicated groupKey renderer accepts. */
export const GROUP_KEY_FIELD_PLACEHOLDERS = ["source", "type", "severity", "dedupeKey"] as const;

const SOURCE_NAME_PATTERN = /^[a-z0-9_.-]{1,64}$/;
const TYPE_PATTERN = /^[a-z0-9_.*-]{1,128}$/;
const LABEL_KEY_PATTERN = /^[a-z0-9_]{1,64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LABEL_VALUE_LENGTH = 256;

export type LabelPairDraft = {
  id: string;
  key: string;
  values: string[];
};

export type EventTriggerDraft = {
  sourceId: string;
  /** `event.source` emitter names (for example `gatus`). Empty means any. */
  sources: string[];
  /** Event types, `*` globs allowed. Empty means any. */
  types: string[];
  minSeverity: "any" | EventSeverity;
  labels: LabelPairDraft[];
  groupKey: string;
  cooldownMinutes: string;
  rewakeOnSeverityIncrease: boolean;
  onRecovery: EventOnRecovery;
  issueMode: "group" | "append";
  appendToIssueId: string;
  fallback: boolean;
};

let labelRowCounter = 0;
export function newLabelPair(key = "", values: string[] = []): LabelPairDraft {
  labelRowCounter += 1;
  return { id: `label-${Date.now().toString(36)}-${labelRowCounter}`, key, values };
}

export function defaultEventDraft(): EventTriggerDraft {
  return {
    sourceId: "",
    sources: [],
    types: [],
    minSeverity: "any",
    labels: [],
    groupKey: DEFAULT_GROUP_KEY,
    cooldownMinutes: DEFAULT_COOLDOWN_MINUTES,
    rewakeOnSeverityIncrease: true,
    onRecovery: "comment_and_wake",
    issueMode: "group",
    appendToIssueId: "",
    fallback: false,
  };
}

/** Coerce whatever was persisted in a saved draft back into a full draft. */
export function normalizeEventDraft(value: unknown): EventTriggerDraft {
  const base = defaultEventDraft();
  if (!value || typeof value !== "object") return base;
  const raw = value as Partial<EventTriggerDraft>;
  const strings = (input: unknown) =>
    Array.isArray(input) ? input.filter((item): item is string => typeof item === "string") : [];
  return {
    sourceId: typeof raw.sourceId === "string" ? raw.sourceId : base.sourceId,
    sources: strings(raw.sources),
    types: strings(raw.types),
    minSeverity:
      raw.minSeverity === "any" || (EVENT_SEVERITIES as readonly string[]).includes(raw.minSeverity as string)
        ? (raw.minSeverity as EventTriggerDraft["minSeverity"])
        : base.minSeverity,
    labels: Array.isArray(raw.labels)
      ? raw.labels
          .filter((pair): pair is LabelPairDraft => Boolean(pair) && typeof pair === "object")
          .map((pair) => ({
            id: typeof pair.id === "string" ? pair.id : newLabelPair().id,
            key: typeof pair.key === "string" ? pair.key : "",
            values: strings(pair.values),
          }))
      : [],
    groupKey: typeof raw.groupKey === "string" ? raw.groupKey : base.groupKey,
    cooldownMinutes: typeof raw.cooldownMinutes === "string" ? raw.cooldownMinutes : base.cooldownMinutes,
    rewakeOnSeverityIncrease:
      typeof raw.rewakeOnSeverityIncrease === "boolean" ? raw.rewakeOnSeverityIncrease : base.rewakeOnSeverityIncrease,
    onRecovery: (EVENT_ON_RECOVERY_MODES as readonly string[]).includes(raw.onRecovery as string)
      ? (raw.onRecovery as EventOnRecovery)
      : base.onRecovery,
    issueMode: raw.issueMode === "append" ? "append" : "group",
    appendToIssueId: typeof raw.appendToIssueId === "string" ? raw.appendToIssueId : "",
    fallback: raw.fallback === true,
  };
}

export type GroupKeyCheck = {
  /** Blocking problem, or `null` when the template is acceptable. */
  error: string | null;
  /** Non-blocking guidance. */
  warnings: string[];
  unknownPlaceholders: string[];
};

const PLACEHOLDER_PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/g;

/**
 * Mirrors the server's groupKey renderer: only `{{source}}`, `{{type}}`,
 * `{{severity}}`, `{{dedupeKey}}` and `{{labels.<key>}}` are accepted, and the
 * server answers 422 for anything else, so the form says so before saving.
 */
export function validateGroupKeyTemplate(template: string): GroupKeyCheck {
  const trimmed = template.trim();
  if (!trimmed) {
    return { error: "Enter a group key, or reset it to the default.", warnings: [], unknownPlaceholders: [] };
  }
  const placeholders = [...trimmed.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1] ?? "");
  const unknown = placeholders.filter((name) => !isKnownPlaceholder(name));
  if (unknown.length > 0) {
    const names = [...new Set(unknown)].map((name) => `{{${name}}}`).join(", ");
    return {
      error: `Unknown placeholder ${names}. Use {{source}}, {{type}}, {{severity}}, {{dedupeKey}} or {{labels.<key>}}.`,
      warnings: [],
      unknownPlaceholders: [...new Set(unknown)],
    };
  }
  const withoutPlaceholders = trimmed.replace(PLACEHOLDER_PATTERN, "");
  if (withoutPlaceholders.includes("{{") || withoutPlaceholders.includes("}}")) {
    return {
      error: "Unbalanced braces. Wrap each placeholder in {{ and }}.",
      warnings: [],
      unknownPlaceholders: [],
    };
  }
  const warnings: string[] = [];
  if (placeholders.length === 0) {
    warnings.push("A fixed key puts every event from this trigger into one group and one issue.");
  } else if (!placeholders.includes("dedupeKey")) {
    warnings.push(
      "Keep {{dedupeKey}} in the key. Without it, two problems of one type on one host (for example two disk mounts) merge into one issue.",
    );
  }
  return { error: null, warnings, unknownPlaceholders: [] };
}

function isKnownPlaceholder(name: string): boolean {
  if ((GROUP_KEY_FIELD_PLACEHOLDERS as readonly string[]).includes(name)) return true;
  return name.startsWith("labels.") && LABEL_KEY_PATTERN.test(name.slice("labels.".length));
}

export type EventTriggerErrors = {
  source?: string;
  sources?: string;
  types?: string;
  labels?: string;
  groupKey?: string;
  cooldown?: string;
  appendToIssueId?: string;
};

export function validateEventDraft(draft: EventTriggerDraft): {
  valid: boolean;
  errors: EventTriggerErrors;
  groupKey: GroupKeyCheck;
} {
  const errors: EventTriggerErrors = {};
  if (!draft.sourceId) errors.source = "Choose the event source this trigger listens to.";
  const badSource = draft.sources.find((name) => !SOURCE_NAME_PATTERN.test(name));
  if (badSource) errors.sources = `“${badSource}” isn’t a valid emitter name. Use lowercase letters, digits, “.”, “_” or “-”.`;
  const badType = draft.types.find((name) => !TYPE_PATTERN.test(name));
  if (badType) errors.types = `“${badType}” isn’t a valid event type. Use lowercase letters, digits, “.”, “_”, “-” and “*”.`;
  errors.labels = validateLabelPairs(draft.labels);
  if (!errors.labels) delete errors.labels;
  const groupKey = validateGroupKeyTemplate(draft.groupKey);
  if (groupKey.error) errors.groupKey = groupKey.error;
  const cooldown = Number(draft.cooldownMinutes);
  if (draft.cooldownMinutes.trim() === "" || !Number.isFinite(cooldown) || cooldown < 0) {
    errors.cooldown = "Enter 0 or more minutes.";
  }
  if (draft.issueMode === "append" && !UUID_PATTERN.test(draft.appendToIssueId.trim())) {
    errors.appendToIssueId = "Enter the issue ID (a UUID) to append events to.";
  }
  return { valid: Object.keys(errors).length === 0, errors, groupKey };
}

function validateLabelPairs(pairs: LabelPairDraft[]): string | undefined {
  if (pairs.length > MAX_LABEL_PAIRS) return `Use at most ${MAX_LABEL_PAIRS} label filters.`;
  const seen = new Set<string>();
  for (const pair of pairs) {
    const key = pair.key.trim();
    if (!key) return "Give every label filter a name, or remove the empty row.";
    if (!LABEL_KEY_PATTERN.test(key)) {
      return `“${key}” isn’t a valid label name. Use lowercase letters, digits and “_”.`;
    }
    if (seen.has(key)) return `The label “${key}” is listed twice. Add its values to a single row.`;
    seen.add(key);
    if (pair.values.length === 0) return `Add at least one value for “${key}”.`;
    const tooLong = pair.values.find((value) => value.length > MAX_LABEL_VALUE_LENGTH);
    if (tooLong) return `A value for “${key}” is longer than ${MAX_LABEL_VALUE_LENGTH} characters.`;
  }
  return undefined;
}

export function buildEventMatch(draft: EventTriggerDraft): EventMatch {
  const match: EventMatch = {};
  if (draft.sources.length > 0) match.sources = draft.sources;
  if (draft.types.length > 0) match.types = draft.types;
  if (draft.minSeverity !== "any") match.minSeverity = draft.minSeverity;
  if (draft.labels.length > 0) {
    match.labels = Object.fromEntries(
      draft.labels.map((pair) => [
        pair.key.trim(),
        pair.values.length === 1 ? pair.values[0]! : pair.values,
      ]),
    );
  }
  return match;
}

export function buildEventGrouping(draft: EventTriggerDraft): EventGrouping {
  return {
    groupKey: draft.groupKey.trim(),
    repeatCommentCooldownSec: Math.round(Number(draft.cooldownMinutes) * 60),
    rewakeOnSeverityIncrease: draft.rewakeOnSeverityIncrease,
    onRecovery: draft.onRecovery,
    issueMode: draft.issueMode === "append" ? { appendToIssueId: draft.appendToIssueId.trim() } : "group",
  };
}

/** Body for `POST /routines/{id}/triggers` and `PATCH /routine-triggers/{id}`. */
export function buildEventTriggerPayload(draft: EventTriggerDraft) {
  return {
    eventSourceId: draft.sourceId,
    eventMatch: buildEventMatch(draft),
    eventGrouping: buildEventGrouping(draft),
    fallback: draft.fallback,
  };
}

export function eventDraftFromTrigger(trigger: EventRoutineTrigger): EventTriggerDraft {
  const base = defaultEventDraft();
  const match = trigger.eventMatch ?? {};
  const grouping = trigger.eventGrouping;
  const append =
    grouping && typeof grouping.issueMode === "object" ? grouping.issueMode.appendToIssueId : "";
  return {
    sourceId: trigger.eventSourceId ?? "",
    sources: match.sources ?? [],
    types: match.types ?? [],
    minSeverity: match.minSeverity ?? "any",
    labels: Object.entries(match.labels ?? {}).map(([key, value]) =>
      newLabelPair(key, Array.isArray(value) ? value : [value]),
    ),
    groupKey: grouping?.groupKey ?? base.groupKey,
    cooldownMinutes:
      grouping?.repeatCommentCooldownSec !== undefined
        ? String(Number((grouping.repeatCommentCooldownSec / 60).toFixed(2)))
        : base.cooldownMinutes,
    rewakeOnSeverityIncrease: grouping?.rewakeOnSeverityIncrease ?? base.rewakeOnSeverityIncrease,
    onRecovery: grouping?.onRecovery ?? base.onRecovery,
    issueMode: append ? "append" : "group",
    appendToIssueId: append,
    fallback: trigger.fallback === true,
  };
}

const SEVERITY_LABELS: Record<EventSeverity, string> = {
  info: "Info",
  warning: "Warning",
  critical: "Critical",
};
export function severityLabel(severity: EventSeverity): string {
  return SEVERITY_LABELS[severity] ?? severity;
}

/** One line for trigger cards: what this trigger listens for. */
export function describeEventMatch(match: EventMatch | null | undefined, fallback = false): string {
  const parts: string[] = [];
  if (match?.sources?.length) parts.push(match.sources.join(", "));
  if (match?.types?.length) parts.push(match.types.join(", "));
  if (match?.minSeverity) parts.push(`${severityLabel(match.minSeverity)} and above`);
  for (const [key, value] of Object.entries(match?.labels ?? {})) {
    parts.push(`${key}=${Array.isArray(value) ? value.join("|") : value}`);
  }
  const base = parts.length > 0 ? parts.join(" · ") : "Every event from the source";
  return fallback ? `Fallback · ${base}` : base;
}

export const ON_RECOVERY_LABELS: Record<EventOnRecovery, string> = {
  comment_and_wake: "Comment and wake the agent",
  comment_only: "Comment only",
  ignore: "Ignore recoveries",
};
