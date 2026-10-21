import { createHash, randomUUID } from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { HttpError } from "../errors.js";
import { companyService } from "../services/companies.js";
import {
  assertNoCrossCompanyReferences,
  COMPANY_DELETE_CROSS_COMPANY_REFERENCES,
  CROSS_COMPANY_REFERENCES,
} from "../services/company-removal-cross-company.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping company evals removal tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const T0 = new Date("2031-02-03T04:05:06.000Z");

const INPUT_SCHEMA: CompanyEvalInputSchema = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
};

const QUESTIONS: CompanyEvalQuestions = {
  needs_qa: { type: "predicate", instructions: "Does this change need a QA pass?" },
};

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The rows that one company has in the four eval tables, in a fixed order. */
interface EvalRows {
  evals: Array<typeof companyEvals.$inferSelect>;
  versions: Array<typeof companyEvalVersions.$inferSelect>;
  runs: Array<typeof companyEvalRuns.$inferSelect>;
  feedback: Array<typeof companyEvalFeedback.$inferSelect>;
}

const NO_EVAL_ROWS: EvalRows = { evals: [], versions: [], runs: [], feedback: [] };

/** One company with the rows that an eval run can point at. */
interface Tenant {
  companyId: string;
  /** The agent that calls evals. It owns no heartbeat run, so a test can delete it alone. */
  agentId: string;
  /** The agent that owns the heartbeat run. */
  runnerAgentId: string;
  projectId: string;
  issueId: string;
  heartbeatRunId: string;
}

interface EvalGraph {
  evalId: string;
  versionIds: string[];
  linkedRunId: string;
  rejectedRunId: string;
  userRunId: string;
  feedbackIds: string[];
}

describeEmbeddedPostgres("company evals and company removal", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-evals-removal-");
    db = createDb(tempDb.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(companyId: string, label: string): Promise<string> {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: `${label} ${id.slice(0, 8)}`,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  async function seedTenant(label: string): Promise<Tenant> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `${label} ${companyId}`,
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 8).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const agentId = await seedAgent(companyId, "Caller");
    const runnerAgentId = await seedAgent(companyId, "Runner");
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: `Project ${label}` });
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: `Issue ${label}`, status: "todo" });
    const heartbeatRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: heartbeatRunId,
      companyId,
      agentId: runnerAgentId,
      invocationSource: "assignment",
      status: "completed",
      contextSnapshot: { issueId },
    });
    return { companyId, agentId, runnerAgentId, projectId, issueId, heartbeatRunId };
  }

  /**
   * A published eval with two versions, a run that points at the agent, the heartbeat run, the
   * issue and the project of the tenant, a rejected run, a run of a board user, and three marks.
   */
  async function seedEvalGraph(tenant: Tenant, slug: string): Promise<EvalGraph> {
    const { companyId } = tenant;
    const evalId = randomUUID();
    const versionIds = [randomUUID(), randomUUID()];
    await db.insert(companyEvals).values({
      id: evalId,
      companyId,
      slug,
      title: `Eval ${slug}`,
      whenToUse: "Use it when a pull request changes the UI.",
      status: "draft",
      latestVersionNumber: 2,
      createdByUserId: "user-1",
      updatedByUserId: "user-1",
      createdAt: T0,
      updatedAt: T0,
    });
    await db.insert(companyEvalVersions).values(
      versionIds.map((id, index) => ({
        id,
        companyId,
        evalId,
        versionNumber: index + 1,
        inputSchema: INPUT_SCHEMA,
        questions: QUESTIONS,
        definitionHash: sha(`definition:${id}`),
        changeNote: null,
        createdByUserId: "user-1",
        createdAt: T0,
      })),
    );
    await db
      .update(companyEvals)
      .set({ status: "published", publishedVersionId: versionIds[1], publishedAt: T0 })
      .where(eq(companyEvals.id, evalId));

    const linkedRunId = randomUUID();
    const rejectedRunId = randomUUID();
    const userRunId = randomUUID();
    const base = {
      companyId,
      evalId,
      versionId: versionIds[1] ?? "",
      versionNumber: 2,
      inputRedacted: false,
      inputRedactionCount: 0,
      inputBytes: 18,
      mode: "live",
      anyAbstained: false,
      cached: false,
      createdAt: T0,
    } as const;
    await db.insert(companyEvalRuns).values([
      {
        ...base,
        id: linkedRunId,
        callerType: "agent",
        callerAgentId: tenant.agentId,
        callerUserId: null,
        heartbeatRunId: tenant.heartbeatRunId,
        issueId: tenant.issueId,
        projectId: tenant.projectId,
        inputHash: sha(`input:${linkedRunId}`),
        input: { text: "hello" },
        inputExpiresAt: new Date(T0.getTime() + 86_400_000),
        outcome: "answered",
        answers: { needs_qa: { type: "predicate", probability: 0.9, value: true, abstained: false } },
        latencyMs: 120,
        modelId: "typesafe-ai/jev",
        inputTokens: 10,
        outputTokens: 2,
        costUsd: "0.000100",
      },
      {
        ...base,
        id: rejectedRunId,
        callerType: "agent",
        callerAgentId: tenant.agentId,
        callerUserId: null,
        inputHash: sha(`input:${rejectedRunId}`),
        input: null,
        outcome: "rejected",
        failureReason: "input_invalid",
        latencyMs: 0,
      },
      {
        ...base,
        id: userRunId,
        callerType: "user",
        callerAgentId: null,
        callerUserId: "user-1",
        inputHash: sha(`input:${userRunId}`),
        input: { text: "from a board user" },
        outcome: "answered",
        answers: { needs_qa: { type: "predicate", probability: 0.2, value: false, abstained: false } },
        latencyMs: 90,
      },
    ]);
    const feedbackIds = [randomUUID(), randomUUID(), randomUUID()];
    await db.insert(companyEvalFeedback).values([
      {
        id: feedbackIds[0],
        companyId,
        runId: linkedRunId,
        questionKey: "",
        verdict: "correct",
        authorType: "agent",
        authorKey: `agent:${tenant.agentId}`,
        authorAgentId: tenant.agentId,
        authorUserId: null,
        createdAt: T0,
        updatedAt: T0,
      },
      {
        id: feedbackIds[1],
        companyId,
        runId: linkedRunId,
        questionKey: "needs_qa",
        verdict: "incorrect",
        note: "Wrong on the second look",
        authorType: "user",
        authorKey: "user:board-1",
        authorAgentId: null,
        authorUserId: "board-1",
        createdAt: T0,
        updatedAt: T0,
      },
      {
        id: feedbackIds[2],
        companyId,
        runId: userRunId,
        questionKey: "",
        verdict: "correct",
        authorType: "user",
        authorKey: "user:board-1",
        authorAgentId: null,
        authorUserId: "board-1",
        createdAt: T0,
        updatedAt: T0,
      },
    ]);
    return { evalId, versionIds, linkedRunId, rejectedRunId, userRunId, feedbackIds };
  }

  async function evalRows(companyId: string): Promise<EvalRows> {
    return {
      evals: await db.select().from(companyEvals).where(eq(companyEvals.companyId, companyId)).orderBy(asc(companyEvals.id)),
      versions: await db.select().from(companyEvalVersions).where(eq(companyEvalVersions.companyId, companyId)).orderBy(asc(companyEvalVersions.id)),
      runs: await db.select().from(companyEvalRuns).where(eq(companyEvalRuns.companyId, companyId)).orderBy(asc(companyEvalRuns.id)),
      feedback: await db.select().from(companyEvalFeedback).where(eq(companyEvalFeedback.companyId, companyId)).orderBy(asc(companyEvalFeedback.id)),
    };
  }

  async function companyExists(companyId: string): Promise<boolean> {
    return (await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId))).length === 1;
  }

  async function removalFailure(companyId: string): Promise<unknown> {
    return companyService(db)
      .remove(companyId)
      .then(
        () => null,
        (error: unknown) => error,
      );
  }

  // ---------------------------------------------------------------------------------------------
  // Removing a company
  // ---------------------------------------------------------------------------------------------

  describe("removing a company", () => {
    it("lists the five eval references that can reach another company's rows", () => {
      const evalReferences = CROSS_COMPANY_REFERENCES.filter((reference) => reference.child.startsWith("company_eval"))
        .map((reference) => `${reference.child}.${reference.column} -> ${reference.parent}`)
        .sort();

      expect(evalReferences).toEqual([
        "company_eval_feedback.author_agent_id -> agents",
        "company_eval_runs.caller_agent_id -> agents",
        "company_eval_runs.heartbeat_run_id -> heartbeat_runs",
        "company_eval_runs.issue_id -> issues",
        "company_eval_runs.project_id -> projects",
      ]);
    });

    it("leaves no eval row of the company, keeps every eval row of another company, and passes the cross-company check", async () => {
      const doomed = await seedTenant("Doomed");
      const kept = await seedTenant("Kept");
      const doomedGraph = await seedEvalGraph(doomed, "pr-needs-qa");
      await seedEvalGraph(doomed, "second-eval");
      // The same slug in the other company is a different eval.
      await seedEvalGraph(kept, "pr-needs-qa");
      const doomedBefore = await evalRows(doomed.companyId);
      const keptBefore = await evalRows(kept.companyId);
      expect(doomedBefore.evals).toHaveLength(2);
      expect(doomedBefore.versions).toHaveLength(4);
      expect(doomedBefore.runs).toHaveLength(6);
      expect(doomedBefore.feedback).toHaveLength(6);
      expect(keptBefore.runs).toHaveLength(3);
      // The runs point at the agent, the heartbeat run, the issue and the project that go with the company.
      expect(doomedBefore.runs.filter((run) => run.heartbeatRunId === doomed.heartbeatRunId)).toHaveLength(2);

      await expect(assertNoCrossCompanyReferences(db, doomed.companyId)).resolves.toBeUndefined();
      const removed = await companyService(db).remove(doomed.companyId);

      expect(removed).toMatchObject({ id: doomed.companyId });
      expect(await companyExists(doomed.companyId)).toBe(false);
      expect(await evalRows(doomed.companyId)).toEqual(NO_EVAL_ROWS);
      // Nothing is left that points at a row of the removed eval, under any company.
      expect(await db.select({ id: companyEvalVersions.id }).from(companyEvalVersions).where(eq(companyEvalVersions.evalId, doomedGraph.evalId))).toEqual([]);
      expect(await db.select({ id: companyEvalRuns.id }).from(companyEvalRuns).where(eq(companyEvalRuns.evalId, doomedGraph.evalId))).toEqual([]);
      expect(await db.select({ id: companyEvalFeedback.id }).from(companyEvalFeedback).where(inArray(companyEvalFeedback.runId, [doomedGraph.linkedRunId, doomedGraph.userRunId]))).toEqual([]);
      expect(await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, doomed.companyId))).toEqual([]);
      // The other company is exactly as it was: its rows, its references and its company row.
      expect(await evalRows(kept.companyId)).toEqual(keptBefore);
      expect(await companyExists(kept.companyId)).toBe(true);
      await expect(assertNoCrossCompanyReferences(db, kept.companyId)).resolves.toBeUndefined();
    });

    it("removes a company whose evals are only drafts, and a company without evals", async () => {
      const draftOnly = await seedTenant("Draft only");
      const empty = await seedTenant("Empty");
      const evalId = randomUUID();
      const versionId = randomUUID();
      await db.insert(companyEvals).values({
        id: evalId,
        companyId: draftOnly.companyId,
        slug: "draft",
        title: "Draft",
        whenToUse: "Use it when you draft.",
        status: "draft",
        latestVersionNumber: 1,
      });
      await db.insert(companyEvalVersions).values({
        id: versionId,
        companyId: draftOnly.companyId,
        evalId,
        versionNumber: 1,
        inputSchema: INPUT_SCHEMA,
        questions: QUESTIONS,
        definitionHash: sha("draft"),
      });

      await companyService(db).remove(draftOnly.companyId);
      await companyService(db).remove(empty.companyId);

      expect(await companyExists(draftOnly.companyId)).toBe(false);
      expect(await companyExists(empty.companyId)).toBe(false);
      expect(await evalRows(draftOnly.companyId)).toEqual(NO_EVAL_ROWS);
      expect(await db.select({ id: companyEvals.id }).from(companyEvals).where(eq(companyEvals.id, evalId))).toEqual([]);
      expect(await db.select({ id: companyEvalVersions.id }).from(companyEvalVersions).where(eq(companyEvalVersions.id, versionId))).toEqual([]);
    });

    it("removes a company whose evals were already cleaned of their input by the retention job", async () => {
      const tenant = await seedTenant("Purged");
      const graph = await seedEvalGraph(tenant, "purged");
      await db.update(companyEvalRuns).set({ input: null }).where(eq(companyEvalRuns.evalId, graph.evalId));

      await companyService(db).remove(tenant.companyId);

      expect(await evalRows(tenant.companyId)).toEqual(NO_EVAL_ROWS);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // A row of another company that points at this company
  // ---------------------------------------------------------------------------------------------

  describe("an eval row of another company that points at a row of the company that is removed", () => {
    interface Pointer {
      table: string;
      /** Points a row of the eval graph of `other` at a row of `doomed`. */
      point: (other: Tenant, otherGraph: EvalGraph, doomed: Tenant) => Promise<void>;
      /** Clears that pointer again. */
      clear: (otherGraph: EvalGraph) => Promise<void>;
    }

    const pointers: Array<[string, Pointer]> = [
      [
        "caller_agent_id of a run",
        {
          table: "company_eval_runs",
          point: async (_other, graph, doomed) => {
            await db.update(companyEvalRuns).set({ callerAgentId: doomed.agentId }).where(eq(companyEvalRuns.id, graph.userRunId));
          },
          clear: async (graph) => {
            await db.update(companyEvalRuns).set({ callerAgentId: null }).where(eq(companyEvalRuns.id, graph.userRunId));
          },
        },
      ],
      [
        "heartbeat_run_id of a run",
        {
          table: "company_eval_runs",
          point: async (_other, graph, doomed) => {
            await db.update(companyEvalRuns).set({ heartbeatRunId: doomed.heartbeatRunId }).where(eq(companyEvalRuns.id, graph.userRunId));
          },
          clear: async (graph) => {
            await db.update(companyEvalRuns).set({ heartbeatRunId: null }).where(eq(companyEvalRuns.id, graph.userRunId));
          },
        },
      ],
      [
        "issue_id of a run",
        {
          table: "company_eval_runs",
          point: async (_other, graph, doomed) => {
            await db.update(companyEvalRuns).set({ issueId: doomed.issueId }).where(eq(companyEvalRuns.id, graph.userRunId));
          },
          clear: async (graph) => {
            await db.update(companyEvalRuns).set({ issueId: null }).where(eq(companyEvalRuns.id, graph.userRunId));
          },
        },
      ],
      [
        "project_id of a run",
        {
          table: "company_eval_runs",
          point: async (_other, graph, doomed) => {
            await db.update(companyEvalRuns).set({ projectId: doomed.projectId }).where(eq(companyEvalRuns.id, graph.userRunId));
          },
          clear: async (graph) => {
            await db.update(companyEvalRuns).set({ projectId: null }).where(eq(companyEvalRuns.id, graph.userRunId));
          },
        },
      ],
      [
        "author_agent_id of a mark",
        {
          table: "company_eval_feedback",
          point: async (_other, graph, doomed) => {
            await db.update(companyEvalFeedback).set({ authorAgentId: doomed.agentId }).where(eq(companyEvalFeedback.id, graph.feedbackIds[2] ?? ""));
          },
          clear: async (graph) => {
            await db.update(companyEvalFeedback).set({ authorAgentId: null }).where(eq(companyEvalFeedback.id, graph.feedbackIds[2] ?? ""));
          },
        },
      ],
    ];

    it.each(pointers)("refuses the removal and changes nothing while %s points at it", async (_label, pointer) => {
      const doomed = await seedTenant("Referenced");
      const other = await seedTenant("Referencing");
      await seedEvalGraph(doomed, "own-eval");
      const otherGraph = await seedEvalGraph(other, "other-eval");
      await pointer.point(other, otherGraph, doomed);
      const doomedBefore = await evalRows(doomed.companyId);
      const otherBefore = await evalRows(other.companyId);

      const failure = await removalFailure(doomed.companyId);

      if (!(failure instanceof HttpError)) throw new Error("the removal should have been refused");
      expect(failure.status).toBe(409);
      expect(failure.details).toMatchObject({
        code: COMPANY_DELETE_CROSS_COMPANY_REFERENCES,
        references: [{ table: pointer.table, count: 1 }],
      });
      // The refusal names a table and a count, and no id of any row.
      expect(JSON.stringify({ message: failure.message, details: failure.details })).not.toMatch(UUID_PATTERN);
      expect(await evalRows(doomed.companyId)).toEqual(doomedBefore);
      expect(await evalRows(other.companyId)).toEqual(otherBefore);
      expect(await companyExists(doomed.companyId)).toBe(true);
      expect(await companyExists(other.companyId)).toBe(true);
      await expect(db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, doomed.companyId))).resolves.toHaveLength(2);

      // Once the other company no longer points at it, the company goes, and the other company stays whole.
      await pointer.clear(otherGraph);
      const otherCleared = await evalRows(other.companyId);
      await companyService(db).remove(doomed.companyId);

      expect(await companyExists(doomed.companyId)).toBe(false);
      expect(await evalRows(doomed.companyId)).toEqual(NO_EVAL_ROWS);
      expect(await evalRows(other.companyId)).toEqual(otherCleared);
    });

    it("counts each referencing row once, for each table", async () => {
      const doomed = await seedTenant("Referenced twice");
      const other = await seedTenant("Referencing twice");
      const otherGraph = await seedEvalGraph(other, "other-eval");
      // One run points at four rows of the company, and two marks point at its agent.
      await db
        .update(companyEvalRuns)
        .set({ callerAgentId: doomed.agentId, heartbeatRunId: doomed.heartbeatRunId, issueId: doomed.issueId, projectId: doomed.projectId })
        .where(eq(companyEvalRuns.id, otherGraph.userRunId));
      await db.update(companyEvalFeedback).set({ authorAgentId: doomed.agentId }).where(inArray(companyEvalFeedback.id, otherGraph.feedbackIds.slice(1)));

      const failure = await removalFailure(doomed.companyId);

      if (!(failure instanceof HttpError)) throw new Error("the removal should have been refused");
      expect(failure.status).toBe(409);
      expect(failure.details).toMatchObject({
        code: COMPANY_DELETE_CROSS_COMPANY_REFERENCES,
        references: [
          { table: "company_eval_feedback", count: 2 },
          { table: "company_eval_runs", count: 1 },
        ],
      });
      expect(await companyExists(doomed.companyId)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Deleting a row that a run points at
  // ---------------------------------------------------------------------------------------------

  describe("deleting a row that an eval run points at", () => {
    type Reference = "callerAgentId" | "heartbeatRunId" | "issueId" | "projectId";

    const deletions: Array<[string, Reference, (tenant: Tenant) => Promise<unknown>]> = [
      ["an agent", "callerAgentId", (tenant) => db.delete(agents).where(eq(agents.id, tenant.agentId))],
      ["a heartbeat run", "heartbeatRunId", (tenant) => db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, tenant.heartbeatRunId))],
      ["an issue", "issueId", (tenant) => db.delete(issues).where(eq(issues.id, tenant.issueId))],
      ["a project", "projectId", (tenant) => db.delete(projects).where(eq(projects.id, tenant.projectId))],
    ];

    it.each(deletions)("keeps the run and clears its reference when %s is deleted", async (_label, reference, deleteRow) => {
      const tenant = await seedTenant("Deleting");
      const graph = await seedEvalGraph(tenant, "kept-runs");
      const bystander = await seedTenant("Bystander");
      await seedEvalGraph(bystander, "kept-runs");
      const before = await evalRows(tenant.companyId);
      const bystanderBefore = await evalRows(bystander.companyId);

      await deleteRow(tenant);

      const after = await evalRows(tenant.companyId);
      // Every row is still there: the audit record of a call outlives the thing that it pointed at.
      expect(after.evals).toEqual(before.evals);
      expect(after.versions).toEqual(before.versions);
      expect(after.runs.map((run) => run.id)).toEqual(before.runs.map((run) => run.id));
      expect(after.feedback.map((mark) => mark.id)).toEqual(before.feedback.map((mark) => mark.id));
      // Only that one reference changed, on the rows that held it.
      const expectedRuns = before.runs.map((run) => (run[reference] === null ? run : { ...run, [reference]: null }));
      expect(after.runs).toEqual(expectedRuns);
      const cleared = after.runs.find((run) => run.id === graph.linkedRunId);
      expect(cleared?.[reference]).toBeNull();
      expect(cleared).toMatchObject({ input: { text: "hello" }, outcome: "answered", costUsd: "0.000100", versionNumber: 2 });
      // A mark by a deleted agent stays, and still says who it was from.
      const expectedMarks = before.feedback.map((mark) => (reference === "callerAgentId" && mark.authorAgentId !== null ? { ...mark, authorAgentId: null } : mark));
      expect(after.feedback).toEqual(expectedMarks);
      expect(after.feedback.find((mark) => mark.id === graph.feedbackIds[0])).toMatchObject({
        authorType: "agent",
        authorKey: `agent:${tenant.agentId}`,
        verdict: "correct",
      });
      // The rows of another company do not change.
      expect(await evalRows(bystander.companyId)).toEqual(bystanderBefore);
    });

    it("clears every reference of a run in turn, and the run stays", async () => {
      const tenant = await seedTenant("Deleting all");
      const graph = await seedEvalGraph(tenant, "kept-runs");

      for (const [, , deleteRow] of deletions) await deleteRow(tenant);

      const [run] = await db.select().from(companyEvalRuns).where(eq(companyEvalRuns.id, graph.linkedRunId));
      expect(run).toMatchObject({
        callerAgentId: null,
        heartbeatRunId: null,
        issueId: null,
        projectId: null,
        callerType: "agent",
        input: { text: "hello" },
        outcome: "answered",
      });
      expect((await evalRows(tenant.companyId)).runs).toHaveLength(3);
    });

    it("deletes the runs and the marks of an eval with the eval, and no other eval's", async () => {
      const tenant = await seedTenant("Deleting an eval");
      const gone = await seedEvalGraph(tenant, "gone");
      const stays = await seedEvalGraph(tenant, "stays");
      const staysBefore = (await evalRows(tenant.companyId)).runs.filter((run) => run.evalId === stays.evalId);

      await db.delete(companyEvals).where(eq(companyEvals.id, gone.evalId));

      const after = await evalRows(tenant.companyId);
      expect(after.evals.map((row) => row.id)).toEqual([stays.evalId]);
      expect(after.versions.map((row) => row.evalId)).toEqual([stays.evalId, stays.evalId]);
      expect(after.runs.filter((run) => run.evalId === gone.evalId)).toEqual([]);
      expect(after.runs.filter((run) => run.evalId === stays.evalId)).toEqual(staysBefore);
      expect(after.feedback.map((mark) => mark.runId).sort()).toEqual([stays.linkedRunId, stays.linkedRunId, stays.userRunId].sort());
    });
  });
});
