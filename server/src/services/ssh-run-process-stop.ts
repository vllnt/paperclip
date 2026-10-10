import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { environmentLeases, heartbeatRuns } from "@paperclipai/db";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import type { RemoteProcessTreeStopSummary } from "@paperclipai/adapter-utils/remote-process-identity";
import { stopSshRunProcesses, type SshConnectionConfig } from "@paperclipai/adapter-utils/ssh";
import { logger } from "../middleware/logger.js";
import { resolveEnvironmentDriverConfigForRuntime } from "./environment-config.js";

// Stops what an SSH run left on its worker before the run's lease is released.
// The local child of an SSH run is the `ssh` client: signalling it ends the
// connection but not the remote command, which keeps running without a pty.

/** The lease metadata key that records the stop, so it runs once per lease. */
export const REMOTE_PROCESS_STOP_METADATA_KEY = "remoteProcessStop";

/** One lease's stop: counts and labels only, never the marker or a path. */
export interface RemoteRunProcessStopOutcome extends RemoteProcessTreeStopSummary {
  leaseId: string;
  environmentId: string | null;
  /** `stopped`: nothing of the run is left; `survived`: some processes are; `partial`: the stop could not cover every process. */
  outcome: "stopped" | "survived" | "partial";
}

const NO_STOP: RemoteProcessTreeStopSummary = { records: 0, matched: 0, matchedByMarker: 0, matchedByGroup: 0, killed: 0, skipped: 0, survived: 0, partial: null };

// The worker and root the lease was acquired on, as `acquireRunLease` recorded
// them: an environment edited since then must not send the stop elsewhere.
// Only the credentials come from the current config.
function launchTarget(config: SshConnectionConfig, lease: EnvironmentLease): SshConnectionConfig {
  const metadata = lease.metadata ?? {};
  const text = (key: string) => {
    const value = metadata[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  };
  const port = metadata.port;
  return {
    ...config,
    host: text("host") ?? config.host,
    port: typeof port === "number" && Number.isInteger(port) && port > 0 ? port : config.port,
    username: text("username") ?? config.username,
    remoteWorkspacePath: text("remoteWorkspacePath") ?? config.remoteWorkspacePath,
  };
}

/** Twice the 20-second stop budget: a claim older than this belongs to a stop that died. */
const STOP_CLAIM_TTL_MS = 40_000;
const STOP_CLAIM_POLL_MS = 250;

// Claims the lease's stop before any remote work, by compare-and-set: the key
// is absent, or it holds a claim older than the TTL. The claim is
// `{ state: "stopping", claim, claimedAt }`; a final outcome has no state.
async function claimStop(db: Db, leaseId: string, token: string): Promise<boolean> {
  const now = Date.now();
  const stop = sql`${environmentLeases.metadata}->${REMOTE_PROCESS_STOP_METADATA_KEY}`;
  const claimedAt = sql`${stop}->>'claimedAt'`;
  const rows = await db
    .update(environmentLeases)
    .set({
      metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || jsonb_build_object(${REMOTE_PROCESS_STOP_METADATA_KEY}::text, jsonb_build_object('state', 'stopping', 'claim', ${token}::text, 'claimedAt', ${now}::bigint))`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(environmentLeases.id, leaseId),
        sql`(not (coalesce(${environmentLeases.metadata}, '{}'::jsonb) ? ${REMOTE_PROCESS_STOP_METADATA_KEY})
          or (${stop}->>'state' = 'stopping'
            and (case when ${claimedAt} ~ '^[0-9]+$' then (${claimedAt})::bigint else 0 end) < ${now - STOP_CLAIM_TTL_MS}::bigint))`,
      ),
    )
    .returning({ id: environmentLeases.id });
  return rows.length > 0;
}

// Waits while another path holds the claim. `done`: that stop recorded its
// outcome (or the lease is gone); `expired`: its claim outlived the TTL.
async function waitForClaimedStop(db: Db, leaseId: string): Promise<"done" | "expired"> {
  const deadline = Date.now() + STOP_CLAIM_TTL_MS + 5_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, STOP_CLAIM_POLL_MS));
    const row = await db
      .select({ metadata: environmentLeases.metadata })
      .from(environmentLeases)
      .where(eq(environmentLeases.id, leaseId))
      .then((rows) => rows[0] ?? null);
    const stop = row?.metadata?.[REMOTE_PROCESS_STOP_METADATA_KEY] as { state?: unknown; claimedAt?: unknown } | undefined;
    if (!stop || stop.state !== "stopping") return "done";
    if (typeof stop.claimedAt !== "number" || stop.claimedAt < Date.now() - STOP_CLAIM_TTL_MS) return "expired";
  }
  return "expired";
}

function classify(summary: RemoteProcessTreeStopSummary): RemoteRunProcessStopOutcome["outcome"] {
  if (summary.survived > 0) return "survived";
  return summary.partial ? "partial" : "stopped";
}

/**
 * Stops the processes that a legacy heartbeat run started on the SSH worker of
 * `lease`, over a connection of its own and within 20 seconds. It connects to
 * the worker and root recorded when the lease was acquired. It runs once
 * per lease: it claims the lease's stop before any remote work, so a second
 * caller does no remote work and waits for the first one's outcome (taking the
 * claim over only once it is older than 40 seconds), then returns `null`. Only
 * the claim holder records the outcome. Native runs keep their own runner
 * lifecycle and are skipped. Never throws.
 *
 * @returns The outcome, or `null` when nothing was stopped by this call.
 */
export async function stopSshLeaseRunProcesses(
  db: Db,
  input: { environment: Environment | null; lease: EnvironmentLease },
): Promise<RemoteRunProcessStopOutcome | null> {
  const { environment, lease } = input;
  if (lease.provider !== "ssh" || !lease.heartbeatRunId) return null;
  const recordedStop = lease.metadata?.[REMOTE_PROCESS_STOP_METADATA_KEY] as { state?: unknown } | undefined;
  if (recordedStop && recordedStop.state !== "stopping") return null;
  try {
    const run = await db
      .select({ runtimeMode: heartbeatRuns.runtimeMode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, lease.heartbeatRunId))
      .then((rows) => rows[0] ?? null);
    if (run?.runtimeMode === "native") return null;

    const token = randomUUID();
    let claimed = false;
    for (let attempt = 0; attempt < 3 && !claimed; attempt += 1) {
      claimed = await claimStop(db, lease.id, token);
      if (!claimed && (await waitForClaimedStop(db, lease.id)) === "done") return null;
    }
    if (!claimed) return null;

    let summary: RemoteProcessTreeStopSummary;
    if (!environment) {
      // The worker's credentials went with the environment row, so nothing can
      // reach the worker. Record that rather than release in silence.
      summary = { ...NO_STOP, partial: "environment_deleted" };
    } else {
      try {
        const parsed = await resolveEnvironmentDriverConfigForRuntime(db, lease.companyId, environment, {
          heartbeatRunId: lease.heartbeatRunId,
        });
        summary = parsed.driver === "ssh"
          ? await stopSshRunProcesses(launchTarget(parsed.config, lease), lease.heartbeatRunId)
          : { ...NO_STOP, partial: "environment_changed" };
      } catch {
        summary = { ...NO_STOP, partial: "config_unavailable" };
      }
    }
    const stored = { ...summary, outcome: classify(summary), at: new Date().toISOString() };
    const outcome: RemoteRunProcessStopOutcome = {
      ...summary,
      leaseId: lease.id,
      environmentId: lease.environmentId ?? null,
      outcome: stored.outcome,
    };
    const recorded = await db
      .update(environmentLeases)
      .set({
        metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || jsonb_build_object(${REMOTE_PROCESS_STOP_METADATA_KEY}::text, ${JSON.stringify(stored)}::jsonb)`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(environmentLeases.id, lease.id),
          sql`${environmentLeases.metadata}->${REMOTE_PROCESS_STOP_METADATA_KEY}->>'claim' = ${token}`,
        ),
      )
      .returning({ id: environmentLeases.id });
    if (recorded.length === 0) return null;
    if (outcome.outcome !== "stopped") {
      logger.warn(
        { runId: lease.heartbeatRunId, leaseId: lease.id, outcome: outcome.outcome, survived: outcome.survived, partial: outcome.partial },
        "SSH run processes were not all stopped",
      );
    }
    return outcome;
  } catch (error) {
    logger.warn({ err: error, runId: lease.heartbeatRunId, leaseId: lease.id }, "failed to stop SSH run processes");
    return null;
  }
}

/**
 * The run event that reports a stop: `remote_processes_stopped`,
 * `remote_processes_survived` or `remote_kill_partial`, with counts, the
 * environment id and the reason code only.
 *
 * @returns Input for the heartbeat's run event append.
 */
export function remoteProcessStopRunEvent(outcome: RemoteRunProcessStopOutcome): {
  eventType: "remote_processes_stopped" | "remote_processes_survived" | "remote_kill_partial";
  stream: "system";
  level: "info" | "warn";
  message: string;
  payload: Record<string, unknown>;
} {
  const payload = {
    environmentId: outcome.environmentId,
    records: outcome.records,
    matched: outcome.matched,
    matchedByMarker: outcome.matchedByMarker,
    matchedByGroup: outcome.matchedByGroup,
    killed: outcome.killed,
    skipped: outcome.skipped,
    survived: outcome.survived,
    ...(outcome.partial ? { reason: outcome.partial } : {}),
  };
  if (outcome.outcome === "survived") {
    return {
      eventType: "remote_processes_survived",
      stream: "system",
      level: "warn",
      message: `${outcome.survived} remote process(es) of this run were still running after the stop on its SSH environment.`,
      payload,
    };
  }
  if (outcome.outcome === "partial") {
    return {
      eventType: "remote_kill_partial",
      stream: "system",
      level: "warn",
      message: `Not every remote process of this run could be stopped on its SSH environment (${outcome.partial}).`,
      payload,
    };
  }
  return {
    eventType: "remote_processes_stopped",
    stream: "system",
    level: "info",
    message: `Stopped ${outcome.matched} remote process(es) of this run on its SSH environment before releasing it.`,
    payload,
  };
}
