import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0302_wide_dragon_man.sql";
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function migrationHash() {
  const content = await fs.promises.readFile(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
  return createHash("sha256").update(content).digest("hex");
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describeEmbeddedPostgres("goal planning columns migration", () => {
  it("keeps existing goals as plain goals and is safe to replay", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-goal-planning-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    const companyId = randomUUID();
    const goalId = randomUUID();

    try {
      await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;
      await sql`
        ALTER TABLE "goals"
          DROP COLUMN IF EXISTS "kind",
          DROP COLUMN IF EXISTS "horizon",
          DROP COLUMN IF EXISTS "target_date",
          DROP COLUMN IF EXISTS "success_criteria"
      `;
      await sql`INSERT INTO "companies" ("id", "name", "issue_prefix") VALUES (${companyId}, 'Goal company', 'GPC')`;
      await sql`INSERT INTO "goals" ("id", "company_id", "title") VALUES (${goalId}, ${companyId}, 'Historical goal')`;
    } finally {
      await sql.end();
    }

    expect(await inspectMigrations(database.connectionString)).toMatchObject({
      status: "needsMigrations",
      pendingMigrations: [MIGRATION_FILE],
    });
    await applyPendingMigrations(database.connectionString);

    const verify = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const rows = await verify<{ kind: string; horizon: string | null; target_date: string | null; success_criteria: string | null }[]>`
        SELECT "kind", "horizon", "target_date", "success_criteria" FROM "goals" WHERE "id" = ${goalId}
      `;
      expect(rows).toEqual([{ kind: "goal", horizon: null, target_date: null, success_criteria: null }]);

      // Replaying the file against a schema that already has the columns must not fail.
      const body = await fs.promises.readFile(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
      for (const statement of body.split("--> statement-breakpoint")) {
        await verify.unsafe(statement);
      }
    } finally {
      await verify.end();
    }

    expect(await inspectMigrations(database.connectionString)).toMatchObject({ status: "upToDate" });
  }, 120_000);
});
