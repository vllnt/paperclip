import express, { type Express, type Request } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  companyEvalInputSchemaSchema,
  companyEvalQuestionsSchema,
  type CompanyEval,
  type CompanyEvalDetail,
  type CompanyEvalFeedback,
  type CompanyEvalRunResult,
  type CompanyEvalVersion,
} from "@paperclipai/shared";
import { errorHandler } from "../middleware/error-handler.js";
import { EvalInputRejectedError, EvalsApplicationError, type EvalsService } from "../modules/evals/index.js";
import { companyEvalRoutes } from "../routes/company-evals.js";

const activity = vi.hoisted(() => ({
  logActivity: vi.fn<(db: unknown, input: Record<string, unknown>) => Promise<void>>(),
}));

vi.mock("../services/activity-log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/activity-log.js")>();
  return { ...actual, logActivity: activity.logActivity };
});

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const EVAL_ID = "33333333-3333-4333-8333-333333333333";
const VERSION_ID = "44444444-4444-4444-8444-444444444444";
const RUN_ID = "55555555-5555-4555-8555-555555555555";
const AGENT_ID = "66666666-6666-4666-8666-666666666666";
const HEARTBEAT_RUN_ID = "77777777-7777-4777-8777-777777777777";
const ISSUE_ID = "88888888-8888-4888-8888-888888888888";
const SLUG = "pr-preview-needs-qa";
const CANARY = "CANARY-value-must-not-be-logged";

const evalsUrl = `/api/companies/${COMPANY}/evals`;
const evalUrl = `${evalsUrl}/${SLUG}`;
const runsUrl = `${evalUrl}/runs`;

type Actor = Request["actor"];
type Payload = string | object | undefined;

function boardActor(overrides: Partial<Actor> = {}): Actor {
  return {
    type: "board",
    userId: "board-user",
    source: "session",
    companyIds: [COMPANY],
    memberships: [{ companyId: COMPANY, membershipRole: "owner", status: "active" }],
    isInstanceAdmin: false,
    ...overrides,
  };
}

function agentActor(overrides: Partial<Actor> = {}): Actor {
  return {
    type: "agent",
    agentId: AGENT_ID,
    companyId: COMPANY,
    keyId: "agent-key-1",
    runId: HEARTBEAT_RUN_ID,
    source: "agent_key",
    keyScope: { kind: "standard" },
    ...overrides,
  };
}

const inputSchema = companyEvalInputSchemaSchema.parse({
  type: "object",
  properties: { title: { type: "string", maxLength: 200 } },
  required: ["title"],
});
const questions = companyEvalQuestionsSchema.parse({
  needs_qa: { type: "predicate", instructions: "Does this change need a QA pass?" },
});

const evalRecord: CompanyEval = {
  id: EVAL_ID,
  companyId: COMPANY,
  slug: SLUG,
  title: "PR preview needs QA",
  whenToUse: "Before asking for a QA pass.",
  status: "draft",
  publishedVersionId: null,
  publishedVersionNumber: null,
  latestVersionNumber: 1,
  templateKey: null,
  templateVersion: null,
  createdByUserId: "board-user",
  updatedByUserId: "board-user",
  createdAt: "2026-10-09T12:00:00.000Z",
  updatedAt: "2026-10-09T12:00:00.000Z",
  publishedAt: null,
  archivedAt: null,
};

const versionRecord: CompanyEvalVersion = {
  id: VERSION_ID,
  companyId: COMPANY,
  evalId: EVAL_ID,
  versionNumber: 2,
  inputSchema,
  questions,
  definitionHash: "a".repeat(64),
  changeNote: null,
  createdByUserId: "board-user",
  createdAt: "2026-10-09T12:00:00.000Z",
};

const detailRecord: CompanyEvalDetail = { ...evalRecord, publishedVersion: null, latestVersion: versionRecord };

const feedbackRecord: CompanyEvalFeedback = {
  id: "99999999-9999-4999-8999-999999999999",
  companyId: COMPANY,
  runId: RUN_ID,
  questionId: "needs_qa",
  verdict: "incorrect",
  note: CANARY,
  authorType: "user",
  authorAgentId: null,
  authorUserId: "board-user",
  createdAt: "2026-10-09T12:00:00.000Z",
  updatedAt: "2026-10-09T12:00:00.000Z",
};

const runResult: CompanyEvalRunResult = {
  runId: RUN_ID,
  eval: { id: EVAL_ID, slug: SLUG, versionId: VERSION_ID, versionNumber: 2 },
  outcome: "answered",
  failureReason: null,
  answers: { needs_qa: { type: "predicate", probability: 0.91, value: true, abstained: false } },
  cached: false,
  latencyMs: 1180,
  modelId: "typesafe-ai/jev",
  mode: "live",
};

const createBody = {
  slug: SLUG,
  title: "PR preview needs QA",
  whenToUse: "Before asking for a QA pass.",
  inputSchema: { type: "object", properties: { title: { type: "string", maxLength: 200 } }, required: ["title"] },
  questions: { needs_qa: { type: "predicate", instructions: "Does this change need a QA pass?" } },
};

const versionBody = { inputSchema: createBody.inputSchema, questions: createBody.questions };

function createFakeEvals() {
  return {
    list: vi.fn<EvalsService["list"]>(),
    get: vi.fn<EvalsService["get"]>(),
    create: vi.fn<EvalsService["create"]>(),
    update: vi.fn<EvalsService["update"]>(),
    createVersion: vi.fn<EvalsService["createVersion"]>(),
    listVersions: vi.fn<EvalsService["listVersions"]>(),
    getVersion: vi.fn<EvalsService["getVersion"]>(),
    publish: vi.fn<EvalsService["publish"]>(),
    archive: vi.fn<EvalsService["archive"]>(),
    remove: vi.fn<EvalsService["remove"]>(),
    run: vi.fn<EvalsService["run"]>(),
    listRuns: vi.fn<EvalsService["listRuns"]>(),
    getRun: vi.fn<EvalsService["getRun"]>(),
    putFeedback: vi.fn<EvalsService["putFeedback"]>(),
  };
}

type FakeEvals = ReturnType<typeof createFakeEvals>;

/** The routes never touch the database themselves: the activity log is mocked. */
const db: Db = Object.create(null);

function setup(actor: Actor = boardActor()) {
  const evals = createFakeEvals();
  const service: EvalsService = evals;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", companyEvalRoutes(db, service));
  app.use(errorHandler);
  return { app, evals };
}

function serviceWasTouched(evals: FakeEvals): boolean {
  return Object.values(evals).some((method) => method.mock.calls.length > 0);
}

function activityEntries(): Array<Record<string, unknown>> {
  return activity.logActivity.mock.calls.map(([, input]) => input);
}

interface MutationCase {
  name: string;
  arrange: (evals: FakeEvals) => void;
  /** Makes the service refuse, to check that a refused change leaves no activity entry. */
  refuse: (evals: FakeEvals, error: EvalsApplicationError) => void;
  call: (app: Express) => request.Test;
  status: number;
  entry: { action: string; entityType: "eval" | "eval_run"; entityId: string; details: Record<string, unknown> };
}

const mutations: MutationCase[] = [
  {
    name: "create",
    arrange: (evals) => evals.create.mockResolvedValue(detailRecord),
    refuse: (evals, error) => evals.create.mockRejectedValue(error),
    call: (app) => request(app).post(evalsUrl).send(createBody),
    status: 201,
    entry: { action: "eval.created", entityType: "eval", entityId: EVAL_ID, details: { slug: SLUG, versionNumber: 2 } },
  },
  {
    name: "update",
    arrange: (evals) => evals.update.mockResolvedValue({ ...evalRecord, title: "Renamed" }),
    refuse: (evals, error) => evals.update.mockRejectedValue(error),
    call: (app) => request(app).patch(evalUrl).send({ whenToUse: "A new reason", title: "Renamed" }),
    status: 200,
    entry: { action: "eval.updated", entityType: "eval", entityId: EVAL_ID, details: { slug: SLUG, changed: ["title", "whenToUse"] } },
  },
  {
    name: "new version",
    arrange: (evals) => evals.createVersion.mockResolvedValue({ version: versionRecord, created: true }),
    refuse: (evals, error) => evals.createVersion.mockRejectedValue(error),
    call: (app) => request(app).post(`${evalUrl}/versions`).send(versionBody),
    status: 201,
    entry: { action: "eval.version_created", entityType: "eval", entityId: EVAL_ID, details: { slug: SLUG, versionNumber: 2 } },
  },
  {
    name: "publish",
    arrange: (evals) =>
      evals.publish.mockResolvedValue({ ...evalRecord, status: "published", publishedVersionId: VERSION_ID, publishedVersionNumber: 2 }),
    refuse: (evals, error) => evals.publish.mockRejectedValue(error),
    call: (app) => request(app).post(`${evalUrl}/publish`).send({ versionNumber: 2 }),
    status: 200,
    entry: { action: "eval.published", entityType: "eval", entityId: EVAL_ID, details: { slug: SLUG, versionNumber: 2 } },
  },
  {
    name: "archive",
    arrange: (evals) => evals.archive.mockResolvedValue({ ...evalRecord, status: "archived" }),
    refuse: (evals, error) => evals.archive.mockRejectedValue(error),
    call: (app) => request(app).post(`${evalUrl}/archive`),
    status: 200,
    entry: { action: "eval.archived", entityType: "eval", entityId: EVAL_ID, details: { slug: SLUG } },
  },
  {
    name: "delete",
    arrange: (evals) => evals.remove.mockResolvedValue({ id: EVAL_ID, slug: SLUG }),
    refuse: (evals, error) => evals.remove.mockRejectedValue(error),
    call: (app) => request(app).delete(evalUrl),
    status: 204,
    entry: { action: "eval.deleted", entityType: "eval", entityId: EVAL_ID, details: { slug: SLUG } },
  },
  {
    name: "feedback",
    arrange: (evals) => evals.putFeedback.mockResolvedValue(feedbackRecord),
    refuse: (evals, error) => evals.putFeedback.mockRejectedValue(error),
    call: (app) => request(app).put(`${runsUrl}/${RUN_ID}/feedback`).send({ verdict: "incorrect", questionId: "needs_qa", note: CANARY }),
    status: 200,
    entry: {
      action: "eval.feedback_recorded",
      entityType: "eval_run",
      entityId: RUN_ID,
      details: { slug: SLUG, questionId: "needs_qa", verdict: "incorrect", hasNote: true },
    },
  },
];

beforeEach(() => {
  activity.logActivity.mockReset();
  activity.logActivity.mockResolvedValue(undefined);
});

describe("company eval routes", () => {
  describe("activity log", () => {
    it.each(mutations)("$name answers $status and writes exactly one entry", async (mutation) => {
      const { app, evals } = setup();
      mutation.arrange(evals);
      const response = await mutation.call(app);
      expect(response.status).toBe(mutation.status);

      expect(activity.logActivity).toHaveBeenCalledTimes(1);
      expect(activityEntries()[0]).toEqual({
        companyId: COMPANY,
        actorType: "user",
        actorId: "board-user",
        agentId: null,
        runId: null,
        agentApiKeyId: null,
        ...mutation.entry,
      });
    });

    it.each(mutations)("$name writes no entry when the service refuses", async (mutation) => {
      const { app, evals } = setup();
      mutation.refuse(evals, new EvalsApplicationError("conflict", "Refused", { code: "eval_has_history" }));
      const response = await mutation.call(app);
      expect(response.status).toBe(409);
      expect(activity.logActivity).not.toHaveBeenCalled();
    });

    it("names the agent, its key and its run when an agent marks a run", async () => {
      const { app, evals } = setup(agentActor());
      evals.putFeedback.mockResolvedValue({ ...feedbackRecord, authorType: "agent", authorAgentId: AGENT_ID, authorUserId: null });
      await request(app).put(`${runsUrl}/${RUN_ID}/feedback`).send({ verdict: "correct" }).expect(200);
      expect(activityEntries()).toEqual([
        expect.objectContaining({
          companyId: COMPANY,
          actorType: "agent",
          actorId: AGENT_ID,
          agentId: AGENT_ID,
          runId: HEARTBEAT_RUN_ID,
          agentApiKeyId: "agent-key-1",
          action: "eval.feedback_recorded",
        }),
      ]);
    });

    it("writes an entry for a new version only, and none for an identical definition", async () => {
      const { app, evals } = setup();
      evals.createVersion.mockResolvedValue({ version: versionRecord, created: false });
      const response = await request(app).post(`${evalUrl}/versions`).send(versionBody);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ id: VERSION_ID, versionNumber: 2 });
      expect(activity.logActivity).not.toHaveBeenCalled();

      evals.createVersion.mockResolvedValue({ version: versionRecord, created: true });
      const created = await request(app).post(`${evalUrl}/versions`).send(versionBody);
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ id: VERSION_ID, versionNumber: 2 });
      expect(activity.logActivity).toHaveBeenCalledTimes(1);
    });

    it("writes no entry for a run, whatever its outcome", async () => {
      const { app, evals } = setup();
      evals.run.mockResolvedValueOnce(runResult);
      evals.run.mockResolvedValueOnce({
        ...runResult,
        outcome: "failed",
        failureReason: "no_key",
        answers: null,
        hint: "Add the company secret AI_GATEWAY_API_KEY",
      });
      evals.run.mockRejectedValueOnce(
        new EvalInputRejectedError("The input does not match the eval's input schema.", {
          code: "eval_input_invalid",
          runId: RUN_ID,
          errors: [{ path: "/title", message: "must be string" }],
        }),
      );
      evals.run.mockRejectedValueOnce(new EvalsApplicationError("not_found", "Eval not found"));
      for (const status of [200, 200, 422, 404]) {
        const response = await request(app).post(runsUrl).send({ input: { title: CANARY } });
        expect(response.status).toBe(status);
      }
      expect(activity.logActivity).not.toHaveBeenCalled();
    });

    it("writes no entry for a read", async () => {
      const { app, evals } = setup();
      evals.list.mockResolvedValue({ items: [evalRecord], nextCursor: null });
      evals.get.mockResolvedValue(detailRecord);
      evals.listVersions.mockResolvedValue({ items: [versionRecord], nextCursor: null });
      evals.getVersion.mockResolvedValue(versionRecord);
      evals.listRuns.mockResolvedValue({ items: [], nextCursor: null });
      evals.getRun.mockRejectedValue(new EvalsApplicationError("not_found", "Run not found"));
      await request(app).get(evalsUrl).expect(200);
      await request(app).get(evalUrl).expect(200);
      await request(app).get(`${evalUrl}/versions`).expect(200);
      await request(app).get(`${evalUrl}/versions/2`).expect(200);
      await request(app).get(runsUrl).expect(200);
      await request(app).get(`${runsUrl}/${RUN_ID}`).expect(404);
      expect(activity.logActivity).not.toHaveBeenCalled();
    });

    it("never puts an input value, a note, a title or a definition in an entry", async () => {
      const { app, evals } = setup();
      evals.create.mockResolvedValue(detailRecord);
      evals.update.mockResolvedValue({ ...evalRecord, title: CANARY });
      evals.createVersion.mockResolvedValue({ version: versionRecord, created: true });
      evals.putFeedback.mockResolvedValue(feedbackRecord);
      evals.run.mockResolvedValue(runResult);

      await request(app).post(evalsUrl).send({ ...createBody, title: CANARY, whenToUse: CANARY }).expect(201);
      await request(app).patch(evalUrl).send({ title: CANARY, whenToUse: CANARY }).expect(200);
      await request(app)
        .post(`${evalUrl}/versions`)
        .send({ ...versionBody, changeNote: CANARY })
        .expect(201);
      await request(app).post(runsUrl).send({ input: { title: CANARY } }).expect(200);
      await request(app).put(`${runsUrl}/${RUN_ID}/feedback`).send({ verdict: "incorrect", note: CANARY }).expect(200);

      expect(activity.logActivity).toHaveBeenCalledTimes(4);
      expect(JSON.stringify(activity.logActivity.mock.calls)).not.toContain(CANARY);
    });
  });

  describe("statuses and bodies", () => {
    it("answers 201 with the created eval, and passes the parsed body and the actor to the service", async () => {
      const { app, evals } = setup();
      evals.create.mockResolvedValue(detailRecord);
      const response = await request(app).post(evalsUrl).send(createBody);
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ id: EVAL_ID, slug: SLUG, status: "draft" });
      expect(evals.create).toHaveBeenCalledTimes(1);
      const [actor, companyId, body] = evals.create.mock.calls[0] ?? [];
      expect(actor).toEqual({ type: "user", userId: "board-user" });
      expect(companyId).toBe(COMPANY);
      expect(body?.inputSchema.additionalProperties).toBe(false);
    });

    it("answers 204 with no body on delete", async () => {
      const { app, evals } = setup();
      evals.remove.mockResolvedValue({ id: EVAL_ID, slug: SLUG });
      const response = await request(app).delete(evalUrl);
      expect(response.status).toBe(204);
      expect(response.text).toBe("");
      expect(evals.remove).toHaveBeenCalledWith({ type: "user", userId: "board-user" }, COMPANY, SLUG);
    });

    it("answers 201 for a new version and 200 for an identical definition", async () => {
      const { app, evals } = setup();
      evals.createVersion.mockResolvedValueOnce({ version: versionRecord, created: true });
      evals.createVersion.mockResolvedValueOnce({ version: versionRecord, created: false });
      await request(app).post(`${evalUrl}/versions`).send(versionBody).expect(201);
      await request(app).post(`${evalUrl}/versions`).send(versionBody).expect(200);
    });

    it("answers 200 with the result of a run and passes the body, the actor and the run id header value", async () => {
      const { app, evals } = setup(agentActor());
      evals.run.mockResolvedValue(runResult);
      const response = await request(app)
        .post(runsUrl)
        .send({ input: { title: "Fix login" }, issueId: ISSUE_ID });
      expect(response.status).toBe(200);
      expect(response.body).toEqual(runResult);
      expect(evals.run).toHaveBeenCalledWith(
        { type: "agent", agentId: AGENT_ID },
        COMPANY,
        SLUG,
        { input: { title: "Fix login" }, issueId: ISSUE_ID },
        { runId: HEARTBEAT_RUN_ID },
      );
    });

    it("passes a null run id for a board caller without one", async () => {
      const { app, evals } = setup();
      evals.run.mockResolvedValue(runResult);
      await request(app).post(runsUrl).send({ input: { title: "x" }, versionNumber: 2, mode: "try_it" }).expect(200);
      expect(evals.run).toHaveBeenCalledWith(
        { type: "user", userId: "board-user" },
        COMPANY,
        SLUG,
        { input: { title: "x" }, versionNumber: 2, mode: "try_it" },
        { runId: null },
      );
    });

    it("answers a failed run with 200 and the hint", async () => {
      const { app, evals } = setup();
      const failed: CompanyEvalRunResult = {
        ...runResult,
        outcome: "failed",
        failureReason: "no_key",
        answers: null,
        hint: "Add the company secret AI_GATEWAY_API_KEY",
      };
      evals.run.mockResolvedValue(failed);
      const response = await request(app).post(runsUrl).send({ input: { title: "x" } });
      expect(response.status).toBe(200);
      expect(response.body).toEqual(failed);
    });

    it("passes a run input of any shape to the service, because the service records a bad one", async () => {
      const { app, evals } = setup();
      evals.run.mockResolvedValue(runResult);
      for (const input of [null, "text", [1, 2], { nested: { deep: true } }]) {
        await request(app).post(runsUrl).send({ input }).expect(200);
      }
      expect(evals.run.mock.calls.map((call) => call[3].input)).toEqual([null, "text", [1, 2], { nested: { deep: true } }]);
    });

    it("passes the list query with its defaults", async () => {
      const { app, evals } = setup();
      evals.list.mockResolvedValue({ items: [], nextCursor: null });
      await request(app).get(evalsUrl).expect(200);
      await request(app).get(`${evalsUrl}?status=archived&limit=10&cursor=abc`).expect(200);
      expect(evals.list.mock.calls[0]?.[2]).toEqual({ limit: 50 });
      expect(evals.list.mock.calls[1]?.[2]).toEqual({ status: "archived", limit: 10, cursor: "abc" });
    });

    it("passes the run list filters, parsed", async () => {
      const { app, evals } = setup();
      evals.listRuns.mockResolvedValue({ items: [], nextCursor: null });
      await request(app)
        .get(`${runsUrl}?outcome=failed&mode=try_it&versionNumber=3&agentId=${AGENT_ID}&from=2026-10-01T00:00:00Z&limit=5`)
        .expect(200);
      expect(evals.listRuns.mock.calls[0]?.[3]).toEqual({
        outcome: "failed",
        mode: "try_it",
        versionNumber: 3,
        agentId: AGENT_ID,
        from: "2026-10-01T00:00:00Z",
        limit: 5,
      });
    });

    it("reads one version and one run by their path", async () => {
      const { app, evals } = setup();
      evals.getVersion.mockResolvedValue(versionRecord);
      evals.getRun.mockRejectedValue(new EvalsApplicationError("not_found", "Run not found"));
      await request(app).get(`${evalUrl}/versions/2`).expect(200);
      await request(app).get(`${runsUrl}/${RUN_ID}`).expect(404);
      expect(evals.getVersion).toHaveBeenCalledWith({ type: "user", userId: "board-user" }, COMPANY, SLUG, 2);
      expect(evals.getRun).toHaveBeenCalledWith({ type: "user", userId: "board-user" }, COMPANY, SLUG, RUN_ID);
    });
  });

  describe("a rejected input", () => {
    it("answers 422 with the code, the run id and the issues, and no input", async () => {
      const { app, evals } = setup();
      evals.run.mockRejectedValue(
        new EvalInputRejectedError("The input does not match the eval's input schema.", {
          code: "eval_input_invalid",
          runId: RUN_ID,
          errors: [{ path: "/title", message: "must be string" }],
        }),
      );
      const response = await request(app).post(runsUrl).send({ input: { title: CANARY, extra: CANARY } });
      expect(response.status).toBe(422);
      expect(response.body).toEqual({
        error: "The input does not match the eval's input schema.",
        code: "eval_input_invalid",
        runId: RUN_ID,
        details: { errors: [{ path: "/title", message: "must be string" }] },
      });
      expect(response.text).not.toContain(CANARY);
    });

    it("answers 422 with the size facts for an input that is too large", async () => {
      const { app, evals } = setup();
      evals.run.mockRejectedValue(
        new EvalInputRejectedError("The input is too large.", {
          code: "eval_input_too_large",
          runId: RUN_ID,
          maxInputBytes: 32_768,
          inputBytes: 40_000,
        }),
      );
      const response = await request(app).post(runsUrl).send({ input: { body: "x" } });
      expect(response.status).toBe(422);
      expect(response.body).toEqual({
        error: "The input is too large.",
        code: "eval_input_too_large",
        runId: RUN_ID,
        details: { maxInputBytes: 32_768, inputBytes: 40_000 },
      });
    });

    it("answers 422 only for a rejected input, never for another refusal", async () => {
      const { app, evals } = setup();
      evals.run.mockRejectedValue(new EvalsApplicationError("invalid_request", "The input must be a JSON object."));
      expect((await request(app).post(runsUrl).send({ input: [] })).status).toBe(400);
    });
  });

  describe("errors from the service", () => {
    it.each([
      ["not_found", 404],
      ["forbidden", 403],
      ["conflict", 409],
      ["invalid_request", 400],
    ] as const)("maps %s to HTTP %i with the message of the error", async (code, status) => {
      const { app, evals } = setup();
      evals.get.mockRejectedValue(new EvalsApplicationError(code, `The service said ${code}`));
      const response = await request(app).get(evalUrl);
      expect(response.status).toBe(status);
      expect(response.body.error).toBe(`The service said ${code}`);
    });

    it("carries the code of a conflict", async () => {
      const { app, evals } = setup();
      evals.remove.mockRejectedValue(
        new EvalsApplicationError("conflict", "This eval was published, so it keeps its history.", { code: "eval_has_history" }),
      );
      const response = await request(app).delete(evalUrl);
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: "eval_has_history" });
    });

    it("carries the code of a version conflict and a slug conflict", async () => {
      const { app, evals } = setup();
      evals.create.mockRejectedValue(new EvalsApplicationError("conflict", "Slug taken", { code: "eval_slug_taken" }));
      evals.createVersion.mockRejectedValue(new EvalsApplicationError("conflict", "Try again", { code: "eval_version_conflict" }));
      expect((await request(app).post(evalsUrl).send(createBody)).body).toMatchObject({ code: "eval_slug_taken" });
      expect((await request(app).post(`${evalUrl}/versions`).send(versionBody)).body).toMatchObject({ code: "eval_version_conflict" });
    });

    it("answers 500 for an input refusal outside the run route and for an unknown error", async () => {
      const { app, evals } = setup();
      evals.get.mockRejectedValueOnce(new EvalsApplicationError("input_rejected", "Not a thing here"));
      evals.get.mockRejectedValueOnce(new Error("storage unavailable"));
      expect((await request(app).get(evalUrl)).status).toBe(500);
      expect((await request(app).get(evalUrl)).status).toBe(500);
    });
  });

  describe("invalid requests", () => {
    const invalidBodies: Array<[string, "post" | "patch" | "put", string, Payload]> = [
      ["create without a body", "post", evalsUrl, {}],
      ["create with a bad slug", "post", evalsUrl, { ...createBody, slug: "Bad Slug" }],
      [
        "create with an input schema outside the subset",
        "post",
        evalsUrl,
        { ...createBody, inputSchema: { ...createBody.inputSchema, additionalProperties: true } },
      ],
      ["create with no questions", "post", evalsUrl, { ...createBody, questions: {} }],
      ["create with an unknown key", "post", evalsUrl, { ...createBody, status: "published" }],
      ["update with nothing to change", "patch", evalUrl, {}],
      ["update with an unknown key", "patch", evalUrl, { title: "New", slug: "other" }],
      ["a version without questions", "post", `${evalUrl}/versions`, { inputSchema: createBody.inputSchema }],
      ["publish with version 0", "post", `${evalUrl}/publish`, { versionNumber: 0 }],
      ["a run without an input", "post", runsUrl, {}],
      ["a run in the live mode", "post", runsUrl, { input: { title: CANARY }, mode: "live" }],
      ["a run with a bad issue id", "post", runsUrl, { input: { title: CANARY }, issueId: "not-a-uuid" }],
      ["a run with an unknown key", "post", runsUrl, { input: { title: CANARY }, agentId: AGENT_ID }],
      ["feedback without a verdict", "put", `${runsUrl}/${RUN_ID}/feedback`, { note: CANARY }],
      ["feedback with an unknown verdict", "put", `${runsUrl}/${RUN_ID}/feedback`, { verdict: "maybe", note: CANARY }],
      ["feedback with a note over 2000 characters", "put", `${runsUrl}/${RUN_ID}/feedback`, { verdict: "correct", note: CANARY.padEnd(2_001, "x") }],
    ];

    it.each(invalidBodies)("answers 400 for %s", async (_name, method, url, body) => {
      const { app, evals } = setup();
      const response = await request(app)[method](url).send(body);
      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Validation error");
      expect(response.text).not.toContain(CANARY);
      expect(serviceWasTouched(evals)).toBe(false);
      expect(activity.logActivity).not.toHaveBeenCalled();
    });

    it.each([
      ["a limit of 0", `${evalsUrl}?limit=0`],
      ["a limit over 200", `${evalsUrl}?limit=201`],
      ["an unknown status", `${evalsUrl}?status=bogus`],
      ["an unknown parameter", `${evalsUrl}?agentId=${AGENT_ID}`],
      ["a bad version list limit", `${evalUrl}/versions?limit=abc`],
      ["an unknown outcome", `${runsUrl}?outcome=nope`],
      ["a bad date", `${runsUrl}?from=yesterday`],
      ["a bad agent id", `${runsUrl}?agentId=agent-1`],
    ])("answers 400 for a query with %s", async (_name, url) => {
      const { app, evals } = setup();
      const response = await request(app).get(url);
      expect(response.status).toBe(400);
      expect(serviceWasTouched(evals)).toBe(false);
    });

    it.each([
      ["a slug that is not valid", "get", `${evalsUrl}/Bad_Slug`],
      ["a one-character slug", "get", `${evalsUrl}/x`],
      ["a version number of 0", "get", `${evalUrl}/versions/0`],
      ["a version number that is not a number", "get", `${evalUrl}/versions/abc`],
      ["a version number with a fraction", "get", `${evalUrl}/versions/1.5`],
      ["a run id that is not a uuid", "get", `${runsUrl}/not-a-uuid`],
    ] as const)("answers 404 for %s", async (_name, method, url) => {
      const { app, evals } = setup();
      const response = await request(app)[method](url);
      expect(response.status).toBe(404);
      expect(serviceWasTouched(evals)).toBe(false);
    });

    it("answers 404 for feedback on a run id that is not a uuid", async () => {
      const { app, evals } = setup();
      const response = await request(app).put(`${runsUrl}/not-a-uuid/feedback`).send({ verdict: "correct" });
      expect(response.status).toBe(404);
      expect(serviceWasTouched(evals)).toBe(false);
      expect(activity.logActivity).not.toHaveBeenCalled();
    });
  });

  describe("access to the company", () => {
    const everyRoute: Array<[string, "get" | "post" | "patch" | "put" | "delete", string, Payload]> = [
      ["list", "get", evalsUrl, undefined],
      ["create", "post", evalsUrl, createBody],
      ["detail", "get", evalUrl, undefined],
      ["update", "patch", evalUrl, { title: "New" }],
      ["delete", "delete", evalUrl, undefined],
      ["versions", "get", `${evalUrl}/versions`, undefined],
      ["new version", "post", `${evalUrl}/versions`, versionBody],
      ["one version", "get", `${evalUrl}/versions/1`, undefined],
      ["publish", "post", `${evalUrl}/publish`, {}],
      ["archive", "post", `${evalUrl}/archive`, undefined],
      ["run", "post", runsUrl, { input: { title: "x" } }],
      ["runs", "get", runsUrl, undefined],
      ["one run", "get", `${runsUrl}/${RUN_ID}`, undefined],
      ["feedback", "put", `${runsUrl}/${RUN_ID}/feedback`, { verdict: "correct" }],
    ];
    const writeRoutes = everyRoute.filter(([, method]) => method !== "get");

    it.each(everyRoute)("refuses a board user of another company on %s", async (_name, method, url, body) => {
      const { app, evals } = setup(boardActor({ companyIds: [OTHER_COMPANY], memberships: [{ companyId: OTHER_COMPANY, membershipRole: "owner", status: "active" }] }));
      const response = await request(app)[method](url).send(body);
      expect(response.status).toBe(403);
      expect(response.body.error).toBe("User does not have access to this company");
      expect(serviceWasTouched(evals)).toBe(false);
      expect(activity.logActivity).not.toHaveBeenCalled();
    });

    it.each(writeRoutes)("refuses a viewer on %s", async (_name, method, url, body) => {
      const { app, evals } = setup(boardActor({ memberships: [{ companyId: COMPANY, membershipRole: "viewer", status: "active" }] }));
      const response = await request(app)[method](url).send(body);
      expect(response.status).toBe(403);
      expect(response.body.error).toBe("Viewer access is read-only");
      expect(serviceWasTouched(evals)).toBe(false);
      expect(activity.logActivity).not.toHaveBeenCalled();
    });

    it("lets a viewer read", async () => {
      const { app, evals } = setup(boardActor({ memberships: [{ companyId: COMPANY, membershipRole: "viewer", status: "active" }] }));
      evals.list.mockResolvedValue({ items: [evalRecord], nextCursor: null });
      evals.get.mockResolvedValue(detailRecord);
      evals.listRuns.mockResolvedValue({ items: [], nextCursor: null });
      await request(app).get(evalsUrl).expect(200);
      await request(app).get(evalUrl).expect(200);
      await request(app).get(runsUrl).expect(200);
    });

    it("refuses a caller that is not signed in", async () => {
      const { app, evals } = setup({ type: "none", source: "none" });
      const response = await request(app).get(evalsUrl);
      expect(response.status).toBe(401);
      expect(serviceWasTouched(evals)).toBe(false);
    });

    it.each(everyRoute)("refuses an agent key of another company on %s", async (_name, method, url, body) => {
      const { app, evals } = setup(agentActor({ companyId: OTHER_COMPANY }));
      const response = await request(app)[method](url).send(body);
      expect(response.status).toBe(403);
      expect(response.body.error).toBe("Agent key cannot access another company");
      expect(serviceWasTouched(evals)).toBe(false);
    });

    it.each(everyRoute)("refuses an agent key with the skill_test scope on %s", async (_name, method, url, body) => {
      const { app, evals } = setup(agentActor({ keyScope: { kind: "skill_test", issueId: ISSUE_ID } }));
      const response = await request(app)[method](url).send(body);
      expect(response.status).toBe(403);
      expect(response.body.error).toBe("Skill-test run tokens cannot use evals.");
      expect(serviceWasTouched(evals)).toBe(false);
      expect(activity.logActivity).not.toHaveBeenCalled();
    });

    it("lets an agent key with the standard scope through, as an agent", async () => {
      const { app, evals } = setup(agentActor());
      evals.list.mockResolvedValue({ items: [], nextCursor: null });
      await request(app).get(evalsUrl).expect(200);
      expect(evals.list).toHaveBeenCalledWith({ type: "agent", agentId: AGENT_ID }, COMPANY, { limit: 50 });
    });

    it("lets the service decide what an agent may change, since the route trusts its actor mapping", async () => {
      const { app, evals } = setup(agentActor());
      evals.create.mockRejectedValue(new EvalsApplicationError("forbidden", "Only board users can change evals."));
      const response = await request(app).post(evalsUrl).send(createBody);
      expect(response.status).toBe(403);
      expect(evals.create.mock.calls[0]?.[0]).toEqual({ type: "agent", agentId: AGENT_ID });
      expect(activity.logActivity).not.toHaveBeenCalled();
    });

    it("refuses an agent whose identity is missing", async () => {
      const { app, evals } = setup(agentActor({ agentId: undefined }));
      const response = await request(app).get(evalsUrl);
      expect(response.status).toBe(403);
      expect(serviceWasTouched(evals)).toBe(false);
    });
  });
});
