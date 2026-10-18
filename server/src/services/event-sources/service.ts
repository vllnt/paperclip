import crypto from "node:crypto";
import { and, asc, desc, eq, lt, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  eventDeliveries,
  eventSources,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import {
  matchesEvent,
  validateEventSourceNormalizerConfig,
  type CreateEventSource,
  type EventDelivery,
  type EventDeliveryPage,
  type EventDeliveryStatus,
  type EventDryRunRoutineResult,
  type EventRejectOutcome,
  type EventRoutineOutcome,
  type EventSource,
  type EventSourceDryRunResult,
  type EventSourceSecretMaterial,
  type ListEventDeliveriesQuery,
  type NormalizedEvent,
  type UpdateEventSource,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { redactEventPayload } from "../../redaction.js";
import { getConfiguredSecretProvider } from "../../secrets/configured-provider.js";
import { runtimePublicOrigin } from "../cloud-runtime-identity.js";
import type { IssueAssignmentWakeupDeps } from "../issue-assignment-wakeup.js";
import type { PluginWorkerManager } from "../plugin-worker-manager.js";
import { routineService } from "../routines.js";
import { secretService } from "../secrets.js";
import { verifyBearerAuthorization, verifyHmacSha256Signature } from "../webhook-auth.js";
import { registerGatedEventSettler, type GatedEventSettlement } from "../routine-gates/hooks.js";
import { previewEventRoutine } from "./event-dispatch.js";
import { pruneEventData } from "./prune.js";
import { normalizeEvent } from "./normalizers.js";
import { createRejectCounters, type RejectBucket } from "./reject-counters.js";
import { createSemaphore } from "./semaphore.js";
import { createSlidingWindowLimiter } from "./sliding-window-limiter.js";
import { createEventSourceCache } from "./source-cache.js";

type EventSourceRow = typeof eventSources.$inferSelect;
type RoutineRow = typeof routines.$inferSelect;
type RoutineTriggerRow = typeof routineTriggers.$inferSelect;

export type EventActor = { agentId?: string | null; userId?: string | null; runId?: string | null };

/** Per-IP and global budgets for requests that fail authentication. Authenticated requests never spend them. */
export const EVENT_AUTH_FAILURE_PER_IP_PER_MINUTE = 60;
export const EVENT_AUTH_FAILURE_GLOBAL_PER_MINUTE = 600;
/** A `processing` delivery may be re-claimed once its claim is older than this. Keep it well above worst-case fan-out time. */
export const EVENT_DELIVERY_LEASE_MS = 120_000;
export const EVENT_RETRY_AFTER_SECONDS = 30;
const EVENT_AUDIT_MAX_BYTES = 16 * 1024;
const EVENT_SOURCE_SECRET_CONFIG_PATH = "eventSourceSecret";
const LAST_DELIVERY_TOUCH_INTERVAL_MS = 10_000;
const REJECT_FLUSH_INTERVAL_MS = 30_000;
/** Dispatches hold two pooled connections each (see semaphore.ts), so only a few run at once. */
export const EVENT_DISPATCH_CONCURRENCY = 4;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const PRUNE_FIRST_RUN_DELAY_MS = 2 * 60 * 1000;

const TERMINAL_DELIVERY_STATUSES: EventDeliveryStatus[] = [
  "dispatched",
  "grouped_silent",
  "invalid",
  "unrouted",
  "storm_folded",
  "recovery_without_issue",
];

export function eventSourceIngressUrl(publicId: string): string {
  const path = `/api/event-sources/public/${publicId}/events`;
  const baseUrl = runtimePublicOrigin() ?? process.env.PAPERCLIP_API_URL?.trim();
  return baseUrl ? `${baseUrl.replace(/\/+$/, "")}${path}` : path;
}

function toApiSource(row: EventSourceRow): EventSource {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    enabled: row.enabled,
    archived: row.archived,
    publicId: row.publicId,
    ingressUrl: eventSourceIngressUrl(row.publicId),
    secretId: row.secretId,
    signingMode: row.signingMode as EventSource["signingMode"],
    replayWindowSec: row.replayWindowSec,
    normalizer: row.normalizer as EventSource["normalizer"],
    normalizerConfig: row.normalizerConfig ?? null,
    pinnedLabels: row.pinnedLabels ?? {},
    rateLimitPerMinute: row.rateLimitPerMinute,
    maxNewIssuesPerHour: row.maxNewIssuesPerHour,
    retentionDays: row.retentionDays,
    lastRotatedAt: row.lastRotatedAt,
    lastDeliveryAt: row.lastDeliveryAt,
    lastResult: row.lastResult,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    updatedByAgentId: row.updatedByAgentId,
    updatedByUserId: row.updatedByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toApiDelivery(row: typeof eventDeliveries.$inferSelect): EventDelivery {
  return {
    id: row.id,
    companyId: row.companyId,
    sourceId: row.sourceId,
    status: row.status as EventDeliveryStatus,
    receivedAt: row.receivedAt,
    claimedAt: row.claimedAt,
    attempts: row.attempts,
    httpStatus: row.httpStatus,
    latencyMs: row.latencyMs,
    event: row.event ?? null,
    routineOutcomes: row.routineOutcomes ?? {},
    matchedTriggerIds: row.matchedTriggerIds ?? [],
    routineRunIds: row.routineRunIds ?? [],
    issueIds: row.issueIds ?? [],
    error: row.error,
    rejectCounts: row.rejectCounts ?? null,
    firstIp: row.firstIp,
    lastIp: row.lastIp,
  };
}

/** The audit copy of an event: redacted with the shared secret redactor and capped at 16 KB. */
export function eventForAudit(event: NormalizedEvent): Record<string, unknown> {
  const redacted = redactEventPayload(event as unknown as Record<string, unknown>) ?? {};
  if (Buffer.byteLength(JSON.stringify(redacted)) <= EVENT_AUDIT_MAX_BYTES) return redacted;
  return { ...redacted, summary: "", labels: {}, truncated: true };
}

function sha256Hex(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

interface CachedSource {
  row: EventSourceRow;
  /** `null` when the source has no resolvable secret: every request then fails authentication. */
  secret: string | null;
}

export interface IngestRequest {
  publicId: string;
  ip: string | null;
  authorizationHeader: string | undefined;
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  rawBody: Buffer | null;
  body: unknown;
  /** Test seam; defaults to the wall clock. */
  nowMs?: number;
}

export interface IngestResult {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

interface Subscriber {
  routine: RoutineRow;
  /** Oldest matching trigger; its grouping config applies. */
  trigger: RoutineTriggerRow;
  triggerIds: string[];
}

function isSuccessfulOutcome(outcome: EventRoutineOutcome | undefined): boolean {
  return !!outcome && outcome.status !== "failed_permanent" && outcome.status !== "failed_transient";
}

function summarizeOutcomes(outcomes: EventRoutineOutcome[]): EventDeliveryStatus {
  const succeeded = outcomes.filter((outcome) => isSuccessfulOutcome(outcome));
  // A run parked behind a gate script counts as dispatched; its final outcome lands on the delivery later.
  if (succeeded.some((o) => o.status === "issue_created" || o.status === "grouped" || o.status === "recovered" || o.status === "gating")) {
    return "dispatched";
  }
  if (succeeded.some((o) => o.status === "storm_folded")) return "storm_folded";
  if (succeeded.some((o) => o.status === "grouped_silent")) return "grouped_silent";
  if (succeeded.length > 0) return "recovery_without_issue";
  return "failed";
}

export function eventSourceService(
  db: Db,
  deps: {
    heartbeat?: IssueAssignmentWakeupDeps;
    pluginWorkerManager?: PluginWorkerManager;
    now?: () => number;
  } = {},
) {
  const now = deps.now ?? Date.now;
  const secretsSvc = secretService(db);
  const routinesSvc = routineService(db, { heartbeat: deps.heartbeat, pluginWorkerManager: deps.pluginWorkerManager });
  const failureLimiter = createSlidingWindowLimiter({ now });
  const sourceLimiter = createSlidingWindowLimiter({ now });
  const rejectCounters = createRejectCounters({ now });
  const dispatchGate = createSemaphore(EVENT_DISPATCH_CONCURRENCY);
  const lastTouchedAt = new Map<string, number>();
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let pruneTimer: ReturnType<typeof setInterval> | null = null;
  let pruneStartTimer: ReturnType<typeof setTimeout> | null = null;

  async function resolveSourceSecret(row: EventSourceRow): Promise<string | null> {
    if (!row.secretId) return null;
    return secretsSvc.resolveSecretValue(row.companyId, row.secretId, "latest", {
      consumerType: "event_source",
      consumerId: row.id,
      actorType: "system",
      actorId: null,
      configPath: EVENT_SOURCE_SECRET_CONFIG_PATH,
    });
  }

  async function loadCachedSource(row: EventSourceRow | null): Promise<CachedSource | null> {
    // Unknown, disabled and archived sources are indistinguishable to a caller.
    if (!row || row.archived || !row.enabled) return null;
    return { row, secret: await resolveSourceSecret(row) };
  }

  const cache = createEventSourceCache<CachedSource>({
    now,
    load: async (publicId) => {
      const row = await db.select().from(eventSources).where(eq(eventSources.publicId, publicId)).then((rows) => rows[0] ?? null);
      return loadCachedSource(row);
    },
    loadAll: async () => {
      const rows = await db.select().from(eventSources).where(and(eq(eventSources.enabled, true), eq(eventSources.archived, false)));
      const loaded: Array<{ publicId: string; value: CachedSource }> = [];
      for (const row of rows) {
        try {
          const value = await loadCachedSource(row);
          if (value) loaded.push({ publicId: row.publicId, value });
        } catch (err) {
          logger.warn({ err, eventSourceId: row.id }, "failed to preload event source secret");
        }
      }
      return loaded;
    },
  });

  async function getSourceRow(id: string): Promise<EventSourceRow> {
    const row = await db.select().from(eventSources).where(eq(eventSources.id, id)).then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Event source not found");
    return row;
  }

  // ── rejects and audit rows ────────────────────────────────────────────────

  function countReject(source: { id: string; companyId: string } | null, outcome: EventRejectOutcome, ip: string | null) {
    rejectCounters.record({ sourceId: source?.id ?? null, companyId: source?.companyId ?? null, outcome, ip });
  }

  async function writeRejectBucket(bucket: RejectBucket) {
    if (!bucket.sourceId || !bucket.companyId) {
      logger.info(
        { counts: bucket.counts, firstIp: bucket.firstIp, lastIp: bucket.lastIp, minute: new Date(bucket.minuteStart).toISOString() },
        "event source requests for unknown sources",
      );
      return;
    }
    try {
      await db.insert(eventDeliveries).values({
        companyId: bucket.companyId,
        sourceId: bucket.sourceId,
        status: "rejected_aggregate",
        receivedAt: new Date(bucket.minuteStart),
        attempts: 0,
        rejectCounts: bucket.counts,
        firstIp: bucket.firstIp,
        lastIp: bucket.lastIp,
      });
    } catch (err) {
      logger.warn({ err, sourceId: bucket.sourceId }, "failed to flush event source reject counts");
    }
  }

  /** Writes one aggregate row per source per finished minute (everything with `all`). */
  async function flushRejects(options: { all?: boolean } = {}) {
    for (const bucket of rejectCounters.drain(options)) await writeRejectBucket(bucket);
  }

  async function prune() {
    try {
      const result = await pruneEventData(db, new Date(now()));
      if (result.deliveries || result.groups || result.webhookTestReceipts) {
        logger.info({ ...result }, "pruned event source data");
      }
      return result;
    } catch (err) {
      logger.warn({ err }, "event source pruning failed");
      return null;
    }
  }

  async function touchSource(sourceId: string, result: string) {
    const at = now();
    const last = lastTouchedAt.get(sourceId) ?? 0;
    if (at - last < LAST_DELIVERY_TOUCH_INTERVAL_MS) return;
    lastTouchedAt.set(sourceId, at);
    await db
      .update(eventSources)
      .set({ lastDeliveryAt: new Date(at), lastResult: result })
      .where(eq(eventSources.id, sourceId))
      .catch((err) => logger.warn({ err, sourceId }, "failed to record event source last delivery"));
  }

  // ── matching ──────────────────────────────────────────────────────────────

  async function findSubscribers(source: EventSourceRow, event: NormalizedEvent) {
    const rows = await db
      .select({ trigger: routineTriggers, routine: routines })
      .from(routineTriggers)
      .innerJoin(routines, eq(routines.id, routineTriggers.routineId))
      .where(
        and(
          eq(routineTriggers.eventSourceId, source.id),
          eq(routineTriggers.companyId, source.companyId),
          eq(routineTriggers.kind, "event"),
          eq(routineTriggers.enabled, true),
          eq(routineTriggers.archived, false),
          eq(routineTriggers.setupPending, false),
          eq(routines.status, "active"),
          eq(routines.companyId, source.companyId),
        ),
      )
      .orderBy(asc(routineTriggers.createdAt), asc(routineTriggers.id));

    const regular = new Map<string, Subscriber>();
    const fallbackByRoutine = new Map<string, Subscriber>();
    for (const { trigger, routine } of rows) {
      if (!matchesEvent(trigger.eventMatch, event)) continue;
      const bucket = trigger.fallback ? fallbackByRoutine : regular;
      const existing = bucket.get(routine.id);
      // One dispatch per routine: the oldest matching trigger wins, every match is recorded.
      if (existing) existing.triggerIds.push(trigger.id);
      else bucket.set(routine.id, { routine, trigger, triggerIds: [trigger.id] });
    }
    // A routine that already matched on a regular trigger never also takes the fallback.
    for (const routineId of regular.keys()) fallbackByRoutine.delete(routineId);
    return { regular: [...regular.values()], fallback: [...fallbackByRoutine.values()] };
  }

  /** Atomic counter: one short statement, run outside any dispatch transaction. */
  async function consumeStormSlot(sourceId: string): Promise<boolean> {
    const result = await db.execute(sql`
      update event_sources set
        storm_window_start = case
          when storm_window_start is null or storm_window_start <= now() - interval '1 hour' then now()
          else storm_window_start end,
        storm_window_count = case
          when storm_window_start is null or storm_window_start <= now() - interval '1 hour' then 1
          else least(storm_window_count + 1, max_new_issues_per_hour + 1) end
      where id = ${sourceId}
      returning storm_window_count, max_new_issues_per_hour
    `);
    const rows = (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? []) as Array<{
      storm_window_count: number;
      max_new_issues_per_hour: number;
    }>;
    const row = rows[0];
    return !row || Number(row.storm_window_count) <= Number(row.max_new_issues_per_hour);
  }

  // ── ingest ────────────────────────────────────────────────────────────────

  function failAuth(source: EventSourceRow | null, ip: string | null, outcome: "unauthorized" | "not_found"): IngestResult {
    const ipKey = `ip:${ip ?? "unknown"}`;
    const perIp = failureLimiter.consume(ipKey, EVENT_AUTH_FAILURE_PER_IP_PER_MINUTE);
    const global = failureLimiter.consume("global", EVENT_AUTH_FAILURE_GLOBAL_PER_MINUTE);
    if (!perIp.allowed || !global.allowed) {
      countReject(source, "auth_failure_rate_limited", ip);
      const retryAfter = Math.max(perIp.retryAfterSeconds, global.retryAfterSeconds, 1);
      return {
        status: 429,
        body: { error: "too_many_failed_requests" },
        headers: { "Retry-After": String(retryAfter) },
      };
    }
    countReject(source, outcome, ip);
    return outcome === "not_found"
      ? { status: 404, body: { error: "not_found" } }
      : { status: 401, body: { error: "unauthorized" } };
  }

  async function ingest(request: IngestRequest): Promise<IngestResult> {
    const startedAt = now();
    let cached: CachedSource | null;
    try {
      cached = await cache.get(request.publicId);
    } catch (err) {
      logger.warn({ err }, "event source lookup failed");
      return { status: 503, body: { error: "unavailable" }, headers: { "Retry-After": "5" } };
    }
    if (!cached) return failAuth(null, request.ip, "not_found");
    const source = cached.row;

    // Authenticate before any shared budget is spent.
    let authenticated = false;
    let hmacFingerprint: string | null = null;
    if (cached.secret) {
      if (source.signingMode === "bearer") {
        authenticated = verifyBearerAuthorization({ secret: cached.secret, authorizationHeader: request.authorizationHeader });
      } else if (request.rawBody) {
        const verified = verifyHmacSha256Signature({
          secret: cached.secret,
          rawBody: request.rawBody,
          signatureHeader: request.signatureHeader,
          timestampHeader: request.timestampHeader,
          replayWindowSec: source.replayWindowSec,
          now: request.nowMs ?? startedAt,
        });
        if (verified.valid) {
          authenticated = true;
          hmacFingerprint = `${verified.timestamp}:${verified.expectedHmac}`;
        }
      }
    }
    if (!authenticated) return failAuth(source, request.ip, "unauthorized");

    const budget = sourceLimiter.consume(source.id, source.rateLimitPerMinute);
    if (!budget.allowed) {
      countReject(source, "rate_limited", request.ip);
      return {
        status: 429,
        body: { error: "rate_limited" },
        headers: { "Retry-After": String(budget.retryAfterSeconds) },
      };
    }

    let normalized: ReturnType<typeof normalizeEvent>;
    try {
      normalized = normalizeEvent(source, request.body, new Date(startedAt));
    } catch (err) {
      // A sender must never turn a normalizer defect into a 500.
      logger.warn({ err, sourceId: source.id }, "event normalizer threw");
      normalized = { ok: false, errors: ["event could not be normalized"] };
    }
    if (!normalized.ok) {
      await db.insert(eventDeliveries).values({
        companyId: source.companyId,
        sourceId: source.id,
        status: "invalid",
        claimedAt: null,
        httpStatus: 422,
        latencyMs: Math.max(0, now() - startedAt),
        error: normalized.errors.join("; ").slice(0, 2000),
        firstIp: request.ip,
        lastIp: request.ip,
      });
      await touchSource(source.id, "invalid");
      return { status: 422, body: { error: "invalid_event", details: normalized.errors } };
    }
    const event = normalized.event;

    const deliveryKeyHash = event.eventId
      ? sha256Hex(`${source.id}:${event.source}:${event.eventId}`)
      : hmacFingerprint
        ? sha256Hex(`${source.id}:${hmacFingerprint}`)
        : null;

    const claim = await claimDelivery(source, event, deliveryKeyHash, request.ip, startedAt);
    if (claim.kind === "duplicate") {
      countReject(source, "duplicate", request.ip);
      return { status: 200, body: { duplicate: true } };
    }
    if (claim.kind === "in_progress") {
      return {
        status: 409,
        body: { inProgress: true },
        headers: { "Retry-After": String(EVENT_RETRY_AFTER_SECONDS) },
      };
    }

    try {
      return await processDelivery(source, event, claim, startedAt);
    } catch (err) {
      logger.error({ err, sourceId: source.id, deliveryId: claim.deliveryId }, "event delivery processing failed");
      await finishDelivery(claim, {
        status: "failed",
        httpStatus: 503,
        latencyMs: Math.max(0, now() - startedAt),
        error: (err instanceof Error ? err.message : String(err)).slice(0, 2000),
      });
      return {
        status: 503,
        body: { error: "dispatch_failed", deliveryId: claim.deliveryId },
        headers: { "Retry-After": String(EVENT_RETRY_AFTER_SECONDS) },
      };
    }
  }

  type Claim =
    | { kind: "claimed"; deliveryId: string; attempts: number; priorOutcomes: Record<string, EventRoutineOutcome> }
    | { kind: "duplicate" }
    | { kind: "in_progress" };

  async function claimDelivery(
    source: EventSourceRow,
    event: NormalizedEvent,
    deliveryKeyHash: string | null,
    ip: string | null,
    startedAt: number,
  ): Promise<Claim> {
    const claimedAt = new Date(startedAt);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const inserted = await db
        .insert(eventDeliveries)
        .values({
          companyId: source.companyId,
          sourceId: source.id,
          deliveryKeyHash,
          status: "processing",
          receivedAt: claimedAt,
          claimedAt,
          attempts: 1,
          event: eventForAudit(event),
          firstIp: ip,
          lastIp: ip,
        })
        .onConflictDoNothing({
          target: [eventDeliveries.sourceId, eventDeliveries.deliveryKeyHash],
          where: sql`delivery_key_hash is not null`,
        })
        .returning({ id: eventDeliveries.id, attempts: eventDeliveries.attempts });
      if (inserted[0]) return { kind: "claimed", deliveryId: inserted[0].id, attempts: inserted[0].attempts, priorOutcomes: {} };
      if (!deliveryKeyHash) continue;

      // Compare-and-set re-claim: only a failed delivery, or one whose lease expired, can be taken again.
      const reclaimed = await db
        .update(eventDeliveries)
        .set({ status: "processing", claimedAt, attempts: sql`${eventDeliveries.attempts} + 1`, error: null, lastIp: ip })
        .where(
          and(
            eq(eventDeliveries.sourceId, source.id),
            eq(eventDeliveries.deliveryKeyHash, deliveryKeyHash),
            or(
              eq(eventDeliveries.status, "failed"),
              and(
                eq(eventDeliveries.status, "processing"),
                lt(eventDeliveries.claimedAt, new Date(startedAt - EVENT_DELIVERY_LEASE_MS)),
              ),
            ),
          ),
        )
        .returning({
          id: eventDeliveries.id,
          attempts: eventDeliveries.attempts,
          routineOutcomes: eventDeliveries.routineOutcomes,
        });
      if (reclaimed[0]) {
        return {
          kind: "claimed",
          deliveryId: reclaimed[0].id,
          attempts: reclaimed[0].attempts,
          priorOutcomes: reclaimed[0].routineOutcomes ?? {},
        };
      }

      const existing = await db
        .select({ status: eventDeliveries.status })
        .from(eventDeliveries)
        .where(and(eq(eventDeliveries.sourceId, source.id), eq(eventDeliveries.deliveryKeyHash, deliveryKeyHash)))
        .then((rows) => rows[0] ?? null);
      // The row was pruned between the two statements: claim again.
      if (!existing) continue;
      if (TERMINAL_DELIVERY_STATUSES.includes(existing.status as EventDeliveryStatus)) return { kind: "duplicate" };
      return { kind: "in_progress" };
    }
    return { kind: "in_progress" };
  }

  /** Every write of a claimed delivery carries the attempt number, so a superseded attempt cannot overwrite a newer one. */
  async function finishDelivery(
    claim: { deliveryId: string; attempts: number },
    patch: Partial<typeof eventDeliveries.$inferInsert>,
  ): Promise<boolean> {
    const updated = await db
      .update(eventDeliveries)
      .set(patch)
      .where(and(eq(eventDeliveries.id, claim.deliveryId), eq(eventDeliveries.attempts, claim.attempts)))
      .returning({ id: eventDeliveries.id });
    return updated.length > 0;
  }

  async function mergeOutcome(
    claim: { deliveryId: string; attempts: number },
    routineId: string,
    outcome: EventRoutineOutcome,
  ): Promise<boolean> {
    const result = await db.execute(sql`
      update event_deliveries
      set routine_outcomes = routine_outcomes || jsonb_build_object(${routineId}::text, ${JSON.stringify(outcome)}::jsonb)
      where id = ${claim.deliveryId} and attempts = ${claim.attempts}
      returning id
    `);
    const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? [];
    return rows.length > 0;
  }

  async function processDelivery(
    source: EventSourceRow,
    event: NormalizedEvent,
    claim: Extract<Claim, { kind: "claimed" }>,
    startedAt: number,
  ): Promise<IngestResult> {
    const subscribers = await findSubscribers(source, event);
    const outcomes: Record<string, EventRoutineOutcome> = { ...claim.priorOutcomes };
    const triggerIds = new Set<string>();
    let superseded = false;

    const runSubscribers = async (list: Subscriber[]) => {
      for (const subscriber of list) {
        if (superseded) return;
        for (const id of subscriber.triggerIds) triggerIds.add(id);
        // A re-claimed delivery only dispatches the routines that have no success yet.
        if (isSuccessfulOutcome(outcomes[subscriber.routine.id])) continue;
        const outcome = await dispatchGate.run(() =>
          routinesSvc.dispatchEvent({
            routine: subscriber.routine,
            trigger: subscriber.trigger,
            event,
            deliveryId: claim.deliveryId,
            consumeStormSlot: () => consumeStormSlot(source.id),
            now: new Date(now()),
          }),
        );
        outcomes[subscriber.routine.id] = outcome;
        if (!(await mergeOutcome(claim, subscriber.routine.id, outcome))) superseded = true;
      }
    };

    await runSubscribers(subscribers.regular);
    const regularOutcomes = subscribers.regular.map((s) => outcomes[s.routine.id]!).filter(Boolean);
    const fallbackNeeded = regularOutcomes.length === 0 || regularOutcomes.every((o) => o.status === "failed_permanent");
    const usedFallback = fallbackNeeded && subscribers.fallback.length > 0 && !superseded;
    if (usedFallback) await runSubscribers(subscribers.fallback);

    if (superseded) {
      // A newer attempt owns the delivery now; this one must not write its result.
      return {
        status: 409,
        body: { inProgress: true },
        headers: { "Retry-After": String(EVENT_RETRY_AFTER_SECONDS) },
      };
    }

    const dispatched = [...subscribers.regular, ...(usedFallback ? subscribers.fallback : [])];
    const considered = dispatched.map((s) => ({ routineId: s.routine.id, outcome: outcomes[s.routine.id]! })).filter((x) => x.outcome);
    const anyTransient = considered.some(({ outcome }) => outcome.status === "failed_transient");
    const latencyMs = Math.max(0, now() - startedAt);
    const common = {
      latencyMs,
      matchedTriggerIds: [...triggerIds],
      routineRunIds: considered.map(({ outcome }) => outcome.runId).filter((id): id is string => !!id),
      issueIds: [...new Set(considered.map(({ outcome }) => outcome.issueId).filter((id): id is string => !!id))],
    };
    const summary = considered.map(({ routineId, outcome }) => ({
      routineId,
      status: outcome.status,
      issueId: outcome.issueId ?? null,
      failureClass: outcome.failureClass ?? null,
      note: outcome.note ?? null,
    }));

    if (anyTransient) {
      // A transient failure must not fall back (the same alert could land on two agents): the sender retries instead.
      await finishDelivery(claim, { ...common, status: "failed", httpStatus: 503, error: "transient dispatch failure" });
      await touchSource(source.id, "failed");
      return {
        status: 503,
        body: { error: "dispatch_failed", deliveryId: claim.deliveryId, outcomes: summary },
        headers: { "Retry-After": String(EVENT_RETRY_AFTER_SECONDS) },
      };
    }

    const status: EventDeliveryStatus = considered.length === 0
      ? "unrouted"
      : summarizeOutcomes(considered.map(({ outcome }) => outcome));
    const error = status === "failed" ? "no routine accepted the event" : null;
    await finishDelivery(claim, { ...common, status, httpStatus: 202, error });
    await touchSource(source.id, status);
    return {
      status: 202,
      body: {
        deliveryId: claim.deliveryId,
        matched: subscribers.regular.length,
        fallback: usedFallback,
        outcomes: summary,
      },
    };
  }

  // ── gated runs ────────────────────────────────────────────────────────────

  /**
   * A routine's gate script finished after the delivery was answered `gating`: record the final
   * outcome on the delivery. If the routine failed permanently, A's promise that an alert never
   * vanishes silently still holds, so the source's fallback routines take over now, exactly as they
   * would have had the failure been immediate.
   */
  async function settleGatedOutcome(settlement: GatedEventSettlement): Promise<void> {
    const { deliveryId, routineId, outcome } = settlement;
    if (!deliveryId) return;
    const mergeInto = async (id: string, value: EventRoutineOutcome) => {
      await db.execute(sql`
        update event_deliveries
        set routine_outcomes = routine_outcomes || jsonb_build_object(${id}::text, ${JSON.stringify(value)}::jsonb)
        where id = ${deliveryId}
      `);
    };
    await mergeInto(routineId, outcome);
    if (outcome.status !== "failed_permanent") return;

    const delivery = await db
      .select({ sourceId: eventDeliveries.sourceId, outcomes: eventDeliveries.routineOutcomes })
      .from(eventDeliveries)
      .where(eq(eventDeliveries.id, deliveryId))
      .then((rows) => rows[0] ?? null);
    if (!delivery) return;
    const source = await getSourceRow(delivery.sourceId).catch(() => null);
    if (!source) return;
    const event = settlement.event as NormalizedEvent;
    const subscribers = await findSubscribers(source, event);
    const fallbackIds = new Set(subscribers.fallback.map((subscriber) => subscriber.routine.id));
    const outcomes: Record<string, EventRoutineOutcome> = { ...(delivery.outcomes ?? {}), [routineId]: outcome };
    // The fallback applies only when every routine that took the event on a regular trigger failed permanently.
    const regular = Object.entries(outcomes).filter(([id]) => !fallbackIds.has(id));
    const fallbackNeeded = regular.length > 0 && regular.every(([, value]) => value.status === "failed_permanent");
    if (!fallbackNeeded) return;
    for (const subscriber of subscribers.fallback) {
      if (isSuccessfulOutcome(outcomes[subscriber.routine.id])) continue;
      const fallbackOutcome = await dispatchGate.run(() =>
        routinesSvc.dispatchEvent({
          routine: subscriber.routine,
          trigger: subscriber.trigger,
          event,
          deliveryId,
          consumeStormSlot: () => consumeStormSlot(source.id),
          now: new Date(now()),
        }),
      );
      outcomes[subscriber.routine.id] = fallbackOutcome;
      await mergeInto(subscriber.routine.id, fallbackOutcome);
    }
  }

  registerGatedEventSettler(db, settleGatedOutcome);

  // ── dry run ───────────────────────────────────────────────────────────────

  async function dryRun(sourceId: string, payload: Record<string, unknown>): Promise<EventSourceDryRunResult> {
    const source = await getSourceRow(sourceId);
    const normalized = normalizeEvent(source, payload, new Date(now()));
    if (!normalized.ok) {
      return { event: null, validationErrors: normalized.errors, matched: [], fallback: [], wouldBe: "invalid" };
    }
    const event = normalized.event;
    const subscribers = await findSubscribers(source, event);
    const windowActive = !!source.stormWindowStart && source.stormWindowStart.getTime() > now() - 3_600_000;
    const stormBudgetSpent = windowActive && source.stormWindowCount >= source.maxNewIssuesPerHour;

    const preview = async (list: Subscriber[]): Promise<EventDryRunRoutineResult[]> =>
      Promise.all(list.map(async (subscriber) => {
        const result = await previewEventRoutine(db, {
          routine: subscriber.routine,
          trigger: subscriber.trigger,
          event,
          stormBudgetSpent,
          now: new Date(now()),
        });
        return {
          routineId: subscriber.routine.id,
          routineTitle: subscriber.routine.title,
          assigneeAgentId: subscriber.routine.assigneeAgentId,
          triggerIds: subscriber.triggerIds,
          groupKey: result.groupKey,
          action: result.action,
          issueId: result.issueId,
        };
      }));

    const matched = await preview(subscribers.regular);
    const fallback = matched.length === 0 ? await preview(subscribers.fallback) : [];
    const effective = matched.length > 0 ? matched : fallback;
    let wouldBe: EventDeliveryStatus;
    if (effective.length === 0) wouldBe = "unrouted";
    else if (effective.some((r) => r.action === "new_issue" || r.action === "comment" || r.action === "comment_and_wake" || r.action === "recovery_comment")) wouldBe = "dispatched";
    else if (effective.some((r) => r.action === "storm_folded")) wouldBe = "storm_folded";
    else if (effective.some((r) => r.action === "silent")) wouldBe = "grouped_silent";
    else wouldBe = "recovery_without_issue";
    return { event, validationErrors: [], matched, fallback, wouldBe };
  }

  // ── management ────────────────────────────────────────────────────────────

  async function createSourceSecret(companyId: string, sourceId: string, actor: EventActor) {
    const secretValue = crypto.randomBytes(24).toString("hex");
    const secret = await secretsSvc.create(
      companyId,
      {
        name: `event-source-${sourceId}`,
        provider: getConfiguredSecretProvider(),
        value: secretValue,
        managedMode: "paperclip_managed",
        description: `Ingress auth for event source ${sourceId}`,
      },
      { agentId: actor.agentId ?? null, userId: actor.userId ?? null },
    );
    await secretsSvc.createBinding({
      companyId,
      secretId: secret.id,
      targetType: "event_source",
      targetId: sourceId,
      configPath: EVENT_SOURCE_SECRET_CONFIG_PATH,
    });
    return { secret, secretValue };
  }

  async function listDeliveries(sourceId: string, query: ListEventDeliveriesQuery): Promise<EventDeliveryPage> {
    const source = await getSourceRow(sourceId);
    // Keyset pagination over (received_at, id): the cursor is "<iso>|<id>".
    let cursorCondition;
    if (query.cursor) {
      const [receivedAtRaw, cursorId] = query.cursor.split("|");
      const receivedAt = new Date(receivedAtRaw ?? "");
      if (!cursorId || Number.isNaN(receivedAt.getTime())) throw unprocessable("Invalid cursor");
      cursorCondition = sql`(${eventDeliveries.receivedAt}, ${eventDeliveries.id}) < (${receivedAt.toISOString()}::timestamptz, ${cursorId}::uuid)`;
    }
    const rows = await db
      .select()
      .from(eventDeliveries)
      .where(
        and(
          eq(eventDeliveries.companyId, source.companyId),
          eq(eventDeliveries.sourceId, source.id),
          query.status ? eq(eventDeliveries.status, query.status) : undefined,
          cursorCondition,
        ),
      )
      .orderBy(desc(eventDeliveries.receivedAt), desc(eventDeliveries.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toApiDelivery),
      nextCursor: rows.length > query.limit && last ? `${last.receivedAt.toISOString()}|${last.id}` : null,
    };
  }

  return {
    ingest,
    dryRun,
    listDeliveries,
    flushRejects,
    prune,
    /** Warms the source cache and starts the periodic reject-count flush and pruning job. */
    start: async () => {
      await cache.preload().catch((err) => logger.warn({ err }, "event source cache preload failed"));
      if (!flushTimer) {
        flushTimer = setInterval(() => void flushRejects(), REJECT_FLUSH_INTERVAL_MS);
        flushTimer.unref?.();
      }
      if (!pruneTimer) {
        pruneStartTimer = setTimeout(() => void prune(), PRUNE_FIRST_RUN_DELAY_MS);
        pruneStartTimer.unref?.();
        pruneTimer = setInterval(() => void prune(), PRUNE_INTERVAL_MS);
        pruneTimer.unref?.();
      }
    },
    stop: async () => {
      if (flushTimer) clearInterval(flushTimer);
      if (pruneTimer) clearInterval(pruneTimer);
      if (pruneStartTimer) clearTimeout(pruneStartTimer);
      flushTimer = null;
      pruneTimer = null;
      pruneStartTimer = null;
      await flushRejects({ all: true });
    },
    invalidateCache: (publicId?: string) => cache.invalidate(publicId),

    list: async (companyId: string, options: { includeArchived?: boolean } = {}): Promise<EventSource[]> => {
      const rows = await db
        .select()
        .from(eventSources)
        .where(
          and(
            eq(eventSources.companyId, companyId),
            options.includeArchived ? undefined : eq(eventSources.archived, false),
          ),
        )
        .orderBy(asc(eventSources.createdAt), asc(eventSources.id));
      return rows.map(toApiSource);
    },

    get: async (id: string): Promise<EventSource> => toApiSource(await getSourceRow(id)),
    find: async (id: string): Promise<EventSource | null> => {
      const row = await db.select().from(eventSources).where(eq(eventSources.id, id)).then((rows) => rows[0] ?? null);
      return row ? toApiSource(row) : null;
    },

    create: async (
      companyId: string,
      input: CreateEventSource,
      actor: EventActor,
    ): Promise<{ source: EventSource; secretMaterial: EventSourceSecretMaterial }> => {
      const sourceId = crypto.randomUUID();
      const publicId = crypto.randomBytes(12).toString("hex");
      const { secret, secretValue } = await createSourceSecret(companyId, sourceId, actor);
      try {
        const [row] = await db
          .insert(eventSources)
          .values({
            id: sourceId,
            companyId,
            name: input.name,
            enabled: input.enabled ?? true,
            publicId,
            secretId: secret.id,
            signingMode: input.signingMode ?? "hmac_sha256",
            replayWindowSec: input.replayWindowSec ?? 300,
            normalizer: input.normalizer ?? "generic_v1",
            normalizerConfig: input.normalizerConfig ?? null,
            pinnedLabels: input.pinnedLabels ?? {},
            rateLimitPerMinute: input.rateLimitPerMinute ?? 600,
            maxNewIssuesPerHour: input.maxNewIssuesPerHour ?? 20,
            retentionDays: input.retentionDays ?? 30,
            lastRotatedAt: new Date(),
            createdByAgentId: actor.agentId ?? null,
            createdByUserId: actor.userId ?? null,
            updatedByAgentId: actor.agentId ?? null,
            updatedByUserId: actor.userId ?? null,
          })
          .returning();
        cache.invalidate(publicId);
        return {
          source: toApiSource(row!),
          secretMaterial: { ingressUrl: eventSourceIngressUrl(publicId), secret: secretValue },
        };
      } catch (err) {
        await secretsSvc.remove(secret.id).catch(() => undefined);
        throw err;
      }
    },

    update: async (id: string, patch: UpdateEventSource, actor: EventActor): Promise<EventSource> => {
      const existing = await getSourceRow(id);
      const nextNormalizer = (patch.normalizer ?? existing.normalizer) as EventSource["normalizer"];
      const nextConfig = patch.normalizerConfig === undefined ? existing.normalizerConfig : patch.normalizerConfig;
      if (patch.normalizer !== undefined || patch.normalizerConfig !== undefined) {
        const error = validateEventSourceNormalizerConfig(nextNormalizer, nextConfig);
        if (error) throw unprocessable(error);
      }
      const [row] = await db
        .update(eventSources)
        .set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
          ...(patch.signingMode !== undefined ? { signingMode: patch.signingMode } : {}),
          ...(patch.replayWindowSec !== undefined ? { replayWindowSec: patch.replayWindowSec } : {}),
          ...(patch.normalizer !== undefined ? { normalizer: patch.normalizer } : {}),
          ...(patch.normalizerConfig !== undefined ? { normalizerConfig: patch.normalizerConfig } : {}),
          ...(patch.pinnedLabels !== undefined ? { pinnedLabels: patch.pinnedLabels } : {}),
          ...(patch.rateLimitPerMinute !== undefined ? { rateLimitPerMinute: patch.rateLimitPerMinute } : {}),
          ...(patch.maxNewIssuesPerHour !== undefined ? { maxNewIssuesPerHour: patch.maxNewIssuesPerHour } : {}),
          ...(patch.retentionDays !== undefined ? { retentionDays: patch.retentionDays } : {}),
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(eventSources.id, id))
        .returning();
      cache.invalidate(existing.publicId);
      return toApiSource(row!);
    },

    /** Soft delete: the source stops answering, its history stays. */
    archive: async (id: string, actor: EventActor): Promise<EventSource> => {
      const existing = await getSourceRow(id);
      const [row] = await db
        .update(eventSources)
        .set({ archived: true, updatedByAgentId: actor.agentId ?? null, updatedByUserId: actor.userId ?? null, updatedAt: new Date() })
        .where(eq(eventSources.id, id))
        .returning();
      cache.invalidate(existing.publicId);
      return toApiSource(row!);
    },

    rotateSecret: async (
      id: string,
      actor: EventActor,
    ): Promise<{ source: EventSource; secretMaterial: EventSourceSecretMaterial }> => {
      const existing = await getSourceRow(id);
      if (!existing.secretId) throw conflict("Event source has no secret to rotate");
      const secretValue = crypto.randomBytes(24).toString("hex");
      await secretsSvc.rotate(existing.secretId, { value: secretValue }, { agentId: actor.agentId ?? null, userId: actor.userId ?? null });
      const [row] = await db
        .update(eventSources)
        .set({ lastRotatedAt: new Date(), updatedByAgentId: actor.agentId ?? null, updatedByUserId: actor.userId ?? null, updatedAt: new Date() })
        .where(eq(eventSources.id, id))
        .returning();
      // No grace period: the old secret stops working immediately.
      cache.invalidate(existing.publicId);
      return {
        source: toApiSource(row!),
        secretMaterial: { ingressUrl: eventSourceIngressUrl(existing.publicId), secret: secretValue },
      };
    },
  };
}

export type EventSourceService = ReturnType<typeof eventSourceService>;
