import { createInterface } from "node:readline";
import { and, desc, eq, isNotNull, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentRuntimeState, agents, heartbeatRuns } from "@paperclipai/db";
import { HEARTBEAT_RUN_TERMINAL_STATUSES, type BillingType, type CostStatus } from "@paperclipai/shared";
import { findServerAdapter } from "../adapters/index.js";
import { parseObject } from "../adapters/utils.js";
import { logger } from "../middleware/logger.js";
import { costService } from "./costs.js";
import type { BudgetServiceHooks } from "./budgets.js";
import { getRunLogStore, type RunLogStore } from "./run-log-store.js";

type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;

/** Stdout text read from one run log is capped, so a runaway log cannot exhaust the heap. */
const MAX_RUN_LOG_STDOUT_CHARS = 64 * 1024 * 1024;

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
 * Reads the stdout stream of one run back from its log. The log is one JSON record per line
 * (`{ts, stream, chunk}`); the stdout chunks join into the text the adapter printed.
 */
async function readRunLogStdout(store: RunLogStore, run: HeartbeatRunRow): Promise<string | null> {
  if (run.logStore !== "local_file" || !run.logRef) return null;
  const handle = { store: "local_file" as const, logRef: run.logRef };
  const chunks: string[] = [];
  let chars = 0;
  const take = (line: string) => {
    if (!line) return;
    try {
      const record = JSON.parse(line) as { stream?: unknown; chunk?: unknown };
      if (record.stream === "stdout" && typeof record.chunk === "string" && chars < MAX_RUN_LOG_STDOUT_CHARS) {
        chunks.push(record.chunk);
        chars += record.chunk.length;
      }
    } catch {
      // A line cut by a crash is not a record; the stream before it still counts.
    }
  };

  if (store.openReadStream) {
    const input = await store.openReadStream(handle);
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) take(line);
  } else {
    let offset = 0;
    let carry = "";
    for (;;) {
      const page = await store.read(handle, { offset, limitBytes: 1_000_000 });
      const text = carry + page.content;
      const parts = text.split("\n");
      carry = parts.pop() ?? "";
      for (const line of parts) take(line);
      if (page.nextOffset === undefined || page.nextOffset <= offset) break;
      offset = page.nextOffset;
    }
    take(carry);
  }
  return chunks.length > 0 ? chunks.join("") : null;
}

/**
 * Records the usage of a run that ended without an adapter result: a restart, a stop, the
 * watchdog fold. The adapters stream their usage into the run log while they work, so the log
 * still holds it. The adapter reads the log back (`parseRunLogUsage`); this service writes the
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

  async function recover(run: HeartbeatRunRow): Promise<RecoveredRunUsage | null> {
    const [agent] = await db
      .select({ adapterType: agents.adapterType })
      .from(agents)
      .where(and(eq(agents.id, run.agentId), eq(agents.companyId, run.companyId)));
    const parseRunLogUsage = agent ? findServerAdapter(agent.adapterType)?.parseRunLogUsage : undefined;
    if (!parseRunLogUsage) return null;

    const stdout = await readRunLogStdout(deps.runLogStore ?? getRunLogStore(), run);
    if (!stdout) return null;
    const found = parseRunLogUsage(stdout);
    if (!found) return null;

    const { inputTokens, outputTokens } = found.usage;
    const cachedInputTokens = found.usage.cachedInputTokens ?? 0;
    if (inputTokens <= 0 && outputTokens <= 0 && cachedInputTokens <= 0 && found.costUsd === null) return null;

    const profile = await readBillingProfile(run);
    const provider = profile.provider ?? "unknown";
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
    } catch (err) {
      // Hand the run back, so the next terminal write or startup repair can try again.
      await db
        .update(heartbeatRuns)
        .set({ usageJson: null, updatedAt: new Date() })
        .where(and(eq(heartbeatRuns.id, run.id), sql`${heartbeatRuns.usageJson} ->> 'usageSource' = 'run_log'`));
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
   * usage yet. Never throws: a failure is logged and the run keeps its (empty) usage. Calls for one
   * run share one pass, so a caller that must finish before the process exits can await the same
   * work that a background caller started.
   */
  function recordRunUsageFromLog(run: HeartbeatRunRow): Promise<RecoveredRunUsage | null> {
    if (!TERMINAL_STATUSES.has(run.status)) return Promise.resolve(null);
    // A run that never started an adapter has no usage to find, and no log.
    if (!run.startedAt || !run.logRef) return Promise.resolve(null);
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
