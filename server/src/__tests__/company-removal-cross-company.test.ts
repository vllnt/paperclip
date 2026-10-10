import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  assets,
  caseAttachments,
  cases,
  companies,
  companyLogos,
  companySecretVersions,
  companySecrets,
  companySkills,
  createDb,
  issueAttachments,
  issueDuplicatePairs,
  issues,
  runnerApiResponseReservations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { HttpError } from "../errors.ts";
import { companyService } from "../services/companies.ts";
import { COMPANY_DELETE_CROSS_COMPANY_REFERENCES } from "../services/company-removal-cross-company.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping cross-company company delete tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;

interface Tenant {
  companyId: string;
  agentId: string;
  issueId: string;
  assetId: string;
}

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describeEmbeddedPostgres("deleting a company that other companies' rows depend on", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyOwnedTables: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-removal-cross-company-");
    db = createDb(tempDb.connectionString);
    const rows = await db.execute(sql`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'company_id'
      ORDER BY table_name
    `);
    companyOwnedTables = Array.from(rows).flatMap((row) => {
      const name: unknown = Reflect.get(row, "table_name");
      return typeof name === "string" ? [name] : [];
    });
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedTenant(label: string): Promise<Tenant> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const assetId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `${label} ${companyId.slice(0, 8)}`,
      issuePrefix: `X${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Agent ${label}`,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Issue ${label}`,
      status: "todo",
      priority: "medium",
    });
    await db.insert(assets).values({
      id: assetId,
      companyId,
      provider: "local_disk",
      objectKey: `${companyId}/${assetId}`,
      contentType: "text/plain",
      byteSize: 1,
      sha256: "a".repeat(64),
    });
    return { companyId, agentId, issueId, assetId };
  }

  /** The number of rows in every table that has a `company_id` column, for one company. */
  async function snapshot(companyId: string): Promise<Record<string, number>> {
    const counts = sql.join(
      companyOwnedTables.map(
        (table) => sql`SELECT ${table}::text AS table_name, count(*)::int AS total FROM ${sql.identifier(table)} WHERE company_id = ${companyId}`,
      ),
      sql` UNION ALL `,
    );
    const rows = await db.execute(sql`SELECT table_name, total FROM (${counts}) AS counted WHERE total > 0 ORDER BY table_name`);
    const result: Record<string, number> = {};
    for (const row of Array.from(rows)) {
      const name: unknown = Reflect.get(row, "table_name");
      const total: unknown = Reflect.get(row, "total");
      if (typeof name === "string" && typeof total === "number") result[name] = total;
    }
    return result;
  }

  async function removalFailure(companyId: string): Promise<unknown> {
    return companyService(db)
      .remove(companyId)
      .then(
        () => null,
        (error: unknown) => error,
      );
  }

  async function expectRefusedAndUnchanged(input: {
    deleted: Tenant;
    other: Tenant;
    table: string;
    ids: string[];
  }) {
    const beforeDeleted = await snapshot(input.deleted.companyId);
    const beforeOther = await snapshot(input.other.companyId);

    const failure = await removalFailure(input.deleted.companyId);

    expect(failure).toBeInstanceOf(HttpError);
    expect(failure).toMatchObject({
      status: 409,
      details: {
        code: COMPANY_DELETE_CROSS_COMPANY_REFERENCES,
        references: [{ table: input.table, count: 1 }],
      },
    });
    const visible = JSON.stringify({ message: (failure as HttpError).message, details: (failure as HttpError).details });
    expect(visible).not.toMatch(UUID_PATTERN);
    for (const id of input.ids) expect(visible).not.toContain(id);
    expect(await snapshot(input.deleted.companyId), "rows of the company that was not deleted").toEqual(beforeDeleted);
    expect(await snapshot(input.other.companyId), "rows of the other company").toEqual(beforeOther);
    await expect(db.select().from(companies).where(eq(companies.id, input.deleted.companyId))).resolves.toHaveLength(1);
    await expect(db.select().from(companies).where(eq(companies.id, input.other.companyId))).resolves.toHaveLength(1);
  }

  describe("a row of another company that points at an asset of this company", () => {
    const kinds: Array<[string, string, (other: Tenant, deleted: Tenant) => Promise<void>]> = [
      [
        "an issue attachment",
        "issue_attachments",
        async (other, deleted) => {
          await db.insert(issueAttachments).values({
            companyId: other.companyId,
            issueId: other.issueId,
            assetId: deleted.assetId,
          });
        },
      ],
      [
        "a case attachment",
        "case_attachments",
        async (other, deleted) => {
          const [created] = await db
            .insert(cases)
            .values({ companyId: other.companyId, caseNumber: 1, identifier: "CASE-1", caseType: "general", title: "A case" })
            .returning();
          await db.insert(caseAttachments).values({
            companyId: other.companyId,
            caseId: created!.id,
            assetId: deleted.assetId,
          });
        },
      ],
      [
        "a company logo",
        "company_logos",
        async (other, deleted) => {
          await db.insert(companyLogos).values({ companyId: other.companyId, assetId: deleted.assetId });
        },
      ],
      [
        "a runner API reservation",
        "runner_api_response_reservations",
        async (other, deleted) => {
          await db.insert(runnerApiResponseReservations).values({
            companyId: other.companyId,
            assetId: deleted.assetId,
            reservedBytes: 1,
          });
        },
      ],
    ];

    it.each(kinds)("makes the delete return 409 for %s, and changes nothing", async (_label, table, seed) => {
      const deleted = await seedTenant("Deleted");
      const other = await seedTenant("Other");
      await seed(other, deleted);

      await expectRefusedAndUnchanged({
        deleted,
        other,
        table,
        ids: [deleted.companyId, other.companyId, deleted.assetId, other.assetId, deleted.issueId, other.issueId],
      });
    });
  });

  it("refuses when a row of another company would have a reference cleared (set null)", async () => {
    const deleted = await seedTenant("Deleted");
    const other = await seedTenant("Other");
    const [secret] = await db
      .insert(companySecrets)
      .values({ companyId: other.companyId, name: "Other secret", key: `other-${randomUUID()}`, createdByAgentId: deleted.agentId })
      .returning();

    await expectRefusedAndUnchanged({
      deleted,
      other,
      table: "company_secrets",
      ids: [deleted.companyId, other.companyId, deleted.agentId, secret!.id],
    });

    const [after] = await db.select().from(companySecrets).where(eq(companySecrets.id, secret!.id));
    expect(after?.createdByAgentId).toBe(deleted.agentId);
  });

  it("follows the owning parent of a table that has no company_id", async () => {
    const deleted = await seedTenant("Deleted");
    const other = await seedTenant("Other");
    const [secret] = await db
      .insert(companySecrets)
      .values({ companyId: other.companyId, name: "Other secret", key: `other-${randomUUID()}` })
      .returning();
    await db.insert(companySecretVersions).values({
      secretId: secret!.id,
      version: 1,
      material: {},
      valueSha256: "b".repeat(64),
      fingerprintSha256: "c".repeat(64),
      createdByAgentId: deleted.agentId,
    });

    await expectRefusedAndUnchanged({
      deleted,
      other,
      table: "company_secret_versions",
      ids: [deleted.companyId, other.companyId, deleted.agentId, secret!.id],
    });
  });

  it("refuses when another company's skill was forked from this company", async () => {
    const deleted = await seedTenant("Deleted");
    const other = await seedTenant("Other");
    await db.insert(companySkills).values({
      companyId: other.companyId,
      key: `fork-${randomUUID()}`,
      slug: "fork",
      name: "Forked skill",
      markdown: "# Fork",
      forkedFromCompanyId: deleted.companyId,
    });

    await expectRefusedAndUnchanged({
      deleted,
      other,
      table: "company_skills",
      ids: [deleted.companyId, other.companyId],
    });
  });

  describe("duplicate pairs from the duplicate detector", () => {
    async function insertPair(owner: Tenant, issue: Tenant, candidate: Tenant) {
      await db.insert(issueDuplicatePairs).values({
        companyId: owner.companyId,
        issueId: issue.issueId,
        candidateIssueId: candidate.issueId,
        lexicalScore: 0.5,
        verdict: "lexical_only",
        inputHash: randomUUID(),
      });
    }

    it("deletes a pair row that this company owns even when its issues belong to another company", async () => {
      const deleted = await seedTenant("Deleted");
      const other = await seedTenant("Other");
      await insertPair(deleted, other, other);
      const beforeOther = await snapshot(other.companyId);

      const removed = await companyService(db).remove(deleted.companyId);

      expect(removed?.id).toBe(deleted.companyId);
      await expect(db.select().from(issueDuplicatePairs).where(eq(issueDuplicatePairs.companyId, deleted.companyId))).resolves.toHaveLength(0);
      expect(await snapshot(other.companyId), "rows of the other company").toEqual(beforeOther);
    });

    it("refuses to delete a company whose issue is the subject of another company's pair row", async () => {
      const deleted = await seedTenant("Deleted");
      const other = await seedTenant("Other");
      await insertPair(other, deleted, deleted);

      await expectRefusedAndUnchanged({
        deleted,
        other,
        table: "issue_duplicate_pairs",
        ids: [deleted.companyId, other.companyId, deleted.issueId],
      });
    });
  });

  it("still deletes a company whose rows all point inside itself, and leaves another company alone", async () => {
    const deleted = await seedTenant("Deleted");
    const other = await seedTenant("Other");
    await db.insert(issueAttachments).values({ companyId: deleted.companyId, issueId: deleted.issueId, assetId: deleted.assetId });
    await db.insert(companyLogos).values({ companyId: deleted.companyId, assetId: deleted.assetId });
    await db.insert(issueAttachments).values({ companyId: other.companyId, issueId: other.issueId, assetId: other.assetId });
    const beforeOther = await snapshot(other.companyId);

    const removed = await companyService(db).remove(deleted.companyId);

    expect(removed?.id).toBe(deleted.companyId);
    expect(await snapshot(deleted.companyId)).toEqual({});
    expect(await snapshot(other.companyId), "rows of the other company").toEqual(beforeOther);
    await expect(db.select().from(companies).where(eq(companies.id, deleted.companyId))).resolves.toHaveLength(0);
  });
});
