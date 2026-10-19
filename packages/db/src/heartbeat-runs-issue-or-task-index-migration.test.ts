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

  it("drops only an invalid index of that name, then ships the pinned statement and its concurrent build hint", () => {
    const statements = migrationSql.split("--> statement-breakpoint")
      .map((statement) => statement.split("\n").filter((line) => line.trim() && !line.startsWith("--")).join("\n"));
    expect(statements).toEqual([
      [
        "DO $$ BEGIN",
        "\tIF EXISTS (",
        "\t\tSELECT 1 FROM pg_index",
        `\t\tWHERE indexrelid = to_regclass('${INDEX_NAME}') AND NOT indisvalid`,
        "\t) THEN",
        `\t\tDROP INDEX "${INDEX_NAME}";`,
        "\tEND IF;",
        "END $$;",
      ].join("\n"),
      STATEMENT,
    ]);
    expect(migrationSql).toContain(`--   ${STATEMENT.replace("CREATE INDEX IF NOT EXISTS", "CREATE INDEX CONCURRENTLY IF NOT EXISTS")}`);
  });
});

const CONCURRENT_STATEMENT = STATEMENT.replace("CREATE INDEX IF NOT EXISTS", "CREATE INDEX CONCURRENTLY IF NOT EXISTS");
const DEFINITION =
  `CREATE INDEX ${INDEX_NAME} ON public.heartbeat_runs USING btree (company_id, COALESCE((context_snapshot ->> 'issueId'::text), (context_snapshot ->> 'taskId'::text)))`;

async function migratedDatabase() {
  const database = await startEmbeddedPostgresTestDatabase("paperclip-issue-or-task-index-");
  cleanups.push(database.cleanup);
  const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
  cleanups.push(async () => { await sql.end(); });
  const indexState = () => sql<Array<{ oid: number; valid: boolean; definition: string }>>`
    select i.indexrelid::int as oid, i.indisvalid as valid, pg_get_indexdef(i.indexrelid) as definition
    from pg_index i join pg_class c on c.oid = i.indexrelid
    where c.relname = ${INDEX_NAME}`;
  // Forget the migration, as on an instance that has not run it yet.
  const unapply = async () => {
    await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${migrationHash}`;
    expect(await inspectMigrations(database.connectionString)).toMatchObject({
      status: "needsMigrations", pendingMigrations: [migrationFile],
    });
  };
  const migrate = async () => {
    await applyPendingMigrations(database.connectionString);
    expect(await inspectMigrations(database.connectionString)).toMatchObject({ status: "upToDate" });
  };
  // Whether the planner reads runs of one issue through the index.
  const usesIndex = async () => sql.begin(async (tx) => {
    await tx`set local enable_seqscan = off`;
    const [row] = await tx.unsafe<Array<{ "QUERY PLAN": unknown }>>(
      `explain (format json) select id from heartbeat_runs
       where company_id = '00000000-0000-0000-0000-000000000000' and ${EXPRESSION} = 'issue'`,
    );
    return JSON.stringify(row?.["QUERY PLAN"]).includes(`"Index Name":"${INDEX_NAME}"`);
  });
  return { connectionString: database.connectionString, sql, indexState, unapply, migrate, usesIndex };
}

describePostgres("heartbeat_runs issue-or-task index migration", () => {
  it("adopts an index an operator built concurrently beforehand, without error or rebuild", async () => {
    const { sql, indexState, unapply, migrate, usesIndex } = await migratedDatabase();
    const [fresh] = await indexState();
    expect(fresh).toMatchObject({ valid: true, definition: DEFINITION });
    expect(await usesIndex()).toBe(true);

    // The operator path the migration documents: build CONCURRENTLY first, then migrate.
    await sql.unsafe(`DROP INDEX "${INDEX_NAME}"`);
    await sql.unsafe(CONCURRENT_STATEMENT);
    const [prebuilt] = await indexState();
    await unapply();

    await migrate();

    expect(await indexState()).toEqual([{ ...prebuilt!, valid: true, definition: DEFINITION }]);
  }, 120_000);

  it("rebuilds the index when a cancelled concurrent build left it invalid", async () => {
    const { connectionString, sql, indexState, unapply, migrate, usesIndex } = await migratedDatabase();
    await sql.unsafe(`DROP INDEX "${INDEX_NAME}"`);

    // A concurrent build waits for every open transaction that can write the
    // table. Hold one open so the build times out after it has added the index:
    // the index stays under its name, invalid.
    const writer = postgres(connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => { await writer.end(); });
    let locked!: () => void;
    let release!: () => void;
    const lockHeld = new Promise<void>((resolve) => { locked = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const openWrite = writer.begin(async (tx) => {
      await tx`lock table heartbeat_runs in row exclusive mode`;
      locked();
      await released;
    });
    await lockHeld;
    await sql`set lock_timeout = '200ms'`;
    await expect(sql.unsafe(CONCURRENT_STATEMENT)).rejects.toThrow(/lock timeout/);
    await sql`reset lock_timeout`;
    release();
    await openWrite;

    const [invalid] = await indexState();
    expect(invalid).toMatchObject({ valid: false, definition: DEFINITION });
    expect(await usesIndex()).toBe(false);
    await unapply();

    await migrate();

    const [rebuilt] = await indexState();
    expect(rebuilt).toMatchObject({ valid: true, definition: DEFINITION });
    expect(rebuilt!.oid).not.toBe(invalid!.oid);
    expect(await usesIndex()).toBe(true);
  }, 120_000);
});
