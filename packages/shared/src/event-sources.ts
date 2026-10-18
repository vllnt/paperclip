import { z } from "zod";

/**
 * Event sources: company-scoped signed ingress for external alert senders. An
 * `event` routine trigger subscribes a routine (and so an agent) to the
 * normalized events of a source. See docs/api/event-sources.md.
 */

export const EVENT_WIRE_SCHEMA_ID = "paperclip.event.v1";

export const EVENT_SOURCE_SIGNING_MODES = ["hmac_sha256", "bearer"] as const;
export type EventSourceSigningMode = (typeof EVENT_SOURCE_SIGNING_MODES)[number];

export const EVENT_SOURCE_NORMALIZERS = ["generic_v1", "gatus"] as const;
export type EventSourceNormalizer = (typeof EVENT_SOURCE_NORMALIZERS)[number];

/** Ordered lowest to highest; `minSeverity` compares by index. */
export const EVENT_SEVERITIES = ["info", "warning", "critical"] as const;
export type EventSeverity = (typeof EVENT_SEVERITIES)[number];

export const EVENT_STATES = ["problem", "recovery", "info"] as const;
export type EventState = (typeof EVENT_STATES)[number];

export const EVENT_ON_RECOVERY_MODES = ["comment_and_wake", "comment_only", "ignore"] as const;
export type EventOnRecoveryMode = (typeof EVENT_ON_RECOVERY_MODES)[number];

export const EVENT_DELIVERY_STATUSES = [
  "processing",
  "dispatched",
  "grouped_silent",
  "invalid",
  "unrouted",
  "storm_folded",
  "recovery_without_issue",
  "failed",
  /** One aggregated row of unauthenticated/duplicate requests per source per minute. */
  "rejected_aggregate",
] as const;
export type EventDeliveryStatus = (typeof EVENT_DELIVERY_STATUSES)[number];

/** Reject/duplicate outcomes counted in memory and flushed as one aggregate row per minute. */
export const EVENT_REJECT_OUTCOMES = [
  "unauthorized",
  "not_found",
  "auth_failure_rate_limited",
  /** An authenticated sender over its `rateLimitPerMinute`. */
  "rate_limited",
  "duplicate",
] as const;
export type EventRejectOutcome = (typeof EVENT_REJECT_OUTCOMES)[number];

export const EVENT_ROUTINE_OUTCOME_STATUSES = [
  // The routine's gate script is queued or running; the outcome settles when it commits.
  "gating",
  "issue_created",
  "grouped",
  "grouped_silent",
  "recovered",
  "recovery_without_issue",
  "recovery_ignored",
  "storm_folded",
  "failed_permanent",
  "failed_transient",
] as const;
export type EventRoutineOutcomeStatus = (typeof EVENT_ROUTINE_OUTCOME_STATUSES)[number];

export const EVENT_SOURCE_NAME_MAX_LENGTH = 120;
export const EVENT_BODY_MAX_BYTES = 64 * 1024;
export const EVENT_MAX_LABELS = 32;
export const EVENT_GROUP_KEY_TEMPLATE_MAX_LENGTH = 512;
export const DEFAULT_EVENT_GROUP_KEY_TEMPLATE = "{{source}}:{{dedupeKey}}";

const SOURCE_PATTERN = /^[a-z0-9_.-]{1,64}$/;
const TYPE_PATTERN = /^[a-z0-9_.-]{1,128}$/;
const LABEL_KEY_PATTERN = /^[a-z0-9_]{1,64}$/;
const PRINTABLE_ASCII_PATTERN = /^[ -~]+$/;

// NUL (and, for single-line fields, every control character) is removed at the
// edge: jsonb rejects \u0000 and newlines would let an event forge extra lines
// in an issue title.
// eslint-disable-next-line no-control-regex
const NON_TEXT_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
// eslint-disable-next-line no-control-regex
const ANY_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** A lone UTF-16 surrogate is legal in a JSON string but cannot be stored in jsonb or percent-encoded. */
export function replaceLoneSurrogates(value: string): string {
  return value.replace(LONE_SURROGATE, "\uFFFD");
}

/** Strips every control character and line break, then collapses whitespace. */
export function sanitizeEventSingleLine(value: string): string {
  return replaceLoneSurrogates(value).replace(ANY_CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
}

/** Strips control characters but keeps tabs and line breaks (summary text). */
export function sanitizeEventMultiLine(value: string): string {
  return replaceLoneSurrogates(value).replace(NON_TEXT_CONTROL_CHARS, "");
}

const labelKeySchema = z.string().regex(LABEL_KEY_PATTERN);
const labelValueSchema = z.string().max(256).transform(sanitizeEventSingleLine);

export const eventLabelsSchema = z
  .record(labelKeySchema, labelValueSchema)
  .refine((labels) => Object.keys(labels).length <= EVENT_MAX_LABELS, {
    message: `At most ${EVENT_MAX_LABELS} labels are allowed`,
  });

const eventUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    // Whitespace and control characters never belong in a URL we store and render.
    // eslint-disable-next-line no-control-regex
    if (/[\s\u0000-\u001f\u007f-\u009f]/.test(value) || replaceLoneSurrogates(value) !== value) return false;
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:" || parsed.protocol === "http:";
    } catch {
      return false;
    }
  }, { message: "url must be an http(s) URL" });

/** Wire format of the `generic_v1` normalizer, the contract for every sender we write. */
export const genericV1EventSchema = z.object({
  schema: z.literal(EVENT_WIRE_SCHEMA_ID),
  eventId: z.string().max(256).regex(PRINTABLE_ASCII_PATTERN).optional(),
  source: z.string().regex(SOURCE_PATTERN),
  type: z.string().regex(TYPE_PATTERN),
  severity: z.enum(EVENT_SEVERITIES),
  state: z.enum(EVENT_STATES),
  dedupeKey: z.string().max(256).regex(PRINTABLE_ASCII_PATTERN),
  title: z.string().max(200).transform(sanitizeEventSingleLine).pipe(z.string().min(1)),
  summary: z.string().max(4000).transform(sanitizeEventMultiLine).optional(),
  labels: eventLabelsSchema.optional(),
  occurredAt: z.string().datetime({ offset: true }).optional(),
  url: eventUrlSchema.optional(),
});
export type GenericV1Event = z.infer<typeof genericV1EventSchema>;

/** The normalized event every normalizer produces and the router/dispatcher consumes. */
export interface NormalizedEvent {
  eventId: string | null;
  source: string;
  type: string;
  severity: EventSeverity;
  state: EventState;
  dedupeKey: string;
  title: string;
  summary: string;
  labels: Record<string, string>;
  occurredAt: string;
  url: string | null;
}

export function eventSeverityRank(severity: EventSeverity): number {
  return EVENT_SEVERITIES.indexOf(severity);
}

// ── Glob matching ───────────────────────────────────────────────────────────

/** `*` matches any run of characters (including none); everything else is literal. */
export function matchesEventGlob(pattern: string, value: string): boolean {
  if (!pattern.includes("*")) return pattern === value;
  // Iterative wildcard match: linear in practice, no regex, so a hostile
  // pattern cannot trigger catastrophic backtracking.
  let p = 0;
  let v = 0;
  let starIndex = -1;
  let matchIndex = 0;
  while (v < value.length) {
    if (p < pattern.length && pattern[p] !== "*" && pattern[p] === value[v]) {
      p += 1;
      v += 1;
    } else if (p < pattern.length && pattern[p] === "*") {
      starIndex = p;
      matchIndex = v;
      p += 1;
    } else if (starIndex !== -1) {
      p = starIndex + 1;
      matchIndex += 1;
      v = matchIndex;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p += 1;
  return p === pattern.length;
}

const globPatternSchema = z.string().min(1).max(128);

const eventMatchLabelValueSchema = z.union([
  globPatternSchema,
  z.array(globPatternSchema).min(1).max(32),
]);

/** Every given field must match; an omitted field matches anything. */
export const eventMatchSchema = z.object({
  sources: z.array(globPatternSchema).min(1).max(32).optional(),
  types: z.array(globPatternSchema).min(1).max(32).optional(),
  minSeverity: z.enum(EVENT_SEVERITIES).optional(),
  labels: z
    .record(labelKeySchema, eventMatchLabelValueSchema)
    .refine((labels) => Object.keys(labels).length <= EVENT_MAX_LABELS, {
      message: `At most ${EVENT_MAX_LABELS} label filters are allowed`,
    })
    .optional(),
}).strict();
export type EventMatch = z.infer<typeof eventMatchSchema>;

/**
 * `minSeverity` gates problems and informational events. A recovery is not
 * severity-gated: the group it closes out only exists if its problem matched,
 * and a sender need not repeat the original severity on the recovery.
 */
export function matchesEvent(match: EventMatch | null | undefined, event: NormalizedEvent): boolean {
  if (!match) return true;
  if (match.sources && !match.sources.some((pattern) => matchesEventGlob(pattern, event.source))) return false;
  if (match.types && !match.types.some((pattern) => matchesEventGlob(pattern, event.type))) return false;
  if (
    match.minSeverity
    && event.state !== "recovery"
    && eventSeverityRank(event.severity) < eventSeverityRank(match.minSeverity)
  ) {
    return false;
  }
  if (match.labels) {
    for (const [key, expected] of Object.entries(match.labels)) {
      const actual = event.labels[key];
      if (actual === undefined) return false;
      const patterns = Array.isArray(expected) ? expected : [expected];
      if (!patterns.some((pattern) => matchesEventGlob(pattern, actual))) return false;
    }
  }
  return true;
}

// ── Group key rendering ─────────────────────────────────────────────────────

// The name is trimmed in code, not in the pattern: `\s*` next to a lazy group made the match quadratic on `{{` plus whitespace.
const GROUP_KEY_PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const GROUP_KEY_FIELD_PLACEHOLDERS = new Set(["source", "type", "severity", "dedupeKey"]);
const GROUP_KEY_LABEL_PLACEHOLDER = /^labels\.([a-z0-9_]{1,64})$/;

/** Returns an error message for an invalid groupKey template, or null when it is valid. */
export function validateEventGroupKeyTemplate(template: string): string | null {
  if (template.length === 0) return "groupKey must not be empty";
  if (template.length > EVENT_GROUP_KEY_TEMPLATE_MAX_LENGTH) {
    return `groupKey must be at most ${EVENT_GROUP_KEY_TEMPLATE_MAX_LENGTH} characters`;
  }
  for (const match of template.matchAll(GROUP_KEY_PLACEHOLDER)) {
    const name = (match[1] ?? "").trim();
    if (!GROUP_KEY_FIELD_PLACEHOLDERS.has(name) && !GROUP_KEY_LABEL_PLACEHOLDER.test(name)) {
      return `Unknown groupKey placeholder {{${name}}}. Allowed: {{source}}, {{type}}, {{severity}}, {{dedupeKey}}, {{labels.<key>}}`;
    }
  }
  if (template.replace(GROUP_KEY_PLACEHOLDER, "").match(/\{\{|\}\}/)) {
    return "groupKey contains a malformed placeholder";
  }
  return null;
}

/**
 * Renders a validated groupKey template. This is deliberately not the routine
 * variable interpolator: it only knows event fields, and a label the event does
 * not carry renders as `labels.<key>=∅` so those events stay in their own,
 * visible group instead of silently merging.
 */
export function renderEventGroupKey(template: string, event: NormalizedEvent): string {
  return template.replace(GROUP_KEY_PLACEHOLDER, (_whole, rawName: string) => {
    const name = rawName.trim();
    if (name === "source") return event.source;
    if (name === "type") return event.type;
    if (name === "severity") return event.severity;
    if (name === "dedupeKey") return event.dedupeKey;
    const label = GROUP_KEY_LABEL_PLACEHOLDER.exec(name);
    if (label) {
      const value = event.labels[label[1]!];
      return value === undefined ? `labels.${label[1]}=∅` : value;
    }
    return "";
  });
}

export const eventGroupKeyTemplateSchema = z
  .string()
  .superRefine((value, ctx) => {
    const error = validateEventGroupKeyTemplate(value);
    if (error) ctx.addIssue({ code: "custom", message: error });
  });

export const eventGroupingSchema = z.object({
  groupKey: eventGroupKeyTemplateSchema.optional().default(DEFAULT_EVENT_GROUP_KEY_TEMPLATE),
  repeatCommentCooldownSec: z.number().int().min(0).max(86_400).optional().default(900),
  rewakeOnSeverityIncrease: z.boolean().optional().default(true),
  onRecovery: z.enum(EVENT_ON_RECOVERY_MODES).optional().default("comment_and_wake"),
  issueMode: z
    .union([z.literal("group"), z.object({ appendToIssueId: z.string().guid() }).strict()])
    .optional()
    .default("group"),
}).strict();
export type EventGrouping = z.infer<typeof eventGroupingSchema>;

export const DEFAULT_EVENT_GROUPING: EventGrouping = eventGroupingSchema.parse({});

// ── Event source configuration ──────────────────────────────────────────────

const gatusEndpointMapEntrySchema = z.object({
  type: z.string().regex(TYPE_PATTERN),
  labels: eventLabelsSchema.optional(),
  severity: z.enum(EVENT_SEVERITIES).optional(),
}).strict();

/** `endpointMap` keys are `<group>/<name>` (an ungrouped endpoint is `/<name>`). */
export const gatusNormalizerConfigSchema = z.object({
  endpointMap: z.record(z.string().min(1).max(256), gatusEndpointMapEntrySchema)
    .refine((map) => Object.keys(map).length <= 500, { message: "At most 500 endpoints can be mapped" })
    .optional()
    .default({}),
}).strict();
export type GatusNormalizerConfig = z.infer<typeof gatusNormalizerConfigSchema>;

const pinnedLabelsSchema = z
  .record(labelKeySchema, z.string().min(1).max(256))
  .refine((labels) => Object.keys(labels).length <= EVENT_MAX_LABELS, {
    message: `At most ${EVENT_MAX_LABELS} pinned labels are allowed`,
  });

const eventSourceFieldsSchema = z.object({
  name: z.string().trim().min(1).max(EVENT_SOURCE_NAME_MAX_LENGTH),
  enabled: z.boolean().optional(),
  signingMode: z.enum(EVENT_SOURCE_SIGNING_MODES).optional(),
  replayWindowSec: z.number().int().min(30).max(86_400).optional(),
  normalizer: z.enum(EVENT_SOURCE_NORMALIZERS).optional(),
  normalizerConfig: z.record(z.string(), z.unknown()).nullable().optional(),
  pinnedLabels: pinnedLabelsSchema.optional(),
  rateLimitPerMinute: z.number().int().min(1).max(100_000).optional(),
  maxNewIssuesPerHour: z.number().int().min(1).max(10_000).optional(),
  retentionDays: z.number().int().min(1).max(365).optional(),
});

/** Returns an error message when the normalizer config does not fit the normalizer. */
export function validateEventSourceNormalizerConfig(
  normalizer: EventSourceNormalizer,
  config: Record<string, unknown> | null | undefined,
): string | null {
  if (normalizer === "gatus") {
    const parsed = gatusNormalizerConfigSchema.safeParse(config ?? {});
    return parsed.success ? null : parsed.error.issues.map((issue) => `${issue.path.join(".") || "normalizerConfig"}: ${issue.message}`).join("; ");
  }
  if (config && Object.keys(config).length > 0) return "normalizerConfig is only used by the gatus normalizer";
  return null;
}

export const createEventSourceSchema = eventSourceFieldsSchema.superRefine((value, ctx) => {
  const error = validateEventSourceNormalizerConfig(value.normalizer ?? "generic_v1", value.normalizerConfig);
  if (error) ctx.addIssue({ code: "custom", path: ["normalizerConfig"], message: error });
});
export type CreateEventSource = z.infer<typeof createEventSourceSchema>;

/** Cross-field normalizer/config validation for a patch runs in the service, which knows the stored normalizer. */
export const updateEventSourceSchema = eventSourceFieldsSchema.partial().extend({
  archived: z.boolean().optional(),
});
export type UpdateEventSource = z.infer<typeof updateEventSourceSchema>;

/** Dry run: the raw body a sender would POST. */
export const testEventSourceSchema = z.object({
  payload: z.record(z.string(), z.unknown()),
});
export type TestEventSource = z.infer<typeof testEventSourceSchema>;

export const rotateEventSourceSecretSchema = z.object({});

export const listEventDeliveriesQuerySchema = z.object({
  status: z.enum(EVENT_DELIVERY_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  cursor: z.string().min(1).max(256).optional(),
});
export type ListEventDeliveriesQuery = z.infer<typeof listEventDeliveriesQuerySchema>;

// ── API shapes ──────────────────────────────────────────────────────────────

export interface EventSource {
  id: string;
  companyId: string;
  name: string;
  enabled: boolean;
  archived: boolean;
  publicId: string;
  /** Absolute ingress URL (`POST`). */
  ingressUrl: string;
  secretId: string | null;
  signingMode: EventSourceSigningMode;
  replayWindowSec: number;
  normalizer: EventSourceNormalizer;
  normalizerConfig: Record<string, unknown> | null;
  pinnedLabels: Record<string, string>;
  rateLimitPerMinute: number;
  maxNewIssuesPerHour: number;
  retentionDays: number;
  lastRotatedAt: Date | null;
  lastDeliveryAt: Date | null;
  lastResult: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Returned exactly once, on create and on rotate. */
export interface EventSourceSecretMaterial {
  ingressUrl: string;
  secret: string;
}

export interface EventRoutineOutcome {
  status: EventRoutineOutcomeStatus;
  runId?: string | null;
  issueId?: string | null;
  failureClass?: "permanent" | "transient";
  error?: string | null;
  /** Non-failure detail, for example `append_target_unavailable` when `appendToIssueId` fell back to group mode. */
  note?: string | null;
}

export interface EventDelivery {
  id: string;
  companyId: string;
  sourceId: string;
  status: EventDeliveryStatus;
  receivedAt: Date;
  claimedAt: Date | null;
  attempts: number;
  httpStatus: number | null;
  latencyMs: number | null;
  event: Record<string, unknown> | null;
  routineOutcomes: Record<string, EventRoutineOutcome>;
  matchedTriggerIds: string[];
  routineRunIds: string[];
  issueIds: string[];
  error: string | null;
  /** Populated on `rejected_aggregate` rows only. */
  rejectCounts: Partial<Record<EventRejectOutcome, number>> | null;
  firstIp: string | null;
  lastIp: string | null;
}

export interface EventDeliveryPage {
  items: EventDelivery[];
  nextCursor: string | null;
}

export type EventDryRunAction =
  | "new_issue"
  | "comment"
  | "comment_and_wake"
  | "silent"
  | "recovery_comment"
  | "recovery_without_issue"
  | "recovery_ignored"
  | "storm_folded";

export interface EventDryRunRoutineResult {
  routineId: string;
  routineTitle: string;
  assigneeAgentId: string | null;
  triggerIds: string[];
  groupKey: string;
  action: EventDryRunAction;
  issueId: string | null;
}

export interface EventSourceDryRunResult {
  event: NormalizedEvent | null;
  validationErrors: string[];
  matched: EventDryRunRoutineResult[];
  fallback: EventDryRunRoutineResult[];
  /** Status the delivery would end with. */
  wouldBe: EventDeliveryStatus | null;
}

export interface RoutineEventGroup {
  id: string;
  companyId: string;
  routineId: string;
  fingerprint: string;
  issueId: string;
  issueIdentifier: string | null;
  issueStatus: string | null;
  issueTitle: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastCommentAt: Date | null;
  repeatCount: number;
  lastSeverity: EventSeverity;
  lastState: EventState;
}
