import { Writable } from "node:stream";
import express from "express";
import pino from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { HttpError } from "../errors.js";
import { errorHandler } from "../middleware/error-handler.js";
import { HTTP_LOG_REDACT_PATHS } from "../middleware/http-log-redaction.js";
import { createHttpLogger } from "../middleware/logger.js";
import { EvalInputRejectedError, type EvalsService } from "../modules/evals/index.js";
import { companyEvalRoutes } from "../routes/company-evals.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const CANARY = "INPUT-CANARY-do-not-log";

function buildApp(evals: Partial<EvalsService>) {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const app = express();
  app.use(express.json());
  app.use(createHttpLogger(pino({ redact: [...HTTP_LOG_REDACT_PATHS] }, stream)));
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "board-user",
      source: "session",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", companyEvalRoutes({} as never, evals as EvalsService));
  app.use(errorHandler);
  return { app, output: () => chunks.join("") };
}

describe("company eval request logs", () => {
  const runRoute = `/api/companies/${companyId}/evals/triage/runs`;
  const feedbackRoute = `${runRoute}/${runId}/feedback`;

  it("keeps a rejected input out of the log (422)", async () => {
    const { app, output } = buildApp({
      run: async () => {
        throw new EvalInputRejectedError("Input does not match the schema", {
          code: "eval_input_invalid",
          runId,
          issues: [{ path: "/text", message: "must be string" }],
        } as never);
      },
    });
    await request(app).post(runRoute).send({ input: { text: CANARY } }).expect(422);
    const log = output();
    expect(log).toContain('"statusCode":422');
    expect(log).not.toContain(CANARY);
  });

  it("keeps the input out of the log when the run fails on the server (500)", async () => {
    const { app, output } = buildApp({
      run: async () => {
        throw new Error("storage unavailable");
      },
    });
    await request(app).post(runRoute).send({ input: { text: CANARY } }).expect(500);
    const log = output();
    expect(log).toContain('"statusCode":500');
    expect(log).not.toContain(CANARY);
  });

  it("keeps the input out of the log when the request is refused (404)", async () => {
    const { app, output } = buildApp({
      run: async () => {
        throw new HttpError(404, "Eval not found");
      },
    });
    await request(app).post(runRoute).send({ input: { text: CANARY } }).expect(404);
    expect(output()).not.toContain(CANARY);
  });

  it("keeps a feedback note out of the log on an error", async () => {
    const { app, output } = buildApp({
      putFeedback: async () => {
        throw new Error("storage unavailable");
      },
    });
    await request(app)
      .put(feedbackRoute)
      .send({ verdict: "incorrect", note: CANARY })
      .expect(500);
    expect(output()).not.toContain(CANARY);
  });

  it("keeps the input out of the log when the body fails validation (400)", async () => {
    const { app, output } = buildApp({});
    await request(app).post(runRoute).send({ input: { text: CANARY }, mode: "nonsense" }).expect(400);
    expect(output()).not.toContain(CANARY);
  });
});
