import { z } from "zod";
import {
  EVENT_MAX_LABELS,
  EVENT_WIRE_SCHEMA_ID,
  gatusNormalizerConfigSchema,
  genericV1EventSchema,
  replaceLoneSurrogates,
  sanitizeEventSingleLine,
  type EventSeverity,
  type EventSourceNormalizer,
  type GatusNormalizerConfig,
  type NormalizedEvent,
} from "@paperclipai/shared";

/** The slice of an event source the normalizers need. */
export interface EventNormalizerSource {
  normalizer: EventSourceNormalizer | string;
  normalizerConfig: Record<string, unknown> | null;
  pinnedLabels: Record<string, string>;
}

export type NormalizeEventResult =
  | { ok: true; event: NormalizedEvent }
  | { ok: false; errors: string[] };

const MAX_REPORTED_ERRORS = 10;

function describeZodIssues(error: z.ZodError): string[] {
  return error.issues.slice(0, MAX_REPORTED_ERRORS).map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

/**
 * Percent-escapes everything outside printable ASCII so the dedupeKey stays within its wire contract.
 * `%` and `/` are escaped too, so `group/name` is injective: "café" and "caf%C3%A9", or
 * ("a/b", "c") and ("a", "b/c"), never share a key.
 */
function toPrintableAscii(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0)!;
    out += code >= 0x20 && code <= 0x7e && char !== "%" && char !== "/" ? char : encodeURIComponent(char);
  }
  return out;
}

function finalizeEvent(
  parsed: z.infer<typeof genericV1EventSchema>,
  pinnedLabels: Record<string, string>,
  now: Date,
): NormalizeEventResult {
  // Pinned labels are forced last, so a sender can never speak for another identity.
  const labels: Record<string, string> = { ...(parsed.labels ?? {}) };
  for (const [key, value] of Object.entries(pinnedLabels)) {
    labels[key] = sanitizeEventSingleLine(value);
  }
  if (Object.keys(labels).length > EVENT_MAX_LABELS) {
    return { ok: false, errors: [`labels: at most ${EVENT_MAX_LABELS} labels are allowed including pinned labels`] };
  }
  const occurred = parsed.occurredAt ? new Date(parsed.occurredAt) : now;
  return {
    ok: true,
    event: {
      eventId: parsed.eventId ?? null,
      source: parsed.source,
      type: parsed.type,
      severity: parsed.severity,
      state: parsed.state,
      dedupeKey: parsed.dedupeKey,
      title: parsed.title,
      summary: parsed.summary ?? "",
      labels,
      occurredAt: (Number.isNaN(occurred.getTime()) ? now : occurred).toISOString(),
      url: parsed.url ?? null,
    },
  };
}

// ── generic_v1 ──────────────────────────────────────────────────────────────

function normalizeGenericV1(body: unknown, source: EventNormalizerSource, now: Date): NormalizeEventResult {
  const parsed = genericV1EventSchema.safeParse(body);
  if (!parsed.success) return { ok: false, errors: describeZodIssues(parsed.error) };
  return finalizeEvent(parsed.data, source.pinnedLabels, now);
}

// ── gatus ───────────────────────────────────────────────────────────────────

/**
 * The body a Gatus `custom` alert provider is configured to send. Gatus can
 * only substitute its own placeholders, so this is the documented template:
 *
 *   {"status":"[ALERT_TRIGGERED_OR_RESOLVED]","group":"[ENDPOINT_GROUP]",
 *    "name":"[ENDPOINT_NAME]","description":"[ALERT_DESCRIPTION]","url":"[ENDPOINT_URL]"}
 */
const gatusBodySchema = z.object({
  status: z.string().transform((value) => value.trim().toUpperCase()).pipe(z.enum(["TRIGGERED", "RESOLVED"])),
  group: z.string().max(200).optional().default(""),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(4000).optional().default(""),
  url: z.string().max(2048).optional(),
});

const GATUS_DEFAULT_TYPE = "gatus.endpoint";
const GATUS_DEFAULT_SEVERITY: EventSeverity = "critical";

function normalizeGatus(body: unknown, source: EventNormalizerSource, now: Date): NormalizeEventResult {
  const parsedBody = gatusBodySchema.safeParse(body);
  if (!parsedBody.success) return { ok: false, errors: describeZodIssues(parsedBody.error) };
  const config: GatusNormalizerConfig = gatusNormalizerConfigSchema.parse(source.normalizerConfig ?? {});

  const gatus = parsedBody.data;
  const endpoint = `${gatus.group}/${gatus.name}`;
  const mapped = config.endpointMap[endpoint];
  const recovery = gatus.status === "RESOLVED";

  const candidate = {
    schema: EVENT_WIRE_SCHEMA_ID,
    source: "gatus",
    type: mapped?.type ?? GATUS_DEFAULT_TYPE,
    severity: mapped?.severity ?? GATUS_DEFAULT_SEVERITY,
    state: recovery ? "recovery" : "problem",
    dedupeKey: `gatus:${toPrintableAscii(gatus.group)}/${toPrintableAscii(gatus.name)}`,
    title: recovery ? `Gatus: ${endpoint} recovered` : `Gatus: ${endpoint} is failing`,
    summary: gatus.description,
    // An unmapped endpoint carries its raw name so it reaches a fallback and stays visible.
    labels: mapped ? { ...(mapped.labels ?? {}) } : { endpoint },
    // The URL is informational: a malformed one is dropped, not a reason to lose the alert.
    ...(gatus.url && /^https?:\/\/[^\s\u0000-\u001f\u007f-\u009f]+$/i.test(gatus.url.trim()) ? { url: gatus.url.trim() } : {}),
  };
  const parsed = genericV1EventSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, errors: describeZodIssues(parsed.error) };
  return finalizeEvent(parsed.data, source.pinnedLabels, now);
}

/** Makes every string in a parsed JSON value well-formed UTF-16, keys included. */
function toWellFormed(value: unknown): unknown {
  if (typeof value === "string") return replaceLoneSurrogates(value);
  if (Array.isArray(value)) return value.map(toWellFormed);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [replaceLoneSurrogates(key), toWellFormed(entry)]));
  }
  return value;
}

/** Pure: turns a sender's parsed JSON body into a normalized event, or the reasons it is invalid. */
export function normalizeEvent(source: EventNormalizerSource, rawBody: unknown, now: Date = new Date()): NormalizeEventResult {
  if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return { ok: false, errors: ["body must be a JSON object"] };
  }
  const body = toWellFormed(rawBody);
  switch (source.normalizer) {
    case "gatus":
      return normalizeGatus(body, source, now);
    case "generic_v1":
      return normalizeGenericV1(body, source, now);
    default:
      return { ok: false, errors: [`Unknown normalizer ${String(source.normalizer)}`] };
  }
}
