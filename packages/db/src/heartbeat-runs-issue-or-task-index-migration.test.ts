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
 * Indexes over a run's issue (issueId, else taskId). Recovery and the attention
 * feed query these exact expressions; any other expression leaves the planner
 * without the index, and it then reads every run's context.
 */
const ISSUE_OR_TASK = `coalesce("context_snapshot"->>'issueId', "context_snapshot"->>'taskId')`;
const ISSUE_OR_TASK_DEF = "COALESCE((context_snapshot ->> 'issueId'::text), (context_snapshot ->> 'taskId'::text))";
const QUALIFIED_ISSUE_OR_TASK = `coalesce("heartbeat_runs"."context_snapshot"->>'issueId', "heartbeat_runs"."context_snapshot"->>'taskId')`;
const NO_ISSUE = `(${QUALIFIED_ISSUE_OR_TASK} is null or ${QUALIFIED_ISSUE_OR_TASK} = '')`;
const NOBODY = "00000000-0000-0000-0000-000000000000";

const INDEXES = [
  {
    name: "heartbeat_runs_company_issue_or_task_idx",
    columns: ["company_id", `(${ISSUE_OR_TASK})`],
    where: undefined,
    statement: `CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_issue_or_task_idx" ON "heartbeat_runs" USING btree ("company_id", (${ISSUE_OR_TASK}));`,
    definition: `CREATE INDEX heartbeat_runs_company_issue_or_task_idx ON public.heartbeat_runs USING btree (company_id, ${ISSUE_OR_TASK_DEF})`,
    // The runs of one issue.
    query: `select id from heartbeat_runs where company_id = '${NOBODY}' and ${ISSUE_OR_TASK} = 'issue'`,
  },
  {
    name: "heartbeat_runs_company_agent_no_issue_created_idx",
    columns: ["company_id", "agent_id", "created_at"],
    where: NO_ISSUE.replaceAll(`"heartbeat_runs".`, ""),
    statement: `CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_agent_no_issue_created_idx" ON "heartbeat_runs" USING btree ("company_id","agent_id","created_at") WHERE ${NO_ISSUE};`,
    definition: `CREATE INDEX heartbeat_runs_company_agent_no_issue_created_idx ON public.heartbeat_runs USING btree (company_id, agent_id, created_at) WHERE ((${ISSUE_OR_TASK_DEF} IS NULL) OR (${ISSUE_OR_TASK_DEF} = ''::text))`,
    // The later runs of one agent without an issue.
    query: `select id from heartbeat_runs where company_id = '${NOBODY}' and agent_id = '${NOBODY}' and created_at >= now() and ${NO_ISSUE}`,
  },
];

const migrationsDir = new URL("./migrations/", import.meta.url);
const migrationFiles = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe.each(INDEXES)("heartbeat_runs index $name", (spec) => {
  const concurrentStatement = spec.statement.replace("CREATE INDEX IF NOT EXISTS", "CREATE INDEX CONCURRENTLY IF NOT EXISTS");
  // Found by content, so the guard survives a renumbered migration file.
  const migration = (async () => {
    for (const file of migrationFiles) {
      const content = await readFile(new URL(file, migrationsDir), "utf8");
      if (content.includes(`"${spec.name}"`)) {
        return { file, content, hash: createHash("sha256").update(content).digest("hex") };
      }
    }
    throw new Error(`no migration creates ${spec.name}`);
  })();

  it("is declared on heartbeat_runs with the exact columns and predicate", () => {
    const index = getTableConfig(heartbeatRuns).indexes.find((candidate) => candidate.config.name === spec.name);
    expect(index, `${spec.name} is not declared on heartbeat_runs`).toBeDefined();
    const dialect = new PgDialect();
    expect(index!.config.columns.map((column) => ("name" in column ? column.name : dialect.sqlToQuery(column as SQL, "indexes").sql)))
      .toEqual(spec.columns);
    expect(index!.config.where && dialect.sqlToQuery(index!.config.where, "indexes").sql).toBe(spec.where);
  });

  it("drops only an invalid index of that name, then ships the pinned statement and its concurrent build hint", async () => {
    const { content } = await migration;
    const statements = content.split("--> statement-breakpoint")
      .map((statement) => statement.split("\n").filter((line) => line.trim() && !line.startsWith("--")).join("\n"));
    expect(statements).toEqual([
      [
        "DO $$ BEGIN",
        "\tIF EXISTS (",
        "\t\tSELECT 1 FROM pg_index",
        `\t\tWHERE indexrelid = to_regclass('${spec.name}') AND NOT indisvalid`,
        "\t) THEN",
        `\t\tDROP INDEX "${spec.name}";`,
        "\tEND IF;",
        "END $$;",
      ].join("\n"),
      spec.statement,
    ]);
    expect(content).toContain(`--   ${concurrentStatement}`);
  });

  describePostgres("migration", () => {
    async function migratedDatabase() {
      const { file, hash } = await migration;
      const database = await startEmbeddedPostgresTestDatabase("paperclip-run-issue-index-");
      cleanups.push(database.cleanup);
      const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      cleanups.push(async () => { await sql.end(); });
      const indexState = () => sql<Array<{ oid: number; valid: boolean; definition: string }>>`
        select i.indexrelid::int as oid, i.indisvalid as valid, pg_get_indexdef(i.indexrelid) as definition
        from pg_index i join pg_class c on c.oid = i.indexrelid
        where c.relname = ${spec.name}`;
      // Forget the migration, as on an instance that has not run it yet.
      const unapply = async () => {
        await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`;
        expect(await inspectMigrations(database.connectionString)).toMatchObject({
          status: "needsMigrations", pendingMigrations: [file],
        });
      };
      const migrate = async () => {
        await applyPendingMigrations(database.connectionString);
        expect(await inspectMigrations(database.connectionString)).toMatchObject({ status: "upToDate" });
      };
      // Whether the planner answers the query the index serves through it.
      const usesIndex = async () => sql.begin(async (tx) => {
        await tx`set local enable_seqscan = off`;
        const [row] = await tx.unsafe<Array<{ "QUERY PLAN": unknown }>>(`explain (format json) ${spec.query}`);
        return JSON.stringify(row?.["QUERY PLAN"]).includes(`"Index Name":"${spec.name}"`);
      });
      return { connectionString: database.connectionString, sql, indexState, unapply, migrate, usesIndex };
    }

    it("adopts an index an operator built concurrently beforehand, without error or rebuild", async () => {
      const { sql, indexState, unapply, migrate, usesIndex } = await migratedDatabase();
      const [fresh] = await indexState();
      expect(fresh).toMatchObject({ valid: true, definition: spec.definition });
      expect(await usesIndex()).toBe(true);

      // The operator path the migration documents: build CONCURRENTLY first, then migrate.
      await sql.unsafe(`DROP INDEX "${spec.name}"`);
      await sql.unsafe(concurrentStatement);
      const [prebuilt] = await indexState();
      await unapply();

      await migrate();

      expect(await indexState()).toEqual([{ ...prebuilt!, valid: true, definition: spec.definition }]);
    }, 120_000);

    it("rebuilds the index when a cancelled concurrent build left it invalid", async () => {
      const { connectionString, sql, indexState, unapply, migrate, usesIndex } = await migratedDatabase();
      await sql.unsafe(`DROP INDEX "${spec.name}"`);

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
      await expect(sql.unsafe(concurrentStatement)).rejects.toThrow(/lock timeout/);
      await sql`reset lock_timeout`;
      release();
      await openWrite;

      const [invalid] = await indexState();
      expect(invalid).toMatchObject({ valid: false, definition: spec.definition });
      expect(await usesIndex()).toBe(false);
      await unapply();

      await migrate();

      const [rebuilt] = await indexState();
      expect(rebuilt).toMatchObject({ valid: true, definition: spec.definition });
      expect(rebuilt!.oid).not.toBe(invalid!.oid);
      expect(await usesIndex()).toBe(true);
    }, 120_000);
  });
});
