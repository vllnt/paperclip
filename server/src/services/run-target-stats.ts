import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { classifyModelVendor, type RunTargetSource } from "@paperclipai/shared";

export type ProviderPool = "anthropic" | "openai" | "xai" | "unknown" | "unassigned";

export interface RunTargetGroup {
  source: RunTargetSource;
  tier: string | null;
  adapterType: string | null;
  model: string | null;
  pool: ProviderPool;
  runs: number;
  succeeded: number;
  failed: number;
  successRate: number;
  avgDurationSeconds: number | null;
}

export interface RunTargetStats {
  windowHours: number;
  /** Queued and running runs, by the provider pool of the harness and model they run on. */
  inFlight: { total: number; byPool: Partial<Record<ProviderPool, number>> };
  /** Finished runs in the window, grouped by where their target came from. */
  groups: RunTargetGroup[];
}

function poolOf(adapterType: string | null, model: string | null): ProviderPool {
  if (!adapterType) return "unassigned";
  const vendor = classifyModelVendor(model ?? "");
  if (vendor !== "unknown") return vendor;
  if (adapterType === "claude_local") return "anthropic";
  if (adapterType === "grok_local") return "xai";
  return "unknown";
}

/**
 * Run statistics per harness target. The in-flight counts per provider pool
 * show how far runs spread across pools, so an operator can raise an agent's
 * concurrency once they do. The groups compare success and duration by where
 * the target came from (issue profile, routine profile, fallback, agent
 * default) and by tier.
 *
 * @param db - Database handle.
 * @returns A report function.
 */
export function runTargetStatsService(db: Db) {
  return {
    async report(companyId: string, options: { hours: number }): Promise<RunTargetStats> {
      const since = new Date(Date.now() - options.hours * 3_600_000);
      const inFlightRows = (await db.execute(sql`
        SELECT run.executed_adapter_type AS adapter_type, run.executed_model AS model, count(*)::int AS count
        FROM ${heartbeatRuns} AS run
        WHERE run.company_id = ${companyId} AND run.status IN ('queued', 'running')
        GROUP BY run.executed_adapter_type, run.executed_model
      `)) as unknown as Array<{ adapter_type: string | null; model: string | null; count: number }>;
      const byPool: Partial<Record<ProviderPool, number>> = {};
      let total = 0;
      for (const row of inFlightRows) {
        const pool = poolOf(row.adapter_type, row.model);
        byPool[pool] = (byPool[pool] ?? 0) + row.count;
        total += row.count;
      }

      const groupRows = (await db.execute(sql`
        SELECT
          coalesce(run.runner_profile_json->'adapterDispatch'->>'source', 'agent_default') AS source,
          run.runner_profile_json->'adapterDispatch'->'profile'->>'tier' AS tier,
          run.executed_adapter_type AS adapter_type,
          run.executed_model AS model,
          count(*)::int AS runs,
          count(*) FILTER (WHERE run.status = 'succeeded')::int AS succeeded,
          count(*) FILTER (WHERE run.status IN ('failed', 'timed_out'))::int AS failed,
          avg(extract(epoch FROM (run.finished_at - run.started_at))) AS avg_seconds
        FROM ${heartbeatRuns} AS run
        WHERE run.company_id = ${companyId}
          AND run.status IN ('succeeded', 'failed', 'timed_out')
          AND run.finished_at >= ${since.toISOString()}::timestamptz
          AND run.started_at IS NOT NULL
        GROUP BY 1, 2, 3, 4
        ORDER BY runs DESC, source, adapter_type, model
      `)) as unknown as Array<{
        source: RunTargetSource; tier: string | null; adapter_type: string | null; model: string | null;
        runs: number; succeeded: number; failed: number; avg_seconds: string | number | null;
      }>;
      return {
        windowHours: options.hours,
        inFlight: { total, byPool },
        groups: groupRows.map((row) => ({
          source: row.source,
          tier: row.tier,
          adapterType: row.adapter_type,
          model: row.model,
          pool: poolOf(row.adapter_type, row.model),
          runs: row.runs,
          succeeded: row.succeeded,
          failed: row.failed,
          successRate: row.runs > 0 ? row.succeeded / row.runs : 0,
          avgDurationSeconds: row.avg_seconds === null ? null : Math.round(Number(row.avg_seconds)),
        })),
      };
    },
  };
}
