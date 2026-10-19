import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin, { register } from "../src/worker.js";
import { CAPABILITIES, ENVIRONMENT_CLASSES, PRESETS, isRepositoryName } from "../src/contracts.js";
import { parseConfig } from "../src/config.js";
import { TOOL_DECLARATIONS } from "../src/tool-declarations.js";
import { projectDeployKeys } from "../src/projection.js";
import { REPORT_LIST_CAP } from "../src/agent-tools.js";
import { COMPANY_A, COMPANY_B, admin, baseConfig, member, run, setup } from "./fixture.js";
import { HOUR, NOW, deployment } from "./fakes.js";

type Result = { data?: any; error?: string };
const tool = (f: Awaited<ReturnType<typeof setup>>, name: string, input: Record<string, unknown>, agent = "observer") => f.h.executeTool<Result>(name, input, run(agent));
const properties = (schema: any) => schema.properties as Record<string, any>;

describe("the manifest and the registered tools", () => {
  it("publish the same tools, with the same descriptions and input schemas", () => {
    const h = createTestHarness({ manifest, config: {} });
    const registered = new Map<string, { description: string; parametersSchema: unknown }>();
    const original = h.ctx.tools.register.bind(h.ctx.tools);
    vi.spyOn(h.ctx.tools, "register").mockImplementation((name, declaration, handler) => { registered.set(name, declaration as never); return original(name, declaration, handler); });
    register(h.ctx, {});
    expect([...registered.keys()].sort()).toEqual((manifest.tools ?? []).map(item => item.name).sort());
    for (const published of manifest.tools ?? []) {
      expect(registered.get(published.name)).toMatchObject({ description: published.description, parametersSchema: published.parametersSchema });
    }
  });

  it("declares every tool with a closed input schema, a unique name and a grant the plugin enforces", () => {
    const names = TOOL_DECLARATIONS.map(item => item.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(14);
    for (const declared of TOOL_DECLARATIONS) {
      const schema = declared.parametersSchema as { type: string; additionalProperties: boolean; required: string[] };
      expect(declared.name).toMatch(/^convex_[a-z_]+$/);
      expect(CAPABILITIES).toContain(declared.capability);
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      for (const key of schema.required) expect(Object.keys(properties(schema))).toContain(key);
      expect(declared.description.length).toBeGreaterThan(20);
    }
  });

  it("names the deployment with the same field in every tool that takes one, and defaults deletes to a plan", () => {
    for (const declared of TOOL_DECLARATIONS) {
      const props = properties(declared.parametersSchema);
      if (["convex_list_projects", "convex_list_deployments", "convex_quota", "convex_list_classes_regions", "convex_reap_previews"].includes(declared.name)) continue;
      expect(props.name, declared.name).toMatchObject({ type: "string", pattern: expect.any(String) });
      expect((declared.parametersSchema as any).required).toContain("name");
    }
    for (const name of ["convex_delete_preview", "convex_reap_previews"]) {
      expect(properties(TOOL_DECLARATIONS.find(item => item.name === name)!.parametersSchema).dryRun.default).toBe(true);
    }
  });

  it("offers no capability, preset or UI slot this version does not enforce", () => {
    const text = JSON.stringify(manifest);
    expect(text).not.toMatch(/triager|approval|env-write/i);
    expect(manifest.capabilities).not.toContain("instance.settings.register");
    expect(manifest.ui?.slots?.map(slot => slot.type)).toEqual(["page"]);
    const grant = properties(properties(manifest.instanceConfigSchema).grants.items);
    expect(grant.preset.enum).toEqual(Object.keys(PRESETS));
    expect(grant.capabilities.items.enum).toEqual([...CAPABILITIES]);
    expect(grant.environments.items.enum).toEqual([...ENVIRONMENT_CLASSES]);
  });

  it("accepts the repositories the config parser accepts and rejects the rest", () => {
    const pattern = new RegExp(properties(properties(manifest.instanceConfigSchema).projects.items).repository.pattern);
    for (const value of ["org/app", "a/b.c", "org/app-1_x", "./x", "x/..", "../x", "x/.", "org/", "/app", "a/b/c", "org/ app", "...", ".../x", ""]) {
      expect(pattern.test(value), value).toBe(isRepositoryName(value));
    }
  });
});

describe("config validation", () => {
  const validate = (config: Record<string, unknown>) => plugin.definition.onValidateConfig!(config as never);
  const parses = (config: Record<string, unknown>) => { try { parseConfig(config); return true; } catch { return false; } };
  const grant = (extra: Record<string, unknown>) => baseConfig({ grants: [{ preset: "observer", environments: ["preview"], ...extra }] });

  it("agrees with the parser the plugin applies at call time", async () => {
    const fixtures: Array<Record<string, unknown>> = [
      baseConfig(),
      {},
      grant({ agentId: "a" }),
      grant({ agentId: "a", approval: true }),
      grant({ agentId: "a", role: "devops" }),
      grant({ agentId: "a", capabilities: ["env-write"] }),
      grant({ agentId: "a", preset: "triager" }),
      grant({}),
      baseConfig({ typo: true }),
      baseConfig({ guards: { maxDeletesPerRun: 0 } }),
      baseConfig({ projects: [{ convexProjectId: "100", repository: "../etc" }] }),
    ];
    for (const config of fixtures) expect((await validate(config)).ok, JSON.stringify(config).slice(0, 80)).toBe(parses(config));
  });

  it("reports why a config is refused", async () => {
    const result = await validate(grant({ agentId: "a", approval: true }));
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toMatch(/approval/i);
  });

  it("warns about a grant by role and about a reaper that cannot act", async () => {
    const roles = await validate(grant({ role: "devops" }));
    expect(roles).toMatchObject({ ok: true, warnings: [expect.stringContaining('the role "devops"')] });
    const idle = await validate(baseConfig({ reaper: { enabled: true }, guards: { dryRunOnly: true } }));
    expect(idle).toMatchObject({ ok: true, warnings: [expect.stringContaining("dryRunOnly")] });
    expect((await validate(baseConfig())).warnings).toBeUndefined();
  });
});

describe("naming a deployment", () => {
  const AGENT_FOR: Record<string, string> = { "meta-read": "observer", "health-read": "observer", "logs-read": "auditor", "data-read-pii": "pii-auditor", lifecycle: "janitor" };
  const named = TOOL_DECLARATIONS.filter(item => "name" in properties(item.parametersSchema));

  it("gets a message that says how to call the tool, whatever the field was called", async () => {
    const f = await setup();
    for (const declared of named) {
      const base = declared.name === "convex_set_preview_expiry" ? { hours: 2 } : {};
      for (const input of [{}, { nam: "x" }, { deployment: "x" }, { name: "  " }, { name: 7 }]) {
        const result = await tool(f, declared.name, { ...base, ...input }, AGENT_FOR[declared.capability]);
        expect(result.error, `${declared.name} ${JSON.stringify(input)}`).toBe("Pass the deployment as { name } (see convex_list_deployments).");
      }
    }
    expect(f.convex.calls).toHaveLength(0);
  });

  it("gets a pointer to convex_list_deployments when the name is not one of the company's", async () => {
    const f = await setup();
    f.convex.add(deployment("elsewhere", { projectId: 999 }));
    for (const declared of named) {
      const base = declared.name === "convex_set_preview_expiry" ? { hours: 2 } : {};
      for (const name of ["no-such-deployment", "elsewhere"]) {
        const result = await tool(f, declared.name, { ...base, name }, AGENT_FOR[declared.capability]);
        expect(result.error, `${declared.name} ${name}`).toMatch(/not available for this company\. Use convex_list_deployments/);
      }
    }
    expect(f.convex.mutations()).toHaveLength(0);
  });
});

describe("listing deployments", () => {
  const withDeployments = async (count: number) => {
    const f = await setup();
    // Added in reverse, so only the ordering by name puts them right.
    for (let i = count - 1; i >= 0; i--) f.convex.add(deployment(`p${String(i).padStart(2, "0")}`));
    return f;
  };

  it("pages by name with short rows, for an agent and for the board alike", async () => {
    const f = await withDeployments(5);
    const keys = ["deploymentType", "environment", "expiresAt", "lastDeployTime", "name", "previewIdentifier"];
    const agent = (await tool(f, "convex_list_deployments", { limit: 2 })).data;
    expect(agent.deployments.map((row: any) => row.name)).toEqual(["p00", "p01"]);
    expect(Object.keys(agent.deployments[0]).sort()).toEqual(keys);
    expect(agent).toMatchObject({ total: 5, truncated: true, nextCursor: "p01" });
    const second = (await tool(f, "convex_list_deployments", { limit: 2, cursor: agent.nextCursor })).data;
    expect(second.deployments.map((row: any) => row.name)).toEqual(["p02", "p03"]);
    const last = (await f.h.performAction<any>("deployments.list", { limit: 2, cursor: second.nextCursor }, member(COMPANY_A)));
    expect(last).toMatchObject({ deployments: [expect.objectContaining({ name: "p04" })], total: 5, truncated: false, nextCursor: null });
  });

  it("returns fifty rows when no limit is given", async () => {
    const f = await withDeployments(60);
    const page = (await tool(f, "convex_list_deployments", {})).data;
    expect(page.deployments).toHaveLength(50);
    expect(page).toMatchObject({ total: 60, truncated: true });
  });

  it("refuses a limit or cursor the schema does not allow, and keeps the board's inside the bounds", async () => {
    const f = await withDeployments(3);
    for (const limit of [0, 201, 1.5 - 3, "5", null]) {
      expect((await tool(f, "convex_list_deployments", { limit })).error, String(limit)).toMatch(/limit must be a number from 1 to 200/);
    }
    expect((await tool(f, "convex_list_deployments", { cursor: "x".repeat(129) })).error).toMatch(/cursor must be the nextCursor/);
    expect((await tool(f, "convex_list_deployments", { cursor: 5 })).error).toMatch(/cursor must be the nextCursor/);
    const clamped = await f.h.performAction<any>("deployments.list", { limit: 0 }, member(COMPANY_A));
    expect(clamped.deployments).toHaveLength(1);
    const big = await f.h.performAction<any>("deployments.list", { limit: 99999 }, member(COMPANY_A));
    expect(big.deployments).toHaveLength(3);
  });
});

describe("the quota tool", () => {
  it("shares one team count for a minute and counts again after it", async () => {
    const f = await setup();
    f.convex.add(deployment("a"), deployment("b"));
    const teamCalls = () => f.convex.calls.filter(call => /\/teams\/1\/list_deployments/.test(call.url)).length;
    const first = (await tool(f, "convex_quota", {})).data;
    expect(first).toMatchObject({ count: 2, partial: false });
    await tool(f, "convex_quota", {});
    await tool(f, "convex_quota", {}, "preview-reader");
    expect(teamCalls()).toBe(1);
    f.convex.add(deployment("c"));
    f.clock.now += 61_000;
    expect((await tool(f, "convex_quota", {})).data.count).toBe(3);
    expect(teamCalls()).toBe(2);
  });

  it("does not keep a failed count", async () => {
    const f = await setup();
    f.convex.validTokens.delete("cvx_team_TOPSECRET_0123456789");
    expect((await tool(f, "convex_quota", {})).error).toBeTruthy();
    f.convex.validTokens.add("cvx_team_TOPSECRET_0123456789");
    expect((await tool(f, "convex_quota", {})).data).toMatchObject({ partial: false });
  });
});

describe("the reaper tool's report", () => {
  it("lists the first entries of each list, counts all of them and says it was cut", async () => {
    const f = await setup();
    for (let i = 0; i < REPORT_LIST_CAP + 5; i++) {
      const name = `done-${String(i).padStart(2, "0")}`;
      f.convex.add(deployment(name));
      f.github.pulls.push({ number: i + 1, ref: name, state: "closed", merged: true });
    }
    const report = (await tool(f, "convex_reap_previews", {}, "janitor")).data;
    expect(report.dryRun).toBe(true);
    expect(report.projects[0]).toMatchObject({ previews: 30, counts: { delete: 30, deleted: 0 }, truncated: true });
    expect(report.projects[0].delete).toHaveLength(REPORT_LIST_CAP);
    expect(f.convex.mutations()).toHaveLength(0);
  });
});

describe("the deployment API", () => {
  it("sends a Convex scheme to the deployment's host and a Bearer scheme to the management API, nowhere else", async () => {
    const f = await setup();
    f.convex.add(deployment("probe"));
    const health = await tool(f, "convex_deployment_health", { name: "probe" });
    expect(health.error).toBeUndefined();
    const calls = f.convex.calls.map(call => ({ host: new URL(call.url).hostname, scheme: call.authorization?.split(" ")[0] }));
    expect(calls.filter(call => call.host === "probe.convex.cloud").length).toBeGreaterThan(0);
    for (const call of calls) expect(call.scheme).toBe(call.host.endsWith(".convex.cloud") ? "Convex" : "Bearer");
    expect(new Set(calls.map(call => call.host))).toEqual(new Set(["api.convex.dev", "probe.convex.cloud"]));
  });

  it("asks for the last 24 hours of audit events unless the agent gives a start", async () => {
    const f = await setup();
    f.convex.add(deployment("probe"));
    const fromOf = () => new URL(f.convex.calls.filter(call => call.url.includes("list_audit_log_events")).at(-1)!.url).searchParams.get("from");
    const standard = await tool(f, "convex_list_audit_events", { name: "probe" }, "auditor");
    expect(fromOf()).toBe(String(NOW - 24 * HOUR));
    expect(standard.data.from).toBe(NOW - 24 * HOUR);
    await tool(f, "convex_list_audit_events", { name: "probe", from: 12345.9 }, "auditor");
    expect(fromOf()).toBe("12345");
  });

  it("returns deploy key metadata from a bare list, never key material", async () => {
    const f = await setup();
    f.convex.add(deployment("probe"));
    const keys = (await tool(f, "convex_list_deploy_keys", { name: "probe" })).data.keys;
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ name: "ci", allowedActions: ["deployment:deploy"] });
    expect(JSON.stringify(keys)).not.toMatch(/LEAK-ME|adminKey|token/);
    const raw = [{ id: 1, name: "ci", adminKey: "LEAK-ME" }];
    expect(projectDeployKeys({ items: raw })).toEqual(projectDeployKeys(raw));
    expect(projectDeployKeys(null)).toEqual([]);
  });
});

describe("the status action", () => {
  it("has every field of a connected company when the config is invalid or missing", async () => {
    const f = await setup({ configs: { [COMPANY_A]: baseConfig(), [COMPANY_B]: baseConfig({ grants: [{ agentId: "a", preset: "observer", environments: ["preview"], approval: true }] }), "company-c": {} }, connect: [COMPANY_A] });
    const ok = await f.h.performAction<any>("status", { companyId: COMPANY_A }, member(COMPANY_A));
    const broken = await f.h.performAction<any>("status", { companyId: COMPANY_B }, member(COMPANY_B));
    const empty = await f.h.performAction<any>("status", { companyId: "company-c" }, member("company-c"));
    expect(ok.connection).toBe("connected");
    for (const key of Object.keys(ok)) expect(Object.keys(broken), key).toContain(key);
    expect(broken).toMatchObject({ connection: "not-configured", configError: expect.any(String), projects: [], lastReport: null });
    expect(empty).toMatchObject({ connection: "not-configured", projects: [], lastReport: null, reaper: expect.objectContaining({ enabled: false }) });
  });

  it("is for board users, and the connection changes are for instance administrators", async () => {
    const f = await setup();
    const agent = { companyId: COMPANY_A, actor: { type: "agent" as const, userId: null, companyId: COMPANY_A, agentId: "janitor", runId: "run-1" } };
    await expect(f.h.performAction("status", {}, agent)).rejects.toThrow(/board user/);
    await expect(f.h.performAction("connection.connect", {}, member(COMPANY_A))).rejects.toThrow(/Instance administrator/);
    await expect(f.h.performAction("connection.disconnect", {}, member(COMPANY_A))).rejects.toThrow(/Instance administrator/);
    await expect(f.h.performAction("status", {}, admin(COMPANY_A))).resolves.toMatchObject({ connection: "connected" });
  });
});
