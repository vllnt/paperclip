import { isProviderQuotaMessage, parseProviderQuotaResetAt } from "@paperclipai/adapter-utils/provider-quota";
import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { applyTurnBoundary, createTurnBoundaryState } from "../shared/turn-boundary.js";

export interface ParsedGrokJsonl {
  sessionId: string | null;
  summary: string;
  thought: string;
  errorMessage: string | null;
  stopReason: string | null;
  requestId: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number | null;
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = parseObject(value);
  const message =
    asString(rec.message, "").trim() ||
    asString(rec.error, "").trim() ||
    asString(rec.detail, "").trim() ||
    asString(rec.code, "").trim();
  if (message) return message;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

export function parseGrokJsonl(stdout: string): ParsedGrokJsonl {
  let sessionId: string | null = null;
  let stopReason: string | null = null;
  let requestId: string | null = null;
  let errorMessage: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let costUsd: number | null = null;
  const thoughtParts: string[] = [];
  const textParts: string[] = [];
  const thoughtBoundary = createTurnBoundaryState();

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event.type, "").trim();
    if (type === "thought") {
      const text = asString(event.data, "");
      if (text) thoughtParts.push(applyTurnBoundary(thoughtBoundary, text));
      continue;
    }

    if (type === "text") {
      const text = asString(event.data, "");
      if (text) textParts.push(text);
      continue;
    }

    if (type === "end") {
      sessionId = asString(event.sessionId, "").trim() || sessionId;
      stopReason = asString(event.stopReason, "").trim() || stopReason;
      requestId = asString(event.requestId, "").trim() || requestId;
      const usage = parseObject(event.usage);
      inputTokens = asNumber(usage.input_tokens, inputTokens);
      outputTokens = asNumber(usage.output_tokens, outputTokens);
      cachedInputTokens = asNumber(usage.cache_read_input_tokens, cachedInputTokens);
      const totalCostUsd = event.total_cost_usd;
      if (typeof totalCostUsd === "number" && Number.isFinite(totalCostUsd)) {
        costUsd = totalCostUsd;
      }
      continue;
    }

    if (type === "error") {
      const text = errorText(event.error ?? event.message ?? event.detail ?? event.data).trim();
      if (text) errorMessage = text;
    }
  }

  return {
    sessionId,
    summary: textParts.join("").trim(),
    thought: thoughtParts.join("").trim(),
    errorMessage,
    stopReason,
    requestId,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    costUsd,
  };
}

// Each pattern is a flat alternation of literals with single `\s+` gaps, so a
// long message cannot make it backtrack.
const GROK_AUTH_RE =
  /not\s+signed\s+in|invalid\s+(?:x?ai\s+)?api\s+key|incorrect\s+api\s+key|api\s+key\s+(?:is\s+)?(?:invalid|expired|revoked)|401\s+unauthorized/i;
const GROK_TRANSIENT_RE =
  /overloaded|at\s+capacity|capacity\s+limit|high\s+demand|server\s+is\s+busy|service\s+unavailable|temporarily\s+unavailable|bad\s+gateway|gateway\s+time-?out|too\s+many\s+requests|rate\s+limited/i;

export interface GrokFailureClassification {
  errorCode: "grok_auth_required" | "provider_quota" | "grok_transient_upstream" | null;
  errorFamily: "provider_quota" | "transient_upstream" | null;
  retryNotBefore: string | null;
}

/**
 * Classifies a failed Grok run from its error text. The CLI prints one
 * `{"type":"error","message":…}` event and the same text on stderr, and drops
 * the upstream status, code and reset headers, so only the message is left.
 * A sign-in failure is never a quota failure: a cooldown would only delay the
 * repair. Run it on the run's error message, not on tool output.
 *
 * @param input - The parsed error event text and the process stderr.
 * @param now - Reference time for relative reset durations.
 * @returns The error code and family the heartbeat acts on, or nulls.
 * @example classifyGrokFailure({ errorMessage: "Not signed in. …", stderr: "" }, new Date()).errorCode // "grok_auth_required"
 */
export function classifyGrokFailure(
  input: { errorMessage: string | null; stderr: string },
  now: Date = new Date(),
): GrokFailureClassification {
  const text = [input.errorMessage, firstLine(input.stderr)].filter(Boolean).join("\n");
  if (GROK_AUTH_RE.test(text)) {
    return { errorCode: "grok_auth_required", errorFamily: null, retryNotBefore: null };
  }
  if (isProviderQuotaMessage(text)) {
    return {
      errorCode: "provider_quota",
      errorFamily: "provider_quota",
      retryNotBefore: parseProviderQuotaResetAt(text, now)?.toISOString() ?? null,
    };
  }
  if (GROK_TRANSIENT_RE.test(text)) {
    return {
      errorCode: "grok_transient_upstream",
      errorFamily: "transient_upstream",
      retryNotBefore: parseProviderQuotaResetAt(text, now)?.toISOString() ?? null,
    };
  }
  return { errorCode: null, errorFamily: null, retryNotBefore: null };
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
}

export function isGrokUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session(?:\s+.*)?\s+not\s+found|resume\s+.*\s+not\s+found|invalid\s+session/i.test(haystack);
}
