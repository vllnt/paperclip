import type { heartbeatRuns, runUsageRecords } from "@paperclipai/db";
import {
  RUN_USAGE_RECORD_SCHEMA_VERSION,
  RUN_USAGE_TERMINAL_STATUSES,
  classifyRunFailure,
  type RunUsageQuality,
  type RunUsageRecordSource,
} from "@paperclipai/shared";

/** The columns of a run row that the derivation reads. Nothing else of the row is ever read. */
export type RunUsageDeriveRun = Pick<
  typeof heartbeatRuns.$inferSelect,
  | "id"
  | "companyId"
  | "agentId"
  | "invocationSource"
  | "status"
  | "errorCode"
  | "signal"
  | "stderrExcerpt"
  | "runtimeMode"
  | "driverKind"
  | "retryOfRunId"
  | "scheduledRetryReason"
  | "livenessState"
  | "lastUsefulActionAt"
  | "usageJson"
  | "contextSnapshot"
  | "sessionIdBefore"
  | "createdAt"
  | "startedAt"
  | "finishedAt"
>;

/** The issue a run worked on, as far as the derivation needs it. Resolved inside the run's company. */
export interface RunUsageDeriveIssue {
  id: string;
  projectId: string | null;
  originKind: string;
  originId: string | null;
}

/** Everything {@link deriveRunUsageRecord} needs. The caller resolves related rows inside the company. */
export interface DeriveRunUsageRecordInput {
  run: RunUsageDeriveRun;
  adapterType: string;
  issue: RunUsageDeriveIssue | null;
  /** The project named in the run context, already checked to belong to the run's company. */
  contextProjectId: string | null;
  /** The wake reason from the run context, else from its wake request. */
  wakeReason: string | null;
  retryDepth: number;
  source: RunUsageRecordSource;
}

export type RunUsageRecordInsert = typeof runUsageRecords.$inferInsert;

const IDENTIFIER_PATTERN = /^[a-z0-9_.:@/+-]{1,80}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(RUN_USAGE_TERMINAL_STATUSES);
const DEFERRAL_ERROR_CODES: ReadonlySet<string> = new Set(["workspace_busy", "ai_connection_busy"]);
const USAGE_BASES: ReadonlySet<string> = new Set(["per_run", "session_delta"]);

/**
 * Keeps an identifier column to a short, safe alphabet. Anything else becomes `other`, so free
 * text can never reach the table.
 */
function toIdentifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return null;
  return IDENTIFIER_PATTERN.test(normalized) ? normalized : "other";
}

function readCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)));
}

function readCostUsd(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Cost in micro-USD. It follows the ledger's rule (the cache-adjusted cost, else the plain cost,
 * and zero for a subscription-included run) but keeps the sub-cent part the ledger rounds away.
 */
function readCostMicros(usage: Record<string, unknown>, billingType: string | null): number | null {
  if (billingType === "subscription_included") return 0;
  const usd = readCostUsd(usage.cacheAdjustedCostUsd) ?? readCostUsd(usage.costUsd);
  return usd === null ? null : Math.round(usd * 1_000_000);
}

function isCodexFamily(value: string | null): boolean {
  return value !== null && value.includes("codex");
}

function readUsageBasis(usage: Record<string, unknown>): string | null {
  const basis = usage.usageSource;
  return typeof basis === "string" && USAGE_BASES.has(basis) ? basis : null;
}

/**
 * Codex counts stay `declared` until the provider's cumulative-versus-per-run basis is verified
 * on real data, so a panel can show a caveat. A server-side baseline subtraction is `derived`.
 */
function resolveUsageQuality(input: {
  hasTokens: boolean;
  usageBasis: string | null;
  adapterType: string | null;
  driverKind: string | null;
}): RunUsageQuality {
  if (!input.hasTokens) return "missing";
  if (input.usageBasis === "session_delta") return "derived";
  if (isCodexFamily(input.adapterType) || isCodexFamily(input.driverKind)) return "declared";
  return "measured";
}

function resolveRoutineId(issue: RunUsageDeriveIssue | null): string | null {
  if (issue?.originKind !== "routine_execution") return null;
  return issue.originId !== null && UUID_PATTERN.test(issue.originId) ? issue.originId.toLowerCase() : null;
}

function diffMs(later: Date, earlier: Date): number {
  return Math.max(0, later.getTime() - earlier.getTime());
}

/**
 * Builds one `run_usage_records` row from a terminal run's own row and its resolved issue.
 * It is pure: no database, no clock, no logs. It reads counts, closed enums and short
 * identifiers only, and never a prompt, context, stdout or stderr text; `stderrExcerpt` is
 * passed to the failure classifier and discarded.
 *
 * @param input - The run row columns and the related rows the caller resolved inside the company.
 * @returns The row to upsert, or null when the run is not terminal.
 * @example
 * deriveRunUsageRecord({ run, adapterType: "claude_local", issue: null, contextProjectId: null,
 *   wakeReason: null, retryDepth: 0, source: "derived" });
 */
export function deriveRunUsageRecord(input: DeriveRunUsageRecordInput): RunUsageRecordInsert | null {
  const { run, issue } = input;
  if (!TERMINAL_STATUSES.has(run.status)) return null;

  const usage = run.usageJson ?? {};
  const adapterType = toIdentifier(input.adapterType) ?? "other";
  const driverKind = toIdentifier(run.driverKind);
  const billingType = toIdentifier(usage.billingType);
  const inputTokens = readCount(usage.inputTokens);
  const cacheReadTokens = readCount(usage.cachedInputTokens);
  const outputTokens = readCount(usage.outputTokens);
  const usageBasis = readUsageBasis(usage);
  const finishedAt = run.finishedAt ?? run.createdAt;
  const errorCode = toIdentifier(run.errorCode);

  return {
    runId: run.id,
    companyId: run.companyId,
    agentId: run.agentId,
    issueId: issue?.id ?? null,
    projectId: issue?.projectId ?? input.contextProjectId,
    routineId: resolveRoutineId(issue),

    adapterType,
    runtimeMode: toIdentifier(run.runtimeMode) ?? "other",
    driverKind,
    provider: toIdentifier(usage.provider),
    biller: toIdentifier(usage.biller),
    billingType,
    model: toIdentifier(usage.model),
    modelCount: null,
    invocationSource: toIdentifier(run.invocationSource) ?? "other",
    wakeReason: toIdentifier(input.wakeReason),
    isRetry: run.retryOfRunId !== null,
    retryDepth: input.retryDepth,
    retryReason: toIdentifier(run.scheduledRetryReason),
    sessionReused: usage.sessionReused === true || run.sessionIdBefore !== null,

    status: run.status,
    errorCode,
    causeFamily: classifyRunFailure({
      status: run.status,
      errorCode: run.errorCode,
      signal: run.signal,
      stderrExcerpt: run.stderrExcerpt,
    }),
    livenessState: toIdentifier(run.livenessState),
    providerWorkStarted: run.startedAt !== null && !(errorCode !== null && DEFERRAL_ERROR_CODES.has(errorCode)),
    usefulAction: run.lastUsefulActionAt !== null ? true : run.livenessState !== null ? false : null,
    issueStatusAtStart: null,
    issueStatusAtEnd: null,

    inputTokens,
    cacheReadTokens,
    cacheWriteTokens: null,
    outputTokens,
    reasoningTokens: null,
    usageBasis,
    usageQuality: resolveUsageQuality({
      hasTokens: inputTokens !== null || cacheReadTokens !== null || outputTokens !== null,
      usageBasis,
      adapterType,
      driverKind,
    }),

    costMicros: readCostMicros(usage, billingType),
    apiEquivalentMicros: null,
    costStatus: toIdentifier(usage.costStatus),

    runCreatedAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt,
    day: finishedAt.toISOString().slice(0, 10),
    queueWaitMs: run.startedAt !== null ? diffMs(run.startedAt, run.createdAt) : null,
    durationMs: run.startedAt !== null && run.finishedAt !== null ? diffMs(run.finishedAt, run.startedAt) : null,
    startupMs: null,
    firstEventMs: null,

    turns: null,
    toolCalls: null,
    toolErrors: null,

    firstTurnPromptTokens: null,
    footprintChars: null,
    footprintSources: null,

    schemaVersion: RUN_USAGE_RECORD_SCHEMA_VERSION,
    source: input.source,
  };
}
