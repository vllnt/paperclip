import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import { heartbeatRuns } from "./schema/heartbeat_runs.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

/**
 * The run's issue (issueId, else taskId) index. Recovery and the attention feed
 * query this exact expression; any other expression leaves the planner without
 * the index, and it then reads every run's context.
 */
const INDEX_NAME = "heartbeat_runs_company_issue_or_task_idx";
const EXPRESSION = `coalesce("context_snapshot"->>'issueId', "context_snapshot"->>'taskId')`;
const STATEMENT = `CREATE INDEX IF NOT EXISTS "${INDEX_NAME}" ON "heartbeat_runs" USING btree ("company_id", (${EXPRESSION}));`;

const migrationsDir = new URL("./migrations/", import.meta.url);
// Found by content, so the guard survives a renumbered migration file.
const migrationFile = await (async () => {
  for (const file of (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort()) {
    if ((await readFile(new URL(file, migrationsDir), "utf8")).includes(`"${INDEX_NAME}"`)) return file;
  }
  throw new Error(`no migration creates ${INDEX_NAME}`);
})();
const migrationSql = await readFile(new URL(migrationFile, migrationsDir), "utf8");
const migrationHash = createHash("sha256").update(migrationSql).digest("hex");

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe("heartbeat_runs issue-or-task index schema", () => {
  it("declares the index on company_id and the exact issue expression", () => {
    const index = getTableConfig(heartbeatRuns).indexes.find((candidate) => candidate.config.name === INDEX_NAME);
    expect(index, `${INDEX_NAME} is not declared on heartbeat_runs`).toBeDefined();
    expect(index!.config.where).toBeUndefined();
    const [company, expression, ...rest] = index!.config.columns;
    expect((company as { name: string }).name).toBe("company_id");
    expect(rest).toEqual([]);
    expect(new PgDialect().sqlToQuery(expression as SQL, "indexes").sql).toBe(`(${EXPRESSION})`);
  });

  it("ships the pinned statement, and the concurrent build hint for the same index", () => {
    expect(migrationSql.trimEnd().split("\n").filter((line) => !line.startsWith("--"))).toEqual([STATEMENT]);
    expect(migrationSql).toContain(`--   ${STATEMENT.replace("CREATE INDEX IF NOT EXISTS", "CREATE INDEX CONCURRENTLY IF NOT EXISTS")}`);
  });
});

describePostgres("heartbeat_runs issue-or-task index migration", () => {
  it("adopts an index an operator built concurrently beforehand, without error or rebuild", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-issue-or-task-index-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => { await sql.end(); });
    const indexState = () => sql<Array<{ oid: number; valid: boolean; definition: string }>>`
      select i.indexrelid::int as oid, i.indisvalid as valid, pg_get_indexdef(i.indexrelid) as definition
      from pg_index i join pg_class c on c.oid = i.indexrelid
      where c.relname = ${INDEX_NAME}`;

    const [fresh] = await indexState();
    expect(fresh?.valid).toBe(true);
    expect(fresh?.definition).toBe(
      `CREATE INDEX ${INDEX_NAME} ON public.heartbeat_runs USING btree (company_id, COALESCE((context_snapshot ->> 'issueId'::text), (context_snapshot ->> 'taskId'::text)))`,
    );

    // The operator path the migration documents: build CONCURRENTLY first, then migrate.
    await sql.unsafe(`DROP INDEX "${INDEX_NAME}"`);
    await sql.unsafe(STATEMENT.replace("CREATE INDEX IF NOT EXISTS", "CREATE INDEX CONCURRENTLY IF NOT EXISTS"));
    const [prebuilt] = await indexState();
    await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${migrationHash}`;
    expect(await inspectMigrations(database.connectionString)).toMatchObject({
      status: "needsMigrations", pendingMigrations: [migrationFile],
    });

    await applyPendingMigrations(database.connectionString);

    expect(await inspectMigrations(database.connectionString)).toMatchObject({ status: "upToDate" });
    expect(await indexState()).toEqual([{ ...prebuilt!, valid: true, definition: fresh!.definition }]);
  }, 120_000);
});
