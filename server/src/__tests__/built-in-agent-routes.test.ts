import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyId = "22222222-2222-4222-8222-222222222222";
const agentId = "11111111-1111-4111-8111-111111111111";

const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
  canUser: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

const mockBuiltInAgentService = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  ensure: vi.fn(),
  provision: vi.fn(),
  reset: vi.fn(),
  enableRoutineSchedule: vi.fn(),
  disableRoutineSchedule: vi.fn(),
  runRoutine: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

function allowDecision() {
  return {
    allowed: true,
    action: "agents:create",
    reason: "allow_explicit_grant",
    explanation: "Allowed.",
  };
}

function denyDecision() {
  return {
    allowed: false,
    action: "agents:create",
    reason: "deny_missing_grant",
    explanation: "Missing permission: agents:create.",
  };
}

function builtInState(overrides: Record<string, unknown> = {}) {
  return {
    definition: {
      key: "briefs",
      displayName: "Briefs Agent",
      featureKeys: ["briefs"],
      shortPurpose: "Prepares concise operational briefs.",
      defaultInstructions: "Write briefs.",
      defaultRole: "general",
      allowedAdapterTypes: ["codex_local"],
    },
    status: "ready",
    agentId,
    agent: {
      id: agentId,
      companyId,
      name: "Briefs Agent",
      role: "general",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
    },
    pauseReason: null,
    ...overrides,
  };
}

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    instanceSettingsService: () => mockInstanceSettingsService,
    logActivity: mockLogActivity,
  }));
  vi.doMock("../services/built-in-agents.js", () => ({
    builtInAgentService: () => mockBuiltInAgentService,
  }));
}

async function createApp(actor: Record<string, unknown>) {
  const [{ builtInAgentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/built-in-agents.js")>("../routes/built-in-agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", builtInAgentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("built-in agent routes", () => {
  beforeEach(() => {
    vi.resetModules();
    registerModuleMocks();
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue(allowDecision());
    mockAccessService.canUser.mockResolvedValue(true);
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableBuiltInAgents: true });
    mockBuiltInAgentService.list.mockResolvedValue([builtInState()]);
    mockBuiltInAgentService.get.mockResolvedValue(builtInState());
    mockBuiltInAgentService.ensure.mockResolvedValue(builtInState());
    mockBuiltInAgentService.provision.mockResolvedValue({ state: builtInState(), approval: null });
    mockBuiltInAgentService.reset.mockResolvedValue(builtInState());
    mockBuiltInAgentService.enableRoutineSchedule.mockResolvedValue(builtInState());
    mockBuiltInAgentService.disableRoutineSchedule.mockResolvedValue(builtInState());
    mockBuiltInAgentService.runRoutine.mockResolvedValue({ id: "routine-run-1", source: "manual", status: "queued" });
  });

  it("lists built-in agent state for actors with company access", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app).get(`/api/companies/${companyId}/built-in-agents`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockBuiltInAgentService.list).toHaveBeenCalledWith(companyId);
    expect(res.body).toEqual([expect.objectContaining({ status: "ready", agentId })]);
    expect(res.body[0].agent.adapterConfig).toEqual({});
  });

  it("denies list requests outside the actor company boundary", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: ["33333333-3333-4333-8333-333333333333"],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app).get(`/api/companies/${companyId}/built-in-agents`);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockBuiltInAgentService.list).not.toHaveBeenCalled();
  });

  it("returns 404 and does not load built-in state when the experimental flag is disabled", async () => {
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableBuiltInAgents: false });
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app).get(`/api/companies/${companyId}/built-in-agents`);

    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error).toContain("Built-in agents are not enabled");
    expect(mockBuiltInAgentService.list).not.toHaveBeenCalled();
  });

  it("provisions through the agents:create gate and passes optional adapter overrides", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/built-in-agents/briefs/provision`)
      .send({ adapterType: "codex_local", adapterConfig: { model: "gpt-5.4" }, budgetMonthlyCents: 5000 });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAccessService.decide).toHaveBeenCalledWith({
      actor: expect.objectContaining({ type: "board" }),
      action: "agents:create",
      resource: { type: "company", companyId },
    });
    expect(mockBuiltInAgentService.provision).toHaveBeenCalledWith(
      companyId,
      "briefs",
      {
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-5.4" },
        budgetMonthlyCents: 5000,
      },
      { requestedByAgentId: null, requestedByUserId: "board-user" },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "built_in_agent.provision_requested",
      entityId: agentId,
    }));
  });

  it("denies provision when agents:create is not allowed", async () => {
    mockAccessService.decide.mockResolvedValue(denyDecision());
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/built-in-agents/briefs/provision`)
      .send({ adapterType: "codex_local" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.details).toMatchObject({ reason: "deny_missing_grant" });
    expect(mockBuiltInAgentService.ensure).not.toHaveBeenCalled();
    expect(mockBuiltInAgentService.provision).not.toHaveBeenCalled();
  });

  it("rejects provision bodies with unknown fields", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/built-in-agents/briefs/provision`)
      .send({ adapterType: "codex_local", unexpected: true });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(mockBuiltInAgentService.ensure).not.toHaveBeenCalled();
    expect(mockBuiltInAgentService.provision).not.toHaveBeenCalled();
  });

  it("enables a built-in routine schedule through the board tasks:assign gate", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/built-in-agents/reflection-coach/routines/recent-agent-reflection/enable`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAccessService.canUser).toHaveBeenCalledWith(companyId, "board-user", "tasks:assign");
    expect(mockBuiltInAgentService.enableRoutineSchedule).toHaveBeenCalledWith(
      companyId,
      "reflection-coach",
      "recent-agent-reflection",
      { agentId: null, userId: "board-user", runId: null },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "built_in_agent.routine_schedule_enabled",
      entityId: agentId,
      details: expect.objectContaining({ routineKey: "recent-agent-reflection" }),
    }));
  });

  it("disables a built-in routine schedule", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/built-in-agents/reflection-coach/routines/recent-agent-reflection/disable`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockBuiltInAgentService.disableRoutineSchedule).toHaveBeenCalledWith(
      companyId,
      "reflection-coach",
      "recent-agent-reflection",
      { agentId: null, userId: "board-user", runId: null },
    );
  });

  it("triggers a built-in routine manual run", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/built-in-agents/reflection-coach/routines/recent-agent-reflection/run`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body).toMatchObject({ id: "routine-run-1", source: "manual" });
    expect(mockBuiltInAgentService.runRoutine).toHaveBeenCalledWith(
      companyId,
      "reflection-coach",
      "recent-agent-reflection",
      { agentId: null, userId: "board-user", runId: null },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "built_in_agent.routine_run_triggered",
      details: expect.objectContaining({ routineRunId: "routine-run-1" }),
    }));
  });

  it("denies built-in routine controls when tasks:assign is not allowed", async () => {
    mockAccessService.canUser.mockResolvedValue(false);
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/built-in-agents/reflection-coach/routines/recent-agent-reflection/run`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockBuiltInAgentService.runRoutine).not.toHaveBeenCalled();
  });

  it("denies agent actors from controlling built-in routines", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "manager-agent",
      companyId,
      source: "agent_key",
      runId: "55555555-5555-4555-8555-555555555555",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/built-in-agents/reflection-coach/routines/recent-agent-reflection/run`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Only board operators can control built-in routines.");
    expect(mockAccessService.canUser).not.toHaveBeenCalled();
    expect(mockBuiltInAgentService.runRoutine).not.toHaveBeenCalled();
  });

  it("returns pending hire approvals instead of provisioning immediately when company policy requires it", async () => {
    const approval = {
      id: "approval-1",
      status: "pending",
      type: "hire_agent",
    };
    mockBuiltInAgentService.provision.mockResolvedValue({
      state: builtInState({
        status: "pending_approval",
        agent: { ...builtInState().agent, status: "pending_approval" },
      }),
      approval,
    });
    const app = await createApp({
      type: "agent",
      agentId: "manager-agent",
      companyId,
      source: "agent_key",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/built-in-agents/briefs/provision`)
      .send({ adapterType: "codex_local", adapterConfig: { model: "gpt-5.4" } });

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.status).toBe("pending_approval");
    expect(res.body.approval).toMatchObject({ id: "approval-1", status: "pending", type: "hire_agent" });
    expect(mockBuiltInAgentService.ensure).not.toHaveBeenCalled();
    expect(mockBuiltInAgentService.provision).toHaveBeenCalledWith(
      companyId,
      "briefs",
      { adapterType: "codex_local", adapterConfig: { model: "gpt-5.4" } },
      { requestedByAgentId: "manager-agent", requestedByUserId: null },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId,
      actorType: "agent",
      actorId: "manager-agent",
      action: "approval.created",
      entityId: "approval-1",
    }));
  });

  it("resets registry defaults through the same agents:create gate", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "manager-agent",
      companyId,
      source: "agent_key",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/built-in-agents/briefs/reset`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockBuiltInAgentService.reset).toHaveBeenCalledWith(companyId, "briefs", {}, expect.objectContaining({ type: "agent", agentId: "manager-agent" }));
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId,
      actorType: "agent",
      actorId: "manager-agent",
      agentId: "manager-agent",
      action: "built_in_agent.reset",
      entityId: agentId,
    }));
  });

  it("denies agent actors from provisioning across company boundaries", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "manager-agent",
      companyId: "33333333-3333-4333-8333-333333333333",
      source: "agent_key",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/built-in-agents/briefs/reset`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockAccessService.decide).not.toHaveBeenCalled();
    expect(mockBuiltInAgentService.reset).not.toHaveBeenCalled();
  });

  describe("agent caller provisioning an existing built-in agent", () => {
    const agentCaller = {
      type: "agent",
      agentId: "99999999-9999-4999-8999-999999999999",
      companyId,
      runId: "run-1",
      source: "agent_jwt",
    };

    function decideByAction(configureAllowed: boolean) {
      mockAccessService.decide.mockImplementation(async ({ action }: { action: string }) => {
        if (action === "agent_config:update" && !configureAllowed) {
          return { allowed: false, action, reason: "deny_no_grant", explanation: "Missing permission: agents:configure." };
        }
        return { allowed: true, action, reason: "allow_explicit_grant", explanation: "Allowed." };
      });
    }

    it.each([
      {
        label: "adapter config",
        body: { adapterType: "codex_local", adapterConfig: { model: "gpt-large" } },
        fields: ["adapterConfig.model"],
      },
      { label: "adapter type", body: { adapterType: "claude_local" }, fields: ["adapterType"] },
      {
        label: "budget",
        body: { adapterType: "codex_local", budgetMonthlyCents: 9_999_999 },
        fields: ["budgetMonthlyCents"],
      },
    ])("denies a changed $label without agents:configure and logs it", async ({ body, fields }) => {
      mockBuiltInAgentService.get.mockResolvedValue(
        builtInState({ agent: { ...builtInState().agent, runtimeConfig: {}, budgetMonthlyCents: 1_000 } }),
      );
      decideByAction(false);
      const app = await createApp(agentCaller);

      const res = await request(app)
        .post(`/api/companies/${companyId}/built-in-agents/briefs/provision`)
        .send(body);

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.details).toMatchObject({ code: "agent_self_protected_config_change", fields });
      expect(mockBuiltInAgentService.provision).not.toHaveBeenCalled();
      expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        companyId,
        actorType: "agent",
        actorId: agentCaller.agentId,
        action: "agent.self_config_update_denied",
        entityId: agentId,
        details: expect.objectContaining({ surface: "built_in_provision", fields, builtInAgentKey: "briefs" }),
      }));
    });

    it("still provisions when the body changes no protected field", async () => {
      mockBuiltInAgentService.get.mockResolvedValue(
        builtInState({ agent: { ...builtInState().agent, runtimeConfig: {}, budgetMonthlyCents: 1_000 } }),
      );
      decideByAction(false);
      const app = await createApp(agentCaller);

      const res = await request(app)
        .post(`/api/companies/${companyId}/built-in-agents/briefs/provision`)
        .send({ adapterType: "codex_local", adapterConfig: { model: "gpt-5.4" }, budgetMonthlyCents: 1_000 });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockBuiltInAgentService.provision).toHaveBeenCalled();
    });

    it("still provisions a protected change for an agent holding agents:configure", async () => {
      mockBuiltInAgentService.get.mockResolvedValue(
        builtInState({ agent: { ...builtInState().agent, runtimeConfig: {}, budgetMonthlyCents: 1_000 } }),
      );
      decideByAction(true);
      const app = await createApp(agentCaller);

      const res = await request(app)
        .post(`/api/companies/${companyId}/built-in-agents/briefs/provision`)
        .send({ adapterType: "codex_local", budgetMonthlyCents: 9_999_999 });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockBuiltInAgentService.provision).toHaveBeenCalled();
    });

    it.each([
      {
        label: "adapter config",
        body: { adapterType: "codex_local", adapterConfig: { model: "gpt-large", dangerouslyBypassApprovalsAndSandbox: true } },
        fields: ["adapterConfig.dangerouslyBypassApprovalsAndSandbox", "adapterConfig.model"],
      },
      {
        label: "budget",
        body: { adapterType: "codex_local", budgetMonthlyCents: 9_999_999 },
        fields: ["budgetMonthlyCents"],
      },
    ])("denies a first-time provision with $label from an agent and logs it against the company", async ({ body, fields }) => {
      mockBuiltInAgentService.get.mockResolvedValue(builtInState({ agent: null }));
      decideByAction(false);
      const app = await createApp(agentCaller);

      const res = await request(app)
        .post(`/api/companies/${companyId}/built-in-agents/briefs/provision`)
        .send(body);

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.details).toMatchObject({ code: "agent_self_protected_config_change", fields });
      expect(mockBuiltInAgentService.provision).not.toHaveBeenCalled();
      expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        companyId,
        actorType: "agent",
        entityType: "company",
        entityId: companyId,
        action: "agent.self_config_update_denied",
        details: expect.objectContaining({ surface: "built_in_first_provision", fields, builtInAgentKey: "briefs" }),
      }));
    });

    it("still lets an agent first-provision a built-in agent with no protected settings", async () => {
      mockBuiltInAgentService.get.mockResolvedValue(builtInState({ agent: null }));
      decideByAction(false);
      const app = await createApp(agentCaller);

      const res = await request(app)
        .post(`/api/companies/${companyId}/built-in-agents/briefs/provision`)
        .send({ adapterType: "codex_local" });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockBuiltInAgentService.provision).toHaveBeenCalled();
    });

    it("still first-provisions protected settings for an agent holding agents:configure", async () => {
      mockBuiltInAgentService.get.mockResolvedValue(builtInState({ agent: null }));
      decideByAction(true);
      const app = await createApp(agentCaller);

      const res = await request(app)
        .post(`/api/companies/${companyId}/built-in-agents/briefs/provision`)
        .send({ adapterType: "codex_local", budgetMonthlyCents: 9_999_999 });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockBuiltInAgentService.provision).toHaveBeenCalled();
    });

    function engineerBuiltInState() {
      return builtInState({ agent: { ...builtInState().agent, role: "engineer" } });
    }

    it("denies a reset that would change the stored role without agents:configure, and logs it", async () => {
      mockBuiltInAgentService.get.mockResolvedValue(engineerBuiltInState());
      decideByAction(false);
      const app = await createApp(agentCaller);

      const res = await request(app)
        .post(`/api/companies/${companyId}/built-in-agents/briefs/reset`)
        .send({});

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.details).toMatchObject({ code: "agent_self_protected_config_change", fields: ["role"] });
      expect(mockBuiltInAgentService.reset).not.toHaveBeenCalled();
      expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: "agent.self_config_update_denied",
        entityId: agentId,
        details: expect.objectContaining({ surface: "built_in_reset", fields: ["role"], builtInAgentKey: "briefs" }),
      }));
    });

    it("still resets when the stored role already matches the default, and when the reset leaves the agent row out", async () => {
      decideByAction(false);
      const app = await createApp(agentCaller);

      mockBuiltInAgentService.get.mockResolvedValue(builtInState());
      const matching = await request(app).post(`/api/companies/${companyId}/built-in-agents/briefs/reset`).send({});
      expect(matching.status, JSON.stringify(matching.body)).toBe(200);

      mockBuiltInAgentService.get.mockResolvedValue(engineerBuiltInState());
      const instructionsOnly = await request(app)
        .post(`/api/companies/${companyId}/built-in-agents/briefs/reset`)
        .send({ resources: ["instructions"] });
      expect(instructionsOnly.status, JSON.stringify(instructionsOnly.body)).toBe(200);
      expect(mockBuiltInAgentService.reset).toHaveBeenCalledTimes(2);
    });

    it("still resets a changed role for an agent holding agents:configure", async () => {
      mockBuiltInAgentService.get.mockResolvedValue(engineerBuiltInState());
      decideByAction(true);
      const app = await createApp(agentCaller);

      const res = await request(app).post(`/api/companies/${companyId}/built-in-agents/briefs/reset`).send({});

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockBuiltInAgentService.reset).toHaveBeenCalled();
    });

    it("keeps a board caller unchanged", async () => {
      mockBuiltInAgentService.get.mockResolvedValue(builtInState());
      decideByAction(false);
      const app = await createApp({
        type: "board",
        userId: "board-user",
        companyIds: [companyId],
        source: "session",
        isInstanceAdmin: false,
      });

      const res = await request(app)
        .post(`/api/companies/${companyId}/built-in-agents/briefs/provision`)
        .send({ budgetMonthlyCents: 9_999_999 });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockBuiltInAgentService.get).not.toHaveBeenCalled();
    });
  });
});
