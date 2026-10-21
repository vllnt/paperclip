import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyEvalFeedback,
  companyEvalRuns,
  companyEvals,
  companyEvalVersions,
  createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRuns,
  issues,
  projects,
  type Db,
} from "@paperclipai/db";
import type { CompanyEvalInputSchema, CompanyEvalQuestions } from "@paperclipai/shared";
import { isUniqueViolation } from "../db-errors.js";
import { createPostgresEvalsRepository } from "../modules/evals/adapters/postgres.js";
import { createPostgresRunContext } from "../modules/evals/adapters/run-context.js";
import { createEvalInputRetention } from "../modules/evals/index.js";
import { sweepExpiredEvalInputs } from "../modules/evals/application/use-cases.js";
import type { NewEvalFields, NewFeedbackFields } from "../modules/evals/application/ports.js";
import {
  EvalSlugTakenError,
  type EvalActor,
  type NewRunRecord,
  type NewVersionFields,
  type RunCursor,
  type RunFilter,
  type RunRecord,
} from "../modules/evals/application/types.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping company evals Postgres tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const VERSION_UNIQUE_CONSTRAINT = "company_eval_versions_eval_version_uq";
const EXPIRY_INDEX = "company_eval_runs_input_expiry_idx";

const INPUT_SCHEMA: CompanyEvalInputSchema = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
};

const QUESTIONS: CompanyEvalQuestions = {
  needs_qa: { type: "predicate", instructions: "Does this change need a QA pass?" },
};

/** A fixed clock. Nothing here reads the real time, so every ordering is explicit. */
const T0 = new Date("2031-01-15T10:00:00.000Z");
function at(seconds: number): Date {
  return new Date(T0.getTime() + seconds * 1000);
}

let idBlocks = 0;
/**
 * A readable, deterministic uuid for each number, for rows whose id order matters. Every call
 * starts a block of its own, so two tests never reuse an id.
 */
function idsIn(): (n: number) => string {
  idBlocks += 1;
  const block = idBlocks.toString(16).padStart(8, "0");
  return (n) => `${block}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function versionFields(overrides: Partial<NewVersionFields> = {}): NewVersionFields {
  const id = overrides.id ?? randomUUID();
  return {
    id,
    inputSchema: INPUT_SCHEMA,
    questions: QUESTIONS,
    definitionHash: sha(`definition:${id}`),
    changeNote: null,
    createdByUserId: "user-1",
    createdAt: T0,
    ...overrides,
  };
}

function evalFields(companyId: string, slug: string, overrides: Partial<NewEvalFields> = {}): NewEvalFields {
  return {
    id: randomUUID(),
    companyId,
    slug,
    title: `Eval ${slug}`,
    whenToUse: "Use it when a pull request changes the UI.",
    createdByUserId: "user-1",
    now: T0,
    ...overrides,
  };
}

interface RunTarget {
  companyId: string;
  evalId: string;
  versionId: string;
}

function runFields(target: RunTarget, overrides: Partial<NewRunRecord> = {}): NewRunRecord {
  const id = overrides.id ?? randomUUID();
  return {
    id,
    companyId: target.companyId,
    evalId: target.evalId,
    versionId: target.versionId,
    versionNumber: 1,
    callerType: "user",
    callerAgentId: null,
    callerUserId: "user-1",
    heartbeatRunId: null,
    issueId: null,
    projectId: null,
    inputHash: sha(`input:${id}`),
    inputRedacted: false,
    inputRedactionCount: 0,
    inputBytes: 24,
    input: { text: "hello" },
    inputExpiresAt: null,
    mode: "live",
    outcome: "answered",
    failureReason: null,
    answers: { needs_qa: { type: "predicate", probability: 0.9, value: true, abstained: false } },
    anyAbstained: false,
    cached: false,
    latencyMs: 120,
    modelId: "typesafe-ai/jev",
    inputTokens: 10,
    outputTokens: 2,
    costUsd: null,
    createdAt: T0,
    ...overrides,
  };
}

function feedbackFields(
  run: Pick<RunRecord, "id" | "companyId">,
  overrides: Partial<NewFeedbackFields> = {},
): NewFeedbackFields {
  return {
    id: randomUUID(),
    companyId: run.companyId,
    runId: run.id,
    questionKey: "",
    verdict: "correct",
    note: null,
    authorType: "user",
    authorKey: "user:board-1",
    authorAgentId: null,
    authorUserId: "board-1",
    now: T0,
    ...overrides,
  };
}

describeEmbeddedPostgres("company evals on a real database", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-evals-postgres-");
    db = createDb(tempDb.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(label: string): Promise<string> {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: `${label} ${id}`,
      issuePrefix: `E${id.replace(/-/g, "").slice(0, 8).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return id;
  }

  async function seedAgent(companyId: string): Promise<string> {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: `Agent ${id.slice(0, 8)}`,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  async function seedProject(companyId: string): Promise<string> {
    const id = randomUUID();
    await db.insert(projects).values({ id, companyId, name: `Project ${id.slice(0, 8)}` });
    return id;
  }

  async function seedIssue(companyId: string, projectId: string | null = null): Promise<string> {
    const id = randomUUID();
    await db.insert(issues).values({ id, companyId, title: `Issue ${id.slice(0, 8)}`, status: "todo", projectId });
    return id;
  }

  async function seedHeartbeatRun(
    companyId: string,
    agentId: string,
    contextSnapshot: Record<string, unknown> | null,
  ): Promise<string> {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "completed",
      contextSnapshot,
    });
    return id;
  }

  const repo = () => createPostgresEvalsRepository(db);

  async function seedEval(companyId: string, slug: string, overrides: Partial<NewEvalFields> = {}) {
    return repo().insertEvalWithFirstVersion(evalFields(companyId, slug, overrides), versionFields());
  }

  async function seedTarget(companyId: string, slug: string): Promise<RunTarget> {
    const created = await seedEval(companyId, slug);
    return { companyId, evalId: created.eval.id, versionId: created.version.id };
  }

  async function seedEvalWithRun(companyId: string, slug: string, runOverrides: Partial<NewRunRecord> = {}) {
    const created = await seedEval(companyId, slug);
    const target: RunTarget = { companyId, evalId: created.eval.id, versionId: created.version.id };
    const run = await repo().insertRun(runFields(target, runOverrides));
    return { ...created, target, run };
  }

  async function evalRows(companyId: string) {
    return db.select().from(companyEvals).where(eq(companyEvals.companyId, companyId));
  }

  async function versionRows(evalId: string) {
    return db.select().from(companyEvalVersions).where(eq(companyEvalVersions.evalId, evalId));
  }

  async function runRows(evalId: string) {
    return db.select().from(companyEvalRuns).where(eq(companyEvalRuns.evalId, evalId));
  }

  async function oneEval(evalId: string) {
    const [row] = await db.select().from(companyEvals).where(eq(companyEvals.id, evalId));
    if (!row) throw new Error(`eval ${evalId} does not exist`);
    return row;
  }

  // ---------------------------------------------------------------------------------------------
  // Creating evals and numbering versions
  // ---------------------------------------------------------------------------------------------

  describe("creating an eval", () => {
    it("writes the eval and its version 1 together, as a draft that counts one version", async () => {
      const company = await seedCompany("Create");
      const created = await repo().insertEvalWithFirstVersion(
        evalFields(company, "pr-needs-qa", { createdByUserId: "user-7", now: at(5) }),
        versionFields({ changeNote: "First cut", createdByUserId: "user-7", createdAt: at(5) }),
      );

      expect(created.eval).toMatchObject({
        companyId: company,
        slug: "pr-needs-qa",
        title: "Eval pr-needs-qa",
        status: "draft",
        publishedVersionId: null,
        latestVersionNumber: 1,
        templateKey: null,
        templateVersion: null,
        createdByUserId: "user-7",
        updatedByUserId: "user-7",
        createdAt: at(5),
        updatedAt: at(5),
        publishedAt: null,
        archivedAt: null,
      });
      expect(created.version).toMatchObject({
        companyId: company,
        evalId: created.eval.id,
        versionNumber: 1,
        inputSchema: INPUT_SCHEMA,
        questions: QUESTIONS,
        changeNote: "First cut",
        createdByUserId: "user-7",
        createdAt: at(5),
      });
      expect(await oneEval(created.eval.id)).toEqual(created.eval);
      expect(await versionRows(created.eval.id)).toEqual([created.version]);
    });

    it("refuses a second eval with the same slug in one company, and keeps nothing of it", async () => {
      const company = await seedCompany("Slug");
      const first = await seedEval(company, "triage");

      const error = await repo()
        .insertEvalWithFirstVersion(evalFields(company, "triage", { title: "Second" }), versionFields())
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(EvalSlugTakenError);
      expect(error).toHaveProperty("message", expect.stringContaining('"triage"'));
      expect(await evalRows(company)).toEqual([first.eval]);
      expect(await db.select().from(companyEvalVersions).where(eq(companyEvalVersions.companyId, company))).toEqual([
        first.version,
      ]);
    });

    it("allows the same slug in another company", async () => {
      const a = await seedCompany("Slug A");
      const b = await seedCompany("Slug B");
      const inA = await seedEval(a, "triage");
      const inB = await seedEval(b, "triage");

      expect(inA.eval.id).not.toBe(inB.eval.id);
      expect(await repo().findEvalBySlug(a, "triage")).toEqual(inA.eval);
      expect(await repo().findEvalBySlug(b, "triage")).toEqual(inB.eval);
    });

    it("lets exactly one of two concurrent creates of the same slug win", async () => {
      const company = await seedCompany("Slug race");
      const results = await Promise.allSettled([
        repo().insertEvalWithFirstVersion(evalFields(company, "race"), versionFields()),
        repo().insertEvalWithFirstVersion(evalFields(company, "race"), versionFields()),
        repo().insertEvalWithFirstVersion(evalFields(company, "race"), versionFields()),
      ]);

      const won = results.filter((result) => result.status === "fulfilled");
      const lost = results.filter((result) => result.status === "rejected");
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(2);
      for (const result of lost) expect(result.reason).toBeInstanceOf(EvalSlugTakenError);
      const rows = await evalRows(company);
      expect(rows).toHaveLength(1);
      expect(await versionRows(rows[0]!.id)).toHaveLength(1);
    });

    it("rolls the eval back when its version cannot be written", async () => {
      const company = await seedCompany("Atomic create");
      const first = await seedEval(company, "first");

      // The second eval is fine, but its version reuses the id of the first version.
      const error = await repo()
        .insertEvalWithFirstVersion(evalFields(company, "second"), versionFields({ id: first.version.id }))
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(EvalSlugTakenError);
      expect(await repo().findEvalBySlug(company, "second")).toBeNull();
      expect((await evalRows(company)).map((row) => row.slug)).toEqual(["first"]);
    });
  });

  describe("numbering versions", () => {
    it("appends the next number and moves the counter in one step", async () => {
      const company = await seedCompany("Append");
      const { eval: record } = await seedEval(company, "append");

      const second = await repo().appendVersion({
        companyId: company,
        evalId: record.id,
        expectedLatest: 1,
        version: versionFields({ changeNote: "Tighter wording", createdAt: at(30) }),
      });
      const third = await repo().appendVersion({
        companyId: company,
        evalId: record.id,
        expectedLatest: 2,
        version: versionFields({ createdAt: at(60) }),
      });

      expect(second).toMatchObject({ versionNumber: 2, evalId: record.id, companyId: company, changeNote: "Tighter wording" });
      expect(third).toMatchObject({ versionNumber: 3 });
      const after = await oneEval(record.id);
      expect(after.latestVersionNumber).toBe(3);
      expect(after.updatedAt).toEqual(at(60));
      expect((await versionRows(record.id)).map((row) => row.versionNumber).sort()).toEqual([1, 2, 3]);
    });

    it("writes nothing when the expected latest number is stale", async () => {
      const company = await seedCompany("Stale");
      const { eval: record } = await seedEval(company, "stale");
      await repo().appendVersion({ companyId: company, evalId: record.id, expectedLatest: 1, version: versionFields() });
      const before = await oneEval(record.id);
      const versionsBefore = await versionRows(record.id);

      const stale = await repo().appendVersion({
        companyId: company,
        evalId: record.id,
        expectedLatest: 1,
        version: versionFields({ createdAt: at(999) }),
      });
      const ahead = await repo().appendVersion({
        companyId: company,
        evalId: record.id,
        expectedLatest: 7,
        version: versionFields({ createdAt: at(999) }),
      });

      expect(stale).toBeNull();
      expect(ahead).toBeNull();
      expect(await oneEval(record.id)).toEqual(before);
      expect(await versionRows(record.id)).toHaveLength(versionsBefore.length);
    });

    it("lets exactly one of several writers that read the same latest number win", async () => {
      const company = await seedCompany("Same expected");
      const { eval: record } = await seedEval(company, "same-expected");

      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          repo().appendVersion({ companyId: company, evalId: record.id, expectedLatest: 1, version: versionFields() }),
        ),
      );

      const won = results.filter((result) => result !== null);
      expect(won).toHaveLength(1);
      expect(won[0]?.versionNumber).toBe(2);
      expect((await oneEval(record.id)).latestVersionNumber).toBe(2);
      expect((await versionRows(record.id)).map((row) => row.versionNumber).sort()).toEqual([1, 2]);
    });

    it("gives distinct, consecutive numbers to writers that re-read and retry", async () => {
      const company = await seedCompany("Retry");
      const { eval: record } = await seedEval(company, "retry");

      async function appendWithRetry() {
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const current = await oneEval(record.id);
          const appended = await repo().appendVersion({
            companyId: company,
            evalId: record.id,
            expectedLatest: current.latestVersionNumber,
            version: versionFields(),
          });
          if (appended) return appended;
        }
        throw new Error("the writer never won a version number");
      }
      const appended = await Promise.all(Array.from({ length: 5 }, appendWithRetry));

      expect(appended.map((version) => version.versionNumber).sort((x, y) => x - y)).toEqual([2, 3, 4, 5, 6]);
      expect((await oneEval(record.id)).latestVersionNumber).toBe(6);
      expect(
        (await versionRows(record.id)).map((row) => row.versionNumber).sort((x, y) => x - y),
      ).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it("rolls the counter back when the new version row cannot be written", async () => {
      const company = await seedCompany("Atomic append");
      const { eval: record, version } = await seedEval(company, "atomic-append");

      // The version reuses an existing id, so the insert fails after the counter has moved.
      const error = await repo()
        .appendVersion({ companyId: company, evalId: record.id, expectedLatest: 1, version: versionFields({ id: version.id }) })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((await oneEval(record.id)).latestVersionNumber).toBe(1);
      expect(await versionRows(record.id)).toHaveLength(1);
    });

    it("enforces one row per (eval, version number) in the database itself", async () => {
      const company = await seedCompany("Unique version");
      const { eval: record } = await seedEval(company, "unique-version");
      const other = await seedEval(company, "other-eval");

      const duplicate = await db
        .insert(companyEvalVersions)
        .values({
          id: randomUUID(),
          companyId: company,
          evalId: record.id,
          versionNumber: 1,
          inputSchema: INPUT_SCHEMA,
          questions: QUESTIONS,
          definitionHash: sha("duplicate"),
          createdAt: T0,
        })
        .then(
          () => null,
          (error: unknown) => error,
        );

      expect(isUniqueViolation(duplicate, VERSION_UNIQUE_CONSTRAINT)).toBe(true);
      expect(await versionRows(record.id)).toHaveLength(1);
      // Another eval has its own version 1.
      expect(await versionRows(other.eval.id)).toHaveLength(1);
    });

    it("reads versions by number and by id, inside the eval and the company", async () => {
      const company = await seedCompany("Read versions");
      const { eval: record, version } = await seedEval(company, "read-versions");
      const second = await repo().appendVersion({ companyId: company, evalId: record.id, expectedLatest: 1, version: versionFields() });

      expect(await repo().getVersionByNumber(company, record.id, 1)).toEqual(version);
      expect(await repo().getVersionByNumber(company, record.id, 2)).toEqual(second);
      expect(await repo().getVersionByNumber(company, record.id, 3)).toBeNull();
      expect(await repo().getVersionsByIds(company, [])).toEqual([]);
      const byId = await repo().getVersionsByIds(company, [version.id, second!.id, randomUUID()]);
      expect(byId.map((row) => row.id).sort()).toEqual([version.id, second!.id].sort());
    });

    it("updates only the fields it is given, never the slug", async () => {
      const company = await seedCompany("Meta");
      const { eval: record } = await seedEval(company, "meta");

      const retitled = await repo().updateEvalMeta(company, record.id, { title: "New title", updatedByUserId: "user-9", now: at(40) });
      expect(retitled).toMatchObject({
        slug: "meta",
        title: "New title",
        whenToUse: record.whenToUse,
        updatedByUserId: "user-9",
        updatedAt: at(40),
        createdByUserId: "user-1",
        createdAt: T0,
      });

      const reworded = await repo().updateEvalMeta(company, record.id, { whenToUse: "New guidance", updatedByUserId: "user-9", now: at(80) });
      expect(reworded).toMatchObject({ title: "New title", whenToUse: "New guidance", updatedAt: at(80) });
      expect(await repo().updateEvalMeta(company, randomUUID(), { title: "Nothing", updatedByUserId: null, now: at(90) })).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Publishing, archiving, deleting
  // ---------------------------------------------------------------------------------------------

  describe("publishing, archiving and deleting", () => {
    it("points the eval at the published version, and restores an archived one when it is published again", async () => {
      const company = await seedCompany("Publish");
      const { eval: record, version: v1 } = await seedEval(company, "publish");
      const v2 = await repo().appendVersion({ companyId: company, evalId: record.id, expectedLatest: 1, version: versionFields() });

      const published = await repo().setPublished(company, record.id, { versionId: v2!.id, updatedByUserId: "user-2", now: at(10) });
      expect(published).toMatchObject({
        status: "published",
        publishedVersionId: v2!.id,
        publishedAt: at(10),
        archivedAt: null,
        updatedByUserId: "user-2",
        updatedAt: at(10),
      });

      const archived = await repo().setArchived(company, record.id, { updatedByUserId: "user-3", now: at(20) });
      expect(archived).toMatchObject({
        status: "archived",
        archivedAt: at(20),
        // The archived eval keeps pointing at what it published.
        publishedVersionId: v2!.id,
        publishedAt: at(10),
        updatedByUserId: "user-3",
      });

      const restored = await repo().setPublished(company, record.id, { versionId: v1.id, updatedByUserId: "user-2", now: at(30) });
      expect(restored).toMatchObject({
        status: "published",
        publishedVersionId: v1.id,
        publishedAt: at(30),
        archivedAt: null,
      });
      expect(await oneEval(record.id)).toEqual(restored);
    });

    it("clears the published pointer when the version it names is deleted, and keeps the eval", async () => {
      const company = await seedCompany("Pointer");
      const { eval: record, version } = await seedEval(company, "pointer");
      await repo().setPublished(company, record.id, { versionId: version.id, updatedByUserId: null, now: at(1) });
      expect((await oneEval(record.id)).publishedVersionId).toBe(version.id);

      await db.delete(companyEvalVersions).where(eq(companyEvalVersions.id, version.id));

      const after = await oneEval(record.id);
      expect(after.publishedVersionId).toBeNull();
      // The eval stays published in history: it cannot be deleted for good.
      expect(after.publishedAt).toEqual(at(1));
    });

    it("deletes a never-published eval with its versions, runs and feedback, and nothing else", async () => {
      const company = await seedCompany("Delete");
      const doomed = await seedEvalWithRun(company, "doomed", { mode: "try_it" });
      await repo().appendVersion({ companyId: company, evalId: doomed.eval.id, expectedLatest: 1, version: versionFields() });
      await repo().upsertFeedback(feedbackFields(doomed.run));
      const survivor = await seedEvalWithRun(company, "survivor");
      await repo().upsertFeedback(feedbackFields(survivor.run));

      expect(await repo().deleteNeverPublished(company, doomed.eval.id)).toBe(true);

      expect(await db.select().from(companyEvals).where(eq(companyEvals.id, doomed.eval.id))).toEqual([]);
      expect(await versionRows(doomed.eval.id)).toEqual([]);
      expect(await runRows(doomed.eval.id)).toEqual([]);
      expect(await db.select().from(companyEvalFeedback).where(eq(companyEvalFeedback.runId, doomed.run.id))).toEqual([]);
      expect(await versionRows(survivor.eval.id)).toHaveLength(1);
      expect(await runRows(survivor.eval.id)).toHaveLength(1);
      expect(await db.select().from(companyEvalFeedback).where(eq(companyEvalFeedback.runId, survivor.run.id))).toHaveLength(1);
      expect(await repo().deleteNeverPublished(company, doomed.eval.id)).toBe(false);
    });

    it("refuses to delete an eval that was ever published, even one that is archived now", async () => {
      const company = await seedCompany("Keep");
      const kept = await seedEvalWithRun(company, "kept");
      await repo().upsertFeedback(feedbackFields(kept.run));
      await repo().setPublished(company, kept.eval.id, { versionId: kept.version.id, updatedByUserId: null, now: at(1) });

      expect(await repo().deleteNeverPublished(company, kept.eval.id)).toBe(false);
      await repo().setArchived(company, kept.eval.id, { updatedByUserId: null, now: at(2) });
      expect(await repo().deleteNeverPublished(company, kept.eval.id)).toBe(false);

      expect(await oneEval(kept.eval.id)).toMatchObject({ status: "archived" });
      expect(await versionRows(kept.eval.id)).toHaveLength(1);
      expect(await runRows(kept.eval.id)).toHaveLength(1);
      expect(await db.select().from(companyEvalFeedback).where(eq(companyEvalFeedback.runId, kept.run.id))).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Keyset pagination
  // ---------------------------------------------------------------------------------------------

  describe("keyset pagination", () => {
    it("pages evals by slug and filters by status and by published version", async () => {
      const company = await seedCompany("Page evals");
      const slugs = ["triage", "alpha", "triage-2", "zeta", "beta", "gamma"];
      const created = new Map<string, Awaited<ReturnType<typeof seedEval>>>();
      for (const slug of slugs) created.set(slug, await seedEval(company, slug));
      const publish = async (slug: string) => {
        const row = created.get(slug)!;
        await repo().setPublished(company, row.eval.id, { versionId: row.version.id, updatedByUserId: null, now: at(1) });
      };
      await publish("alpha");
      await publish("triage");
      await publish("zeta");
      await repo().setArchived(company, created.get("zeta")!.eval.id, { updatedByUserId: null, now: at(2) });

      async function pageAll(query: { statuses: Array<"draft" | "published" | "archived">; publishedOnly: boolean }, limit: number) {
        const seen: string[] = [];
        let afterSlug: string | undefined;
        for (let guard = 0; guard < 20; guard += 1) {
          const rows = await repo().listEvals(company, { ...query, limit, afterSlug });
          seen.push(...rows.map((row) => row.slug));
          const last = rows[rows.length - 1];
          if (rows.length < limit || !last) return seen;
          afterSlug = last.slug;
        }
        throw new Error("pagination did not end");
      }

      const everything = ["alpha", "beta", "gamma", "triage", "triage-2", "zeta"];
      for (const limit of [1, 2, 4, 50]) {
        expect(await pageAll({ statuses: ["draft", "published", "archived"], publishedOnly: false }, limit)).toEqual(everything);
      }
      expect(await pageAll({ statuses: ["draft", "published"], publishedOnly: false }, 2)).toEqual([
        "alpha",
        "beta",
        "gamma",
        "triage",
        "triage-2",
      ]);
      expect(await pageAll({ statuses: ["draft"], publishedOnly: false }, 2)).toEqual(["beta", "gamma", "triage-2"]);
      expect(await pageAll({ statuses: ["archived"], publishedOnly: false }, 2)).toEqual(["zeta"]);
      expect(await pageAll({ statuses: ["published"], publishedOnly: true }, 1)).toEqual(["alpha", "triage"]);
      // An archived eval keeps its published pointer, so "has a published version" alone does not hide it.
      expect(await pageAll({ statuses: ["draft", "published", "archived"], publishedOnly: true }, 2)).toEqual([
        "alpha",
        "triage",
        "zeta",
      ]);
    });

    it("pages versions newest first without skipping or repeating one", async () => {
      const company = await seedCompany("Page versions");
      const { eval: record } = await seedEval(company, "page-versions");
      for (let latest = 1; latest < 5; latest += 1) {
        await repo().appendVersion({ companyId: company, evalId: record.id, expectedLatest: latest, version: versionFields() });
      }

      const pages: number[][] = [];
      let beforeNumber: number | undefined;
      for (let guard = 0; guard < 10; guard += 1) {
        const rows = await repo().listVersions(company, record.id, { limit: 2, beforeNumber });
        pages.push(rows.map((row) => row.versionNumber));
        const last = rows[rows.length - 1];
        if (rows.length < 2 || !last) break;
        beforeNumber = last.versionNumber;
      }

      expect(pages).toEqual([[5, 4], [3, 2], [1]]);
    });

    it("pages runs by (created_at, id) when several runs share one timestamp", async () => {
      const idFor = idsIn();
      const company = await seedCompany("Page runs");
      // The run that seedEvalWithRun records sits at T0, older than every run below.
      const { target, run: oldest } = await seedEvalWithRun(company, "page-runs");
      const sibling = await seedEval(company, "page-runs-sibling");
      const shared = at(100);
      // Inserted out of order on purpose. Newest first, ties by id descending:
      // 7, 6 (t=200), 5, 4, 3, 2 (t=100), 1 (t=50), then the oldest run.
      const plan: Array<[number, Date]> = [
        [3, shared],
        [6, at(200)],
        [1, at(50)],
        [4, shared],
        [7, at(200)],
        [2, shared],
        [5, shared],
      ];
      for (const [n, createdAt] of plan) await repo().insertRun(runFields(target, { id: idFor(n), createdAt }));
      // A run of a sibling eval in the same company must not appear.
      await repo().insertRun(
        runFields({ companyId: company, evalId: sibling.eval.id, versionId: sibling.version.id }, { id: idFor(99), createdAt: shared }),
      );
      const expected = [...[7, 6, 5, 4, 3, 2, 1].map(idFor), oldest.id];

      for (const limit of [1, 2, 3, 4, 8, 20]) {
        const seen: string[] = [];
        let after: RunCursor | null = null;
        for (let guard = 0; guard < 20; guard += 1) {
          const rows = await repo().listRuns(company, target.evalId, { filter: {}, limit, after });
          seen.push(...rows.map((row) => row.id));
          const last = rows[rows.length - 1];
          if (rows.length < limit || !last) break;
          after = { at: last.createdAt.toISOString(), id: last.id };
        }
        expect(seen, `limit ${limit}`).toEqual(expected);
        expect(new Set(seen).size).toBe(seen.length);
      }
    });

    it("filters runs by time, version, agent, project, outcome and mode", async () => {
      const idFor = idsIn();
      const company = await seedCompany("Filter runs");
      const agentId = await seedAgent(company);
      const projectId = await seedProject(company);
      const created = await seedEval(company, "filter-runs");
      const v2 = await repo().appendVersion({ companyId: company, evalId: created.eval.id, expectedLatest: 1, version: versionFields() });
      const target: RunTarget = { companyId: company, evalId: created.eval.id, versionId: created.version.id };
      const insert = (n: number, overrides: Partial<NewRunRecord>) => repo().insertRun(runFields(target, { id: idFor(n), ...overrides }));
      await insert(1, { createdAt: at(10) });
      await insert(2, { createdAt: at(20), callerType: "agent", callerUserId: null, callerAgentId: agentId });
      await insert(3, { createdAt: at(30), projectId });
      await insert(4, { createdAt: at(40), outcome: "failed", failureReason: "no_key", answers: null });
      await insert(5, { createdAt: at(50), mode: "try_it" });
      await insert(6, { createdAt: at(60), versionId: v2!.id, versionNumber: 2 });

      async function ids(filter: RunFilter): Promise<number[]> {
        const rows = await repo().listRuns(company, target.evalId, { filter, limit: 50, after: null });
        return rows.map((row) => Number.parseInt(row.id.slice(-12), 16));
      }

      expect(await ids({})).toEqual([6, 5, 4, 3, 2, 1]);
      // The time window includes both of its edges.
      expect(await ids({ from: at(20), to: at(40) })).toEqual([4, 3, 2]);
      expect(await ids({ from: at(55) })).toEqual([6]);
      expect(await ids({ to: at(10) })).toEqual([1]);
      expect(await ids({ versionNumber: 2 })).toEqual([6]);
      expect(await ids({ versionNumber: 1 })).toEqual([5, 4, 3, 2, 1]);
      expect(await ids({ agentId })).toEqual([2]);
      expect(await ids({ projectId })).toEqual([3]);
      expect(await ids({ outcome: "failed" })).toEqual([4]);
      expect(await ids({ mode: "try_it" })).toEqual([5]);
      expect(await ids({ mode: "live", outcome: "answered", from: at(15) })).toEqual([6, 3, 2]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Company isolation
  // ---------------------------------------------------------------------------------------------

  describe("company isolation", () => {
    it("returns nothing, and changes nothing, for the ids of another company", async () => {
      const mine = await seedCompany("Mine");
      const theirs = await seedCompany("Theirs");
      const secret = await seedEvalWithRun(theirs, "secret");
      await repo().appendVersion({ companyId: theirs, evalId: secret.eval.id, expectedLatest: 1, version: versionFields() });
      await repo().upsertFeedback(feedbackFields(secret.run));
      await repo().setPublished(theirs, secret.eval.id, { versionId: secret.version.id, updatedByUserId: null, now: at(1) });
      const before = {
        evalRow: await oneEval(secret.eval.id),
        versions: await versionRows(secret.eval.id),
        runs: await runRows(secret.eval.id),
        feedback: await db.select().from(companyEvalFeedback).where(eq(companyEvalFeedback.runId, secret.run.id)),
      };

      expect(await repo().findEvalBySlug(mine, "secret")).toBeNull();
      expect(await repo().listEvals(mine, { statuses: ["draft", "published", "archived"], publishedOnly: false, limit: 50 })).toEqual([]);
      expect(await repo().getVersionByNumber(mine, secret.eval.id, 1)).toBeNull();
      expect(await repo().getVersionsByIds(mine, [secret.version.id])).toEqual([]);
      expect(await repo().listVersions(mine, secret.eval.id, { limit: 50 })).toEqual([]);
      expect(await repo().listRuns(mine, secret.eval.id, { filter: {}, limit: 50, after: null })).toEqual([]);
      expect(await repo().getRun(mine, secret.eval.id, secret.run.id)).toBeNull();
      expect(await repo().listFeedback(mine, secret.run.id)).toEqual([]);

      expect(await repo().updateEvalMeta(mine, secret.eval.id, { title: "Hijacked", updatedByUserId: "intruder", now: at(5) })).toBeNull();
      expect(
        await repo().appendVersion({ companyId: mine, evalId: secret.eval.id, expectedLatest: 2, version: versionFields() }),
      ).toBeNull();
      expect(await repo().setPublished(mine, secret.eval.id, { versionId: secret.version.id, updatedByUserId: "intruder", now: at(5) })).toBeNull();
      expect(await repo().setArchived(mine, secret.eval.id, { updatedByUserId: "intruder", now: at(5) })).toBeNull();
      expect(await repo().deleteNeverPublished(mine, secret.eval.id)).toBe(false);

      expect({
        evalRow: await oneEval(secret.eval.id),
        versions: await versionRows(secret.eval.id),
        runs: await runRows(secret.eval.id),
        feedback: await db.select().from(companyEvalFeedback).where(eq(companyEvalFeedback.runId, secret.run.id)),
      }).toEqual(before);
    });

    it("keeps each company's evals, runs and feedback in its own lists", async () => {
      const a = await seedCompany("List A");
      const b = await seedCompany("List B");
      const inA = await seedEvalWithRun(a, "shared-name");
      const inB = await seedEvalWithRun(b, "shared-name");
      await repo().upsertFeedback(feedbackFields(inA.run));

      expect((await repo().listEvals(a, { statuses: ["draft"], publishedOnly: false, limit: 50 })).map((row) => row.id)).toEqual([inA.eval.id]);
      expect((await repo().listRuns(a, inA.eval.id, { filter: {}, limit: 50, after: null })).map((row) => row.id)).toEqual([inA.run.id]);
      expect(await repo().listRuns(a, inB.eval.id, { filter: {}, limit: 50, after: null })).toEqual([]);
      expect(await repo().getRun(a, inB.eval.id, inB.run.id)).toBeNull();
      expect(await repo().listFeedback(b, inA.run.id)).toEqual([]);
      expect(await repo().listFeedback(a, inA.run.id)).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Runs
  // ---------------------------------------------------------------------------------------------

  describe("recording runs", () => {
    it("stores an answered run and reads it back exactly, with nested answers and an exact cost", async () => {
      const company = await seedCompany("Answered");
      const agentId = await seedAgent(company);
      const projectId = await seedProject(company);
      const issueId = await seedIssue(company, projectId);
      const heartbeatRunId = await seedHeartbeatRun(company, agentId, { issueId });
      const created = await seedEval(company, "answered");
      const target: RunTarget = { companyId: company, evalId: created.eval.id, versionId: created.version.id };
      const answers: NewRunRecord["answers"] = {
        needs_qa: { type: "predicate", probability: 0.5, value: true, abstained: false },
        depth: {
          type: "choice",
          choice: "full_qa",
          probabilities: { none: 0.05, smoke: 0.25, full_qa: 0.7 },
          confidence: 0.7,
          abstained: false,
        },
        quality: { type: "score", score: null, confidence: null, abstained: true },
        unicode: { type: "choice", choice: "été 日本語", probabilities: null, confidence: 0.123456789012, abstained: false },
      };
      const input = { text: "Ünïcode 日本語 🙂", tags: ["a", "b"], count: 3, nested: { flag: false, nothing: null } };

      const saved = await repo().insertRun(
        runFields(target, {
          callerType: "agent",
          callerUserId: null,
          callerAgentId: agentId,
          heartbeatRunId,
          issueId,
          projectId,
          input,
          inputExpiresAt: at(86_400),
          inputRedacted: true,
          inputRedactionCount: 2,
          inputBytes: 99,
          answers,
          anyAbstained: true,
          cached: true,
          latencyMs: 1_180,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: "0.012345",
          createdAt: at(7),
        }),
      );

      expect(saved).toMatchObject({
        companyId: company,
        callerType: "agent",
        callerAgentId: agentId,
        callerUserId: null,
        heartbeatRunId,
        issueId,
        projectId,
        input,
        inputExpiresAt: at(86_400),
        inputRedacted: true,
        inputRedactionCount: 2,
        inputBytes: 99,
        mode: "live",
        outcome: "answered",
        failureReason: null,
        answers,
        anyAbstained: true,
        cached: true,
        latencyMs: 1_180,
        modelId: "typesafe-ai/jev",
        inputTokens: 0,
        outputTokens: 0,
        costUsd: "0.012345",
        createdAt: at(7),
      });
      expect(await repo().getRun(company, created.eval.id, saved.id)).toEqual(saved);
      const [stored] = await runRows(created.eval.id);
      expect(stored).toEqual(saved);
    });

    it("pads the cost to six places and keeps zero and null apart", async () => {
      const company = await seedCompany("Cost");
      const { target } = await seedEvalWithRun(company, "cost");
      const insert = (costUsd: string | null) => repo().insertRun(runFields(target, { costUsd }));

      expect((await insert("12.5")).costUsd).toBe("12.500000");
      expect((await insert("0.000001")).costUsd).toBe("0.000001");
      expect((await insert("0.000000")).costUsd).toBe("0.000000");
      expect((await insert("999999.999999")).costUsd).toBe("999999.999999");
      expect((await insert(null)).costUsd).toBeNull();
    });

    it("stores a failed run with no answers, no input tokens and no cost", async () => {
      const company = await seedCompany("Failed");
      const { target } = await seedEvalWithRun(company, "failed");

      const saved = await repo().insertRun(
        runFields(target, {
          outcome: "failed",
          failureReason: "cap_exceeded",
          answers: null,
          modelId: null,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          latencyMs: 4_003,
        }),
      );

      expect(saved).toMatchObject({
        outcome: "failed",
        failureReason: "cap_exceeded",
        answers: null,
        anyAbstained: false,
        modelId: null,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        latencyMs: 4_003,
        input: { text: "hello" },
      });
    });

    it("stores a rejected run without input, as a database NULL", async () => {
      const company = await seedCompany("Rejected");
      const { target } = await seedEvalWithRun(company, "rejected");

      const saved = await repo().insertRun(
        runFields(target, {
          outcome: "rejected",
          failureReason: "input_too_large",
          input: null,
          inputExpiresAt: null,
          inputBytes: 40_000,
          answers: null,
          modelId: null,
          inputTokens: null,
          outputTokens: null,
          latencyMs: 0,
        }),
      );

      expect(saved).toMatchObject({
        outcome: "rejected",
        failureReason: "input_too_large",
        input: null,
        inputExpiresAt: null,
        inputBytes: 40_000,
        latencyMs: 0,
        answers: null,
      });
      // A JSON `null` would still count as "not null" for the retention index.
      const rows = await db.execute(sql`SELECT (input IS NULL) AS is_null FROM company_eval_runs WHERE id = ${saved.id}`);
      expect(Array.from(rows).map((row) => Reflect.get(row, "is_null"))).toEqual([true]);
    });

    it("writes caller references only as real rows, and refuses a run of an unknown version", async () => {
      const company = await seedCompany("Refs");
      const { target } = await seedEvalWithRun(company, "refs");

      const unknownAgent = await repo()
        .insertRun(runFields(target, { callerAgentId: randomUUID(), callerType: "agent", callerUserId: null }))
        .catch((error: unknown) => error);
      const unknownVersion = await repo()
        .insertRun(runFields({ ...target, versionId: randomUUID() }))
        .catch((error: unknown) => error);

      expect(unknownAgent).toBeInstanceOf(Error);
      expect(unknownVersion).toBeInstanceOf(Error);
      expect(await runRows(target.evalId)).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Feedback
  // ---------------------------------------------------------------------------------------------

  describe("feedback", () => {
    it("replaces the mark of the same author on the same run and question, keeping its id and creation time", async () => {
      const company = await seedCompany("Replace");
      const { run } = await seedEvalWithRun(company, "replace");

      const first = await repo().upsertFeedback(feedbackFields(run, { verdict: "correct", note: "looks right", now: at(10) }));
      const second = await repo().upsertFeedback(feedbackFields(run, { verdict: "incorrect", note: "on a second look: no", now: at(20) }));
      const third = await repo().upsertFeedback(feedbackFields(run, { verdict: "correct", note: null, now: at(30) }));

      expect(first).toMatchObject({ verdict: "correct", note: "looks right", createdAt: at(10), updatedAt: at(10), questionKey: "" });
      expect(second.id).toBe(first.id);
      expect(second).toMatchObject({ verdict: "incorrect", note: "on a second look: no", createdAt: at(10), updatedAt: at(20) });
      expect(third.id).toBe(first.id);
      // A later mark without a note clears the old note: it is a replacement, not a merge.
      expect(third).toMatchObject({ verdict: "correct", note: null, createdAt: at(10), updatedAt: at(30) });
      expect(await db.select().from(companyEvalFeedback).where(eq(companyEvalFeedback.runId, run.id))).toEqual([third]);
    });

    it("keeps one row per author and one per question", async () => {
      const company = await seedCompany("Rows");
      const agentId = await seedAgent(company);
      const { run } = await seedEvalWithRun(company, "rows");
      const agentMark = { authorType: "agent" as const, authorKey: `agent:${agentId}`, authorAgentId: agentId, authorUserId: null };

      await repo().upsertFeedback(feedbackFields(run, { now: at(1) }));
      await repo().upsertFeedback(feedbackFields(run, { ...agentMark, verdict: "incorrect", now: at(2) }));
      await repo().upsertFeedback(feedbackFields(run, { authorKey: "user:board-2", authorUserId: "board-2", now: at(3) }));
      await repo().upsertFeedback(feedbackFields(run, { questionKey: "needs_qa", now: at(4) }));
      await repo().upsertFeedback(feedbackFields(run, { questionKey: "needs_qa", ...agentMark, now: at(5) }));
      await repo().upsertFeedback(feedbackFields(run, { questionKey: "depth", verdict: "incorrect", now: at(6) }));
      // The same marks again replace and do not add rows.
      await repo().upsertFeedback(feedbackFields(run, { questionKey: "depth", verdict: "correct", now: at(7) }));
      await repo().upsertFeedback(feedbackFields(run, { ...agentMark, verdict: "correct", now: at(8) }));

      const listed = await repo().listFeedback(company, run.id);
      expect(listed.map((row) => [row.questionKey, row.authorKey, row.verdict])).toEqual([
        ["", "user:board-1", "correct"],
        ["", `agent:${agentId}`, "correct"],
        ["", "user:board-2", "correct"],
        ["needs_qa", "user:board-1", "correct"],
        ["needs_qa", `agent:${agentId}`, "correct"],
        ["depth", "user:board-1", "correct"],
      ]);
      expect(listed[1]).toMatchObject({ authorType: "agent", authorAgentId: agentId, authorUserId: null });
      expect(listed[0]).toMatchObject({ authorType: "user", authorAgentId: null, authorUserId: "board-1" });
    });

    it("lists the feedback of one run only, oldest first", async () => {
      const company = await seedCompany("Per run");
      const one = await seedEvalWithRun(company, "per-run-one");
      const other = await seedEvalWithRun(company, "per-run-two");

      await repo().upsertFeedback(feedbackFields(one.run, { questionKey: "late", now: at(9) }));
      await repo().upsertFeedback(feedbackFields(one.run, { questionKey: "early", now: at(1) }));
      await repo().upsertFeedback(feedbackFields(other.run, { questionKey: "elsewhere", now: at(5) }));

      expect((await repo().listFeedback(company, one.run.id)).map((row) => row.questionKey)).toEqual(["early", "late"]);
      expect((await repo().listFeedback(company, other.run.id)).map((row) => row.questionKey)).toEqual(["elsewhere"]);
    });

    it("refuses a mark on a run that does not exist", async () => {
      const company = await seedCompany("Ghost");
      const error = await repo()
        .upsertFeedback(feedbackFields({ id: randomUUID(), companyId: company }))
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Input retention
  // ---------------------------------------------------------------------------------------------

  describe("input retention", () => {
    // The sweep is instance-wide, so every test starts from an empty runs table.
    beforeEach(async () => {
      await db.delete(companyEvalRuns);
    });

    async function storedState(runId: string) {
      const [row] = await db.select().from(companyEvalRuns).where(eq(companyEvalRuns.id, runId));
      if (!row) throw new Error(`run ${runId} does not exist`);
      return row;
    }

    it("clears only expired inputs, and keeps the hash, the size and everything else", async () => {
      const idFor = idsIn();
      const company = await seedCompany("Retention");
      const target = await seedTarget(company, "retention");
      const now = at(1_000);
      const insert = (n: number, overrides: Partial<NewRunRecord>) =>
        repo().insertRun(runFields(target, { id: idFor(n), input: { text: `payload ${n}` }, inputBytes: 100 + n, ...overrides }));
      const expiredLong = await insert(1, { inputExpiresAt: at(-86_400), inputRedacted: true, inputRedactionCount: 3 });
      const expiredAtBoundary = await insert(2, { inputExpiresAt: now });
      const expiredJustNow = await insert(3, { inputExpiresAt: at(999) });
      const unexpired = await insert(4, { inputExpiresAt: at(1_001) });
      const farFuture = await insert(5, { inputExpiresAt: at(30 * 86_400) });
      const notStored = await insert(6, { input: null, inputExpiresAt: null, outcome: "rejected", failureReason: "input_invalid", answers: null });
      const alreadyCleared = await insert(7, { input: null, inputExpiresAt: at(-10) });

      const cleared = await repo().clearExpiredInputs(now, 1_000);

      expect(cleared).toBe(3);
      for (const before of [expiredLong, expiredAtBoundary, expiredJustNow]) {
        expect(await storedState(before.id)).toEqual({ ...before, input: null });
      }
      expect(await storedState(unexpired.id)).toEqual(unexpired);
      expect(await storedState(farFuture.id)).toEqual(farFuture);
      expect(await storedState(notStored.id)).toEqual(notStored);
      expect(await storedState(alreadyCleared.id)).toEqual(alreadyCleared);
      expect(await storedState(expiredLong.id)).toMatchObject({
        inputHash: expiredLong.inputHash,
        inputBytes: 101,
        inputRedacted: true,
        inputRedactionCount: 3,
        inputExpiresAt: at(-86_400),
      });
      // A second sweep finds nothing more.
      expect(await repo().clearExpiredInputs(now, 1_000)).toBe(0);
    });

    it("clears at most one batch per call, oldest expiry first", async () => {
      const idFor = idsIn();
      const company = await seedCompany("Batches");
      const target = await seedTarget(company, "batches");
      const now = at(10_000);
      // Expiry order is the reverse of the id order, so the batch order is not the insert order.
      for (let n = 1; n <= 5; n += 1) {
        await repo().insertRun(runFields(target, { id: idFor(n), inputExpiresAt: at(-n * 60), input: { text: `payload ${n}` } }));
      }
      const hasInput = async (n: number) => (await storedState(idFor(n))).input !== null;

      expect(await repo().clearExpiredInputs(now, 2)).toBe(2);
      expect([await hasInput(1), await hasInput(2), await hasInput(3), await hasInput(4), await hasInput(5)]).toEqual([
        true,
        true,
        true,
        false,
        false,
      ]);
      expect(await repo().clearExpiredInputs(now, 2)).toBe(2);
      expect(await repo().clearExpiredInputs(now, 2)).toBe(1);
      expect(await repo().clearExpiredInputs(now, 2)).toBe(0);
      expect([await hasInput(1), await hasInput(2), await hasInput(3), await hasInput(4), await hasInput(5)]).toEqual([
        false,
        false,
        false,
        false,
        false,
      ]);
    });

    it("sweeps in batches up to a cap, and a later sweep finishes the work", async () => {
      const idFor = idsIn();
      const company = await seedCompany("Sweep");
      const target = await seedTarget(company, "sweep");
      const now = at(10_000);
      for (let n = 1; n <= 5; n += 1) {
        await repo().insertRun(runFields(target, { id: idFor(n), inputExpiresAt: at(-n) }));
      }
      await repo().insertRun(runFields(target, { id: idFor(6), inputExpiresAt: at(86_400) }));
      const sweep = (maxBatches: number) =>
        sweepExpiredEvalInputs({ repo: repo(), runtime: { now: () => now }, batchSize: 2, maxBatches });
      const remaining = async () => (await db.select().from(companyEvalRuns)).filter((row) => row.input !== null).length;

      expect(await sweep(2)).toBe(4);
      expect(await remaining()).toBe(2);
      expect(await sweep(5)).toBe(1);
      expect(await remaining()).toBe(1);
      expect(await sweep(5)).toBe(0);
      expect((await storedState(idFor(6))).input).toEqual({ text: "hello" });
    });

    it("sweeps with the real clock through the module entry point", async () => {
      const idFor = idsIn();
      const company = await seedCompany("Entry point");
      const target = await seedTarget(company, "entry-point");
      await repo().insertRun(runFields(target, { id: idFor(1), inputExpiresAt: new Date("2020-01-01T00:00:00.000Z") }));
      await repo().insertRun(runFields(target, { id: idFor(2), inputExpiresAt: new Date("2099-01-01T00:00:00.000Z") }));

      expect(await createEvalInputRetention(db).sweep()).toBe(1);

      expect((await storedState(idFor(1))).input).toBeNull();
      expect((await storedState(idFor(2))).input).toEqual({ text: "hello" });
    });

    function recordingDb(real: Db) {
      const statements: Array<{ query: string; params: unknown[] }> = [];
      const recorded = drizzle(real.$client, {
        schema: real._.fullSchema,
        logger: { logQuery: (query: string, params: unknown[]) => { statements.push({ query, params }); } },
      });
      return { recorded, statements };
    }

    function literal(value: unknown): string {
      if (value === null || value === undefined) return "null";
      const text = value instanceof Date ? value.toISOString() : String(value);
      return `'${text.replaceAll("'", "''")}'`;
    }

    /** The plan of a statement under `enable_seqscan = off`, so that an unusable index shows as a scan. */
    async function planWithoutSeqScan(statement: { query: string; params: unknown[] }): Promise<string> {
      return db.$client.begin(async (tx) => {
        await tx.unsafe("set local enable_seqscan = off");
        await tx.unsafe(`prepare retention_plan as ${statement.query}`);
        const args = statement.params.map(literal).join(", ");
        const rows = await tx.unsafe(`explain (format json) execute retention_plan${args ? `(${args})` : ""}`);
        await tx.unsafe("deallocate retention_plan");
        return JSON.stringify(rows);
      });
    }

    it("sends a query that the partial expiry index can serve", async () => {
      const { recorded, statements } = recordingDb(db);
      await createPostgresEvalsRepository(recorded).clearExpiredInputs(at(1_000), 500);

      const update = statements.find((statement) => /^update "company_eval_runs"/i.test(statement.query));
      expect(update, "the sweep issues one UPDATE").toBeDefined();
      const plan = await planWithoutSeqScan(update!);
      expect(plan).toContain(EXPIRY_INDEX);

      // Negative control: without `input IS NOT NULL` the partial index cannot be used.
      const withoutPredicate = await planWithoutSeqScan({
        query: "select id from company_eval_runs where input_expires_at <= $1 order by input_expires_at limit $2",
        params: [at(1_000), 500],
      });
      expect(withoutPredicate).not.toContain(EXPIRY_INDEX);
    });

    it("defines the expiry index as partial on rows that still hold an input", async () => {
      const rows = await db.execute(sql`SELECT indexdef FROM pg_indexes WHERE indexname = ${EXPIRY_INDEX}`);
      const [definition] = Array.from(rows).map((row) => String(Reflect.get(row, "indexdef")));
      expect(definition).toContain("(input_expires_at)");
      expect(definition).toMatch(/WHERE \(?input IS NOT NULL\)?/);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Run context: the run id and the issue a caller sends
  // ---------------------------------------------------------------------------------------------

  describe("run context", () => {
    interface World {
      companyA: string;
      companyB: string;
      agentA1: string;
      agentA2: string;
      agentB1: string;
      projectA: string;
      projectB: string;
      issueA: string;
      issueANoProject: string;
      issueB: string;
      runA1: string;
      runA2: string;
      runB1: string;
      runA1NoIssue: string;
      runA1BadIssue: string;
      runA1TaskOnly: string;
      runA1ForeignIssue: string;
      runA1NullContext: string;
    }
    let world!: World;

    beforeAll(async () => {
      const companyA = await seedCompany("Context A");
      const companyB = await seedCompany("Context B");
      const agentA1 = await seedAgent(companyA);
      const agentA2 = await seedAgent(companyA);
      const agentB1 = await seedAgent(companyB);
      const projectA = await seedProject(companyA);
      const projectB = await seedProject(companyB);
      const issueA = await seedIssue(companyA, projectA);
      const issueANoProject = await seedIssue(companyA);
      const issueB = await seedIssue(companyB, projectB);
      world = {
        companyA,
        companyB,
        agentA1,
        agentA2,
        agentB1,
        projectA,
        projectB,
        issueA,
        issueANoProject,
        issueB,
        runA1: await seedHeartbeatRun(companyA, agentA1, { issueId: issueA }),
        runA2: await seedHeartbeatRun(companyA, agentA2, { issueId: issueA }),
        runB1: await seedHeartbeatRun(companyB, agentB1, { issueId: issueB }),
        runA1NoIssue: await seedHeartbeatRun(companyA, agentA1, {}),
        runA1BadIssue: await seedHeartbeatRun(companyA, agentA1, { issueId: "not-a-uuid" }),
        runA1TaskOnly: await seedHeartbeatRun(companyA, agentA1, { taskId: issueA }),
        runA1ForeignIssue: await seedHeartbeatRun(companyA, agentA1, { issueId: issueB }),
        runA1NullContext: await seedHeartbeatRun(companyA, agentA1, null),
      };
    });

    const NOTHING = { heartbeatRunId: null, issueId: null, projectId: null, requestedIssueMissing: false };
    const context = () => createPostgresRunContext(db);
    const agentActor = (agentId: string): EvalActor => ({ type: "agent", agentId });
    const boardActor: EvalActor = { type: "user", userId: "board-1" };

    it("gives the run, its issue and the issue's project for a run of the calling agent", async () => {
      expect(
        await context().verify({ companyId: world.companyA, actor: agentActor(world.agentA1), runId: world.runA1, issueId: null }),
      ).toEqual({
        heartbeatRunId: world.runA1,
        issueId: world.issueA,
        projectId: world.projectA,
        requestedIssueMissing: false,
      });
    });

    it("trusts nothing when the run id is missing, blank or not a UUID, and never fails", async () => {
      const verify = (runId: string | null) =>
        context().verify({ companyId: world.companyA, actor: agentActor(world.agentA1), runId, issueId: null });

      expect(await verify(null)).toEqual(NOTHING);
      expect(await verify("")).toEqual(NOTHING);
      expect(await verify("   ")).toEqual(NOTHING);
      expect(await verify("not-a-uuid")).toEqual(NOTHING);
      expect(await verify("'; DELETE FROM heartbeat_runs; --")).toEqual(NOTHING);
      expect(await verify(world.runA1.replace(/.$/, "g"))).toEqual(NOTHING);
      // A UUID that names no run reads the same.
      expect(await verify(randomUUID())).toEqual(NOTHING);
    });

    it("accepts a run id with surrounding blanks, as the header parser would see it", async () => {
      const verified = await context().verify({
        companyId: world.companyA,
        actor: agentActor(world.agentA1),
        runId: `  ${world.runA1}  `,
        issueId: null,
      });
      expect(verified.heartbeatRunId).toBe(world.runA1);
      expect(verified.issueId).toBe(world.issueA);
    });

    it("drops a run of another company, for an agent and for a board caller, with its issue and project", async () => {
      const asAgent = await context().verify({
        companyId: world.companyA,
        actor: agentActor(world.agentA1),
        runId: world.runB1,
        issueId: null,
      });
      const asBoard = await context().verify({ companyId: world.companyA, actor: boardActor, runId: world.runB1, issueId: null });
      const fromOtherSide = await context().verify({
        companyId: world.companyB,
        actor: boardActor,
        runId: world.runA1,
        issueId: null,
      });

      expect(asAgent).toEqual(NOTHING);
      expect(asBoard).toEqual(NOTHING);
      expect(fromOtherSide).toEqual(NOTHING);
    });

    it("drops a run of another agent of the same company, but lets a board caller name it", async () => {
      const asOtherAgent = await context().verify({
        companyId: world.companyA,
        actor: agentActor(world.agentA2),
        runId: world.runA1,
        issueId: null,
      });
      const asBoard = await context().verify({ companyId: world.companyA, actor: boardActor, runId: world.runA1, issueId: null });

      expect(asOtherAgent).toEqual(NOTHING);
      expect(asBoard).toEqual({
        heartbeatRunId: world.runA1,
        issueId: world.issueA,
        projectId: world.projectA,
        requestedIssueMissing: false,
      });
    });

    it("reads the issue from the run's context only as a UUID under the key issueId, and only inside the company", async () => {
      const verify = (runId: string) =>
        context().verify({ companyId: world.companyA, actor: agentActor(world.agentA1), runId, issueId: null });

      // The run is the caller's, so it is kept, but it names no usable issue.
      for (const runId of [world.runA1NoIssue, world.runA1BadIssue, world.runA1TaskOnly, world.runA1NullContext]) {
        expect(await verify(runId), runId).toEqual({ ...NOTHING, heartbeatRunId: runId });
      }
      // It names an issue of another company, which is not accepted and does not make the call fail.
      expect(await verify(world.runA1ForeignIssue)).toEqual({ ...NOTHING, heartbeatRunId: world.runA1ForeignIssue });
    });

    it("takes an issue from the body in the same company, with that issue's project, instead of the run's", async () => {
      const withProject = await context().verify({
        companyId: world.companyA,
        actor: boardActor,
        runId: null,
        issueId: world.issueA,
      });
      const withoutProject = await context().verify({
        companyId: world.companyA,
        actor: agentActor(world.agentA1),
        runId: world.runA1,
        issueId: world.issueANoProject,
      });

      expect(withProject).toEqual({ heartbeatRunId: null, issueId: world.issueA, projectId: world.projectA, requestedIssueMissing: false });
      // The body wins over the run's issue, and the project is the body issue's, not the run issue's.
      expect(withoutProject).toEqual({
        heartbeatRunId: world.runA1,
        issueId: world.issueANoProject,
        projectId: null,
        requestedIssueMissing: false,
      });
    });

    it("reports an issue of another company, or an unknown one, as missing and does not fall back to the run's issue", async () => {
      const foreign = await context().verify({
        companyId: world.companyA,
        actor: agentActor(world.agentA1),
        runId: world.runA1,
        issueId: world.issueB,
      });
      const unknown = await context().verify({
        companyId: world.companyA,
        actor: boardActor,
        runId: null,
        issueId: randomUUID(),
      });

      // The run is verified (it is the agent's), but the issue and its project are not taken from anywhere.
      expect(foreign).toEqual({ heartbeatRunId: world.runA1, issueId: null, projectId: null, requestedIssueMissing: true });
      expect(unknown).toEqual({ heartbeatRunId: null, issueId: null, projectId: null, requestedIssueMissing: true });
    });
  });
});
