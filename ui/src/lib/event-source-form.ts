import type {
  CreateEventSourceInput,
  EventNormalizer,
  EventSigningMode,
  EventSource,
  UpdateEventSourceInput,
} from "@/api/eventSources";

/** Form model and validation for creating or editing an event source (design §3.1). */

export const REPLAY_WINDOW_RANGE = { min: 30, max: 86400, default: 300 } as const;
export const SOURCE_DEFAULTS = {
  rateLimitPerMinute: 600,
  maxNewIssuesPerHour: 20,
  retentionDays: 30,
} as const;

const LABEL_KEY_PATTERN = /^[a-z0-9_]{1,64}$/;
const MAX_PINNED_LABELS = 32;
const MAX_LABEL_VALUE_LENGTH = 256;

export type PinnedLabelRow = { id: string; key: string; value: string };

export type EventSourceFormState = {
  name: string;
  signingMode: EventSigningMode;
  normalizer: EventNormalizer;
  /** JSON text of `normalizerConfig.endpointMap`, used by the gatus normalizer. */
  endpointMapText: string;
  pinned: PinnedLabelRow[];
  replayWindowSec: string;
  rateLimitPerMinute: string;
  maxNewIssuesPerHour: string;
  retentionDays: string;
};

export type EventSourceFormErrors = Partial<
  Record<
    | "name"
    | "endpointMap"
    | "pinned"
    | "replayWindowSec"
    | "rateLimitPerMinute"
    | "maxNewIssuesPerHour"
    | "retentionDays",
    string
  >
>;

export const GATUS_ENDPOINT_MAP_EXAMPLE = `{
  "core/vm141-disk": {
    "type": "disk.usage",
    "labels": { "host_id": "vm141", "check": "disk.usage" }
  }
}`;

let pinnedRowCounter = 0;
export function newPinnedRow(key = "", value = ""): PinnedLabelRow {
  pinnedRowCounter += 1;
  return { id: `pinned-${Date.now().toString(36)}-${pinnedRowCounter}`, key, value };
}

export function emptyFormState(): EventSourceFormState {
  return {
    name: "",
    signingMode: "hmac_sha256",
    normalizer: "generic_v1",
    endpointMapText: "",
    pinned: [],
    replayWindowSec: "",
    rateLimitPerMinute: "",
    maxNewIssuesPerHour: "",
    retentionDays: "",
  };
}

export function formFromSource(source: EventSource): EventSourceFormState {
  const endpointMap = (source.normalizerConfig as { endpointMap?: unknown } | null)?.endpointMap;
  return {
    name: source.name,
    signingMode: source.signingMode,
    normalizer: source.normalizer,
    endpointMapText: endpointMap ? JSON.stringify(endpointMap, null, 2) : "",
    pinned: Object.entries(source.pinnedLabels ?? {}).map(([key, value]) => newPinnedRow(key, value)),
    replayWindowSec: String(source.replayWindowSec),
    rateLimitPerMinute: String(source.rateLimitPerMinute),
    maxNewIssuesPerHour: String(source.maxNewIssuesPerHour),
    retentionDays: String(source.retentionDays),
  };
}

function checkInteger(text: string, min: number, max: number | null, label: string): string | undefined {
  if (text.trim() === "") return undefined;
  const value = Number(text);
  if (!Number.isInteger(value) || value < min || (max !== null && value > max)) {
    return max === null
      ? `${label} must be a whole number of ${min} or more.`
      : `${label} must be a whole number from ${min} to ${max}.`;
  }
  return undefined;
}

/** Parse the gatus endpoint map text. Returns the map, `null` for blank, or an error string. */
export function parseEndpointMap(text: string): { map: Record<string, unknown> | null } | { error: string } {
  if (text.trim() === "") return { map: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "The endpoint map isn’t valid JSON." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "The endpoint map must be a JSON object keyed by “group/name”." };
  }
  for (const [endpoint, value] of Object.entries(parsed)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { error: `“${endpoint}” must map to an object with a type and labels.` };
    }
    const entry = value as { type?: unknown; labels?: unknown };
    if (entry.type !== undefined && typeof entry.type !== "string") {
      return { error: `“${endpoint}”: type must be a string.` };
    }
    if (
      entry.labels !== undefined &&
      (!entry.labels || typeof entry.labels !== "object" || Array.isArray(entry.labels))
    ) {
      return { error: `“${endpoint}”: labels must be an object of strings.` };
    }
  }
  return { map: parsed as Record<string, unknown> };
}

export function validateSourceForm(state: EventSourceFormState): {
  valid: boolean;
  errors: EventSourceFormErrors;
} {
  const errors: EventSourceFormErrors = {};
  if (!state.name.trim()) errors.name = "Give the event source a name.";
  if (state.normalizer === "gatus") {
    const parsed = parseEndpointMap(state.endpointMapText);
    if ("error" in parsed) errors.endpointMap = parsed.error;
  }
  const seen = new Set<string>();
  if (state.pinned.length > MAX_PINNED_LABELS) {
    errors.pinned = `Use at most ${MAX_PINNED_LABELS} pinned labels.`;
  } else {
    for (const row of state.pinned) {
      const key = row.key.trim();
      if (!LABEL_KEY_PATTERN.test(key)) {
        errors.pinned = key
          ? `“${key}” isn’t a valid label name. Use lowercase letters, digits and “_”.`
          : "Give every pinned label a name, or remove the empty row.";
        break;
      }
      if (seen.has(key)) {
        errors.pinned = `The label “${key}” is pinned twice.`;
        break;
      }
      seen.add(key);
      if (!row.value.trim() || row.value.length > MAX_LABEL_VALUE_LENGTH) {
        errors.pinned = `Give “${key}” a value of 1–${MAX_LABEL_VALUE_LENGTH} characters.`;
        break;
      }
    }
  }
  const replay = state.signingMode === "hmac_sha256"
    ? checkInteger(state.replayWindowSec, REPLAY_WINDOW_RANGE.min, REPLAY_WINDOW_RANGE.max, "The replay window")
    : undefined;
  if (replay) errors.replayWindowSec = replay;
  const rate = checkInteger(state.rateLimitPerMinute, 1, null, "The rate limit");
  if (rate) errors.rateLimitPerMinute = rate;
  const storm = checkInteger(state.maxNewIssuesPerHour, 1, null, "The new-issue limit");
  if (storm) errors.maxNewIssuesPerHour = storm;
  const retention = checkInteger(state.retentionDays, 1, null, "Retention");
  if (retention) errors.retentionDays = retention;
  return { valid: Object.keys(errors).length === 0, errors };
}

function optionalNumber(text: string): number | undefined {
  return text.trim() === "" ? undefined : Number(text);
}

function normalizerFields(state: EventSourceFormState) {
  const parsed = state.normalizer === "gatus" ? parseEndpointMap(state.endpointMapText) : { map: null };
  const endpointMap = "map" in parsed ? parsed.map : null;
  return {
    normalizer: state.normalizer,
    normalizerConfig: state.normalizer === "gatus" && endpointMap ? { endpointMap } : null,
  };
}

function commonFields(state: EventSourceFormState) {
  return {
    name: state.name.trim(),
    ...normalizerFields(state),
    pinnedLabels: Object.fromEntries(state.pinned.map((row) => [row.key.trim(), row.value.trim()])),
    ...(state.signingMode === "hmac_sha256" && optionalNumber(state.replayWindowSec) !== undefined
      ? { replayWindowSec: optionalNumber(state.replayWindowSec) }
      : {}),
    ...(optionalNumber(state.rateLimitPerMinute) !== undefined
      ? { rateLimitPerMinute: optionalNumber(state.rateLimitPerMinute) }
      : {}),
    ...(optionalNumber(state.maxNewIssuesPerHour) !== undefined
      ? { maxNewIssuesPerHour: optionalNumber(state.maxNewIssuesPerHour) }
      : {}),
    ...(optionalNumber(state.retentionDays) !== undefined
      ? { retentionDays: optionalNumber(state.retentionDays) }
      : {}),
  };
}

export function buildCreateInput(state: EventSourceFormState): CreateEventSourceInput {
  return { ...commonFields(state), signingMode: state.signingMode };
}

export function buildUpdateInput(state: EventSourceFormState): UpdateEventSourceInput {
  return commonFields(state);
}

/**
 * A starter payload for the dry run. Gatus bodies are defined by the alert
 * template in the user's Gatus config, so there is no honest sample to offer:
 * the box starts empty and the form tells them to paste a real body.
 */
export function sampleTestPayload(normalizer: EventNormalizer): Record<string, unknown> {
  if (normalizer === "gatus") return {};
  return {
    schema: "paperclip.event.v1",
    source: "upkeep",
    type: "disk.usage",
    severity: "critical",
    state: "problem",
    dedupeKey: "vm141/disk.usage:/",
    title: "worker-ops: / at 93%",
    summary: "Root filesystem usage crossed the critical threshold.",
    labels: { host_id: "vm141", host: "worker-ops", check: "disk.usage" },
    occurredAt: new Date().toISOString(),
  };
}
