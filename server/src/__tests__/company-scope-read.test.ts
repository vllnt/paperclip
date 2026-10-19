import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { assertCompanyScopeReadAllowed } from "../routes/company-scope-read.js";
import type { AuthorizationDecision } from "../services/authorization.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const DENIED_MESSAGE = "Costs are outside this actor's authorization boundary";

const ALLOWED: AuthorizationDecision = {
  allowed: true,
  action: "company_scope:read",
  reason: "allow_local_board",
  explanation: "test",
};
const DENIED: AuthorizationDecision = {
  allowed: false,
  action: "company_scope:read",
  reason: "deny_scope",
  explanation: "test",
};

function appWith(decision: AuthorizationDecision) {
  const decide = vi.fn(async () => decision);
  const actor: Express.Request["actor"] = { type: "agent", agentId: "agent", companyId: COMPANY_ID, source: "agent_key" };
  const app = express();
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.get("/read", async (req, res) => {
    if (!(await assertCompanyScopeReadAllowed({ decide }, req, res, COMPANY_ID, DENIED_MESSAGE))) return;
    res.json({ ok: true });
  });
  return { app, decide, actor };
}

describe("assertCompanyScopeReadAllowed", () => {
  it("asks for company_scope:read on the company and lets an allowed actor through", async () => {
    const { app, decide, actor } = appWith(ALLOWED);

    const response = await request(app).get("/read");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(decide).toHaveBeenCalledWith({
      actor,
      action: "company_scope:read",
      resource: { type: "company", companyId: COMPANY_ID },
    });
  });

  it("answers 403 with the caller's message when the actor is denied", async () => {
    const { app } = appWith(DENIED);

    const response = await request(app).get("/read");

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: DENIED_MESSAGE });
  });
});
