import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
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
import type {
  CompanyEvalAgentView,
  CompanyEvalDetail,
  CompanyEvalFeedback,
  CompanyEvalPage,
  CompanyEvalRun,
  CompanyEvalRunDetail,
  CompanyEvalRunResult,
  CompanyEvalVersion,
} from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import { canonicalJson } from "../modules/evals/domain/canonical.js";
import { createEvalsModule, type EvalsService } from "../modules/evals/index.js";
import { redactSensitiveText } from "../redaction.js";
import { companyEvalRoutes } from "../routes/company-evals.js";
import { createJudgeClient, type JudgeTransport, type RawDecision } from "../services/judge-client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping company evals route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Actor = Express.Request["actor"];
type Req = request.Test;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_INPUT_BYTES = 32_768;

/** A fake gateway key. It is assembled here so that no scanner reads it as a real credential. */
const FAKE_GATEWAY_KEY = ["fake", "gateway", "key", "for", "evals", "tests"].join("-");
/** Text that must never reach a log, a response, an activity entry or a rejected run. */
const INPUT_CANARY = ["input", "canary", "do", "not", "keep"].join("-");
const NOTE_CANARY = ["note", "canary", "do", "not", "log"].join("-");

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", maxLength: 200, description: "The pull request title" },
    files: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 10 },
    lines: { type: "integer", minimum: 0 },
  },
  required: ["title"],
} as const;

const QUESTIONS = {
  needs_qa: { type: "predicate", instructions: "Does this pull request need a QA pass?" },
  qa_depth: {
    type: "choice",
    instructions: "How deep should the QA pass be?",
    options: { none: "No QA", smoke: "A smoke test", full_qa: "A full QA pass" },
  },
} as const;

function definitionBody(slug: string, overrides: Record<string, unknown> = {}) {
  return {
    slug,
    title: `Eval ${slug}`,
    whenToUse: "Use it when you review a pull request and must decide on QA.",
    inputSchema: INPUT_SCHEMA,
    questions: QUESTIONS,
    ...overrides,
  };
}

function versionBody(overrides: Record<string, unknown> = {}) {
  return { inputSchema: INPUT_SCHEMA, questions: QUESTIONS, ...overrides };
}

/** The same questions with different wording, so that its definition hash differs. */
const REWORDED_QUESTIONS = {
  ...QUESTIONS,
  needs_qa: { type: "predicate", instructions: "Would a reviewer ask for a QA pass here?" },
} as const;

function decision(): RawDecision {
  return {
    answers: {
      needs_qa: { type: "boolean", probability: 0.91 },
      qa_depth: { type: "choice", choice: "smoke", probabilities: { none: 0.05, smoke: 0.71, full_qa: 0.24 } },
    },
    modelId: "typesafe-ai/jev-test",
    confidence: { qa_depth: 0.71 },
    usage: { inputTokens: 123, outputTokens: 4 },
    costUsd: 0.000321,
  };
}

function boardOf(companyId: string, options: { userId?: string; role?: string } = {}): Actor {
  return {
    type: "board",
    userId: options.userId ?? "board-user",
    source: "session",
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: options.role ?? "owner", status: "active" }],
    isInstanceAdmin: false,
  };
}

function agentOf(companyId: string, agentId: string, extra: Partial<Actor> = {}): Actor {
  return { type: "agent", agentId, companyId, source: "agent_key", ...extra };
}

describeEmbeddedPostgres("company evals over HTTP on a real database", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const gatewayKeys = new Map<string, string>();
  const gate = { capAvailable: true };
  const transport = vi.fn<JudgeTransport>(async () => decision());
  const judge = createJudgeClient({
    config: { timeoutMs: 5_000, dailyCallCap: 100, zeroDataRetention: false },
    usage: { reserve: async () => gate.capAvailable },
    resolveApiKey: async (companyId) => gatewayKeys.get(companyId),
    transportFor: () => transport,
  });
  let evals!: EvalsService;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-evals-routes-");
    db = createDb(tempDb.connectionString);
    evals = createEvalsModule({ db, judge, settings: { inputRetentionDays: 30 } });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  beforeEach(() => {
    transport.mockReset();
    transport.mockImplementation(async () => decision());
    gate.capAvailable = true;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // ---------------------------------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------------------------------

  async function seedCompany(label: string): Promise<string> {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: `${label} ${id}`,
      issuePrefix: `V${id.replace(/-/g, "").slice(0, 8).toUpperCase()}`,
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

  interface World {
    companyA: string;
    companyB: string;
    agentA1: string;
    agentA2: string;
    agentB1: string;
    projectA: string;
    issueA: string;
    issueB: string;
    /** A heartbeat run of agent A1 that works on `issueA`. */
    runA1: string;
    /** A heartbeat run of agent B1 in the other company. */
    runB1: string;
  }

  async function seedWorld(options: { gatewayKey?: boolean } = {}): Promise<World> {
    const companyA = await seedCompany("Evals A");
    const companyB = await seedCompany("Evals B");
    const agentA1 = await seedAgent(companyA);
    const agentA2 = await seedAgent(companyA);
    const agentB1 = await seedAgent(companyB);
    const projectA = randomUUID();
    const projectB = randomUUID();
    await db.insert(projects).values([
      { id: projectA, companyId: companyA, name: "Project A" },
      { id: projectB, companyId: companyB, name: "Project B" },
    ]);
    const issueA = randomUUID();
    const issueB = randomUUID();
    await db.insert(issues).values([
      { id: issueA, companyId: companyA, title: "Issue A", status: "todo", projectId: projectA },
      { id: issueB, companyId: companyB, title: "Issue B", status: "todo", projectId: projectB },
    ]);
    const runA1 = randomUUID();
    const runB1 = randomUUID();
    await db.insert(heartbeatRuns).values([
      { id: runA1, companyId: companyA, agentId: agentA1, invocationSource: "assignment", status: "completed", contextSnapshot: { issueId: issueA } },
      { id: runB1, companyId: companyB, agentId: agentB1, invocationSource: "assignment", status: "completed", contextSnapshot: { issueId: issueB } },
    ]);
    if (options.gatewayKey ?? true) {
      gatewayKeys.set(companyA, FAKE_GATEWAY_KEY);
      gatewayKeys.set(companyB, FAKE_GATEWAY_KEY);
    }
    return { companyA, companyB, agentA1, agentA2, agentB1, projectA, issueA, issueB, runA1, runB1 };
  }

  function appFor(actor: Actor, service: EvalsService = evals): express.Express {
    const app = express();
    app.use(express.json());
    // The auth middleware copies this header into the actor without checking it.
    app.use((req, _res, next) => {
      const runId = req.header("x-paperclip-run-id");
      req.actor = runId ? { ...actor, runId } : actor;
      next();
    });
    app.use("/api", companyEvalRoutes(db, service));
    app.use(errorHandler);
    return app;
  }

  function clientFor(actor: Actor, companyId: string, service: EvalsService = evals) {
    const app = appFor(actor, service);
    const base = `/api/companies/${companyId}/evals`;
    return {
      list: (query = ""): Req => request(app).get(`${base}${query}`),
      create: (body: unknown): Req => request(app).post(base).send(body as object),
      get: (slug: string): Req => request(app).get(`${base}/${slug}`),
      patch: (slug: string, body: unknown): Req => request(app).patch(`${base}/${slug}`).send(body as object),
      remove: (slug: string): Req => request(app).delete(`${base}/${slug}`),
      versions: (slug: string, query = ""): Req => request(app).get(`${base}/${slug}/versions${query}`),
      createVersion: (slug: string, body: unknown): Req => request(app).post(`${base}/${slug}/versions`).send(body as object),
      version: (slug: string, versionNumber: number | string): Req => request(app).get(`${base}/${slug}/versions/${versionNumber}`),
      publish: (slug: string, body: unknown = {}): Req => request(app).post(`${base}/${slug}/publish`).send(body as object),
      archive: (slug: string): Req => request(app).post(`${base}/${slug}/archive`).send({}),
      run: (slug: string, body: unknown, headers: Record<string, string> = {}): Req =>
        request(app).post(`${base}/${slug}/runs`).set(headers).send(body as object),
      runs: (slug: string, query = ""): Req => request(app).get(`${base}/${slug}/runs${query}`),
      getRun: (slug: string, runId: string): Req => request(app).get(`${base}/${slug}/runs/${runId}`),
      feedback: (slug: string, runId: string, body: unknown): Req =>
        request(app).put(`${base}/${slug}/runs/${runId}/feedback`).send(body as object),
    };
  }

  type Client = ReturnType<typeof clientFor>;

  /** A board client and an agent client for company A, and the board client of company B. */
  function clientsFor(world: World) {
    return {
      board: clientFor(boardOf(world.companyA), world.companyA),
      agent1: clientFor(agentOf(world.companyA, world.agentA1), world.companyA),
      agent2: clientFor(agentOf(world.companyA, world.agentA2), world.companyA),
      boardB: clientFor(boardOf(world.companyB, { userId: "board-b" }), world.companyB),
    };
  }

  async function createEval(board: Client, slug: string, overrides: Record<string, unknown> = {}): Promise<CompanyEvalDetail> {
    const res = await board.create(definitionBody(slug, overrides));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
  }

  async function createPublishedEval(board: Client, slug: string): Promise<CompanyEvalDetail> {
    await createEval(board, slug);
    const res = await board.publish(slug);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  }

  async function activityOf(companyId: string) {
    return db
      .select({
        action: activityLog.action,
        entityType: activityLog.entityType,
        entityId: activityLog.entityId,
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        agentId: activityLog.agentId,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId))
      .orderBy(asc(activityLog.createdAt));
  }

  async function versionsOf(evalId: string) {
    return db.select().from(companyEvalVersions).where(eq(companyEvalVersions.evalId, evalId));
  }

  async function runsOf(evalId: string) {
    return db.select().from(companyEvalRuns).where(eq(companyEvalRuns.evalId, evalId));
  }

  async function oneEval(evalId: string) {
    const [row] = await db.select().from(companyEvals).where(eq(companyEvals.id, evalId));
    if (!row) throw new Error(`eval ${evalId} does not exist`);
    return row;
  }

  const GOOD_INPUT = { title: "Add a dark mode toggle", files: ["ui/theme.tsx"], lines: 120 };

  // ---------------------------------------------------------------------------------------------
  // A board user authors evals
  // ---------------------------------------------------------------------------------------------

  describe("a board user authors evals", () => {
    it("creates an eval with its first version, and answers a second create with the same slug with 409", async () => {
      const world = await seedWorld();
      const { board, boardB } = clientsFor(world);

      const res = await board.create(definitionBody("pr-needs-qa", { changeNote: "First cut" }));

      expect(res.status).toBe(201);
      const created: CompanyEvalDetail = res.body;
      expect(created).toMatchObject({
        companyId: world.companyA,
        slug: "pr-needs-qa",
        title: "Eval pr-needs-qa",
        status: "draft",
        publishedVersionId: null,
        publishedVersionNumber: null,
        latestVersionNumber: 1,
        createdByUserId: "board-user",
        publishedVersion: null,
        latestVersion: {
          versionNumber: 1,
          changeNote: "First cut",
          createdByUserId: "board-user",
          questions: QUESTIONS,
          inputSchema: { ...INPUT_SCHEMA, required: ["title"], additionalProperties: false },
        },
      });
      expect((await versionsOf(created.id)).map((row) => row.versionNumber)).toEqual([1]);

      const again = await board.create(definitionBody("pr-needs-qa", { title: "Another title" }));
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ code: "eval_slug_taken" });
      expect((await oneEval(created.id)).title).toBe("Eval pr-needs-qa");
      expect(await db.select().from(companyEvals).where(eq(companyEvals.companyId, world.companyA))).toHaveLength(1);
      expect(await activityOf(world.companyA)).toHaveLength(1);

      // Another company may use the same slug.
      expect((await boardB.create(definitionBody("pr-needs-qa"))).status).toBe(201);
    });

    it.each([
      ["a slug with capitals and an underscore", definitionBody("Bad_Slug")],
      ["a one-character slug", definitionBody("a")],
      ["an empty title", definitionBody("ok-slug", { title: "  " })],
      ["an input schema with a nested object property", definitionBody("ok-slug", { inputSchema: { type: "object", properties: { nested: { type: "object" } } } })],
      ["an input schema with no properties", definitionBody("ok-slug", { inputSchema: { type: "object", properties: {} } })],
      ["a required name that is not a property", definitionBody("ok-slug", { inputSchema: { ...INPUT_SCHEMA, required: ["ghost"] } })],
      ["no questions", definitionBody("ok-slug", { questions: {} })],
      ["a question id with capitals", definitionBody("ok-slug", { questions: { NeedsQa: QUESTIONS.needs_qa } })],
      ["a choice question with one option", definitionBody("ok-slug", { questions: { pick: { type: "choice", instructions: "Pick", options: { a: "A" } } } })],
      ["an unknown field", definitionBody("ok-slug", { unexpected: true })],
    ])("answers %s with 400 and writes nothing", async (_label, body) => {
      const world = await seedWorld();
      const { board } = clientsFor(world);

      const res = await board.create(body);

      expect(res.status).toBe(400);
      expect(await db.select().from(companyEvals).where(eq(companyEvals.companyId, world.companyA))).toEqual([]);
      expect(await activityOf(world.companyA)).toEqual([]);
    });

    it("saves a changed definition as the next version, and an identical one as no new version", async () => {
      const world = await seedWorld();
      const { board } = clientsFor(world);
      const created = await createEval(board, "versions");

      const changed = await board.createVersion("versions", versionBody({ questions: REWORDED_QUESTIONS, changeNote: "Sharper wording" }));
      expect(changed.status).toBe(201);
      const second: CompanyEvalVersion = changed.body;
      expect(second).toMatchObject({ versionNumber: 2, evalId: created.id, changeNote: "Sharper wording", createdByUserId: "board-user" });
      const afterSecond = await activityOf(world.companyA);
      expect(afterSecond.map((row) => row.action)).toEqual(["eval.created", "eval.version_created"]);

      const identical = await board.createVersion("versions", versionBody({ questions: REWORDED_QUESTIONS, changeNote: "A different note" }));
      expect(identical.status).toBe(200);
      expect(identical.body).toMatchObject({ id: second.id, versionNumber: 2, changeNote: "Sharper wording" });
      expect(await versionsOf(created.id)).toHaveLength(2);
      expect((await oneEval(created.id)).latestVersionNumber).toBe(2);
      // The identical save writes no activity entry.
      expect(await activityOf(world.companyA)).toHaveLength(afterSecond.length);

      // The check compares with the latest version only: the first definition is new again.
      const back = await board.createVersion("versions", versionBody());
      expect(back.status).toBe(201);
      expect(back.body).toMatchObject({ versionNumber: 3 });
      expect((await activityOf(world.companyA)).map((row) => row.action)).toEqual([
        "eval.created",
        "eval.version_created",
        "eval.version_created",
      ]);
    });

    it("lists versions newest first in pages, and reads one by number", async () => {
      const world = await seedWorld();
      const { board } = clientsFor(world);
      await createEval(board, "history");
      await board.createVersion("history", versionBody({ questions: REWORDED_QUESTIONS }));
      await board.createVersion("history", versionBody());

      const first = await board.versions("history", "?limit=2");
      const firstPage: CompanyEvalPage<CompanyEvalVersion> = first.body;
      expect(first.status).toBe(200);
      expect(firstPage.items.map((item) => item.versionNumber)).toEqual([3, 2]);
      expect(firstPage.nextCursor).toEqual(expect.any(String));
      const second = await board.versions("history", `?limit=2&cursor=${firstPage.nextCursor}`);
      const secondPage: CompanyEvalPage<CompanyEvalVersion> = second.body;
      expect(secondPage.items.map((item) => item.versionNumber)).toEqual([1]);
      expect(secondPage.nextCursor).toBeNull();

      expect((await board.version("history", 2)).body).toMatchObject({ versionNumber: 2, questions: REWORDED_QUESTIONS });
      expect((await board.version("history", 9)).status).toBe(404);
      expect((await board.version("history", 0)).status).toBe(404);
      expect((await board.version("history", "latest")).status).toBe(404);
      expect((await board.versions("history", "?cursor=not-a-cursor")).status).toBe(400);
    });

    it("updates the title and the guidance, but not the slug", async () => {
      const world = await seedWorld();
      const { board } = clientsFor(world);
      const created = await createEval(board, "rename");

      const res = await board.patch("rename", { title: "A new title" });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ slug: "rename", title: "A new title", whenToUse: created.whenToUse, updatedByUserId: "board-user" });
      expect((await board.patch("rename", {})).status).toBe(400);
      expect((await board.patch("rename", { slug: "other-name" })).status).toBe(400);
      expect((await activityOf(world.companyA)).map((row) => [row.action, row.details])).toEqual([
        ["eval.created", { slug: "rename", versionNumber: 1 }],
        ["eval.updated", { slug: "rename", changed: ["title"] }],
      ]);
    });

    it("publishes the latest version by default, a chosen version on request, and refuses an unknown one", async () => {
      const world = await seedWorld();
      const { board } = clientsFor(world);
      await createEval(board, "publish");
      await board.createVersion("publish", versionBody({ questions: REWORDED_QUESTIONS }));

      const latest = await board.publish("publish");
      expect(latest.status).toBe(200);
      expect(latest.body).toMatchObject({ status: "published", publishedVersionNumber: 2, archivedAt: null });
      const first = await board.publish("publish", { versionNumber: 1 });
      expect(first.body).toMatchObject({ status: "published", publishedVersionNumber: 1 });
      expect((await board.publish("publish", { versionNumber: 9 })).status).toBe(404);
      expect((await board.publish("publish", { versionNumber: 0 })).status).toBe(400);

      const detail: CompanyEvalDetail = (await board.get("publish")).body;
      expect(detail).toMatchObject({
        status: "published",
        publishedVersionNumber: 1,
        publishedVersion: { versionNumber: 1 },
        latestVersion: { versionNumber: 2 },
      });
      expect((await activityOf(world.companyA)).map((row) => [row.action, row.details])).toEqual([
        ["eval.created", { slug: "publish", versionNumber: 1 }],
        ["eval.version_created", { slug: "publish", versionNumber: 2 }],
        ["eval.published", { slug: "publish", versionNumber: 2 }],
        ["eval.published", { slug: "publish", versionNumber: 1 }],
      ]);
    });

    it("deletes an eval that was never published, and refuses to delete one that was", async () => {
      const world = await seedWorld();
      const { board } = clientsFor(world);
      const draft = await createEval(board, "scratch");
      const published = await createPublishedEval(board, "kept");
      const tryItRun = await board.run("scratch", { input: GOOD_INPUT });
      expect(tryItRun.status).toBe(200);
      expect(tryItRun.body).toMatchObject({ mode: "try_it" });

      const removed = await board.remove("scratch");
      expect(removed.status).toBe(204);
      expect(await db.select().from(companyEvals).where(eq(companyEvals.id, draft.id))).toEqual([]);
      expect(await versionsOf(draft.id)).toEqual([]);
      expect(await runsOf(draft.id)).toEqual([]);
      expect((await board.get("scratch")).status).toBe(404);

      const refused = await board.remove("kept");
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: "eval_has_history" });
      expect((await oneEval(published.id)).status).toBe("published");
      expect(await versionsOf(published.id)).toHaveLength(1);

      const actions = (await activityOf(world.companyA)).map((row) => [row.action, row.entityId]);
      expect(actions.filter(([action]) => action === "eval.deleted")).toEqual([["eval.deleted", draft.id]]);
    });

    it("archives an eval, hides it from agents, keeps it from deletion and brings it back when it is published again", async () => {
      const world = await seedWorld();
      const { board, agent1 } = clientsFor(world);
      const published = await createPublishedEval(board, "seasonal");
      const run = await agent1.run("seasonal", { input: GOOD_INPUT });
      expect(run.status).toBe(200);
      const agentSees = async () => ((await agent1.list()).body as CompanyEvalPage<CompanyEvalAgentView>).items.map((item) => item.slug);
      expect(await agentSees()).toEqual(["seasonal"]);

      const archived = await board.archive("seasonal");
      expect(archived.status).toBe(200);
      expect(archived.body).toMatchObject({ status: "archived", archivedAt: expect.any(String), publishedVersionNumber: 1 });
      expect(await agentSees()).toEqual([]);
      expect((await agent1.get("seasonal")).status).toBe(404);
      expect((await agent1.run("seasonal", { input: GOOD_INPUT })).status).toBe(404);
      // The board still reads it, with its runs, by name or by status.
      expect((await board.get("seasonal")).status).toBe(200);
      expect(((await board.list()).body as CompanyEvalPage<CompanyEvalDetail>).items).toEqual([]);
      expect(((await board.list("?status=archived")).body as CompanyEvalPage<CompanyEvalDetail>).items.map((item) => item.slug)).toEqual(["seasonal"]);
      expect(((await board.runs("seasonal")).body as CompanyEvalPage<CompanyEvalRun>).items).toHaveLength(1);
      expect((await board.remove("seasonal")).status).toBe(409);
      expect(await runsOf(published.id)).toHaveLength(1);

      const restored = await board.publish("seasonal");
      expect(restored.status).toBe(200);
      expect(restored.body).toMatchObject({ status: "published", archivedAt: null, publishedVersionNumber: 1 });
      expect(await agentSees()).toEqual(["seasonal"]);
      expect((await agent1.run("seasonal", { input: GOOD_INPUT })).status).toBe(200);
      expect((await activityOf(world.companyA)).map((row) => row.action)).toEqual([
        "eval.created",
        "eval.published",
        "eval.archived",
        "eval.published",
      ]);
    });

    it("pages the eval list by slug with a cursor, and refuses a bad cursor or status", async () => {
      const world = await seedWorld();
      const { board } = clientsFor(world);
      for (const slug of ["gamma", "alpha", "beta"]) await createEval(board, slug);

      const first: CompanyEvalPage<CompanyEvalDetail> = (await board.list("?limit=2")).body;
      expect(first.items.map((item) => item.slug)).toEqual(["alpha", "beta"]);
      const second: CompanyEvalPage<CompanyEvalDetail> = (await board.list(`?limit=2&cursor=${first.nextCursor}`)).body;
      expect(second.items.map((item) => item.slug)).toEqual(["gamma"]);
      expect(second.nextCursor).toBeNull();
      expect((await board.list("?cursor=not-a-cursor")).status).toBe(400);
      expect((await board.list("?status=deleted")).status).toBe(400);
    });

    it("lets a viewer read but not write", async () => {
      const world = await seedWorld();
      const owner = clientsFor(world).board;
      await createEval(owner, "viewable");
      const viewer = clientFor(boardOf(world.companyA, { userId: "viewer-user", role: "viewer" }), world.companyA);

      expect((await viewer.list()).status).toBe(200);
      expect((await viewer.get("viewable")).status).toBe(200);
      expect((await viewer.create(definitionBody("nope"))).status).toBe(403);
      expect((await viewer.publish("viewable")).status).toBe(403);
      expect((await viewer.patch("viewable", { title: "Nope" })).status).toBe(403);
      expect((await viewer.remove("viewable")).status).toBe(403);
      expect(await activityOf(world.companyA)).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // What an agent may do
  // ---------------------------------------------------------------------------------------------

  describe("agents", () => {
    async function seedCatalog(world: World) {
      const { board } = clientsFor(world);
      const published = await createPublishedEval(board, "published-one");
      await createEval(board, "draft-one");
      await createPublishedEval(board, "archived-one");
      await board.archive("archived-one");
      return { board, published };
    }

    it("sees published evals only, with the guidance and the input schema but not the questions", async () => {
      const world = await seedWorld();
      const { agent1 } = clientsFor(world);
      const { published } = await seedCatalog(world);

      const listed = await agent1.list();

      expect(listed.status).toBe(200);
      const page: CompanyEvalPage<CompanyEvalAgentView> = listed.body;
      expect(page.items).toEqual([
        {
          id: published.id,
          slug: "published-one",
          title: "Eval published-one",
          whenToUse: published.whenToUse,
          publishedVersion: {
            id: published.publishedVersionId,
            versionNumber: 1,
            inputSchema: { ...INPUT_SCHEMA, required: ["title"], additionalProperties: false },
          },
        },
      ]);
      expect(JSON.stringify(listed.body)).not.toContain("Does this pull request need a QA pass?");
      const detail = await agent1.get("published-one");
      expect(detail.status).toBe(200);
      expect(detail.body).toEqual(page.items[0]);
    });

    it("answers a draft, an archived and a missing eval with the same 404", async () => {
      const world = await seedWorld();
      const { agent1 } = clientsFor(world);
      await seedCatalog(world);

      const draft = await agent1.get("draft-one");
      const archived = await agent1.get("archived-one");
      const missing = await agent1.get("no-such-eval");

      expect(draft.status).toBe(404);
      expect(archived.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(draft.body).toEqual(missing.body);
      expect(archived.body).toEqual(missing.body);
      expect((await agent1.run("draft-one", { input: GOOD_INPUT })).status).toBe(404);
      expect((await agent1.run("archived-one", { input: GOOD_INPUT })).status).toBe(404);
      expect(transport).not.toHaveBeenCalled();
    });

    const authoring: Array<[string, (client: Client) => Req]> = [
      ["create", (client) => client.create(definitionBody("by-agent"))],
      ["patch", (client) => client.patch("published-one", { title: "By agent" })],
      ["delete", (client) => client.remove("draft-one")],
      ["create a version", (client) => client.createVersion("published-one", versionBody({ questions: REWORDED_QUESTIONS }))],
      ["publish", (client) => client.publish("published-one")],
      ["archive", (client) => client.archive("published-one")],
      ["list versions", (client) => client.versions("published-one")],
      ["read a version", (client) => client.version("published-one", 1)],
    ];

    it.each(authoring)("refuses to %s with 403 and changes nothing", async (_label, attempt) => {
      const world = await seedWorld();
      const { agent1 } = clientsFor(world);
      await seedCatalog(world);
      const before = {
        evalRows: await db.select().from(companyEvals).where(eq(companyEvals.companyId, world.companyA)),
        versionRows: await db.select().from(companyEvalVersions).where(eq(companyEvalVersions.companyId, world.companyA)),
        activity: await activityOf(world.companyA),
      };

      const res = await attempt(agent1);

      expect(res.status).toBe(403);
      expect({
        evalRows: await db.select().from(companyEvals).where(eq(companyEvals.companyId, world.companyA)),
        versionRows: await db.select().from(companyEvalVersions).where(eq(companyEvalVersions.companyId, world.companyA)),
        activity: await activityOf(world.companyA),
      }).toEqual(before);
    });

    it("cannot pick a version or a mode when it runs an eval", async () => {
      const world = await seedWorld();
      const { agent1 } = clientsFor(world);
      await seedCatalog(world);

      expect((await agent1.run("published-one", { input: GOOD_INPUT, versionNumber: 1 })).status).toBe(403);
      expect((await agent1.run("published-one", { input: GOOD_INPUT, mode: "try_it" })).status).toBe(403);
      expect(transport).not.toHaveBeenCalled();
    });

    it("cannot use evals with a skill-test key", async () => {
      const world = await seedWorld();
      await seedCatalog(world);
      const skillTest = clientFor(
        agentOf(world.companyA, world.agentA1, { keyScope: { kind: "skill_test", issueId: world.issueA } }),
        world.companyA,
      );

      expect((await skillTest.list()).status).toBe(403);
      expect((await skillTest.get("published-one")).status).toBe(403);
      expect((await skillTest.run("published-one", { input: GOOD_INPUT })).status).toBe(403);
      expect(transport).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Running an eval
  // ---------------------------------------------------------------------------------------------

  describe("running an eval", () => {
    it("answers an agent's call, asks the judge with the version id and the input, and records the call", async () => {
      const world = await seedWorld();
      const { agent1 } = clientsFor(world);
      const published = await createPublishedEval(clientsFor(world).board, "pr-needs-qa");

      const res = await agent1.run("pr-needs-qa", { input: GOOD_INPUT });

      expect(res.status).toBe(200);
      const result: CompanyEvalRunResult = res.body;
      expect(result).toMatchObject({
        outcome: "answered",
        failureReason: null,
        cached: false,
        modelId: "typesafe-ai/jev-test",
        mode: "live",
        eval: { id: published.id, slug: "pr-needs-qa", versionId: published.publishedVersionId, versionNumber: 1 },
      });
      expect(result.runId).toMatch(UUID_PATTERN);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.answers).toEqual({
        needs_qa: { type: "predicate", probability: 0.91, value: true, abstained: false },
        qa_depth: {
          type: "choice",
          choice: "smoke",
          probabilities: { none: 0.05, smoke: 0.71, full_qa: 0.24 },
          confidence: 0.71,
          abstained: false,
        },
      });
      expect(result).not.toHaveProperty("hint");

      expect(transport).toHaveBeenCalledTimes(1);
      const call = transport.mock.calls[0]?.[0];
      expect(call?.state).toEqual(GOOD_INPUT);
      expect(Object.keys(call?.questions ?? {}).sort()).toEqual(["needs_qa", "qa_depth"]);

      const [row] = await runsOf(published.id);
      expect(row).toMatchObject({
        id: result.runId,
        companyId: world.companyA,
        versionId: published.publishedVersionId,
        versionNumber: 1,
        callerType: "agent",
        callerAgentId: world.agentA1,
        callerUserId: null,
        heartbeatRunId: null,
        issueId: null,
        projectId: null,
        mode: "live",
        outcome: "answered",
        failureReason: null,
        input: GOOD_INPUT,
        inputHash: createHash("sha256").update(canonicalJson(GOOD_INPUT)).digest("hex"),
        inputBytes: Buffer.byteLength(JSON.stringify(GOOD_INPUT)),
        inputRedacted: false,
        inputRedactionCount: 0,
        anyAbstained: false,
        cached: false,
        modelId: "typesafe-ai/jev-test",
        inputTokens: 123,
        outputTokens: 4,
        costUsd: "0.000321",
      });
      expect(row?.inputExpiresAt?.getTime()).toBe((row?.createdAt.getTime() ?? 0) + THIRTY_DAYS_MS);
      // A run is recorded in the run table only: no activity entry.
      expect((await activityOf(world.companyA)).map((entry) => entry.action)).toEqual(["eval.created", "eval.published"]);
    });

    it("runs the published version for the board too, and marks other runs as try-it", async () => {
      const world = await seedWorld();
      const { board } = clientsFor(world);
      const published = await createPublishedEval(board, "modes");
      await board.createVersion("modes", versionBody({ questions: REWORDED_QUESTIONS }));
      const draftOnly = await createEval(board, "draft-only");

      const live = await board.run("modes", { input: GOOD_INPUT });
      const explicitTryIt = await board.run("modes", { input: GOOD_INPUT, mode: "try_it" });
      const otherVersion = await board.run("modes", { input: GOOD_INPUT, versionNumber: 2 });
      const publishedByNumber = await board.run("modes", { input: GOOD_INPUT, versionNumber: 1 });
      const draft = await board.run("draft-only", { input: GOOD_INPUT });
      const missingVersion = await board.run("modes", { input: GOOD_INPUT, versionNumber: 7 });

      expect(live.body).toMatchObject({ mode: "live", eval: { versionNumber: 1 } });
      expect(explicitTryIt.body).toMatchObject({ mode: "try_it", eval: { versionNumber: 1 } });
      expect(otherVersion.body).toMatchObject({ mode: "try_it", eval: { versionNumber: 2 } });
      expect(publishedByNumber.body).toMatchObject({ mode: "live", eval: { versionNumber: 1 } });
      expect(draft.body).toMatchObject({ mode: "try_it", eval: { versionNumber: 1 } });
      expect(missingVersion.status).toBe(404);
      const rows = await runsOf(published.id);
      expect(rows.map((row) => [row.versionNumber, row.mode, row.callerType, row.callerUserId]).sort()).toEqual([
        [1, "live", "user", "board-user"],
        [1, "live", "user", "board-user"],
        [1, "try_it", "user", "board-user"],
        [2, "try_it", "user", "board-user"],
      ]);
      expect((await runsOf(draftOnly.id)).map((row) => row.mode)).toEqual(["try_it"]);
    });

    it("reads a run for the agent that made it, and answers 404 to another agent", async () => {
      const world = await seedWorld();
      const { board, agent1, agent2 } = clientsFor(world);
      await createPublishedEval(board, "own-runs");
      const run: CompanyEvalRunResult = (await agent1.run("own-runs", { input: GOOD_INPUT })).body;

      const own = await agent1.getRun("own-runs", run.runId);
      const other = await agent2.getRun("own-runs", run.runId);
      const missing = await agent2.getRun("own-runs", randomUUID());
      const asBoard = await board.getRun("own-runs", run.runId);

      expect(own.status).toBe(200);
      const detail: CompanyEvalRunDetail = own.body;
      expect(detail).toMatchObject({ id: run.runId, callerType: "agent", callerAgentId: world.agentA1, input: GOOD_INPUT, feedback: [] });
      expect(other.status).toBe(404);
      expect(other.body).toEqual(missing.body);
      expect(asBoard.status).toBe(200);
      expect((await agent1.getRun("own-runs", "not-a-uuid")).status).toBe(404);
    });

    it("lists only an agent's own runs, and the board lists every run with filters and pages", async () => {
      const world = await seedWorld();
      const { board, agent1, agent2 } = clientsFor(world);
      await createPublishedEval(board, "listing");
      const first: CompanyEvalRunResult = (await agent1.run("listing", { input: GOOD_INPUT })).body;
      const second: CompanyEvalRunResult = (await agent1.run("listing", { input: { title: "Second" } })).body;
      const third: CompanyEvalRunResult = (await agent2.run("listing", { input: { title: "Third" } })).body;
      const boardRun: CompanyEvalRunResult = (await board.run("listing", { input: { title: "Fourth" }, mode: "try_it" })).body;
      gate.capAvailable = false;
      const failed: CompanyEvalRunResult = (await agent1.run("listing", { input: { title: "Over the cap" } })).body;
      gate.capAvailable = true;
      const rejected = await agent1.run("listing", { input: { title: 5 } });
      const ids = (page: request.Response) => (page.body as CompanyEvalPage<CompanyEvalRun>).items.map((item) => item.id).sort();

      expect(ids(await agent1.runs("listing"))).toEqual([first.runId, second.runId, failed.runId, rejected.body.runId].sort());
      expect(ids(await agent2.runs("listing"))).toEqual([third.runId]);
      // An agent cannot ask for another agent's runs.
      expect(ids(await agent2.runs("listing", `?agentId=${world.agentA1}`))).toEqual([third.runId]);

      const all = [first, second, third, boardRun, failed].map((run) => run.runId).concat(rejected.body.runId).sort();
      expect(ids(await board.runs("listing"))).toEqual(all);
      expect(ids(await board.runs("listing", `?agentId=${world.agentA2}`))).toEqual([third.runId]);
      expect(ids(await board.runs("listing", "?mode=try_it"))).toEqual([boardRun.runId]);
      expect(ids(await board.runs("listing", "?outcome=failed"))).toEqual([failed.runId]);
      expect(ids(await board.runs("listing", "?outcome=rejected"))).toEqual([rejected.body.runId]);
      expect(ids(await board.runs("listing", "?versionNumber=2"))).toEqual([]);

      // Every run is on exactly one page.
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 10; guard += 1) {
        const page: CompanyEvalPage<CompanyEvalRun> = (await board.runs("listing", `?limit=2${cursor ? `&cursor=${cursor}` : ""}`)).body;
        seen.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect([...seen].sort()).toEqual(all);
      expect(new Set(seen).size).toBe(seen.length);
    });

    it("answers a cursor that was altered with 400, not a server error", async () => {
      const world = await seedWorld();
      const { board } = clientsFor(world);
      await createPublishedEval(board, "cursor");
      await board.run("cursor", { input: GOOD_INPUT });
      const cursorOf = (position: unknown) => Buffer.from(JSON.stringify(position), "utf8").toString("base64url");

      for (const position of [
        { at: "not a time", id: randomUUID() },
        { at: new Date().toISOString(), id: "not-a-uuid" },
        { at: 5, id: randomUUID() },
        { at: "+275760-09-13T00:00:00.000Z", id: randomUUID() },
        { at: "2026-13-45T99:99:99.999Z", id: randomUUID() },
        { at: new Date().toISOString() },
        { id: randomUUID() },
      ]) {
        const res = await board.runs("cursor", `?cursor=${cursorOf(position)}`);
        expect(res.status, JSON.stringify(position)).toBe(400);
      }
    });

    it("serves the same input again from the cache for one version, and not for the next", async () => {
      const world = await seedWorld();
      const { board, agent1 } = clientsFor(world);
      const published = await createPublishedEval(board, "cache");

      const first: CompanyEvalRunResult = (await agent1.run("cache", { input: GOOD_INPUT })).body;
      const again: CompanyEvalRunResult = (await agent1.run("cache", { input: GOOD_INPUT })).body;
      await board.createVersion("cache", versionBody({ questions: REWORDED_QUESTIONS }));
      await board.publish("cache");
      const nextVersion: CompanyEvalRunResult = (await agent1.run("cache", { input: GOOD_INPUT })).body;

      expect([first.cached, again.cached, nextVersion.cached]).toEqual([false, true, false]);
      expect(nextVersion.eval.versionNumber).toBe(2);
      expect(transport).toHaveBeenCalledTimes(2);
      const rows = new Map((await runsOf(published.id)).map((row) => [row.id, row]));
      expect(rows.get(first.runId)).toMatchObject({ cached: false, inputTokens: 123, outputTokens: 4, costUsd: "0.000321" });
      // A cache hit used no tokens and cost nothing.
      expect(rows.get(again.runId)).toMatchObject({ cached: true, inputTokens: 0, outputTokens: 0, costUsd: "0.000000", outcome: "answered" });
    });

    it("links a run to the heartbeat run, issue and project of the caller when the run id checks out", async () => {
      const world = await seedWorld();
      const { board, agent1 } = clientsFor(world);
      const published = await createPublishedEval(board, "linked");

      const own = await agent1.run("linked", { input: { title: "Linked" } }, { "x-paperclip-run-id": world.runA1 });
      const spoofed = await agent1.run("linked", { input: { title: "Spoofed" } }, { "x-paperclip-run-id": world.runB1 });
      const garbage = await agent1.run("linked", { input: { title: "Garbage" } }, { "x-paperclip-run-id": "not-a-run-id" });
      const asBoard = await board.run("linked", { input: { title: "Board" } }, { "x-paperclip-run-id": world.runB1 });

      for (const res of [own, spoofed, garbage, asBoard]) expect(res.status).toBe(200);
      const byTitle = new Map((await runsOf(published.id)).map((row) => [(row.input as { title: string }).title, row]));
      expect(byTitle.get("Linked")).toMatchObject({ heartbeatRunId: world.runA1, issueId: world.issueA, projectId: world.projectA });
      for (const title of ["Spoofed", "Garbage", "Board"]) {
        expect(byTitle.get(title), title).toMatchObject({ heartbeatRunId: null, issueId: null, projectId: null });
      }
    });

    it("takes the issue from the body when it is an issue of the company, and answers 404 for another company's issue", async () => {
      const world = await seedWorld();
      const { board, agent1 } = clientsFor(world);
      const published = await createPublishedEval(board, "issues");

      const ok = await agent1.run("issues", { input: GOOD_INPUT, issueId: world.issueA });
      const foreign = await agent1.run("issues", { input: GOOD_INPUT, issueId: world.issueB });
      const unknown = await agent1.run("issues", { input: GOOD_INPUT, issueId: randomUUID() });
      const malformed = await agent1.run("issues", { input: GOOD_INPUT, issueId: "not-a-uuid" });

      expect(ok.status).toBe(200);
      expect(foreign.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(foreign.body).toEqual(unknown.body);
      expect(malformed.status).toBe(400);
      expect((await runsOf(published.id)).map((row) => [row.issueId, row.projectId])).toEqual([[world.issueA, world.projectA]]);
      expect(transport).toHaveBeenCalledTimes(1);
    });

    it("requires an input, and a version number or mode only in the shapes the API allows", async () => {
      const world = await seedWorld();
      const { board } = clientsFor(world);
      await createPublishedEval(board, "shapes");

      expect((await board.run("shapes", {})).status).toBe(400);
      expect((await board.run("shapes", { input: GOOD_INPUT, mode: "live" })).status).toBe(400);
      expect((await board.run("shapes", { input: GOOD_INPUT, versionNumber: 0 })).status).toBe(400);
      expect((await board.run("shapes", { input: GOOD_INPUT, extra: true })).status).toBe(400);
      expect((await board.run("Not_A_Slug", { input: GOOD_INPUT })).status).toBe(404);
      expect(transport).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Rejected inputs and judge failures are recorded
  // ---------------------------------------------------------------------------------------------

  describe("recorded rejections and failures", () => {
    it("answers an input over 32 KiB with 422 and the id of a rejected run that holds no input", async () => {
      const world = await seedWorld();
      const { board, agent1 } = clientsFor(world);
      const published = await createPublishedEval(board, "too-large");
      const input = { title: `${INPUT_CANARY}${"x".repeat(MAX_INPUT_BYTES)}` };

      const res = await agent1.run("too-large", { input });

      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({
        code: "eval_input_too_large",
        runId: expect.stringMatching(UUID_PATTERN),
        details: { maxInputBytes: MAX_INPUT_BYTES, inputBytes: Buffer.byteLength(JSON.stringify(input)) },
      });
      expect(JSON.stringify(res.body)).not.toContain(INPUT_CANARY);
      expect(transport).not.toHaveBeenCalled();
      const [row] = await runsOf(published.id);
      expect(row).toMatchObject({
        id: res.body.runId,
        outcome: "rejected",
        failureReason: "input_too_large",
        latencyMs: 0,
        input: null,
        inputExpiresAt: null,
        inputBytes: Buffer.byteLength(JSON.stringify(input)),
        answers: null,
        modelId: null,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        callerType: "agent",
        callerAgentId: world.agentA1,
        mode: "live",
      });
      expect(row?.inputHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(row)).not.toContain(INPUT_CANARY);
      expect((await activityOf(world.companyA)).map((entry) => entry.action)).toEqual(["eval.created", "eval.published"]);
    });

    it.each([
      ["a value of the wrong type", { title: 5 }],
      ["a missing required property", { files: ["a.ts"] }],
      ["a property the schema does not name", { title: "Fine", unexpected_field: INPUT_CANARY }],
      ["a string longer than its maxLength", { title: "y".repeat(201) }],
      ["an input that is not an object", INPUT_CANARY],
      ["an input that is null", null],
    ])("answers %s with 422 and paths but no values, and records a rejected run without input", async (_label, input) => {
      const world = await seedWorld();
      const { board, agent1 } = clientsFor(world);
      const published = await createPublishedEval(board, "invalid-input");

      const res = await agent1.run("invalid-input", { input });

      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({
        code: "eval_input_invalid",
        runId: expect.stringMatching(UUID_PATTERN),
        details: { errors: expect.arrayContaining([expect.objectContaining({ path: expect.any(String), message: expect.any(String) })]) },
      });
      expect(JSON.stringify(res.body)).not.toContain(INPUT_CANARY);
      expect(transport).not.toHaveBeenCalled();
      const rows = await runsOf(published.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: res.body.runId,
        outcome: "rejected",
        failureReason: "input_invalid",
        latencyMs: 0,
        input: null,
        inputExpiresAt: null,
        answers: null,
      });
      expect(JSON.stringify(rows[0])).not.toContain(INPUT_CANARY);
      // The rejected run shows in the list, so the board can see which agents send bad input.
      const listed: CompanyEvalPage<CompanyEvalRun> = (await board.runs("invalid-input", "?outcome=rejected")).body;
      expect(listed.items.map((item) => item.id)).toEqual([res.body.runId]);
    });

    it("names the property that the schema does not allow, but masks a secret-shaped name", async () => {
      const world = await seedWorld();
      const { board, agent1 } = clientsFor(world);
      await createPublishedEval(board, "extra-names");
      const password = ["not", "a", "real", "password", "value"].join("-");
      const secretName = `https://deploy:${password}@git.example.test/repo.git`;

      const plain = await agent1.run("extra-names", { input: { title: "Fine", unexpected_field: INPUT_CANARY } });
      const secret = await agent1.run("extra-names", { input: { title: "Fine", [secretName]: INPUT_CANARY } });

      expect(plain.status).toBe(422);
      expect(plain.body.details.errors).toEqual([{ path: "/", message: "must NOT have additional properties: unexpected_field" }]);
      expect(secret.status).toBe(422);
      expect(JSON.stringify(secret.body)).not.toContain(password);
      expect(JSON.stringify(secret.body)).not.toContain(INPUT_CANARY);
    });

    it("answers a company without a gateway key with 200, a failed outcome and a recorded run", async () => {
      const world = await seedWorld({ gatewayKey: false });
      const { board, agent1 } = clientsFor(world);
      const published = await createPublishedEval(board, "no-key");

      const res = await agent1.run("no-key", { input: GOOD_INPUT });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        outcome: "failed",
        failureReason: "no_key",
        answers: null,
        cached: false,
        modelId: null,
        hint: "Add the company secret AI_GATEWAY_API_KEY",
        runId: expect.stringMatching(UUID_PATTERN),
      });
      expect(transport).not.toHaveBeenCalled();
      const [row] = await runsOf(published.id);
      expect(row).toMatchObject({
        id: res.body.runId,
        outcome: "failed",
        failureReason: "no_key",
        answers: null,
        modelId: null,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        input: GOOD_INPUT,
        mode: "live",
      });
    });

    it.each([
      ["a spent daily cap", "cap_exceeded"],
      ["a gateway error", "error"],
    ] as const)("answers %s with 200, a failed outcome and a recorded run", async (kind, reason) => {
      const world = await seedWorld();
      const { board, agent1 } = clientsFor(world);
      const published = await createPublishedEval(board, "failing");
      if (reason === "cap_exceeded") gate.capAvailable = false;
      else transport.mockRejectedValue(new Error("gateway unavailable"));

      const res = await agent1.run("failing", { input: GOOD_INPUT });

      expect(res.status, kind).toBe(200);
      expect(res.body).toMatchObject({ outcome: "failed", failureReason: reason, answers: null });
      expect(res.body).not.toHaveProperty("hint");
      const [row] = await runsOf(published.id);
      expect(row).toMatchObject({ id: res.body.runId, outcome: "failed", failureReason: reason, answers: null, costUsd: null });
    });

    it("lets nobody mark a failed or rejected run", async () => {
      const world = await seedWorld({ gatewayKey: false });
      const { board, agent1 } = clientsFor(world);
      await createPublishedEval(board, "unmarkable");
      const failed: CompanyEvalRunResult = (await agent1.run("unmarkable", { input: GOOD_INPUT })).body;
      const rejected = await agent1.run("unmarkable", { input: { title: 5 } });

      for (const runId of [failed.runId, rejected.body.runId]) {
        const res = await agent1.feedback("unmarkable", runId, { verdict: "correct" });
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ code: "eval_run_not_answered" });
      }
      expect(await db.select().from(companyEvalFeedback).where(eq(companyEvalFeedback.companyId, world.companyA))).toEqual([]);
    });

    it("keeps no input when the retention setting is 0, and still records the call", async () => {
      const world = await seedWorld();
      const { board } = clientsFor(world);
      const published = await createPublishedEval(board, "no-retention");
      const forgetful = createEvalsModule({ db, judge, settings: { inputRetentionDays: 0 } });
      const client = clientFor(boardOf(world.companyA), world.companyA, forgetful);

      const res = await client.run("no-retention", { input: GOOD_INPUT });

      expect(res.status).toBe(200);
      const [row] = await runsOf(published.id);
      expect(row).toMatchObject({ id: res.body.runId, outcome: "answered", input: null, inputExpiresAt: null });
      expect(row?.inputHash).toBe(createHash("sha256").update(canonicalJson(GOOD_INPUT)).digest("hex"));
      expect(row?.inputBytes).toBe(Buffer.byteLength(JSON.stringify(GOOD_INPUT)));
    });

    it("masks secret-shaped text in the input before the judge, the database and the response see it", async () => {
      const world = await seedWorld();
      const { board, agent1 } = clientsFor(world);
      const published = await createPublishedEval(board, "redaction");
      const password = ["not", "a", "real", "password", "value"].join("-");
      const urlWithSecret = `https://deploy:${password}@git.example.test/repo.git`;
      const input = { title: `Clone ${urlWithSecret} first`, files: [`see ${urlWithSecret}`, "clean.ts", "also clean"] };
      expect(redactSensitiveText(input.title)).not.toBe(input.title);

      const res = await agent1.run("redaction", { input });

      expect(res.status).toBe(200);
      const sent = transport.mock.calls[0]?.[0].state;
      expect(JSON.stringify(sent)).not.toContain(password);
      expect(sent).toMatchObject({ files: [expect.any(String), "clean.ts", "also clean"] });
      const [row] = await runsOf(published.id);
      expect(row).toMatchObject({ inputRedacted: true, inputRedactionCount: 2 });
      expect(JSON.stringify(row)).not.toContain(password);
      expect(JSON.stringify(res.body)).not.toContain(password);
      expect(row?.input).toEqual(sent);
      // The hash is of the redacted input, so it cannot be used to test guesses at the secret.
      expect(row?.inputHash).toBe(createHash("sha256").update(canonicalJson(sent)).digest("hex"));
      const clean = await agent1.run("redaction", { input: GOOD_INPUT });
      expect(clean.status).toBe(200);
      const rows = await runsOf(published.id);
      expect(rows.find((candidate) => candidate.id === clean.body.runId)).toMatchObject({ inputRedacted: false, inputRedactionCount: 0 });
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Feedback
  // ---------------------------------------------------------------------------------------------

  describe("feedback", () => {
    it("keeps one mark per author and question, replaces a later mark, and lets the caller mark only its own runs", async () => {
      const world = await seedWorld();
      const { board, agent1, agent2 } = clientsFor(world);
      await createPublishedEval(board, "marks");
      const run: CompanyEvalRunResult = (await agent1.run("marks", { input: GOOD_INPUT })).body;

      const byBoard = await board.feedback("marks", run.runId, { verdict: "correct", note: "Right call" });
      const boardAgain = await board.feedback("marks", run.runId, { verdict: "incorrect", note: "On a second look, no" });
      const byAgent = await agent1.feedback("marks", run.runId, { verdict: "correct" });
      const onQuestion = await board.feedback("marks", run.runId, { questionId: "needs_qa", verdict: "correct" });
      const byOtherAgent = await agent2.feedback("marks", run.runId, { verdict: "incorrect" });

      expect(byBoard.status).toBe(200);
      const first: CompanyEvalFeedback = byBoard.body;
      expect(first).toMatchObject({ runId: run.runId, questionId: null, verdict: "correct", note: "Right call", authorType: "user", authorUserId: "board-user", authorAgentId: null });
      expect(boardAgain.body).toMatchObject({ id: first.id, verdict: "incorrect", note: "On a second look, no" });
      expect(byAgent.body).toMatchObject({ authorType: "agent", authorAgentId: world.agentA1, authorUserId: null, verdict: "correct", note: null });
      expect(byAgent.body.id).not.toBe(first.id);
      expect(onQuestion.body).toMatchObject({ questionId: "needs_qa", verdict: "correct" });
      expect(byOtherAgent.status).toBe(404);

      const detail: CompanyEvalRunDetail = (await board.getRun("marks", run.runId)).body;
      expect(detail.feedback.map((mark) => [mark.questionId, mark.authorType, mark.verdict]).sort()).toEqual([
        [null, "agent", "correct"],
        [null, "user", "incorrect"],
        ["needs_qa", "user", "correct"],
      ]);
      expect(await db.select().from(companyEvalFeedback).where(eq(companyEvalFeedback.runId, run.runId))).toHaveLength(3);
      // The agent sees its own marks on its run, the same as the board.
      const agentView: CompanyEvalRunDetail = (await agent1.getRun("marks", run.runId)).body;
      expect(agentView.feedback).toHaveLength(3);
    });

    it("refuses an unknown question, an unknown verdict and an empty note", async () => {
      const world = await seedWorld();
      const { board, agent1 } = clientsFor(world);
      await createPublishedEval(board, "bad-marks");
      const run: CompanyEvalRunResult = (await agent1.run("bad-marks", { input: GOOD_INPUT })).body;

      expect((await board.feedback("bad-marks", run.runId, { questionId: "no_such_question", verdict: "correct" })).status).toBe(400);
      expect((await board.feedback("bad-marks", run.runId, { verdict: "maybe" })).status).toBe(400);
      expect((await board.feedback("bad-marks", run.runId, { verdict: "correct", note: "  " })).status).toBe(400);
      expect((await board.feedback("bad-marks", run.runId, {})).status).toBe(400);
      expect((await board.feedback("bad-marks", "not-a-uuid", { verdict: "correct" })).status).toBe(404);
      expect((await board.feedback("bad-marks", randomUUID(), { verdict: "correct" })).status).toBe(404);
      expect(await db.select().from(companyEvalFeedback).where(eq(companyEvalFeedback.companyId, world.companyA))).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Another company
  // ---------------------------------------------------------------------------------------------

  describe("another company", () => {
    async function seedSecretEval(world: World) {
      const { board, agent1 } = clientsFor(world);
      const published = await createPublishedEval(board, "secret-eval");
      const run: CompanyEvalRunResult = (await agent1.run("secret-eval", { input: GOOD_INPUT })).body;
      await board.feedback("secret-eval", run.runId, { verdict: "correct" });
      return { published, run };
    }

    function routes(slug: string, runId: string): Array<[string, (client: Client) => Req]> {
      return [
        ["list", (client) => client.list()],
        ["create", (client) => client.create(definitionBody("intruder"))],
        ["get", (client) => client.get(slug)],
        ["patch", (client) => client.patch(slug, { title: "Hijacked" })],
        ["delete", (client) => client.remove(slug)],
        ["list versions", (client) => client.versions(slug)],
        ["create a version", (client) => client.createVersion(slug, versionBody({ questions: REWORDED_QUESTIONS }))],
        ["read a version", (client) => client.version(slug, 1)],
        ["publish", (client) => client.publish(slug)],
        ["archive", (client) => client.archive(slug)],
        ["run", (client) => client.run(slug, { input: GOOD_INPUT })],
        ["list runs", (client) => client.runs(slug)],
        ["read a run", (client) => client.getRun(slug, runId)],
        ["mark a run", (client) => client.feedback(slug, runId, { verdict: "incorrect", note: NOTE_CANARY })],
      ];
    }

    async function snapshot(world: World, evalId: string) {
      return {
        evalRow: await oneEval(evalId),
        versions: await versionsOf(evalId),
        runs: await runsOf(evalId),
        feedback: await db.select().from(companyEvalFeedback).where(eq(companyEvalFeedback.companyId, world.companyA)),
        activityA: await activityOf(world.companyA),
        activityB: await activityOf(world.companyB),
      };
    }

    it("answers 403 on every route to a board user and an agent that belong to another company", async () => {
      const world = await seedWorld();
      const { published, run } = await seedSecretEval(world);
      const before = await snapshot(world, published.id);
      const callers = [
        clientFor(boardOf(world.companyB, { userId: "board-b" }), world.companyA),
        clientFor(agentOf(world.companyB, world.agentB1), world.companyA),
      ];

      for (const caller of callers) {
        for (const [label, attempt] of routes("secret-eval", run.runId)) {
          const res = await attempt(caller);
          expect(res.status, label).toBe(403);
        }
      }

      expect(await snapshot(world, published.id)).toEqual(before);
      expect(transport).toHaveBeenCalledTimes(1);
    });

    it("answers 404 on every route that names this company's eval, run or version through its own company", async () => {
      const world = await seedWorld();
      const { published, run } = await seedSecretEval(world);
      const before = await snapshot(world, published.id);
      const { boardB } = clientsFor(world);
      const agentB = clientFor(agentOf(world.companyB, world.agentB1), world.companyB);

      // An agent may not author at all, so those routes answer 403 before any lookup.
      const agentMayNot = new Set(["create", "patch", "delete", "list versions", "create a version", "read a version", "publish", "archive"]);
      for (const [caller, isAgent] of [[boardB, false], [agentB, true]] as const) {
        for (const [label, attempt] of routes("secret-eval", run.runId)) {
          if (label === "list" || label === "create") continue;
          const res = await attempt(caller);
          expect(res.status, `${isAgent ? "agent" : "board"} ${label}`).toBe(isAgent && agentMayNot.has(label) ? 403 : 404);
        }
        const listed: CompanyEvalPage<CompanyEvalDetail> = (await caller.list()).body;
        expect(listed.items).toEqual([]);
      }

      expect(await snapshot(world, published.id)).toEqual(before);
      expect(transport).toHaveBeenCalledTimes(1);
    });

    it("does not read a run or mark it through another company's eval of the same name, or through another eval", async () => {
      const world = await seedWorld();
      const { published, run } = await seedSecretEval(world);
      const { board, boardB } = clientsFor(world);
      await createPublishedEval(boardB, "secret-eval");
      await createPublishedEval(board, "other-eval-of-a");
      const before = await snapshot(world, published.id);

      // The same slug exists in company B, but the run id belongs to company A's eval.
      expect((await boardB.getRun("secret-eval", run.runId)).status).toBe(404);
      expect((await boardB.feedback("secret-eval", run.runId, { verdict: "incorrect" })).status).toBe(404);
      // Another eval of the same company does not own the run either.
      expect((await board.getRun("other-eval-of-a", run.runId)).status).toBe(404);
      expect((await board.feedback("other-eval-of-a", run.runId, { verdict: "incorrect" })).status).toBe(404);

      expect((await snapshot(world, published.id)).feedback).toEqual(before.feedback);
      expect((await snapshot(world, published.id)).runs).toEqual(before.runs);
    });

    it("lets each company keep its own eval under the same slug", async () => {
      const world = await seedWorld();
      const { board, boardB } = clientsFor(world);
      const inA = await createPublishedEval(board, "shared-slug");
      await createEval(boardB, "shared-slug", { title: "Company B's eval" });

      expect(((await board.get("shared-slug")).body as CompanyEvalDetail).id).toBe(inA.id);
      expect((await board.get("shared-slug")).body).toMatchObject({ title: "Eval shared-slug", status: "published" });
      expect((await boardB.get("shared-slug")).body).toMatchObject({ title: "Company B's eval", status: "draft" });
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Activity log
  // ---------------------------------------------------------------------------------------------

  describe("activity log", () => {
    it("writes one entry per change and per mark, never one per run, and never an input value or a note", async () => {
      const world = await seedWorld();
      const { board, agent1 } = clientsFor(world);
      const created = await createEval(board, "audited");
      await board.createVersion("audited", versionBody({ questions: REWORDED_QUESTIONS, changeNote: NOTE_CANARY }));
      await board.createVersion("audited", versionBody({ questions: REWORDED_QUESTIONS }));
      await board.patch("audited", { title: "Audited" });
      await board.publish("audited", { versionNumber: 2 });
      const answered: CompanyEvalRunResult = (await agent1.run("audited", { input: { title: INPUT_CANARY } })).body;
      await agent1.run("audited", { input: { title: INPUT_CANARY, [INPUT_CANARY]: 1 } });
      await agent1.run("audited", { input: { title: "x".repeat(MAX_INPUT_BYTES) } });
      await board.run("audited", { input: GOOD_INPUT, mode: "try_it" });
      await agent1.feedback("audited", answered.runId, { verdict: "correct", note: NOTE_CANARY });
      await board.feedback("audited", answered.runId, { questionId: "needs_qa", verdict: "incorrect", note: NOTE_CANARY });
      await board.feedback("audited", answered.runId, { questionId: "needs_qa", verdict: "correct" });
      await board.archive("audited");
      await board.publish("audited");
      // Reads and refused calls write nothing.
      await board.get("audited");
      await board.list();
      await board.runs("audited");
      await agent1.create(definitionBody("by-agent"));
      await board.feedback("audited", randomUUID(), { verdict: "correct" });
      await board.create(definitionBody("audited"));

      const entries = await activityOf(world.companyA);

      expect(entries.map((entry) => [entry.action, entry.entityType])).toEqual([
        ["eval.created", "eval"],
        ["eval.version_created", "eval"],
        ["eval.updated", "eval"],
        ["eval.published", "eval"],
        ["eval.feedback_recorded", "eval_run"],
        ["eval.feedback_recorded", "eval_run"],
        ["eval.feedback_recorded", "eval_run"],
        ["eval.archived", "eval"],
        ["eval.published", "eval"],
      ]);
      expect(entries.map((entry) => entry.details)).toEqual([
        { slug: "audited", versionNumber: 1 },
        { slug: "audited", versionNumber: 2 },
        { slug: "audited", changed: ["title"] },
        { slug: "audited", versionNumber: 2 },
        { slug: "audited", questionId: null, verdict: "correct", hasNote: true },
        { slug: "audited", questionId: "needs_qa", verdict: "incorrect", hasNote: true },
        { slug: "audited", questionId: "needs_qa", verdict: "correct", hasNote: false },
        { slug: "audited" },
        { slug: "audited", versionNumber: 2 },
      ]);
      expect(entries.map((entry) => entry.entityId)).toEqual([
        created.id,
        created.id,
        created.id,
        created.id,
        answered.runId,
        answered.runId,
        answered.runId,
        created.id,
        created.id,
      ]);
      // Who did it: the board user, or the agent for its own mark.
      expect(entries[0]).toMatchObject({ actorType: "user", actorId: "board-user", agentId: null });
      expect(entries[4]).toMatchObject({ actorType: "agent", actorId: world.agentA1, agentId: world.agentA1 });
      expect(JSON.stringify(entries)).not.toContain(INPUT_CANARY);
      expect(JSON.stringify(entries)).not.toContain(NOTE_CANARY);
      // The runs are in the run table, not in the activity log.
      expect(await runsOf(created.id)).toHaveLength(4);
      expect(
        await db
          .select({ id: activityLog.id })
          .from(activityLog)
          .where(and(eq(activityLog.companyId, world.companyA), eq(activityLog.entityType, "eval_run"), eq(activityLog.action, "eval.run"))),
      ).toEqual([]);
    });
  });
});
