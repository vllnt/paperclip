import { describe, expect, it } from "vitest";
import { COMPANY_A, COMPANY_B, GITHUB_TOKEN, PREVIEW_KEY, PROJECT_TOKEN, TEAM_TOKEN, admin, baseConfig, member, ref, run, setup, type Fixture } from "./fixture.js";
import { HOUR, NOW, deployment } from "./fakes.js";
import { newGuardCache } from "../src/preview-guard.js";

const expire = (f: Fixture, name: string, hours: number, extra: Record<string, unknown> = {}, ctx = run("janitor")) =>
  f.h.executeTool<{ data?: any; error?: string }>("convex_set_preview_expiry", { name, hours, ...extra }, ctx);
const del = (f: Fixture, name: string, ctx = run("janitor")) => f.h.executeTool<{ data?: any; error?: string }>("convex_delete_preview", { name }, ctx);
const closed = (f: Fixture, name: string, number = 5) => {
  f.convex.add(deployment(name));
  f.github.pulls.push({ number, ref: name, state: "closed", merged: true });
};
/** Project token and preview deploy key in addition to the team token. */
const richConfig = (extra: Record<string, unknown> = {}) => baseConfig({
  projects: [{ convexProjectId: "100", name: "app", repository: "org/app", token: ref("s-project"), previewDeployKey: ref("s-preview"), environments: { production: ["prod-app"], staging: ["staging-app"] } }],
  ...extra,
});

describe("an expiry that deletes soon follows the deletion guards (review #1)", () => {
  it("refuses a short expiry on a preview with an open pull request or an active branch", async () => {
    const f = await setup();
    f.convex.add(deployment("feat-open"), deployment("feat-busy"));
    f.github.pulls.push({ number: 12, ref: "feat-open" });
    f.github.branches.set("feat-busy", new Date(NOW - 2 * HOUR).toISOString());
    expect((await expire(f, "feat-open", 0.5)).error).toMatch(/open pull request #12.*deletes the preview/i);
    expect((await expire(f, "feat-busy", 1)).error).toMatch(/recent activity/i);
    expect(f.convex.mutations()).toHaveLength(0);
  });

  it("refuses a short expiry when GitHub cannot be read, but allows one beyond the activity window", async () => {
    const f = await setup();
    f.convex.add(deployment("feat-x"));
    f.github.down = true;
    expect((await expire(f, "feat-x", 2)).error).toMatch(/GitHub/i);
    expect((await expire(f, "feat-x", 48)).data.expiresAt).toBe(NOW + 48 * HOUR);
  });

  it("counts a short expiry as a deletion against the per-run cap", async () => {
    const f = await setup({ configs: { [COMPANY_A]: baseConfig({ guards: { maxDeletesPerRun: 1 } }) } });
    closed(f, "a");
    closed(f, "b");
    expect((await expire(f, "a", 1)).data.expiresAt).toBe(NOW + HOUR);
    expect((await expire(f, "b", 1)).error).toMatch(/limit of 1 deletions/i);
    expect((await del(f, "b")).error).toMatch(/limit of 1 deletions/i);
    expect(f.convex.deployments.get("b")?.expiresAt ?? null).toBeNull();
  });
});

describe("the reaper only follows a redeploy for expiries it set itself (review #2)", () => {
  const enabled = () => baseConfig({ reaper: { enabled: true } });
  it("moves its own expiry later after a redeploy, and leaves one a person set", async () => {
    const f = await setup({ configs: { [COMPANY_A]: enabled() } });
    f.convex.add(deployment("ours", { lastDeployTime: NOW - 10 * HOUR }), deployment("theirs", { lastDeployTime: NOW - 10 * HOUR, expiresAt: NOW + 4 * HOUR }));
    f.github.branches.set("ours", new Date(NOW - 10 * HOUR).toISOString());
    f.github.branches.set("theirs", new Date(NOW - 10 * HOUR).toISOString());
    f.github.pulls.push({ number: 1, ref: "ours" }, { number: 2, ref: "theirs" });
    await f.h.runJob("convex-reaper");
    expect(f.convex.deployments.get("ours")?.expiresAt).toBe(NOW - 10 * HOUR + 36 * HOUR);
    expect(f.convex.deployments.get("theirs")?.expiresAt).toBe(NOW + 4 * HOUR);
    // Both are redeployed ten hours later.
    f.clock.now += 10 * HOUR;
    f.convex.deployments.get("ours")!.lastDeployTime = f.clock.now - HOUR;
    f.convex.deployments.get("theirs")!.lastDeployTime = f.clock.now - HOUR;
    await f.h.runJob("convex-reaper");
    expect(f.convex.deployments.get("ours")?.expiresAt).toBe(f.clock.now - HOUR + 36 * HOUR);
    expect(f.convex.deployments.get("theirs")?.expiresAt).toBe(NOW + 4 * HOUR);
  });
});

describe("branch and pull request matching (review #3, #4)", () => {
  it("matches a preview named feat-login to the branch feat/login", async () => {
    const f = await setup();
    f.convex.add(deployment("feat-login", { previewIdentifier: "feat-login" }));
    f.github.branches.set("feat/login", new Date(NOW - 2 * HOUR).toISOString());
    expect((await del(f, "feat-login")).error).toMatch(/feat\/login.*recent activity/i);
    f.github.branches.delete("feat/login");
    f.github.pulls.push({ number: 7, ref: "feat/login" });
    expect((await del(f, "feat-login")).error).toMatch(/open pull request #7/i);
    expect(f.convex.deletes()).toHaveLength(0);
  });

  it("does not take one missing branch name as proof the branch is gone when branches cannot be listed", async () => {
    const f = await setup({ configs: { [COMPANY_A]: baseConfig({ reaper: { enabled: true } }) } });
    f.convex.add(deployment("feat-x", { lastDeployTime: NOW - 80 * HOUR }));
    f.github.branchesHidden = true;
    expect((await del(f, "feat-x")).error).toMatch(/GitHub/i);
    await f.h.runJob("convex-reaper");
    expect(f.convex.deletes()).toHaveLength(0);
  });

  it("fails closed past 1000 branches or 1000 open pull requests", async () => {
    const f = await setup();
    f.convex.add(deployment("feat-x"));
    f.github.extraBranches = 1000;
    expect((await del(f, "feat-x")).error).toMatch(/GitHub/i);
    f.github.extraBranches = 0;
    f.github.extraOpenPulls = 1000;
    expect((await del(f, "feat-x")).error).toMatch(/GitHub/i);
    expect(f.convex.deletes()).toHaveLength(0);
  });

  it("re-reads open pull requests at delete time instead of trusting the planning pass", async () => {
    const f = await setup();
    closed(f, "feat-done");
    const { service } = f.runtime;
    const { config, reserved } = await service.requireConnected(COMPANY_A);
    const cache = newGuardCache();
    const target = await service.resolveTarget({ kind: "reaper", companyId: COMPANY_A }, config, reserved, "feat-done");
    expect((await service.assess(COMPANY_A, target, cache)).blocked).toBeNull();
    f.github.pulls.push({ number: 99, ref: "feat-done" });
    await expect(service.deletePreview({ kind: "reaper", companyId: COMPANY_A }, config, reserved, "feat-done", { dryRun: false, cache }))
      .rejects.toThrow(/open pull request #99/i);
    expect(f.convex.deletes()).toHaveLength(0);
  });
});

describe("credentials (review #5, #6)", () => {
  it("resolves each secret once per operation, so a pass over many previews stays under the host's secret rate limit", async () => {
    const f = await setup({ configs: { [COMPANY_A]: richConfig({ reaper: { enabled: true } }) } });
    f.convex.validTokens.add(PREVIEW_KEY);
    for (let i = 0; i < 25; i++) closed(f, `old-${i}`, i + 1);
    const resolve = f.h.ctx.secrets.resolve as unknown as { mock: { calls: unknown[] }; mockClear(): void };
    resolve.mockClear();
    await f.h.runJob("convex-reaper");
    expect(f.convex.deletes()).toHaveLength(20);
    expect(resolve.mock.calls.length).toBeLessThanOrEqual(8);
  });

  it("falls back from a rejected preview deploy key to the project token, for delete and expiry", async () => {
    const f = await setup({ configs: { [COMPANY_A]: richConfig() } });
    f.convex.validTokens.delete(PREVIEW_KEY);
    closed(f, "feat-done");
    f.convex.add(deployment("feat-x"));
    expect((await expire(f, "feat-x", 48)).data.expiresAt).toBe(NOW + 48 * HOUR);
    expect((await del(f, "feat-done")).data.deleted).toBe(true);
    const used = f.convex.calls.filter(call => call.method !== "GET").map(call => call.authorization);
    expect(used).toEqual([`Bearer ${PREVIEW_KEY}`, `Bearer ${PROJECT_TOKEN}`, `Bearer ${PREVIEW_KEY}`, `Bearer ${PROJECT_TOKEN}`]);
  });

  it("uses the cheapest working credential: the preview deploy key", async () => {
    const f = await setup({ configs: { [COMPANY_A]: richConfig() } });
    f.convex.validTokens.add(PREVIEW_KEY);
    closed(f, "feat-done");
    expect((await del(f, "feat-done")).data.deleted).toBe(true);
    expect(f.convex.deletes()[0].authorization).toBe(`Bearer ${PREVIEW_KEY}`);
  });

  it("keeps all four tokens out of every output when each credential type is configured", async () => {
    const f = await setup({ configs: { [COMPANY_A]: richConfig() } });
    f.convex.echoCredentialInErrors = true;
    f.convex.validTokens.delete(PREVIEW_KEY);
    closed(f, "feat-x");
    f.convex.failDeleteFor.add("feat-x");
    const outputs = [
      await del(f, "feat-x"), await del(f, "missing"), await f.h.executeTool("convex_list_deployments", {}, run("observer")),
      await f.h.executeTool("convex_deployment_health", { name: "feat-x" }, run("observer")), await f.h.executeTool("convex_list_deploy_keys", { name: "feat-x" }, run("observer")),
      await f.h.performAction("status", {}, member(COMPANY_A)), await f.h.performAction("deployments.list", {}, member(COMPANY_A)),
    ];
    const everything = JSON.stringify([outputs, f.h.activity, f.h.logs]);
    for (const secret of [TEAM_TOKEN, PROJECT_TOKEN, PREVIEW_KEY, GITHUB_TOKEN, "Bearer cvx", "Convex cvx"]) expect(everything).not.toContain(secret);
  });
});

describe("delete outcome (review #7)", () => {
  it("reports success when the response was lost after Convex deleted the deployment", async () => {
    const f = await setup();
    closed(f, "feat-done");
    f.convex.dropDeleteResponseFor.add("feat-done");
    const result = await del(f, "feat-done");
    expect(result.data.deleted).toBe(true);
    expect(f.h.activity.some(item => item.metadata?.outcome === "deleted-verified")).toBe(true);
  });

  it("says the outcome is unconfirmed, not failed, when Convex errors and the deployment still exists", async () => {
    const f = await setup();
    closed(f, "feat-done");
    f.convex.failDeleteFor.add("feat-done");
    expect((await del(f, "feat-done")).error).toMatch(/did not confirm/i);
    expect(f.h.activity.some(item => item.metadata?.outcome === "unknown")).toBe(true);
  });
});

describe("responses are projected (review #8)", () => {
  it("drops fields the plugin does not name from info, usage and usage limits", async () => {
    const f = await setup();
    f.convex.add(deployment("feat-x"));
    const health = await f.h.executeTool<{ data?: any }>("convex_deployment_health", { name: "feat-x" }, run("observer"));
    const usage = await f.h.executeTool<{ data?: any }>("convex_get_usage", { name: "feat-x" }, run("observer"));
    const limits = await f.h.executeTool<{ data?: any }>("convex_list_usage_limits", { name: "feat-x" }, run("observer"));
    expect(JSON.stringify([health, usage, limits])).not.toMatch(/LEAK-ME/);
    expect(usage.data.usage).toEqual({ seedStatus: "complete", metrics: { functionCalls: { unit: "calls", currentDay: 10, currentMonth: 100 } } });
    expect(limits.data.usageLimits.usageLimits).toEqual([{ id: "u1", metric: "functionCalls", window: "day", limitType: "warning", limit: 1000, enabled: true }]);
    expect(health.data.info).toMatchObject({ kind: "cloud", projectId: "100", deploymentType: "preview" });
  });
});

describe("what a deployment lookup reveals (review #9, #10)", () => {
  it("refuses when Convex answers with a different deployment than the one asked for", async () => {
    const f = await setup();
    f.convex.add(deployment("feat-x"));
    f.convex.answerAs.set("feat-x", "Feat-X");
    expect((await del(f, "feat-x")).error).toMatch(/not available/i);
    expect(f.convex.deletes()).toHaveLength(0);
  });

  it("gives the same answer for a missing deployment, another company's and an unmapped project", async () => {
    const f = await setup({
      configs: {
        [COMPANY_A]: baseConfig(),
        [COMPANY_B]: baseConfig({ projects: [{ convexProjectId: "300", name: "b", repository: "org/b" }], grants: [{ agentId: "b-agent", preset: "janitor", environments: ["preview"] }] }),
      },
    });
    f.convex.add(deployment("a-one"), deployment("elsewhere", { projectId: 999 }));
    const b = run("b-agent", COMPANY_B);
    const answers = [await del(f, "a-one", b), await del(f, "elsewhere", b), await del(f, "nothing-here", b)].map(result => result.error);
    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toMatch(/not available for this company/i);
  });

  it("refuses a project that was added to the config but never connected", async () => {
    const f = await setup();
    f.configs[COMPANY_A] = baseConfig({ projects: [
      { convexProjectId: "100", name: "app", repository: "org/app" },
      { convexProjectId: "300", name: "new", repository: "org/new" },
    ] });
    f.convex.add(deployment("in-new", { projectId: 300 }), deployment("in-app"));
    f.github.pulls.push({ number: 1, ref: "in-new", state: "closed", merged: true });
    expect((await del(f, "in-new")).error).toMatch(/not available for this company/i);
    const listed = await f.h.executeTool<{ data?: any }>("convex_list_deployments", {}, run("observer"));
    expect(listed.data.deployments.map((item: any) => item.name)).toEqual(["in-app"]);
  });
});

describe("board actions need the right administrator rights (review test gaps)", () => {
  it("lets a board member read and plan, but not connect, delete or run live", async () => {
    const f = await setup({ configs: { [COMPANY_A]: baseConfig({ reaper: { enabled: true } }) } });
    closed(f, "feat-done");
    await expect(f.h.performAction("connection.connect", {}, member(COMPANY_A))).rejects.toThrow(/administrator/i);
    await expect(f.h.performAction("connection.disconnect", {}, member(COMPANY_A))).rejects.toThrow(/administrator/i);
    await expect(f.h.performAction("deployments.delete-preview", { name: "feat-done" }, member(COMPANY_A))).rejects.toThrow(/administrator/i);
    await expect(f.h.performAction("reaper.run", { dryRun: false }, member(COMPANY_A))).rejects.toThrow(/administrator/i);
    expect(f.convex.mutations()).toHaveLength(0);
    const planned = await f.h.performAction<any>("reaper.run", { dryRun: true }, member(COMPANY_A));
    expect(planned.projects[0].delete.map((item: any) => item.name)).toEqual(["feat-done"]);
  });

  it("lets an administrator delete a preview, still behind the guards", async () => {
    const f = await setup();
    closed(f, "feat-done");
    f.convex.add(deployment("feat-open"), deployment("happy-prod", { deploymentType: "prod", isDefault: true, previewIdentifier: null }));
    f.github.pulls.push({ number: 3, ref: "feat-open" });
    expect((await f.h.performAction<any>("deployments.delete-preview", { name: "feat-done" }, admin(COMPANY_A))).deleted).toBe(true);
    await expect(f.h.performAction("deployments.delete-preview", { name: "feat-open" }, admin(COMPANY_A))).rejects.toThrow(/open pull request/i);
    await expect(f.h.performAction("deployments.delete-preview", { name: "happy-prod" }, admin(COMPANY_A))).rejects.toThrow(/only previews/i);
  });

  it("refuses a companyId parameter that differs from the company the host authorised", async () => {
    const f = await setup({ configs: { [COMPANY_A]: baseConfig(), [COMPANY_B]: baseConfig({ projects: [{ convexProjectId: "300", name: "b" }] }) } });
    const actor = { type: "user" as const, userId: "u9", companyId: COMPANY_A, agentId: null, runId: null };
    await expect(f.h.performAction("deployments.list", { companyId: COMPANY_B }, { actor })).rejects.toThrow(/board user/i);
    await expect(f.h.performAction("status", { companyId: COMPANY_B }, { actor })).rejects.toThrow(/board user/i);
  });
});
