import { createInterface } from "node:readline";
import { and, desc, eq, isNotNull, ne, sql } from "drizzle-orm";
import type { AdapterRunLogUsageReader } from "@paperclipai/adapter-utils";
import type { Db } from "@paperclipai/db";
import { agentRuntimeState, agents, costEvents, heartbeatRuns } from "@paperclipai/db";
import { HEARTBEAT_RUN_TERMINAL_STATUSES, type BillingType, type CostStatus } from "@paperclipai/shared";
import { findServerAdapter } from "../adapters/index.js";
import { parseObject } from "../adapters/utils.js";
import { logger } from "../middleware/logger.js";
import { costService } from "./costs.js";
import type { BudgetServiceHooks } from "./budgets.js";
import { getRunLogStore, type RunLogStore } from "./run-log-store.js";

type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;
/** The run to record. Any copy of its row will do: the recovery reads the row again. */
type RunLogUsageTarget = Pick<HeartbeatRunRow, "id" | "companyId" | "usageJson">;

/**
 * A stdout line longer than this is skipped unread. A usage line is small (an assistant message is
 * bounded by the model's output limit); a line this long is a tool result, which holds no usage.
 */
const MAX_RUN_LOG_STDOUT_LINE_CHARS = 4 * 1024 * 1024;

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(HEARTBEAT_RUN_TERMINAL_STATUSES);
const USAGE_KEYS = ["inputTokens", "cachedInputTokens", "outputTokens", "costUsd", "cacheAdjustedCostUsd"] as const;

/** What the heartbeat service already knows about the ledger. Injected, so this module never imports it. */
export interface RunLogUsageLedger {
  resolveScope(
    companyId: string,
    run: HeartbeatRunRow,
  ): Promise<{ issueId: string | null; projectId: string | null; billingCode: string | null }>;
  normalizeBillingType(value: unknown): BillingType;
  billedCostCents(costUsd: number | null, billingType: BillingType): number;
  costStatus(costUsd: number | null): CostStatus;
}

export interface RunLogUsageRecoveryDeps {
  db: Db;
  ledger: RunLogUsageLedger;
  budgetHooks?: BudgetServiceHooks;
  runLogStore?: RunLogStore;
}

export type RecoveredRunUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  partial: boolean;
};

/** True when the run row already holds a token count or a cost, so nothing needs recovering. */
export function runHasRecordedUsage(usageJson: unknown): boolean {
  const usage = parseObject(usageJson);
  return USAGE_KEYS.some((key) => typeof usage[key] === "number");
}

/**
 * Feeds the stdout lines of one run's log to `reader`, in order. The log is one JSON record per line
 * (`{ts, stream, chunk}`); the stdout chunks join into the lines the adapter printed. It streams the
 * file, so memory holds one record and one stdout line, never the log. Returns false when the run
 * has no log to read.
 */
async function readRunLogStdoutLines(
  store: RunLogStore,
  run: HeartbeatRunRow,
  reader: AdapterRunLogUsageReader,
): Promise<boolean> {
  if (run.logStore !== "local_file" || !run.logRef || !store.openReadStream) return false;
  const input = await store.openReadStream({ store: "local_file", logRef: run.logRef });
  let line = "";
  let lineTooLong = false;
  const take = (text: string) => {
    if (lineTooLong) return;
    if (line.length + text.length > MAX_RUN_LOG_STDOUT_LINE_CHARS) {
      line = "";
      lineTooLong = true;
      return;
    }
    line += text;
  };
  const endLine = () => {
    if (!lineTooLong && line) reader.readLine(line);
    line = "";
    lineTooLong = false;
  };

  for await (const recordLine of createInterface({ input, crlfDelay: Infinity })) {
    let record: unknown;
    try {
      record = JSON.parse(recordLine);
    } catch {
      // A line cut by a crash is not a record; the stream before it still counts.
      continue;
    }
    const { stream, chunk } = parseObject(record);
    if (stream !== "stdout" || typeof chunk !== "string") continue;
    const parts = chunk.split("\n");
    for (let index = 0; index < parts.length - 1; index += 1) {
      take(parts[index]);
      endLine();
    }
    take(parts[parts.length - 1]);
  }
  endLine();
  return true;
}

/**
 * Records the usage of a run that ended without an adapter result: a restart, a stop, the
 * watchdog fold. The adapters stream their usage into the run log while they work, so the log
 * still holds it. The adapter reads the log back (`createRunLogUsageReader`); this service writes the
 * run's `usageJson` and its cost event once, and marks the usage `partial` when the stream
 * stopped before the provider's final totals.
 */
export function createRunLogUsageRecovery(deps: RunLogUsageRecoveryDeps) {
  const { db, ledger } = deps;
  const costs = costService(db, deps.budgetHooks ?? {});
  const inFlight = new Map<string, Promise<RecoveredRunUsage | null>>();

  // The provider, biller and billing type of a run are facts of the agent's setup, which the log
  // does not hold. The agent's latest run that recorded them is the best evidence.
  async function readBillingProfile(run: HeartbeatRunRow) {
    const [previous] = await db
      .select({ usageJson: heartbeatRuns.usageJson })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, run.companyId),
          eq(heartbeatRuns.agentId, run.agentId),
          ne(heartbeatRuns.id, run.id),
          isNotNull(sql`${heartbeatRuns.usageJson} ->> 'billingType'`),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(1);
    const usage = parseObject(previous?.usageJson);
    return {
      provider: typeof usage.provider === "string" ? usage.provider : null,
      biller: typeof usage.biller === "string" ? usage.biller : null,
      billingType: ledger.normalizeBillingType(usage.billingType),
    };
  }

  async function recover(target: RunLogUsageTarget): Promise<RecoveredRunUsage | null> {
    // Read the row again before the log: the caller's copy can be stale, and a finalization that
    // landed since keeps its own usage.
    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, target.id), eq(heartbeatRuns.companyId, target.companyId)));
    if (!run || !TERMINAL_STATUSES.has(run.status) || runHasRecordedUsage(run.usageJson)) return null;
    // A run that never started an adapter has no usage to find, and no log.
    if (!run.startedAt || !run.logRef) return null;

    const [agent] = await db
      .select({ adapterType: agents.adapterType })
      .from(agents)
      .where(and(eq(agents.id, run.agentId), eq(agents.companyId, run.companyId)));
    const createReader = agent ? findServerAdapter(agent.adapterType)?.createRunLogUsageReader : undefined;
    if (!createReader) return null;
    const reader = createReader();
    if (!(await readRunLogStdoutLines(deps.runLogStore ?? getRunLogStore(), run, reader))) return null;
    const found = reader.finish();
    if (!found) return null;

    const { inputTokens, outputTokens } = found.usage;
    const cachedInputTokens = found.usage.cachedInputTokens ?? 0;
    if (inputTokens <= 0 && outputTokens <= 0 && cachedInputTokens <= 0 && found.costUsd === null) return null;

    const profile = await readBillingProfile(run);
    const provider = found.provider ?? profile.provider ?? "unknown";
    const biller = profile.biller ?? provider;
    const model = found.model ?? "unknown";
    const costCents = ledger.billedCostCents(found.costUsd, profile.billingType);
    const costStatus = ledger.costStatus(found.costUsd);
    const usageJson = {
      inputTokens,
      cachedInputTokens,
      outputTokens,
      usageSource: "run_log",
      partial: found.partial,
      provider,
      biller,
      model,
      billingType: profile.billingType,
      costStatus,
      ...(found.costUsd !== null ? { costUsd: found.costUsd } : {}),
    };

    // One writer wins the empty `usage_json`; a normal finalization that lands first keeps its own.
    const [claimed] = await db
      .update(heartbeatRuns)
      .set({ usageJson, updatedAt: new Date() })
      .where(
        and(
          eq(heartbeatRuns.id, run.id),
          eq(heartbeatRuns.companyId, run.companyId),
          sql`(${heartbeatRuns.usageJson} is null or ${heartbeatRuns.usageJson} = '{}'::jsonb)`,
        ),
      )
      .returning({ id: heartbeatRuns.id });
    if (!claimed) return null;

    try {
      const scope = await ledger.resolveScope(run.companyId, run);
      await costs.createEvent(run.companyId, {
        heartbeatRunId: run.id,
        agentId: run.agentId,
        issueId: scope.issueId,
        projectId: scope.projectId,
        billingCode: scope.billingCode,
        provider,
        biller,
        billingType: profile.billingType,
        costStatus,
        model,
        inputTokens,
        cachedInputTokens,
        outputTokens,
        costCents,
        occurredAt: new Date(),
      });
      await db
        .update(agentRuntimeState)
        .set({
          totalInputTokens: sql`${agentRuntimeState.totalInputTokens} + ${inputTokens}`,
          totalOutputTokens: sql`${agentRuntimeState.totalOutputTokens} + ${outputTokens}`,
          totalCachedInputTokens: sql`${agentRuntimeState.totalCachedInputTokens} + ${cachedInputTokens}`,
          totalCostCents: sql`${agentRuntimeState.totalCostCents} + ${costCents}`,
          updatedAt: new Date(),
        })
        .where(eq(agentRuntimeState.agentId, run.agentId));
    } catch (err) {
      // Hand the run back, so the next terminal write or startup repair can try again, but only
      // while no cost event holds it: a failure after the event's insert must not count it twice.
      const [event] = await db
        .select({ id: costEvents.id })
        .from(costEvents)
        .where(and(eq(costEvents.companyId, run.companyId), eq(costEvents.heartbeatRunId, run.id)))
        .limit(1);
      if (!event) {
        await db
          .update(heartbeatRuns)
          .set({ usageJson: null, updatedAt: new Date() })
          .where(and(eq(heartbeatRuns.id, run.id), sql`${heartbeatRuns.usageJson} ->> 'usageSource' = 'run_log'`));
      }
      throw err;
    }

    logger.info(
      { runId: run.id, status: run.status, inputTokens, outputTokens, cachedInputTokens, costCents, partial: found.partial },
      "recorded the usage of a run that ended without an adapter result from its run log",
    );
    return { inputTokens, cachedInputTokens, outputTokens, costUsd: found.costUsd, partial: found.partial };
  }

  /**
   * Records the run's usage from its log when the run is terminal, started an adapter, and has no
   * usage yet; it reads the row again first. Never throws: a failure is logged and the run keeps
   * its (empty) usage. Calls for one run share one pass, so a caller that must finish before the
   * process exits can await the same work that a background caller started.
   */
  function recordRunUsageFromLog(run: RunLogUsageTarget): Promise<RecoveredRunUsage | null> {
    // Usage is never taken off a run, so a copy that holds usage needs no read.
    if (runHasRecordedUsage(run.usageJson)) return Promise.resolve(null);
    const pending = inFlight.get(run.id);
    if (pending) return pending;
    const pass = recover(run)
      .catch((err: unknown) => {
        logger.warn({ err, runId: run.id }, "failed to record the usage of a run from its run log");
        return null;
      })
      .finally(() => inFlight.delete(run.id));
    inFlight.set(run.id, pass);
    return pass;
  }

  return { recordRunUsageFromLog };
}

export type RunLogUsageRecovery = ReturnType<typeof createRunLogUsageRecovery>;
