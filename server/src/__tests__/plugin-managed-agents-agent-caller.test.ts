import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentConfigRevisions,
  agents,
  approvals,
  companies,
  companyMemberships,
  createDb,
  pluginCompanySettings,
  pluginEntities,
  pluginManagedResources,
  plugins,
  principalPermissionGrants,
} from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET, type PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { runWithPluginHostCallAgent } from "../services/plugin-host-call-actor.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin managed-agent agent-caller tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;

const MANIFEST: PaperclipPluginManifestV1 = {
  id: "paperclip.managed-agent-caller-test",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Managed Agent Caller Test",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["agents.managed"],
  entrypoints: { worker: "./dist/worker.js" },
  agents: [
    {
      agentKey: "wiki-maintainer",
      displayName: "Wiki Maintainer",
      role: "engineer",
      title: "Maintains plugin-owned knowledge",
      capabilities: "Maintains a plugin-owned wiki.",
      adapterType: "process",
      adapterConfig: { command: "pnpm wiki:maintain" },
      runtimeConfig: { heartbeat: { enabled: false, maxDailyRuns: 5 } },
      permissions: { canCreateAgents: false },
      budgetMonthlyCents: 1234,
    },
  ],
};

const EVENT_BUS_STUB = {
  forPlugin() {
    return { emit: async () => {}, subscribe: () => {} };
  },
} as never;

describeEmbeddedPostgres("plugin managed-agent reset by an agent caller", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-managed-agent-caller-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentConfigRevisions);
    await db.delete(activityLog);
    await db.delete(pluginEntities);
    await db.delete(pluginManagedResources);
    await db.delete(pluginCompanySettings);
    await db.delete(approvals);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** Seeds a company, the plugin, a managed agent whose config has drifted from the plugin defaults, and a peer agent that can call the plugin. */
  async function seed(options: { provision?: boolean; manifest?: PaperclipPluginManifestV1 } = {}) {
    const manifest = options.manifest ?? MANIFEST;
    const companyId = randomUUID();
    const pluginId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: manifest.id,
      packageName: "@paperclipai/plugin-managed-agent-caller-test",
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      categories: manifest.categories,
      manifestJson: manifest,
      status: "ready",
      installOrder: 1,
    });
    const services = buildHostServices(db, pluginId, manifest.id, EVENT_BUS_STUB, undefined, { manifest });
    let managedAgentId = "";
    if (options.provision !== false) {
      const created = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });
      managedAgentId = created.agentId!;
      await db
        .update(agents)
        .set({
          adapterConfig: { command: "custom", model: "large-model" },
          runtimeConfig: { heartbeat: { enabled: true, maxDailyRuns: 5000 } },
          budgetMonthlyCents: 999_999,
          permissions: { canCreateAgents: true },
        })
        .where(eq(agents.id, managedAgentId));
    }
    const [peer] = await db
      .insert(agents)
      .values({
        companyId,
        name: "Caller",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })
      .returning();
    await db.insert(companyMemberships).values(
      [managedAgentId, peer!.id].filter(Boolean).map((principalId) => ({
        companyId,
        principalType: "agent" as const,
        principalId,
        status: "active",
        membershipRole: "member",
      })),
    );
    return { companyId, services, managedAgentId, peerId: peer!.id };
  }

  async function readAgent(agentId: string) {
    return db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]!);
  }

  async function deniedActivity(agentId: string) {
    return db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, agentId), eq(activityLog.action, "agent.self_config_update_denied")));
  }

  const PROTECTED_FIELDS = [
    "budgetMonthlyCents",
    "adapterConfig.command",
    "adapterConfig.model",
    "runtimeConfig.heartbeat.enabled",
    "runtimeConfig.heartbeat.maxDailyRuns",
    "permissions.canCreateAgents",
  ];

  it.each([
    { label: "a peer agent", caller: "peer" as const },
    { label: "the managed agent itself", caller: "self" as const },
  ])("denies a reset started by $label that would rewrite protected fields, and logs it", async ({ caller }) => {
    const { companyId, services, managedAgentId, peerId } = await seed();
    const before = await readAgent(managedAgentId);
    const callerId = caller === "self" ? managedAgentId : peerId;

    await expect(
      runWithPluginHostCallAgent({ agentId: callerId, runId: null, companyId }, () =>
        services.agents.managedReset({ companyId, agentKey: "wiki-maintainer" })),
    ).rejects.toMatchObject({
      status: 403,
      details: { code: "agent_self_protected_config_change", fields: PROTECTED_FIELDS },
    });

    const after = await readAgent(managedAgentId);
    expect(after).toMatchObject({
      adapterConfig: before.adapterConfig,
      runtimeConfig: before.runtimeConfig,
      budgetMonthlyCents: before.budgetMonthlyCents,
      permissions: before.permissions,
      name: before.name,
    });
    const denied = await deniedActivity(managedAgentId);
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      companyId,
      actorType: "agent",
      actorId: callerId,
      agentId: callerId,
      details: {
        surface: "plugin_managed_reset",
        fields: PROTECTED_FIELDS,
        reason: "deny_no_grant",
        sourcePluginKey: MANIFEST.id,
        managedResourceKey: "wiki-maintainer",
      },
    });
    const resets = await db.select().from(activityLog).where(eq(activityLog.action, "plugin.managed_agent.reset"));
    expect(resets).toHaveLength(0);
  });

  it("still resets for a call that no agent started (board, user, or system)", async () => {
    const { companyId, services, managedAgentId } = await seed();

    const reset = await services.agents.managedReset({ companyId, agentKey: "wiki-maintainer" });

    expect(reset.status).toBe("reset");
    expect(await readAgent(managedAgentId)).toMatchObject({
      adapterConfig: { command: "pnpm wiki:maintain" },
      runtimeConfig: { heartbeat: { enabled: false, maxDailyRuns: 5 } },
      budgetMonthlyCents: 1234,
    });
    expect(await deniedActivity(managedAgentId)).toHaveLength(0);
  });

  it.each([
    { label: "company-wide", scope: null },
    { label: "scoped to the managed agent", scope: "managed" },
  ])("still resets for an agent holding $label agents:configure", async ({ scope }) => {
    const { companyId, services, managedAgentId, peerId } = await seed();
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "agent",
      principalId: peerId,
      permissionKey: "agents:configure",
      scope: scope === "managed" ? { agentIds: [managedAgentId] } : null,
      grantedByUserId: null,
    });

    const reset = await runWithPluginHostCallAgent({ agentId: peerId, runId: null, companyId }, () =>
      services.agents.managedReset({ companyId, agentKey: "wiki-maintainer" }));

    expect(reset.status).toBe("reset");
    expect(await readAgent(managedAgentId)).toMatchObject({ budgetMonthlyCents: 1234 });
    expect(await deniedActivity(managedAgentId)).toHaveLength(0);
  });

  it("allows an agent-started reset that changes no protected field", async () => {
    const { companyId, services, managedAgentId, peerId } = await seed();
    await services.agents.managedReset({ companyId, agentKey: "wiki-maintainer" });
    await db.update(agents).set({ title: "Edited title" }).where(eq(agents.id, managedAgentId));

    const reset = await runWithPluginHostCallAgent({ agentId: peerId, runId: null, companyId }, () =>
      services.agents.managedReset({ companyId, agentKey: "wiki-maintainer" }));

    expect(reset.status).toBe("reset");
    expect(await readAgent(managedAgentId)).toMatchObject({ title: "Maintains plugin-owned knowledge" });
    expect(await deniedActivity(managedAgentId)).toHaveLength(0);
  });

  const ELEVATED_MANIFEST: PaperclipPluginManifestV1 = {
    ...MANIFEST,
    agents: [{
      ...MANIFEST.agents![0]!,
      adapterConfig: { command: "pnpm wiki:maintain", model: "large-model", dangerouslySkipPermissions: true },
      permissions: { canCreateAgents: true },
    }],
  };

  async function agentCount(companyId: string) {
    return (await db.select().from(agents).where(eq(agents.companyId, companyId))).length;
  }

  async function deniedForCompany(companyId: string) {
    return db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, companyId), eq(activityLog.action, "agent.self_config_update_denied")));
  }

  it("denies a reconcile started by an agent that would create a managed agent with protected fields, and logs it", async () => {
    const { companyId, services, peerId } = await seed({ provision: false });

    await expect(
      runWithPluginHostCallAgent({ agentId: peerId, runId: null, companyId }, () =>
        services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" })),
    ).rejects.toMatchObject({
      status: 403,
      details: {
        code: "agent_self_protected_config_change",
        fields: ["budgetMonthlyCents", "adapterConfig.command", "runtimeConfig.heartbeat.maxDailyRuns"],
      },
    });

    expect(await agentCount(companyId)).toBe(1);
    const denied = await deniedForCompany(companyId);
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      companyId,
      actorType: "agent",
      actorId: peerId,
      agentId: peerId,
      entityType: "company",
      details: {
        surface: "plugin_managed_create",
        reason: "deny_no_grant",
        sourcePluginKey: MANIFEST.id,
        managedResourceKey: "wiki-maintainer",
      },
    });
  });

  it("denies a declaration that grants canCreateAgents, a model, and a permission bypass flag to an agent-started create", async () => {
    const { companyId, services, peerId } = await seed({ provision: false, manifest: ELEVATED_MANIFEST });

    await expect(
      runWithPluginHostCallAgent({ agentId: peerId, runId: null, companyId }, () =>
        services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" })),
    ).rejects.toMatchObject({
      status: 403,
      details: {
        fields: expect.arrayContaining([
          "adapterConfig.dangerouslySkipPermissions",
          "adapterConfig.model",
          "permissions.canCreateAgents",
        ]),
      },
    });
    expect(await agentCount(companyId)).toBe(1);
  });

  it("still creates the managed agent for a call that no agent started (board, user, or system)", async () => {
    const { companyId, services } = await seed({ provision: false, manifest: ELEVATED_MANIFEST });

    const created = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });

    expect(created.status).toBe("created");
    expect(await agentCount(companyId)).toBe(2);
    expect(await deniedForCompany(companyId)).toHaveLength(0);
  });

  it("still creates the managed agent for an agent holding company-wide agents:configure", async () => {
    const { companyId, services, peerId } = await seed({ provision: false, manifest: ELEVATED_MANIFEST });
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "agent",
      principalId: peerId,
      permissionKey: "agents:configure",
      scope: null,
      grantedByUserId: null,
    });

    const created = await runWithPluginHostCallAgent({ agentId: peerId, runId: null, companyId }, () =>
      services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" }));

    expect(created.status).toBe("created");
    expect(await deniedForCompany(companyId)).toHaveLength(0);
  });

  it.each([
    { change: "resume" as const, from: "paused", to: "idle" },
    { change: "pause" as const, from: "idle", to: "paused" },
  ])("denies a $change started by an agent without agents:configure, and logs it", async ({ change, from }) => {
    const { companyId, services, managedAgentId, peerId } = await seed();
    await db.update(agents).set({ status: from, pauseReason: from === "paused" ? "budget" : null }).where(eq(agents.id, managedAgentId));

    await expect(
      runWithPluginHostCallAgent({ agentId: peerId, runId: null, companyId }, () =>
        services.agents[change]({ companyId, agentId: managedAgentId })),
    ).rejects.toMatchObject({ status: 403, details: { code: "agent_self_protected_config_change", fields: ["status"] } });

    expect((await readAgent(managedAgentId)).status).toBe(from);
    expect((await deniedActivity(managedAgentId))[0]).toMatchObject({
      actorId: peerId,
      details: { surface: "plugin_status_change", change, sourcePluginKey: MANIFEST.id },
    });
  });

  it("denies the managed agent resuming itself through a plugin call", async () => {
    const { companyId, services, managedAgentId } = await seed();
    await db.update(agents).set({ status: "paused", pauseReason: "budget" }).where(eq(agents.id, managedAgentId));

    await expect(
      runWithPluginHostCallAgent({ agentId: managedAgentId, runId: null, companyId }, () =>
        services.agents.resume({ companyId, agentId: managedAgentId })),
    ).rejects.toMatchObject({ status: 403 });
    expect((await readAgent(managedAgentId)).status).toBe("paused");
  });

  it("still pauses and resumes for a call that no agent started, and for an agent holding agents:configure", async () => {
    const { companyId, services, managedAgentId, peerId } = await seed();

    expect((await services.agents.pause({ companyId, agentId: managedAgentId })).status).toBe("paused");
    expect((await services.agents.resume({ companyId, agentId: managedAgentId })).status).toBe("idle");

    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "agent",
      principalId: peerId,
      permissionKey: "agents:configure",
      scope: null,
      grantedByUserId: null,
    });
    const paused = await runWithPluginHostCallAgent({ agentId: peerId, runId: null, companyId }, () =>
      services.agents.pause({ companyId, agentId: managedAgentId }));
    expect(paused.status).toBe("paused");
    expect(await deniedActivity(managedAgentId)).toHaveLength(0);
  });

  const POLICY = { trustPreset: "standard" };

  function updateAgentPolicy(services: Awaited<ReturnType<typeof seed>>["services"], companyId: string, agentId: string) {
    return services.authorization.updatePolicy({ companyId, resourceType: "agent", resourceId: agentId, policy: POLICY });
  }

  it.each([
    { label: "a peer agent", caller: "peer" as const },
    { label: "the agent itself", caller: "self" as const },
  ])("refuses an agent policy update started by $label without agents:configure, and logs it", async ({ caller }) => {
    const { companyId, services, managedAgentId, peerId } = await seed();
    const before = await readAgent(managedAgentId);
    const callerId = caller === "self" ? managedAgentId : peerId;

    await expect(
      runWithPluginHostCallAgent({ agentId: callerId, runId: null, companyId }, () =>
        updateAgentPolicy(services, companyId, managedAgentId)),
    ).rejects.toMatchObject({
      status: 403,
      details: { code: "agent_self_protected_config_change", fields: ["permissions.authorizationPolicy"] },
    });

    expect((await readAgent(managedAgentId)).permissions).toEqual(before.permissions);
    expect((await deniedActivity(managedAgentId))[0]).toMatchObject({
      actorId: callerId,
      details: { surface: "plugin_policy_update", sourcePluginKey: MANIFEST.id },
    });
  });

  it("still updates an agent policy for a call that no agent started, and for an agent holding agents:configure", async () => {
    const { companyId, services, managedAgentId, peerId } = await seed();

    const updated = await updateAgentPolicy(services, companyId, managedAgentId);
    expect(updated.policy).toEqual(POLICY);

    await services.authorization.updatePolicy({ companyId, resourceType: "agent", resourceId: managedAgentId, policy: null });
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "agent",
      principalId: peerId,
      permissionKey: "agents:configure",
      scope: null,
      grantedByUserId: null,
    });
    const granted = await runWithPluginHostCallAgent({ agentId: peerId, runId: null, companyId }, () =>
      updateAgentPolicy(services, companyId, managedAgentId));
    expect(granted.policy).toEqual(POLICY);
    expect(await deniedActivity(managedAgentId)).toHaveLength(0);
  });

  it("refuses an agent without agents:configure removing a stored policy, and keeps it", async () => {
    const { companyId, services, managedAgentId, peerId } = await seed();
    const stored = { trustPreset: LOW_TRUST_REVIEW_PRESET };
    await db.update(agents).set({ permissions: { authorizationPolicy: stored } }).where(eq(agents.id, managedAgentId));

    await expect(
      runWithPluginHostCallAgent({ agentId: peerId, runId: null, companyId }, () =>
        services.authorization.updatePolicy({ companyId, resourceType: "agent", resourceId: managedAgentId, policy: null })),
    ).rejects.toMatchObject({ status: 403 });

    expect((await readAgent(managedAgentId)).permissions).toMatchObject({ authorizationPolicy: stored });
  });

  it.each([
    { label: "a company-wide agents:configure grant", scope: null, allowed: false },
    { label: "an agents:configure grant that names the agent", scope: "self", allowed: true },
  ])("for the agent updating its own policy, $label decides: allowed=$allowed", async ({ scope, allowed }) => {
    const { companyId, services, managedAgentId } = await seed();
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "agent",
      principalId: managedAgentId,
      permissionKey: "agents:configure",
      scope: scope === "self" ? { agentIds: [managedAgentId] } : null,
      grantedByUserId: null,
    });

    const attempt = runWithPluginHostCallAgent({ agentId: managedAgentId, runId: null, companyId }, () =>
      updateAgentPolicy(services, companyId, managedAgentId));

    if (allowed) {
      expect((await attempt).policy).toEqual(POLICY);
    } else {
      await expect(attempt).rejects.toMatchObject({ status: 403 });
      expect((await readAgent(managedAgentId)).permissions).not.toHaveProperty("authorizationPolicy");
    }
  });

  async function grantKeys(companyId: string, principalId: string) {
    const rows = await db
      .select()
      .from(principalPermissionGrants)
      .where(and(eq(principalPermissionGrants.companyId, companyId), eq(principalPermissionGrants.principalId, principalId)));
    return rows.map((row) => row.permissionKey).sort();
  }

  function setGrants(
    services: Awaited<ReturnType<typeof seed>>["services"],
    companyId: string,
    principalType: "agent" | "user",
    principalId: string,
  ) {
    return services.authorization.setGrants({
      companyId,
      principalType,
      principalId,
      grants: [{ permissionKey: "agents:configure" }],
    });
  }

  it.each([
    { label: "another agent", target: "managed" as const },
    { label: "itself", target: "peer" as const },
  ])("refuses a grant update for $label started by an agent without agents:configure, and logs it", async ({ target }) => {
    const { companyId, services, managedAgentId, peerId } = await seed();
    const targetId = target === "peer" ? peerId : managedAgentId;

    await expect(
      runWithPluginHostCallAgent({ agentId: peerId, runId: null, companyId }, () =>
        setGrants(services, companyId, "agent", targetId)),
    ).rejects.toMatchObject({
      status: 403,
      details: { code: "agent_self_protected_config_change", fields: ["grants.agents:configure"] },
    });

    expect(await grantKeys(companyId, targetId)).toEqual([]);
    expect((await deniedActivity(targetId))[0]).toMatchObject({
      actorId: peerId,
      details: { surface: "plugin_grants_update", sourcePluginKey: MANIFEST.id },
    });
  });

  it("refuses a grant update for a user member started by an agent", async () => {
    const { companyId, services, peerId } = await seed();
    const userId = `user-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "operator",
    });

    await expect(
      runWithPluginHostCallAgent({ agentId: peerId, runId: null, companyId }, () =>
        setGrants(services, companyId, "user", userId)),
    ).rejects.toMatchObject({ status: 403 });

    expect(await grantKeys(companyId, userId)).toEqual([]);
  });

  it("refuses an agent-started grant update for a non-member with the same 403, so the answer does not reveal who is a member", async () => {
    const { companyId, services, peerId } = await seed();
    const strangerId = `user-${randomUUID()}`;

    await expect(
      runWithPluginHostCallAgent({ agentId: peerId, runId: null, companyId }, () =>
        setGrants(services, companyId, "user", strangerId)),
    ).rejects.toMatchObject({ status: 403 });

    await expect(setGrants(services, companyId, "user", strangerId)).rejects.toThrow("Principal is not a member of this company");
  });

  it("still sets grants for a call that no agent started, and for an agent holding company-wide agents:configure on another agent", async () => {
    const { companyId, services, managedAgentId, peerId } = await seed();
    const userId = `user-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "operator",
    });

    await setGrants(services, companyId, "user", userId);
    await setGrants(services, companyId, "agent", managedAgentId);
    expect(await grantKeys(companyId, userId)).toEqual(["agents:configure"]);
    expect(await grantKeys(companyId, managedAgentId)).toEqual(["agents:configure"]);
    await services.authorization.setGrants({ companyId, principalType: "agent", principalId: managedAgentId, grants: [] });

    await db.insert(principalPermissionGrants).values({
      companyId, principalType: "agent", principalId: peerId, permissionKey: "agents:configure", scope: null, grantedByUserId: null,
    });
    await runWithPluginHostCallAgent({ agentId: peerId, runId: null, companyId }, () =>
      setGrants(services, companyId, "agent", managedAgentId));
    expect(await grantKeys(companyId, managedAgentId)).toEqual(["agents:configure"]);
    expect(await deniedActivity(managedAgentId)).toHaveLength(0);
  });

  it("refuses an agent with only a company-wide agents:configure grant adding a grant to itself", async () => {
    const { companyId, services, peerId } = await seed();
    await db.insert(principalPermissionGrants).values({
      companyId, principalType: "agent", principalId: peerId, permissionKey: "agents:configure", scope: null, grantedByUserId: null,
    });

    await expect(
      runWithPluginHostCallAgent({ agentId: peerId, runId: null, companyId }, () =>
        services.authorization.setGrants({
          companyId,
          principalType: "agent",
          principalId: peerId,
          grants: [{ permissionKey: "agents:configure" }, { permissionKey: "users:manage_permissions" }],
        })),
    ).rejects.toMatchObject({ status: 403, details: { fields: ["grants.users:manage_permissions"] } });

    expect(await grantKeys(companyId, peerId)).toEqual(["agents:configure"]);
  });

  async function pluginAudit(companyId: string, action: string, entityId: string) {
    return db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, action), eq(activityLog.entityId, entityId)));
  }

  it("names the agent behind an allowed policy or grant update in the activity log, and no agent for a call that none started", async () => {
    const { companyId, services, managedAgentId, peerId } = await seed();
    await db.insert(principalPermissionGrants).values({
      companyId, principalType: "agent", principalId: peerId, permissionKey: "agents:configure", scope: null, grantedByUserId: null,
    });

    await runWithPluginHostCallAgent({ agentId: peerId, runId: null, companyId }, async () => {
      await updateAgentPolicy(services, companyId, managedAgentId);
      await setGrants(services, companyId, "agent", managedAgentId);
    });

    const [policyEntry] = await pluginAudit(companyId, "authorization.policy_updated_by_plugin", managedAgentId);
    const [grantEntry] = await pluginAudit(companyId, "authorization.grants_updated_by_plugin", `agent:${managedAgentId}`);
    for (const entry of [policyEntry, grantEntry]) {
      expect(entry).toMatchObject({
        actorType: "plugin",
        agentId: peerId,
        details: { sourcePluginKey: MANIFEST.id, initiatingActorType: "agent", initiatingAgentId: peerId },
      });
    }

    await services.authorization.updatePolicy({ companyId, resourceType: "agent", resourceId: managedAgentId, policy: null });
    const entries = await pluginAudit(companyId, "authorization.policy_updated_by_plugin", managedAgentId);
    expect(entries).toHaveLength(2);
    expect(entries.filter((entry) => entry.agentId === null)).toHaveLength(1);
    expect(entries.find((entry) => entry.agentId === null)?.details).toMatchObject({ initiatingAgentId: null });
  });
});
