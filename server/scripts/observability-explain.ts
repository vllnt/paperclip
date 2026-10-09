import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { companies, createDb, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { RUN_FAILURE_CAUSES } from "@paperclipai/shared";
import { buildReportQueries, runUsageQueryService } from "../src/services/run-usage-query.js";

/**
 * Measures the observability reports on a synthetic table in a throwaway embedded database.
 * Usage, from server/: node --import tsx scripts/observability-explain.ts [--rows 5000000] [--big-share 50]
 *
 * `--big-share` percent of the rows belong to one large company and the rest are spread over 19
 * small companies, with finished times spread evenly over the last 365 days. The table needs about
 * 450 bytes of disk for each row, indexes included, plus temporary space while the indexes build.
 * The script prints a markdown table of service latencies (min and median of three runs) and the
 * full plan of the heaviest queries.
 */

const DAY_MS = 24 * 60 * 60_000;
const CHUNK = 500_000;
const RUNS_PER_QUERY = 3;

function parseRows(): number {
  const index = process.argv.indexOf("--rows");
  const value = index >= 0 ? Number(process.argv[index + 1]) : 5_000_000;
  if (!Number.isInteger(value) || value < 1000) throw new Error("--rows must be an integer of at least 1000");
  return value;
}

function parseBigShare(): number {
  const index = process.argv.indexOf("--big-share");
  const value = index >= 0 ? Number(process.argv[index + 1]) : 50;
  if (!Number.isInteger(value) || value < 1 || value > 99) throw new Error("--big-share must be a whole percent from 1 to 99");
  return value;
}

function sqlArray(values: readonly string[]) {
  return sql.raw(`array[${values.map((value) => `'${value}'`).join(",")}]`);
}

async function seed(
  db: ReturnType<typeof createDb>,
  rows: number,
  bigShare: number,
  big: string,
  small: string[],
  now: Date,
): Promise<void> {
  const smallIds = sqlArray(small);
  const adapters = sqlArray(["claude_local", "codex_local", "gemini_local", "cursor", "opencode_local", "paperclip_runner"]);
  const models = sqlArray(Array.from({ length: 12 }, (_, index) => `model-${index}`));
  const providers = sqlArray(["anthropic", "openai", "google", "xai"]);
  const causes = sqlArray(RUN_FAILURE_CAUSES);
  const start = new Date(now.getTime() - 365 * DAY_MS).toISOString();
  for (let from = 0; from < rows; from += CHUNK) {
    const to = Math.min(from + CHUNK, rows);
    await db.execute(sql`
      insert into run_usage_records (
        run_id, company_id, agent_id, issue_id, project_id, routine_id, adapter_type, runtime_mode,
        invocation_source, status, cause_family, provider, model, input_tokens, cache_read_tokens,
        cache_write_tokens, output_tokens, reasoning_tokens, cost_micros, duration_ms, usage_quality,
        run_created_at, finished_at, day, schema_version, source
      )
      select
        gen_random_uuid(),
        case when g % 100 < ${bigShare}::int then ${big}::uuid else (${smallIds}::uuid[])[1 + g % ${small.length}::int] end,
        md5('agent-' || (g % 40))::uuid,
        case when random() < 0.3 then null else md5('issue-' || floor(random() * 20000)::int)::uuid end,
        case when random() < 0.2 then null else md5('project-' || (g % 10))::uuid end,
        case when random() < 0.6 then null else md5('routine-' || (g % 8))::uuid end,
        (${adapters}::text[])[1 + floor(random() * 6)::int],
        'cli',
        'timer',
        case when x.r < 0.85 then 'succeeded' when x.r < 0.93 then 'failed' when x.r < 0.97 then 'timed_out' else 'cancelled' end,
        case when x.r >= 0.85 then (${causes}::text[])[1 + floor(random() * ${RUN_FAILURE_CAUSES.length}::int)::int] end,
        (${providers}::text[])[1 + floor(random() * 4)::int],
        (${models}::text[])[1 + floor(random() * 12)::int],
        floor(random() * 150000)::bigint,
        case when random() < 0.7 then floor(random() * 500000)::bigint end,
        case when random() < 0.5 then floor(random() * 50000)::bigint end,
        floor(random() * 20000)::bigint,
        case when random() < 0.1 then floor(random() * 5000)::bigint end,
        floor(random() * 900000)::bigint,
        floor(random() * 600000)::bigint,
        case when y.q < 0.7 then 'measured' when y.q < 0.9 then 'declared' when y.q < 0.95 then 'derived' else 'missing' end,
        f.t - interval '90 seconds',
        f.t,
        (f.t at time zone 'UTC')::date,
        1,
        'derived'
      from generate_series(${from}::int, ${to - 1}::int) as g,
        lateral (select random() as r) x,
        lateral (select random() as q) y,
        lateral (select ${start}::timestamptz + (g::float8 / ${rows}::float8) * interval '365 days' as t) f
    `);
    console.log(`seeded ${to} of ${rows} rows`);
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function timed(label: string, call: () => Promise<unknown>): Promise<string> {
  const durations: number[] = [];
  for (let run = 0; run < RUNS_PER_QUERY; run += 1) {
    const startedAt = performance.now();
    await call();
    durations.push(performance.now() - startedAt);
  }
  return `| ${label} | ${Math.round(Math.min(...durations))} | ${Math.round(median(durations))} |`;
}

async function main(): Promise<void> {
  const rows = parseRows();
  const bigShare = parseBigShare();
  const now = new Date();
  const embedded = await startEmbeddedPostgresTestDatabase("paperclip-observability-explain-");
  try {
    const db = createDb(embedded.connectionString);
    const big = randomUUID();
    const small = Array.from({ length: 19 }, () => randomUUID());
    for (const id of [big, ...small]) {
      await db.insert(companies).values({
        id,
        name: "Synthetic",
        issuePrefix: `S${id.replace(/-/g, "").slice(0, 8).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
    }

    const indexes = await db.execute(sql`
      select indexname, indexdef from pg_indexes
      where tablename = 'run_usage_records' and indexname <> 'run_usage_records_pkey'
    `);
    const definitions = Array.from(indexes, (row) => ({ name: String(row.indexname), definition: String(row.indexdef) }));
    for (const index of definitions) await db.execute(sql.raw(`drop index "${index.name}"`));
    await seed(db, rows, bigShare, big, small, now);
    for (const index of definitions) await db.execute(sql.raw(index.definition));
    await db.execute(sql`analyze run_usage_records`);

    const [sizes] = await db.execute(sql`
      select pg_size_pretty(pg_table_size('run_usage_records')) as table_size,
             pg_size_pretty(pg_indexes_size('run_usage_records')) as index_size
    `);
    console.log(
      `\nrows: ${rows}, large company: ${Math.round((rows * bigShare) / 100)} rows (${bigShare}%), `
        + `table: ${sizes?.table_size}, indexes: ${sizes?.index_size}\n`,
    );

    const service = runUsageQueryService(db);
    const since = (days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();
    console.log("| report | min ms | median ms |\n|---|---|---|");
    for (const groupBy of ["agent", "project", "routine", "issue", "adapter", "model", "status", "day"] as const) {
      for (const days of [7, 30, 90, 365]) {
        console.log(await timed(`usage by ${groupBy}, ${days} d`, () =>
          service.usage(big, { groupBy, since: since(days), until: now.toISOString() }, now)));
      }
    }
    for (const days of [1, 7, 31]) {
      console.log(await timed(`usage by hour, ${days} d`, () =>
        service.usage(big, { groupBy: "hour", since: since(days), until: now.toISOString() }, now)));
    }
    for (const groupBy of ["cause", "agent", "day"] as const) {
      for (const days of [7, 30, 365]) {
        console.log(await timed(`failures by ${groupBy}, ${days} d`, () =>
          service.failures(big, { groupBy, since: since(days), until: now.toISOString() }, now)));
      }
    }
    console.log(await timed("usage by agent, 30 d, small company", () =>
      service.usage(small[0] ?? big, { groupBy: "agent", since: since(30), until: now.toISOString() }, now)));

    const plans: Array<[string, Parameters<typeof buildReportQueries>[0]]> = [
      ["usage by agent, 30 d", { companyId: big, dimension: "agent", since: new Date(since(30)), until: now, limit: 50, filters: [], failureFilter: null }],
      ["usage by issue, 365 d", { companyId: big, dimension: "issue", since: new Date(since(365)), until: now, limit: 50, filters: [], failureFilter: null }],
      ["usage by day, 365 d", { companyId: big, dimension: "day", since: new Date(since(365)), until: now, limit: 50, filters: [], failureFilter: null }],
    ];
    for (const [label, input] of plans) {
      const plan = await db.execute(sql`explain (analyze, buffers, costs off, timing off) ${buildReportQueries(input).grouped}`);
      console.log(`\nEXPLAIN ${label}\n${Array.from(plan, (row) => String(row["QUERY PLAN"])).join("\n")}`);
    }
  } finally {
    await embedded.cleanup();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  if (error instanceof Error && error.cause) console.error("cause:", error.cause);
  process.exitCode = 1;
});
