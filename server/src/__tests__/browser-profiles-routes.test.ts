import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, browserProfiles, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const COOKIE_MARKER = "COOKIE-VALUE-DO-NOT-LEAK";

interface FakeLaunch {
  session: string | null;
  closed: boolean;
}

function createFakeExecutor() {
  const launches: FakeLaunch[] = [];
  let sessionCounter = 0;

  function makeTab(key: string) {
    let url = "about:blank";
    return {
      async navigate(next: string) {
        url = next;
        return { url, title: "Page" };
      },
      async snapshot() {
        return `- link "Next":\n  - /url: ${url}?token=SNAPSHOT-TOKEN`;
      },
      async state() {
        return { url, title: `Page ${key}` };
      },
      async click() {},
      async fill(ref: string) {
        if (ref === "e99") {
          const { BrowserActionError } = await import("../services/browser-executor.js");
          throw new BrowserActionError("sensitive_field", "Agents cannot type into password fields");
        }
      },
      async press() {},
      async scroll() {},
      async wait() {},
      async pointerClick() {},
      async typeText() {},
      async screenshot() {
        return Buffer.from("jpeg-bytes");
      },
      async close() {},
    };
  }

  const executor = {
    available: true,
    unavailableReason: null,
    async launch(session: string | null) {
      const launch: FakeLaunch = { session, closed: false };
      launches.push(launch);
      const tabs = new Map<string, ReturnType<typeof makeTab>>();
      return {
        async openTab(key: string) {
          const existing = tabs.get(key);
          if (existing) return existing;
          const created = makeTab(key);
          tabs.set(key, created);
          return created;
        },
        async closeTab(key: string) {
          tabs.delete(key);
        },
        tabCount: () => tabs.size,
        async exportSession() {
          sessionCounter += 1;
          return JSON.stringify({ cookies: [{ name: "sid", value: `${COOKIE_MARKER}-${sessionCounter}` }] });
        },
        async close() {
          launch.closed = true;
        },
      };
    },
  };
  return { executor, launches };
}

type Actor =
  | { type: "board"; userId: string; companyIds: string[] }
  | { type: "agent"; agentId: string; companyId: string };

async function createApp(db: Db, executor: ReturnType<typeof createFakeExecutor>["executor"]) {
  const { browserProfileService } = await import("../services/browser-profiles.js");
  const { browserProfileRoutes } = await import("../routes/browser-profiles.js");
  const { errorHandler } = await import("../middleware/error-handler.js");
  const service = browserProfileService(db, { executor, idleMs: 60_000 });
  const current: { actor: Actor } = { actor: { type: "board", userId: "unset", companyIds: [] } };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const actor = current.actor;
    req.actor =
      actor.type === "board"
        ? {
            type: "board",
            userId: actor.userId,
            source: "session",
            companyIds: actor.companyIds,
            memberships: actor.companyIds.map((companyId) => ({ companyId, membershipRole: "owner", status: "active" })),
            isInstanceAdmin: false,
          }
        : { type: "agent", agentId: actor.agentId, companyId: actor.companyId, source: "agent_jwt" };
    next();
  });
  app.use("/api", browserProfileRoutes(db, service));
  app.use(errorHandler);
  return {
    service,
    as(actor: Actor) {
      current.actor = actor;
      return request(app);
    },
  };
}

describeEmbeddedPostgres("browser profile routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-browser-profiles-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function newCompany() {
    const [company] = await db
      .insert(companies)
      .values({ name: `Browser ${randomUUID()}`, issuePrefix: `BR${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}` })
      .returning();
    return company!.id;
  }

  async function newAgent(companyId: string) {
    const [agent] = await db
      .insert(agents)
      .values({ companyId, name: `Agent ${randomUUID()}`, role: "engineer", status: "idle", adapterType: "codex_local" })
      .returning();
    return agent!.id;
  }

  async function setup() {
    const companyId = await newCompany();
    const userId = `user-${randomUUID()}`;
    const fake = createFakeExecutor();
    const harness = await createApp(db, fake.executor);
    const board = () => harness.as({ type: "board", userId, companyIds: [companyId] });
    const agent = (agentId: string) => harness.as({ type: "agent", agentId, companyId });
    await board().put(`/api/companies/${companyId}/browser/settings`).send({ enabled: true }).expect(200);
    const profile = async (name = "posthog", allowedDomains = ["app.posthog.com"]) => {
      const res = await board().post(`/api/companies/${companyId}/browser/profiles`).send({ name, allowedDomains });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const id: string = res.body.id;
      return { id, base: `/api/companies/${companyId}/browser/profiles/${id}` };
    };
    return { companyId, userId, harness, fake, board, agent, profile };
  }

  it("is invisible until a board user enables it for the company", async () => {
    const companyId = await newCompany();
    const { as } = await createApp(db, createFakeExecutor().executor);
    const board = () => as({ type: "board", userId: "u", companyIds: [companyId] });
    const overview = await board().get(`/api/companies/${companyId}/browser/overview`).expect(200);
    expect(overview.body).toMatchObject({ enabled: false, profiles: [] });
    await board().post(`/api/companies/${companyId}/browser/profiles`).send({ name: "x" }).expect(404);
  });

  it("creates a profile whose key is a company secret and returns no secret material", async () => {
    const { companyId, board, profile } = await setup();
    const created = await profile();
    const [row] = await db.select().from(browserProfiles).where(eq(browserProfiles.id, created.id));
    expect(row?.keySecretId).toBeTruthy();
    expect(row?.sealedState).toBeNull();
    const body = JSON.stringify((await board().get(`/api/companies/${companyId}/browser/overview`).expect(200)).body);
    expect(body).not.toContain("sealed");
    expect(body).not.toContain(row!.keySecretId!);
  });

  it("encrypts the saved session at rest and restores it into a new browser", async () => {
    const { companyId, board, agent, fake, harness, profile } = await setup();
    const { id, base } = await profile();

    await board().post(`${base}/signin`).send({ startUrl: "https://accounts.identity.test/login" }).expect(200);
    await board().post(`${base}/signin/input`).send({ type: "click", x: 10, y: 20 }).expect(200);
    await board().post(`${base}/signin/input`).send({ type: "type", text: "123456" }).expect(200);
    const frame = await board().get(`${base}/signin/frame`).expect(200);
    expect(frame.headers["content-type"]).toContain("image/jpeg");
    expect(frame.headers["cache-control"]).toContain("no-store");
    const ended = await board().post(`${base}/signin/end`).expect(200);
    expect(ended.body.hasSavedSession).toBe(true);
    expect(JSON.stringify(ended.body)).not.toContain(COOKIE_MARKER);

    const [row] = await db.select().from(browserProfiles).where(eq(browserProfiles.id, id));
    expect(row?.sealedState?.startsWith("v1.")).toBe(true);
    expect(row?.sealedState).not.toContain(COOKIE_MARKER);
    expect(Buffer.from(row!.sealedState!.slice(3), "base64url").toString("utf8")).not.toContain(COOKIE_MARKER);
    expect(row?.stateGeneration).toBe(1);

    await harness.service.closeAll();
    expect(fake.launches[0]!.closed).toBe(true);
    const grantee = await newAgent(companyId);
    await board().patch(base).send({ allowedAgentIds: [grantee] }).expect(200);
    await agent(grantee).post(`${base}/actions`).send({ action: "snapshot" }).expect(200);
    expect(fake.launches[fake.launches.length - 1]!.session).toContain(COOKIE_MARKER);
  });

  it("never writes cookie values, typed text or query strings to the activity log", async () => {
    const { companyId, board, agent, profile } = await setup();
    const { base } = await profile();
    const agentId = await newAgent(companyId);
    await board().patch(base).send({ allowedAgentIds: [agentId] }).expect(200);
    await board().post(`${base}/signin`).send({}).expect(200);
    await board().post(`${base}/signin/input`).send({ type: "type", text: "TYPED-PASSWORD-123" }).expect(200);
    await board().post(`${base}/signin/end`).expect(200);
    await agent(agentId)
      .post(`${base}/actions`)
      .send({ action: "navigate", url: "https://app.posthog.com/dash?token=URL-TOKEN-XYZ" })
      .expect(200);
    const rows = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    const dump = JSON.stringify(rows);
    for (const secret of [COOKIE_MARKER, "TYPED-PASSWORD-123", "URL-TOKEN-XYZ", "sealed_state"]) {
      expect(dump, secret).not.toContain(secret);
    }
    expect(rows.map((row) => row.action)).toEqual(
      expect.arrayContaining(["browser.profile_created", "browser.signin_started", "browser.signin_ended", "browser.agent_action"]),
    );
  });

  describe("company isolation", () => {
    it("treats another company's profile id as missing for every board operation", async () => {
      const owner = await setup();
      const other = await setup();
      const { id } = await owner.profile();
      const foreign = `/api/companies/${other.companyId}/browser/profiles/${id}`;

      await other.board().patch(foreign).send({ name: "renamed" }).expect(404);
      await other.board().post(`${foreign}/suspend`).expect(404);
      await other.board().post(`${foreign}/signin`).send({}).expect(404);
      await other.board().delete(foreign).expect(404);

      const [row] = await db.select().from(browserProfiles).where(eq(browserProfiles.id, id));
      expect(row).toMatchObject({ companyId: owner.companyId, name: "posthog", status: "active" });
    });

    it("refuses a board user who is not a member of the URL's company", async () => {
      const owner = await setup();
      const outsider = await setup();
      const { base } = await owner.profile();
      await outsider.board().get(`/api/companies/${owner.companyId}/browser/overview`).expect(403);
      await outsider.board().post(`${base}/signin`).send({}).expect(403);
    });

    it("lets an agent use only profiles of its own company and only when allowed", async () => {
      const owner = await setup();
      const { id, base } = await owner.profile();
      const foreignCompany = await newCompany();
      const foreignAgent = await newAgent(foreignCompany);
      const asForeign = () => owner.harness.as({ type: "agent", agentId: foreignAgent, companyId: foreignCompany });

      await owner.board().patch(base).send({ allowedAgentIds: [foreignAgent] }).expect(422);
      await asForeign().post(`${base}/actions`).send({ action: "snapshot" }).expect(403);
      await asForeign()
        .post(`/api/companies/${foreignCompany}/browser/profiles/${id}/actions`)
        .send({ action: "snapshot" })
        .expect(404);
    });
  });

  describe("agent access", () => {
    it("denies and audits an agent that the board did not allow, then allows it after the grant", async () => {
      const { companyId, board, agent, fake, profile } = await setup();
      const { id, base } = await profile();
      const agentId = await newAgent(companyId);

      await agent(agentId).post(`${base}/actions`).send({ action: "snapshot" }).expect(403);
      expect(fake.launches).toHaveLength(0);
      const denied = await db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "browser.access_denied")));
      expect(denied).toHaveLength(1);
      expect(denied[0]).toMatchObject({ actorType: "agent", actorId: agentId });

      await board().patch(base).send({ allowedAgentIds: [agentId] }).expect(200);
      const listed = await agent(agentId).get(`/api/companies/${companyId}/browser/agent-profiles`).expect(200);
      expect(listed.body).toEqual([{ id, name: "posthog", allowedDomains: ["app.posthog.com"] }]);
    });

    it("cannot manage profiles, grant itself access, or sign in", async () => {
      const { companyId, agent, profile } = await setup();
      const { id, base } = await profile();
      const agentId = await newAgent(companyId);
      await agent(agentId).patch(base).send({ allowedAgentIds: [agentId] }).expect(403);
      await agent(agentId).put(`/api/companies/${companyId}/browser/settings`).send({ enabled: false }).expect(403);
      await agent(agentId).post(`${base}/signin`).send({}).expect(403);
      await agent(agentId).delete(base).expect(403);
      expect(await db.select().from(browserProfiles).where(eq(browserProfiles.id, id))).toHaveLength(1);
    });

    it("rejects board users on the agent action route", async () => {
      const { board, profile } = await setup();
      const { base } = await profile();
      await board().post(`${base}/actions`).send({ action: "snapshot" }).expect(403);
    });

    it("enforces the domain allowlist, rejects unknown actions and reports sensitive fields", async () => {
      const { companyId, board, agent, profile } = await setup();
      const { base } = await profile();
      const agentId = await newAgent(companyId);
      await board().patch(base).send({ allowedAgentIds: [agentId] }).expect(200);

      for (const url of ["https://evil.test/", "http://app.posthog.com/", "https://app.posthog.com@evil.test/", "javascript:alert(1)"]) {
        await agent(agentId).post(`${base}/actions`).send({ action: "navigate", url }).expect(403);
      }
      const ok = await agent(agentId)
        .post(`${base}/actions`)
        .send({ action: "navigate", url: "https://app.posthog.com/insights?secret=abc" })
        .expect(200);
      expect(ok.body.url).toBe("app.posthog.com/insights");
      expect(ok.body.snapshot).not.toContain("SNAPSHOT-TOKEN");

      for (const action of [
        { action: "eval", script: "document.cookie" },
        { action: "cookies" },
        { action: "storage_state" },
        { action: "navigate", url: "https://app.posthog.com/", extra: 1 },
      ]) {
        await agent(agentId).post(`${base}/actions`).send(action).expect(400);
      }
      const sensitive = await agent(agentId).post(`${base}/actions`).send({ action: "fill", ref: "e99", value: "hunter2" }).expect(403);
      expect(sensitive.body.error).toContain("password");
    });
  });

  describe("sign-in lease and kill switch", () => {
    it("lets only the lease holder drive the browser and blocks agents meanwhile", async () => {
      const { companyId, board, agent, harness, profile } = await setup();
      const { base } = await profile();
      const agentId = await newAgent(companyId);
      await board().patch(base).send({ allowedAgentIds: [agentId] }).expect(200);
      const someoneElse = () => harness.as({ type: "board", userId: "someone-else", companyIds: [companyId] });

      await board().get(`${base}/signin/state`).expect(409);
      await board().post(`${base}/signin`).send({}).expect(200);
      await someoneElse().post(`${base}/signin/input`).send({ type: "key", key: "Enter" }).expect(409);
      await someoneElse().post(`${base}/signin`).send({}).expect(409);
      await agent(agentId).post(`${base}/actions`).send({ action: "snapshot" }).expect(409);
      await board().post(`${base}/signin/end`).expect(200);
      await agent(agentId).post(`${base}/actions`).send({ action: "snapshot" }).expect(200);
      await board().post(`${base}/signin/input`).send({ type: "key", key: "Enter" }).expect(409);
    });

    it("rejects non-https sign-in navigation", async () => {
      const { board, profile } = await setup();
      const { base } = await profile();
      await board().post(`${base}/signin`).send({ startUrl: "http://accounts.identity.test/" }).expect(422);
      await board().post(`${base}/signin`).send({}).expect(200);
      await board().post(`${base}/signin/input`).send({ type: "navigate", url: "javascript:alert(1)" }).expect(422);
      await board().post(`${base}/signin/input`).send({ type: "navigate", url: "http://accounts.identity.test/" }).expect(422);
    });

    it("suspend stops the live browser and refuses the next agent call; resume restores access", async () => {
      const { companyId, board, agent, fake, profile } = await setup();
      const { base } = await profile();
      const agentId = await newAgent(companyId);
      await board().patch(base).send({ allowedAgentIds: [agentId] }).expect(200);
      await agent(agentId).post(`${base}/actions`).send({ action: "snapshot" }).expect(200);

      await board().post(`${base}/suspend`).expect(200);
      expect(fake.launches[fake.launches.length - 1]!.closed).toBe(true);
      await agent(agentId).post(`${base}/actions`).send({ action: "snapshot" }).expect(403);
      await board().post(`${base}/signin`).send({}).expect(403);
      await board().post(`${base}/resume`).expect(200);
      await agent(agentId).post(`${base}/actions`).send({ action: "snapshot" }).expect(200);
    });

    it("destroy erases the saved session and the key, and the agent loses access", async () => {
      const { companyId, board, agent, profile } = await setup();
      const { id, base } = await profile();
      const agentId = await newAgent(companyId);
      await board().patch(base).send({ allowedAgentIds: [agentId] }).expect(200);
      await board().post(`${base}/signin`).send({}).expect(200);
      await board().post(`${base}/signin/end`).expect(200);

      await board().delete(base).expect(200);
      expect(await db.select().from(browserProfiles).where(eq(browserProfiles.id, id))).toHaveLength(0);
      await agent(agentId).post(`${base}/actions`).send({ action: "snapshot" }).expect(404);
    });

    it("turning the company switch off closes live browsers and hides the feature", async () => {
      const { companyId, board, fake, profile } = await setup();
      const { base } = await profile();
      await board().post(`${base}/signin`).send({}).expect(200);
      await board().put(`/api/companies/${companyId}/browser/settings`).send({ enabled: false }).expect(200);
      expect(fake.launches[fake.launches.length - 1]!.closed).toBe(true);
      await board().post(`${base}/signin`).send({}).expect(404);
    });
  });
});
