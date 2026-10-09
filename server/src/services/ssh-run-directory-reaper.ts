import { randomUUID } from "node:crypto";
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

/** Environments already reported as having a worker without `timeout`, so the log says it once. */
const environmentsWithoutTimeout = new Set<string>();
// A claim whose owner has not renewed it for a whole removal plus slack belongs
// to a server that died or stalled.
const REAP_CLAIM_STALE_MS = REAP_TIMEOUT_MS + 5 * 60 * 1000;
// The owner renews its claim this often while it works, so a removal that runs
// longer than the timeout above still holds the claim as long as its owner lives.
const REAP_CLAIM_RENEW_MS = 60 * 1000;

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
  /** Stands in for the remote delete. */
  reapRemote?: typeof reapSshRunDirectory;
}

/** What a service instance can be given; the defaults are the production values. */
export interface SshRunDirectoryReaperOptions {
  hooks?: SshRunDirectoryReaperHooks;
  /** Test seam: the time claims are stamped and judged against. */
  clock?: () => Date;
  /** Test seam: how often a claim owner renews. 0 turns renewal off. */
  claimRenewMs?: number;
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

/** What identifies one run directory: the host, its root, and the run. */
interface RunDirectoryKey {
  host: string;
  port: number;
  username: string;
  root: string;
  runId: string;
}

// Every lease row that names this directory. A directory is `runs/<runId>`
// under one root on one host, so these are its leases, whatever their status.
function leasesOfDirectory(key: RunDirectoryKey) {
  return and(
    eq(environmentLeases.heartbeatRunId, key.runId),
    eq(environmentLeases.provider, "ssh"),
    sql`${environmentLeases.metadata} ->> 'remoteCwd' = ${key.root}`,
    sql`${environmentLeases.metadata} ->> 'host' = ${key.host}`,
    sql`${environmentLeases.metadata} ->> 'port' = ${String(key.port)}`,
    sql`${environmentLeases.metadata} ->> 'username' = ${key.username}`,
  );
}

const claimDecision = sql`${environmentLeases.metadata} -> 'sshRunDirectory'`;

// When the claim's owner last showed it was alive: its latest renewal, or the
// claim itself if it never renewed. Judging a claim by this and not by when it
// was taken is what lets a removal outlast the stale window while its owner
// lives, and lets a dead owner's claim expire.
const claimAliveAt = sql`coalesce(${claimDecision} ->> 'renewedAt', ${claimDecision} ->> 'claimedAt')::timestamptz`;

// Takes the one claim on a directory, and returns the owner token that proves
// it, or null if someone else holds it. Two leases of the same directory can be
// released at the same time (two servers, two sweeps), and a check followed by
// an update of the caller's own row would let both win. So a short transaction
// first locks every lease row of the directory, in a fixed order, and decides
// only then: the second contender waits for the first to commit and then sees
// its claim. The claim also fails while any lease of the run is busy.
async function claimRunDirectory(db: Db, lease: EnvironmentLease, key: RunDirectoryKey, context: ReapContext): Promise<string | null> {
  const owner = randomUUID();
  const claimedAt = context.now.toISOString();
  const claim = { state: "reaping", owner, claimedAt, renewedAt: claimedAt, trigger: context.trigger, attempts: previousAttempts(lease) };
  const staleBefore = new Date(context.now.getTime() - REAP_CLAIM_STALE_MS).toISOString();
  const claimed = await db.transaction(async (tx) => {
    await tx.select({ id: environmentLeases.id }).from(environmentLeases)
      .where(leasesOfDirectory(key)).orderBy(asc(environmentLeases.id)).for("update");
    const [held] = await tx.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
      leasesOfDirectory(key),
      ne(environmentLeases.id, lease.id),
      sql`${claimDecision} ->> 'state' = 'reaping'`,
      sql`${claimAliveAt} > ${staleBefore}::timestamptz`,
    )).limit(1);
    if (held) return false;
    const [busy] = await tx.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
      eq(environmentLeases.heartbeatRunId, key.runId),
      ne(environmentLeases.id, lease.id),
      inArray(environmentLeases.status, [...BUSY_LEASE_STATUSES]),
    )).limit(1);
    if (busy) return false;
    const taken = await tx.update(environmentLeases).set({
      metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({ sshRunDirectory: claim })}::jsonb`,
      updatedAt: new Date(),
    }).where(and(
      eq(environmentLeases.id, lease.id),
      sql`(${claimDecision} is null
        or ${claimDecision} ->> 'reason' = 'rm_failed'
        or (${claimDecision} ->> 'state' = 'reaping' and ${claimAliveAt} < ${staleBefore}::timestamptz))`,
    )).returning({ id: environmentLeases.id });
    return taken.length > 0;
  });
  return claimed ? owner : null;
}

const ownsClaim = (leaseId: string, owner: string) => and(
  eq(environmentLeases.id, leaseId),
  sql`${claimDecision} ->> 'state' = 'reaping'`,
  sql`${claimDecision} ->> 'owner' = ${owner}`,
);

/** A claim on a directory, held by one owner token. */
interface HeldClaim {
  owner: string;
  /**
   * Confirms that this owner is still the only live holder of the directory,
   * and renews the claim in the same step. False once another reaper took the
   * claim over, whichever lease row of the directory it took it on.
   */
  hold: () => Promise<boolean>;
}

// Under the directory's row locks, in the same order as the claim: the claim is
// ours only if our row still carries our token and no other row of the
// directory holds a live claim. A reaper that was paused past the stale window
// can find that another one took over through a sibling lease row; its own row
// still shows its token, so the siblings must be looked at too. When the claim
// is ours the renewal is written in the same transaction, so nobody can take it
// between the check and the renewal.
async function reassertClaim(db: Db, lease: EnvironmentLease, key: RunDirectoryKey, owner: string, now: Date): Promise<boolean> {
  const staleBefore = new Date(now.getTime() - REAP_CLAIM_STALE_MS).toISOString();
  return await db.transaction(async (tx) => {
    await tx.select({ id: environmentLeases.id }).from(environmentLeases)
      .where(leasesOfDirectory(key)).orderBy(asc(environmentLeases.id)).for("update");
    const [rival] = await tx.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
      leasesOfDirectory(key),
      ne(environmentLeases.id, lease.id),
      sql`${claimDecision} ->> 'state' = 'reaping'`,
      sql`${claimAliveAt} > ${staleBefore}::timestamptz`,
    )).limit(1);
    if (rival) return false;
    const renewed = await tx.update(environmentLeases)
      .set({ metadata: sql`jsonb_set(${environmentLeases.metadata}, '{sshRunDirectory,renewedAt}', to_jsonb(${now.toISOString()}::text))` })
      .where(ownsClaim(lease.id, owner))
      .returning({ id: environmentLeases.id });
    return renewed.length > 0;
  });
}

// Renews the claim while its owner works, so a removal that runs longer than
// the stale window keeps it. If another reaper took the claim over, this finds
// out and `lost()` turns true. A failed write is retried on the next tick.
function keepClaimAlive(claim: HeldClaim, everyMs: number): { stop: () => void; lost: () => boolean } {
  let lost = false;
  if (!(everyMs > 0)) return { stop: () => undefined, lost: () => lost };
  let renewing = false;
  const timer = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void claim.hold()
      .then((held) => { if (!held) lost = true; }, () => undefined)
      .finally(() => { renewing = false; });
  }, everyMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer), lost: () => lost };
}

// Gives the claim back, restoring what was decided before it. Only its owner can.
async function releaseClaim(db: Db, lease: EnvironmentLease, owner: string): Promise<void> {
  const before = previousDecision(lease);
  await db
    .update(environmentLeases)
    .set({
      metadata: before
        ? sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({ sshRunDirectory: before })}::jsonb`
        : sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) - 'sshRunDirectory'`,
      updatedAt: new Date(),
    })
    .where(ownsClaim(lease.id, owner));
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
      sql`${claimDecision} ->> 'state' = 'reaping'`,
      sql`${claimAliveAt} > ${staleBefore}::timestamptz`,
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

// Writes what was decided for a lease's directory. With an owner token it writes
// only while that owner still holds the claim, and says whether it did: a reaper
// whose claim was taken over must not overwrite the new owner's record.
async function recordDecision(db: Db, leaseId: string, record: Record<string, unknown>, owner?: string): Promise<boolean> {
  const rows = await db
    .update(environmentLeases)
    .set({
      metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({ sshRunDirectory: record })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(owner ? ownsClaim(leaseId, owner) : eq(environmentLeases.id, leaseId))
    .returning({ id: environmentLeases.id });
  return rows.length > 0;
}

// Removes the run directory of one released SSH lease when it is safe to. It
// never throws: a failure only keeps the directory on the host.
async function reapLease(
  db: Db,
  environment: Pick<Environment, "id" | "driver" | "config">,
  lease: EnvironmentLease,
  context: ReapContext,
  serviceOptions: SshRunDirectoryReaperOptions = {},
): Promise<ReapReport> {
  const hooks = serviceOptions.hooks;
  const clock = serviceOptions.clock ?? (() => new Date());
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
    const key: RunDirectoryKey = {
      host: parsed.config.host, port: parsed.config.port, username: parsed.config.username, root: remoteRoot, runId,
    };
    const owner = await claimRunDirectory(db, lease, key, context);
    if (!owner) return SKIPPED;
    const claim: HeldClaim = { owner, hold: () => reassertClaim(db, lease, key, owner, clock()) };
    const renewal = keepClaimAlive(claim, serviceOptions.claimRenewMs ?? REAP_CLAIM_RENEW_MS);
    let remoteStarted = false;
    try {
      await hooks?.beforeRemoteDelete?.();
      // Delete only while the claim is still ours and no lease has appeared.
      if (renewal.lost() || !await claim.hold()) {
        logger.warn({ leaseId: lease.id, runId }, "kept a finished SSH run directory: its claim was taken over before the delete");
        return SKIPPED;
      }
      if (await hasBusyLease(db, runId, lease.id)) {
        await releaseClaim(db, lease, owner);
        return SKIPPED;
      }
      remoteStarted = true;
      const result = await (hooks?.reapRemote ?? reapSshRunDirectory)({
        spec: parsed.config, remoteRoot, runId, timeoutMs: REAP_TIMEOUT_MS,
      });
      return await recordResult(db, lease, runId, run.agentId, remoteRoot, result, context, claim);
    } catch (error) {
      // After the command was sent, a failure here says nothing about the
      // worker: an SSH timeout does not stop a delete that already runs there.
      // So the claim is not given back. It stops being renewed and expires, and
      // only then can a lease or another reaper use the directory again.
      if (!remoteStarted) await releaseClaim(db, lease, owner).catch(() => undefined);
      throw error;
    } finally {
      renewal.stop();
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
  claim: HeldClaim,
): Promise<ReapReport> {
  const at = context.now.toISOString();
  const base = { leaseId: lease.id, environmentId: lease.environmentId, trigger: context.trigger };
  // Only the claim's owner records the outcome. If the claim was taken over
  // while the delete ran, the new owner records its own, and ours is dropped so
  // the same directory is not reported twice.
  const record = async (decision: Record<string, unknown>) => {
    if (await claim.hold() && await recordDecision(db, lease.id, decision, claim.owner)) return true;
    logger.warn({ leaseId: lease.id, runId }, "dropped the outcome of a finished SSH run directory removal: its claim was taken over");
    return false;
  };
  if (result.outcome === "unbounded") {
    await releaseClaim(db, lease, claim.owner);
    const environmentKey = lease.environmentId ?? lease.id;
    if (!environmentsWithoutTimeout.has(environmentKey)) {
      environmentsWithoutTimeout.add(environmentKey);
      logger.warn(
        { environmentId: lease.environmentId },
        "did not remove finished SSH run directories: the worker has no timeout command to bound the removal script",
      );
    }
    return SKIPPED;
  }
  if (result.outcome === "absent") {
    if (!await record({ state: "absent", at, trigger: context.trigger })) return SKIPPED;
    return { outcome: "absent", bytesFreed: 0 };
  }
  if (result.outcome === "removed") {
    const preservedBundle = result.preserved.length > 0 ? sshPreservedBundlePath(remoteRoot, runId) : undefined;
    if (!await record({
      state: "removed", at, trigger: context.trigger, bytesFreed: result.bytesFreed, preserved: result.preserved,
    })) return SKIPPED;
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
  return await recordKept(db, lease, runId, agentId, reason, bytes, context, claim);
}

async function recordKept(
  db: Db, lease: EnvironmentLease, runId: string, agentId: string, reason: string, bytes: number, context: ReapContext,
  claim?: HeldClaim,
): Promise<ReapReport> {
  const attempts = reason === "rm_failed" ? previousAttempts(lease) + 1 : undefined;
  const recorded = (!claim || await claim.hold()) && await recordDecision(db, lease.id, {
    state: "kept", reason, at: context.now.toISOString(), trigger: context.trigger, bytes, ...(attempts ? { attempts } : {}),
  }, claim?.owner);
  if (!recorded) {
    logger.warn({ leaseId: lease.id, runId }, "dropped the outcome of a finished SSH run directory removal: its claim was taken over");
    return SKIPPED;
  }
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
export function sshRunDirectoryReaperService(db: Db, serviceOptions: SshRunDirectoryReaperOptions = {}) {
  let sweeping = false;
  const clock = serviceOptions.clock ?? (() => new Date());
  return {
    /** Never throws. */
    async reapReleasedLease(environment: Pick<Environment, "id" | "driver" | "config">, lease: EnvironmentLease): Promise<void> {
      await reapLease(db, environment, lease, { trigger: "lease_release", now: clock() }, serviceOptions);
    },

    async sweep(options: {
      now?: Date;
      readDiskUsagePercent?: (config: SshConnectionConfig, remoteRoot: string) => Promise<number>;
    } = {}): Promise<SshRunDirectorySweepSummary> {
      const summary: SshRunDirectorySweepSummary = { examined: 0, removed: 0, kept: 0, absent: 0, bytesFreed: 0, diskPressure: false };
      if (sweeping) return summary;
      sweeping = true;
      try {
        const now = options.now ?? clock();
        const readDisk = options.readDiskUsagePercent
          ?? ((config: SshConnectionConfig, remoteRoot: string) => readSshDiskUsagePercent({ spec: config, remoteRoot }));
        const finishedAt = sql`coalesce(${environmentLeases.releasedAt}, ${environmentLeases.updatedAt})`;
        const decision = claimDecision;
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
              or (${decision} ->> 'state' = 'reaping' and ${claimAliveAt} < ${staleClaimBefore}::timestamptz))`,
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
          const report = await reapLease(db, environment, lease, { trigger: "sweep", now, minAgeMs }, serviceOptions);
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
