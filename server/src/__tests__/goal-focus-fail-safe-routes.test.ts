import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, goals, issues, type Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { issueRoutes } from "../routes/issues.js";

/** How the focus reader the routes get behaves: never answer, fail at once, or fail after the time limit. */
const focusReader = vi.hoisted(() => ({ mode: "hang" as "hang" | "fail" | "fail-late" }));

// The real guarded reads, given a reader that misbehaves. A database lock cannot stand in for a
// hang: heartbeat-context also reads the goals table for the company's default goal.
vi.mock("../services/goal-focus.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/goal-focus.js")>();
  const read = (): Promise<never> => {
    if (focusReader.mode === "fail") return Promise.reject(new Error("focus read failed"));
    if (focusReader.mode === "fail-late") {
      return new Promise((_resolve, reject) => setTimeout(() => reject(new Error("focus read failed late")), 700));
    }
    return new Promise(() => {});
  };
  const service = { getFocusIndex: read, getFocusForIssue: read };
  return {
    ...actual,
    readFocusIndex: (db: Db, companyId: string) => actual.readFocusIndex(db, companyId, { service }),
    readCompanyFocusForIssue: (db: Db, companyId: string, issueGoalId: string | null) =>
      actual.readCompanyFocusForIssue(db, companyId, issueGoalId, { service }),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres goal focus fail-safe tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/** Well above the 500 ms focus time limit, well below a stalled request. */
const ANSWER_WITHIN_MS = 2_000;

describeEmbeddedPostgres("company focus reads never fail or delay an agent", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    // A local worktree instance env file sets this and filters the agent inbox; tests must not depend on it.
    vi.stubEnv("PAPERCLIP_IN_WORKTREE", "false");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-goal-focus-fail-safe-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db.$client.end();
    await tempDb?.cleanup();
  });

  function app(actor: Record<string, unknown>) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as unknown as { actor: Record<string, unknown> }).actor = actor;
      next();
    });
    testApp.use("/api", agentRoutes(db as Db));
    testApp.use("/api", issueRoutes(db as Db, {} as never, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  /** A company whose focus would show, with an agent and two tasks: a low one that serves the focus, then a high one. */
  async function seedFocusedCompany() {
    const companyId = randomUUID();
    const prefix = `F${randomUUID().replaceAll("-", "").slice(0, 5).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: `Co ${prefix}`, issuePrefix: prefix, requireBoardApprovalForNewAgents: false });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId, companyId, name: "Agent", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const [focusGoal] = await db.insert(goals).values({ companyId, title: "Land PRs", status: "active", horizon: "short" }).returning();
    const [serving, other] = await db.insert(issues).values([
      { companyId, title: "Serves the focus", status: "todo", priority: "low", identifier: `${prefix}-1`, issueNumber: 1, assigneeAgentId: agentId, goalId: focusGoal!.id },
      { companyId, title: "Other", status: "todo", priority: "high", identifier: `${prefix}-2`, issueNumber: 2, assigneeAgentId: agentId },
    ]).returning();
    return { client: request(app({ type: "agent", source: "agent_key", companyId, agentId })), serving: serving!, other: other! };
  }

  async function timed<T>(call: () => Promise<T>): Promise<{ result: T; elapsedMs: number }> {
    const started = performance.now();
    const result = await call();
    return { result, elapsedMs: performance.now() - started };
  }

  for (const mode of ["hang", "fail"] as const) {
    it(`answers the heartbeat context without the focus when the focus read ${mode === "hang" ? "never answers" : "fails"}`, async () => {
      focusReader.mode = mode;
      const { client, serving } = await seedFocusedCompany();

      const { result: res, elapsedMs } = await timed(() => client.get(`/api/issues/${serving.id}/heartbeat-context`));

      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty("companyFocus");
      expect(res.body.goal).toMatchObject({ title: "Land PRs", horizon: "short" });
      expect(elapsedMs).toBeLessThan(ANSWER_WITHIN_MS);
    });

    it(`keeps the normal inbox order when the focus read ${mode === "hang" ? "never answers" : "fails"}`, async () => {
      focusReader.mode = mode;
      const { client, serving, other } = await seedFocusedCompany();

      const { result: res, elapsedMs } = await timed(() => client.get("/api/agents/me/inbox-lite"));

      expect(res.status).toBe(200);
      expect(res.body.map((row: { id: string }) => row.id)).toEqual([other.id, serving.id]);
      for (const row of res.body) expect(row).not.toHaveProperty("focusGoalId");
      expect(elapsedMs).toBeLessThan(ANSWER_WITHIN_MS);
    });
  }

  it("handles a focus read that fails after the time limit, so the late failure cannot crash the server", async () => {
    focusReader.mode = "fail-late";
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { client, serving } = await seedFocusedCompany();

      const context = await client.get(`/api/issues/${serving.id}/heartbeat-context`);
      const inbox = await client.get("/api/agents/me/inbox-lite");
      await new Promise((resolve) => setTimeout(resolve, 900));

      expect(context.status).toBe(200);
      expect(context.body).not.toHaveProperty("companyFocus");
      expect(inbox.status).toBe(200);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
