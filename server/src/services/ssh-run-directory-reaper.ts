import path from "node:path";
import { and, asc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentTaskSessions, environmentLeases, heartbeatRuns } from "@paperclipai/db";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import {
  readSshDiskUsagePercent,
  reapSshRunDirectory,
  sshPreservedBundlePath,
  type SshRunDirectoryReapResult,
} from "@paperclipai/adapter-utils/remote-managed-runtime";
import type { SshConnectionConfig } from "@paperclipai/adapter-utils/ssh";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { resolveEnvironmentDriverConfigForRuntime } from "./environment-config.js";
import { environmentService } from "./environments.js";

const TERMINAL_RUN_STATUSES: readonly string[] = ["succeeded", "interrupted", "failed", "cancelled", "timed_out"];
const REAPABLE_LEASE_STATUSES = ["released", "expired", "failed"] as const;
// A lease or run that is still using the host keeps its directory.
const BUSY_LEASE_STATUSES = ["active", "retained", "pending_cleanup"] as const;

const REAPER_ACTOR_ID = "ssh_run_directory_reaper";
const REAPED_ACTION = "environment.ssh_run_directory_reaped";
const KEPT_ACTION = "environment.ssh_run_directory_kept";

// A removal runs in the background, so it can afford a large, busy tree.
const REAP_TIMEOUT_MS = 10 * 60 * 1000;
const SWEEP_BATCH = 100;
const SWEEP_TIME_BUDGET_MS = 4 * 60 * 1000;
// Older leases are history: their directories were reaped or are decided.
const SWEEP_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_REMOVAL_ATTEMPTS = 5;
// A claim older than a whole removal plus slack belongs to a server that died.
const REAP_CLAIM_STALE_MS = REAP_TIMEOUT_MS + 5 * 60 * 1000;

function minutesFromEnv(name: string, fallbackMinutes: number): number {
  const configured = Number(process.env[name]);
  return (Number.isFinite(configured) && configured >= 1 ? configured : fallbackMinutes) * 60 * 1000;
}

/** How long a finished run's directory may stay before the sweep removes it. */
export function sshRunReaperMinAgeMs(): number {
  return minutesFromEnv("PAPERCLIP_SSH_RUN_REAPER_MAX_AGE_MINUTES", 6 * 60);
}

/** The same threshold while the worker's disk is above the pressure level. */
export function sshRunReaperPressureMinAgeMs(): number {
  return minutesFromEnv("PAPERCLIP_SSH_RUN_REAPER_PRESSURE_MAX_AGE_MINUTES", 15);
}

/** Disk use, in percent, above which the sweep shortens the age threshold. */
export function sshRunReaperDiskPressurePercent(): number {
  const configured = Number(process.env.PAPERCLIP_SSH_RUN_REAPER_DISK_PRESSURE_PERCENT);
  return Number.isFinite(configured) && configured >= 1 && configured <= 100 ? configured : 80;
}

export interface SshRunDirectorySweepSummary {
  examined: number;
  removed: number;
  kept: number;
  absent: number;
  bytesFreed: number;
  diskPressure: boolean;
}

type ReapTrigger = "lease_release" | "sweep";
type ReapOutcome = "removed" | "kept" | "absent" | "skipped";

interface ReapContext {
  trigger: ReapTrigger;
  now: Date;
  // The sweep only: how long the directory must have been finished.
  minAgeMs?: (config: SshConnectionConfig, remoteRoot: string) => Promise<number>;
}

interface ReapReport {
  outcome: ReapOutcome;
  bytesFreed: number;
}

const SKIPPED: ReapReport = { outcome: "skipped", bytesFreed: 0 };

/** Test seams: they run at fixed points of a removal. */
export interface SshRunDirectoryReaperHooks {
  /** After the directory is claimed and before the remote delete starts. */
  beforeRemoteDelete?: () => Promise<void>;
}

function previousDecision(lease: EnvironmentLease): Record<string, unknown> | null {
  const record = lease.metadata?.sshRunDirectory;
  return record && typeof record === "object" && !Array.isArray(record) ? (record as Record<string, unknown>) : null;
}

function previousAttempts(lease: EnvironmentLease): number {
  const attempts = previousDecision(lease)?.attempts;
  return typeof attempts === "number" ? attempts : 0;
}

// Whether another lease of the run still uses its directory.
async function hasBusyLease(db: Db, runId: string, exceptLeaseId: string): Promise<boolean> {
  const [busy] = await db
    .select({ id: environmentLeases.id })
    .from(environmentLeases)
    .where(and(
      eq(environmentLeases.heartbeatRunId, runId),
      ne(environmentLeases.id, exceptLeaseId),
      inArray(environmentLeases.status, [...BUSY_LEASE_STATUSES]),
    ))
    .limit(1);
  return Boolean(busy);
}

// One statement checks that no other lease of the run is busy and records the
// claim, so the two cannot be separated by a lease that starts in between. The
// claim fails when another server holds a fresh one.
async function claimRunDirectory(db: Db, lease: EnvironmentLease, runId: string, context: ReapContext): Promise<boolean> {
  const claim = { state: "reaping", claimedAt: context.now.toISOString(), trigger: context.trigger, attempts: previousAttempts(lease) };
  const staleBefore = new Date(context.now.getTime() - REAP_CLAIM_STALE_MS).toISOString();
  const decision = sql`${environmentLeases.metadata} -> 'sshRunDirectory'`;
  const claimed = await db
    .update(environmentLeases)
    .set({
      metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({ sshRunDirectory: claim })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(environmentLeases.id, lease.id),
      sql`(${decision} is null
        or ${decision} ->> 'reason' = 'rm_failed'
        or (${decision} ->> 'state' = 'reaping' and (${decision} ->> 'claimedAt')::timestamptz < ${staleBefore}::timestamptz))`,
      sql`not exists (
        select 1 from ${environmentLeases} as other
        where other.heartbeat_run_id = ${runId}
          and other.id <> ${lease.id}
          and other.status in (${sql.join(BUSY_LEASE_STATUSES.map((status) => sql`${status}`), sql`, `)}))`,
    ))
    .returning({ id: environmentLeases.id });
  return claimed.length > 0;
}

// Gives the claim back, restoring what was decided before it.
async function releaseClaim(db: Db, lease: EnvironmentLease): Promise<void> {
  const before = previousDecision(lease);
  await db
    .update(environmentLeases)
    .set({
      metadata: before
        ? sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({ sshRunDirectory: before })}::jsonb`
        : sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) - 'sshRunDirectory'`,
      updatedAt: new Date(),
    })
    .where(and(eq(environmentLeases.id, lease.id), sql`${environmentLeases.metadata} -> 'sshRunDirectory' ->> 'state' = 'reaping'`));
}

/**
 * The other half of the claim. A lease that starts for a run whose directory is
 * being removed must not use it. The new lease is already visible when this
 * runs, and a reaper rechecks for leases after it claims, so either this sees
 * the claim or the reaper sees the lease.
 */
export async function assertRunDirectoryNotBeingRemoved(db: Db, runId: string, exceptLeaseId: string): Promise<void> {
  const staleBefore = new Date(Date.now() - REAP_CLAIM_STALE_MS).toISOString();
  const [claim] = await db
    .select({ id: environmentLeases.id })
    .from(environmentLeases)
    .where(and(
      eq(environmentLeases.heartbeatRunId, runId),
      ne(environmentLeases.id, exceptLeaseId),
      sql`${environmentLeases.metadata} -> 'sshRunDirectory' ->> 'state' = 'reaping'`,
      sql`(${environmentLeases.metadata} -> 'sshRunDirectory' ->> 'claimedAt')::timestamptz > ${staleBefore}::timestamptz`,
    ))
    .limit(1);
  if (claim) throw new Error("This run's workspace directory is being removed. Start the run again.");
}

// The root a lease may name: the one its environment is configured with, as the
// acquire recorded it, and deep enough to be a runtime base rather than a place
// like /tmp. A stale or corrupted lease must not point a delete elsewhere.
function trustedRunRoot(lease: EnvironmentLease, remoteRoot: string, configuredRoot: string): boolean {
  const normalized = (value: unknown) => (typeof value === "string" ? path.posix.normalize(value).replace(/\/+$/, "") : null);
  const configured = normalized(configuredRoot);
  return configured !== null &&
    path.posix.isAbsolute(configured) &&
    configured.split("/").filter(Boolean).length >= 2 &&
    normalized(remoteRoot) === configured &&
    normalized(lease.metadata?.remoteWorkspacePath) === configured;
}

async function recordDecision(db: Db, leaseId: string, record: Record<string, unknown>): Promise<void> {
  await db
    .update(environmentLeases)
    .set({
      metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({ sshRunDirectory: record })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(environmentLeases.id, leaseId));
}

// Removes the run directory of one released SSH lease when it is safe to. It
// never throws: a failure only keeps the directory on the host.
async function reapLease(
  db: Db,
  environment: Pick<Environment, "id" | "driver" | "config">,
  lease: EnvironmentLease,
  context: ReapContext,
  hooks?: SshRunDirectoryReaperHooks,
): Promise<ReapReport> {
  const runId = lease.heartbeatRunId;
  const remoteRoot = typeof lease.metadata?.remoteCwd === "string" ? lease.metadata.remoteCwd : null;
  if (lease.provider !== "ssh" || lease.leasePolicy !== "ephemeral" || !runId || !remoteRoot) return SKIPPED;
  if (!(REAPABLE_LEASE_STATUSES as readonly string[]).includes(lease.status)) return SKIPPED;
  try {
    const [run] = await db
      .select({ status: heartbeatRuns.status, agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    if (!run || !TERMINAL_RUN_STATUSES.includes(run.status)) return SKIPPED;
    if (await hasBusyLease(db, runId, lease.id)) return SKIPPED;
    if (context.trigger === "lease_release") {
      // A task session may resume from its last run. The sweep removes it
      // once it is old enough.
      const [session] = await db
        .select({ id: agentTaskSessions.id })
        .from(agentTaskSessions)
        .where(eq(agentTaskSessions.lastRunId, runId))
        .limit(1);
      if (session) return SKIPPED;
    }
    const parsed = await resolveEnvironmentDriverConfigForRuntime(db, lease.companyId, environment, {
      issueId: lease.issueId,
      heartbeatRunId: runId,
    });
    if (parsed.driver !== "ssh") return SKIPPED;
    // An environment re-pointed after the acquire names another host.
    const metadata = lease.metadata ?? {};
    if (
      metadata.host !== parsed.config.host ||
      Number(metadata.port) !== parsed.config.port ||
      metadata.username !== parsed.config.username
    ) {
      logger.info({ leaseId: lease.id, runId }, "kept a finished SSH run directory: the environment now points at another host");
      return SKIPPED;
    }
    if (!trustedRunRoot(lease, remoteRoot, parsed.config.remoteWorkspacePath)) {
      logger.warn({ leaseId: lease.id, runId }, "kept a finished SSH run directory: its root is not the environment's configured root");
      return await recordKept(db, lease, runId, run.agentId, "root_mismatch", 0, context);
    }
    if (context.minAgeMs) {
      const finishedAt = (lease.releasedAt ?? lease.updatedAt).getTime();
      if (context.now.getTime() - finishedAt < await context.minAgeMs(parsed.config, remoteRoot)) return SKIPPED;
    }

    // Claim the directory, then look for a lease once more: a lease that began
    // after the checks above sees the claim and refuses, or is seen here.
    if (!await claimRunDirectory(db, lease, runId, context)) return SKIPPED;
    try {
      await hooks?.beforeRemoteDelete?.();
      if (await hasBusyLease(db, runId, lease.id)) {
        await releaseClaim(db, lease);
        return SKIPPED;
      }
      const result = await reapSshRunDirectory({ spec: parsed.config, remoteRoot, runId, timeoutMs: REAP_TIMEOUT_MS });
      return await recordResult(db, lease, runId, run.agentId, remoteRoot, result, context);
    } catch (error) {
      await releaseClaim(db, lease).catch(() => undefined);
      throw error;
    }
  } catch {
    // Log a constant kind only: an SSH error can carry host or credential detail.
    logger.warn(
      { errorKind: "ssh_run_directory_cleanup_failed", leaseId: lease.id, runId },
      "could not remove a finished SSH run directory; it stays on the host",
    );
    return SKIPPED;
  }
}

async function recordResult(
  db: Db,
  lease: EnvironmentLease,
  runId: string,
  agentId: string,
  remoteRoot: string,
  result: SshRunDirectoryReapResult,
  context: ReapContext,
): Promise<ReapReport> {
  const at = context.now.toISOString();
  const base = { leaseId: lease.id, environmentId: lease.environmentId, trigger: context.trigger };
  if (result.outcome === "absent") {
    await recordDecision(db, lease.id, { state: "absent", at, trigger: context.trigger });
    return { outcome: "absent", bytesFreed: 0 };
  }
  if (result.outcome === "removed") {
    const preservedBundle = result.preserved.length > 0 ? sshPreservedBundlePath(remoteRoot, runId) : undefined;
    await recordDecision(db, lease.id, {
      state: "removed", at, trigger: context.trigger, bytesFreed: result.bytesFreed, preserved: result.preserved,
    });
    await logActivity(db, {
      companyId: lease.companyId, actorType: "system", actorId: REAPER_ACTOR_ID, action: REAPED_ACTION,
      entityType: "heartbeat_run", entityId: runId, runId, agentId,
      details: { ...base, outcome: "removed", bytesFreed: result.bytesFreed, preserved: result.preserved, ...(preservedBundle ? { preservedBundle } : {}) },
    });
    logger.info({ runId, leaseId: lease.id, trigger: context.trigger, bytesFreed: result.bytesFreed, preserved: result.preserved.length },
      "removed a finished SSH run directory");
    return { outcome: "removed", bytesFreed: result.bytesFreed };
  }
  const reason = result.outcome === "symlink" ? "symlink" : result.reason;
  const bytes = result.outcome === "kept" ? result.bytes : 0;
  return await recordKept(db, lease, runId, agentId, reason, bytes, context);
}

async function recordKept(
  db: Db, lease: EnvironmentLease, runId: string, agentId: string, reason: string, bytes: number, context: ReapContext,
): Promise<ReapReport> {
  const attempts = reason === "rm_failed" ? previousAttempts(lease) + 1 : undefined;
  await recordDecision(db, lease.id, {
    state: "kept", reason, at: context.now.toISOString(), trigger: context.trigger, bytes, ...(attempts ? { attempts } : {}),
  });
  // A directory that cannot be removed is retried; say so only the first time.
  if (attempts === undefined || attempts === 1) {
    await logActivity(db, {
      companyId: lease.companyId, actorType: "system", actorId: REAPER_ACTOR_ID, action: KEPT_ACTION,
      entityType: "heartbeat_run", entityId: runId, runId, agentId,
      details: { leaseId: lease.id, environmentId: lease.environmentId, trigger: context.trigger, outcome: "kept", reason, bytes },
    });
  }
  logger.warn({ runId, leaseId: lease.id, trigger: context.trigger, reason, bytes }, "kept a finished SSH run directory");
  return { outcome: "kept", bytesFreed: 0 };
}

/**
 * Removes the run directories of finished SSH runs from their workers. A run's
 * `runs/<runId>` directory is reaped when its lease releases, whatever the
 * run's terminal status was; the sweep removes the ones that release-time
 * removal missed.
 */
export function sshRunDirectoryReaperService(db: Db, serviceOptions: { hooks?: SshRunDirectoryReaperHooks } = {}) {
  let sweeping = false;
  return {
    /** Never throws. */
    async reapReleasedLease(environment: Pick<Environment, "id" | "driver" | "config">, lease: EnvironmentLease): Promise<void> {
      await reapLease(db, environment, lease, { trigger: "lease_release", now: new Date() }, serviceOptions.hooks);
    },

    async sweep(options: {
      now?: Date;
      readDiskUsagePercent?: (config: SshConnectionConfig, remoteRoot: string) => Promise<number>;
    } = {}): Promise<SshRunDirectorySweepSummary> {
      const summary: SshRunDirectorySweepSummary = { examined: 0, removed: 0, kept: 0, absent: 0, bytesFreed: 0, diskPressure: false };
      if (sweeping) return summary;
      sweeping = true;
      try {
        const now = options.now ?? new Date();
        const readDisk = options.readDiskUsagePercent
          ?? ((config: SshConnectionConfig, remoteRoot: string) => readSshDiskUsagePercent({ spec: config, remoteRoot }));
        const finishedAt = sql`coalesce(${environmentLeases.releasedAt}, ${environmentLeases.updatedAt})`;
        const decision = sql`${environmentLeases.metadata} -> 'sshRunDirectory'`;
        const staleClaimBefore = new Date(now.getTime() - REAP_CLAIM_STALE_MS).toISOString();
        const candidates = await db
          .select()
          .from(environmentLeases)
          .where(and(
            eq(environmentLeases.provider, "ssh"),
            eq(environmentLeases.leasePolicy, "ephemeral"),
            inArray(environmentLeases.status, [...REAPABLE_LEASE_STATUSES]),
            isNotNull(environmentLeases.heartbeatRunId),
            isNotNull(environmentLeases.environmentId),
            sql`${environmentLeases.metadata} ->> 'remoteCwd' is not null`,
            sql`${finishedAt} > ${new Date(now.getTime() - SWEEP_LOOKBACK_MS).toISOString()}::timestamptz`,
            sql`(${decision} is null
              or (${decision} ->> 'reason' = 'rm_failed' and coalesce((${decision} ->> 'attempts')::int, 0) < ${MAX_REMOVAL_ATTEMPTS})
              or (${decision} ->> 'state' = 'reaping' and (${decision} ->> 'claimedAt')::timestamptz < ${staleClaimBefore}::timestamptz))`,
          ))
          .orderBy(asc(finishedAt))
          .limit(SWEEP_BATCH);
        const environments = environmentService(db);
        const pressureByHost = new Map<string, boolean>();
        const startedAt = Date.now();
        for (const row of candidates) {
          if (Date.now() - startedAt > SWEEP_TIME_BUDGET_MS) break;
          const lease = row as unknown as EnvironmentLease;
          const environment = lease.environmentId ? await environments.getById(lease.environmentId) : null;
          if (!environment) continue;
          const minAgeMs = async (config: SshConnectionConfig, remoteRoot: string) => {
            const key = `${config.username}@${config.host}:${config.port}${remoteRoot}`;
            if (!pressureByHost.has(key)) {
              // An unreadable disk keeps the calm threshold.
              pressureByHost.set(key, await readDisk(config, remoteRoot).then((percent) => percent > sshRunReaperDiskPressurePercent(), () => false));
            }
            return pressureByHost.get(key) ? sshRunReaperPressureMinAgeMs() : sshRunReaperMinAgeMs();
          };
          const report = await reapLease(db, environment, lease, { trigger: "sweep", now, minAgeMs }, serviceOptions.hooks);
          if (report.outcome === "skipped") continue;
          summary.examined += 1;
          summary.bytesFreed += report.bytesFreed;
          if (report.outcome === "removed") summary.removed += 1;
          else if (report.outcome === "kept") summary.kept += 1;
          else summary.absent += 1;
        }
        summary.diskPressure = [...pressureByHost.values()].some(Boolean);
        return summary;
      } finally {
        sweeping = false;
      }
    },
  };
}
