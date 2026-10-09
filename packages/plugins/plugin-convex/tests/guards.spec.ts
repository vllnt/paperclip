import { describe, expect, it } from "vitest";
import { COMPANY_A, COMPANY_B, GITHUB_TOKEN, PROJECT_TOKEN, TEAM_TOKEN, baseConfig, member, ref, run, setup, type Fixture } from "./fixture.js";
import { HOUR, NOW, deployment } from "./fakes.js";

const del = (f: Fixture, agent: string, name: string, extra: Record<string, unknown> = {}, ctx = run(agent)) =>
  f.h.executeTool<{ data?: any; error?: string }>("convex_delete_preview", { name, ...extra }, ctx);

/** A closed PR and a gone branch: the preview is eligible for deletion. */
function eligible(f: Fixture, name = "feat-done") {
  f.convex.add(deployment(name));
  f.github.pulls.push({ number: 5, ref: name, state: "closed", merged: true });
}

describe("production and unknown environments are never agent-deletable", () => {
  it("refuses to delete a production deployment, even for an agent granted lifecycle on previews", async () => {
    const f = await setup();
    f.convex.add(deployment("happy-prod", { deploymentType: "prod", isDefault: true, reference: "prod", previewIdentifier: null }));
    const result = await del(f, "janitor", "happy-prod");
    expect(result.error).toMatch(/production/i);
    expect(f.convex.deletes()).toHaveLength(0);
  });

  it("refuses to set an expiry on production", async () => {
    const f = await setup();
    f.convex.add(deployment("happy-prod", { deploymentType: "prod", isDefault: true, previewIdentifier: null }));
    const result = await f.h.executeTool<{ error?: string }>("convex_set_preview_expiry", { name: "happy-prod", hours: 24 }, run("janitor"));
    expect(result.error).toMatch(/production/i);
    expect(f.convex.mutations()).toHaveLength(0);
  });

  it("treats a deployment with an unknown type as production", async () => {
    const f = await setup();
    f.convex.add(deployment("odd-one", { deploymentType: "sandbox" }));
    const read = await f.h.executeTool<{ data?: any }>("convex_get_deployment", { name: "odd-one" }, run("observer"));
    expect(read.data.environment).toBe("production");
    expect((await del(f, "janitor", "odd-one")).error).toMatch(/production/i);
    expect(f.convex.deletes()).toHaveLength(0);
  });

  it("treats a record missing its type or default flag as production", async () => {
    const f = await setup();
    const broken = deployment("broken") as unknown as Record<string, unknown>;
    delete broken.deploymentType;
    delete broken.isDefault;
    f.convex.add(broken as never);
    const read = await f.h.executeTool<{ data?: any }>("convex_get_deployment", { name: "broken" }, run("observer"));
    expect(read.data.environment).toBe("production");
    expect((await del(f, "janitor", "broken")).error).toMatch(/production/i);
  });

  it("refuses a preview the company lists as production or staging", async () => {
    const f = await setup();
    f.convex.add(deployment("prod-app"), deployment("staging-app"));
    expect((await del(f, "janitor", "prod-app")).error).toMatch(/production/i);
    expect((await del(f, "janitor", "staging-app")).error).toMatch(/staging/i);
    expect(f.convex.deletes()).toHaveLength(0);
  });

  it("refuses custom deployments and tells the agent a dev deployment is board-only", async () => {
    const f = await setup();
    f.convex.add(deployment("custom-one", { deploymentType: "custom" }), deployment("dev-sam", { deploymentType: "dev", reference: "dev/sam", previewIdentifier: null }));
    expect((await del(f, "janitor", "custom-one")).error).toMatch(/custom/i);
    expect((await del(f, "janitor", "dev-sam")).error).toMatch(/board/i);
    expect(f.convex.deletes()).toHaveLength(0);
  });
});

describe("agents need a grant", () => {
  it("refuses an agent without any grant, before calling Convex", async () => {
    const f = await setup();
    eligible(f);
    const result = await del(f, "nogrant", "feat-done");
    expect(result.error).toMatch(/grant/i);
    expect(f.convex.calls).toHaveLength(0);
  });

  it("refuses an agent whose grant does not include the capability", async () => {
    const f = await setup();
    eligible(f);
    expect((await del(f, "observer", "feat-done")).error).toMatch(/grant/i);
    expect(f.convex.deletes()).toHaveLength(0);
  });

  it("denies reads when nothing is granted", async () => {
    const f = await setup();
    const result = await f.h.executeTool<{ error?: string }>("convex_list_deployments", {}, run("nogrant"));
    expect(result.error).toMatch(/grant/i);
  });

  it("matches a grant by role", async () => {
    const f = await setup({ configs: { [COMPANY_A]: baseConfig({ grants: [{ role: "devops", preset: "janitor", environments: ["preview"] }] }) } });
    eligible(f);
    expect((await del(f, "janitor", "feat-done")).data.deleted).toBe(true);
  });
});

describe("company isolation", () => {
  it("refuses another company's deployment even when the credential could see it", async () => {
    const f = await setup({
      configs: {
        [COMPANY_A]: baseConfig(),
        [COMPANY_B]: baseConfig({ projects: [{ convexProjectId: "300", name: "b-app", repository: "org/b" }], grants: [{ agentId: "b-agent", preset: "janitor", environments: ["preview"] }] }),
      },
    });
    eligible(f);
    const result = await del(f, "b-agent", "feat-done", {}, run("b-agent", COMPANY_B));
    expect(result.error).toMatch(/not mapped to this company/i);
    expect(f.convex.deletes()).toHaveLength(0);
  });

  it("refuses a project another company reserved, even if this company's config lists it", async () => {
    const configs = {
      [COMPANY_A]: baseConfig(),
      [COMPANY_B]: baseConfig({ grants: [{ agentId: "b-agent", preset: "janitor", environments: ["preview"] }] }),
    };
    const f = await setup({ configs, connect: [COMPANY_A] });
    await expect(f.h.performAction("connection.connect", {}, { companyId: COMPANY_B, actor: { type: "user", userId: "u1", companyId: COMPANY_B, agentId: null, runId: null, isInstanceAdmin: true } }))
      .rejects.toThrow(/another company/i);
    eligible(f);
    const result = await del(f, "b-agent", "feat-done", {}, run("b-agent", COMPANY_B));
    expect(result.error).toMatch(/connect/i);
    expect(f.convex.deletes()).toHaveLength(0);
  });

  it("rejects a companyId that differs from the run's company", async () => {
    const f = await setup();
    eligible(f);
    const result = await del(f, "janitor", "feat-done", { companyId: COMPANY_B });
    expect(result.error).toMatch(/another company/i);
    expect(f.convex.calls).toHaveLength(0);
  });

  it("does not let board users of another company act through the actions", async () => {
    const f = await setup();
    await expect(f.h.performAction("deployments.list", {}, { companyId: COMPANY_A, actor: { type: "agent", userId: null, companyId: COMPANY_A, agentId: "janitor", runId: "r" } }))
      .rejects.toThrow(/board user/i);
  });
});

describe("pull request guard", () => {
  it("refuses a preview whose branch has an open pull request", async () => {
    const f = await setup();
    f.convex.add(deployment("feat-open"));
    f.github.pulls.push({ number: 12, ref: "feat-open" });
    const result = await del(f, "janitor", "feat-open");
    expect(result.error).toMatch(/open pull request #12/i);
    expect(f.convex.deletes()).toHaveLength(0);
  });

  it("matches pr-<number> style preview identifiers to an open pull request", async () => {
    const f = await setup();
    f.convex.add(deployment("pr-12", { previewIdentifier: "pr-12" }));
    f.github.pulls.push({ number: 12, ref: "some-branch" });
    expect((await del(f, "janitor", "pr-12")).error).toMatch(/open pull request #12/i);
  });

  it("refuses a preview whose branch has recent activity", async () => {
    const f = await setup();
    f.convex.add(deployment("feat-busy"));
    f.github.branches.set("feat-busy", new Date(NOW - 2 * HOUR).toISOString());
    expect((await del(f, "janitor", "feat-busy")).error).toMatch(/recent activity/i);
    expect(f.convex.deletes()).toHaveLength(0);
  });

  it("fails closed when GitHub cannot be read", async () => {
    const f = await setup();
    eligible(f);
    f.github.down = true;
    expect((await del(f, "janitor", "feat-done")).error).toMatch(/GitHub/i);
    expect(f.convex.deletes()).toHaveLength(0);
  });

  it("fails closed when the project has no repository mapped", async () => {
    const f = await setup({ configs: { [COMPANY_A]: baseConfig({ projects: [{ convexProjectId: "100", name: "app" }] }) } });
    eligible(f);
    expect((await del(f, "janitor", "feat-done")).error).toMatch(/repository/i);
    expect(f.convex.deletes()).toHaveLength(0);
  });

  it("deletes a preview whose pull request is closed, and audits the before-state", async () => {
    const f = await setup();
    eligible(f);
    const result = await del(f, "janitor", "feat-done");
    expect(result.data).toMatchObject({ deleted: true, environment: "preview" });
    expect(f.convex.deletes()).toHaveLength(1);
    expect(f.convex.deployments.has("feat-done")).toBe(false);
    const entry = f.h.activity.find(item => /Convex preview deleted/.test(item.message));
    expect(entry?.metadata).toMatchObject({ agentId: "janitor", runId: "run-1", environment: "preview", capability: "lifecycle", deployment: "feat-done", outcome: "deleted", before: expect.objectContaining({ name: "feat-done", deploymentType: "preview", previewIdentifier: "feat-done" }) });
  });
});

describe("dry run, caps and rate limits", () => {
  it("deletes nothing in dry-run mode but runs every guard", async () => {
    const f = await setup();
    eligible(f);
    const result = await del(f, "janitor", "feat-done", { dryRun: true });
    expect(result.data).toMatchObject({ dryRun: true, wouldDelete: true });
    expect(f.convex.mutations()).toHaveLength(0);
    expect(f.convex.deployments.has("feat-done")).toBe(true);
    f.convex.add(deployment("feat-open"));
    f.github.pulls.push({ number: 9, ref: "feat-open" });
    expect((await del(f, "janitor", "feat-open", { dryRun: true })).error).toMatch(/open pull request/i);
  });

  it("forces dry-run for every destructive tool when the company sets dryRunOnly", async () => {
    const f = await setup({ configs: { [COMPANY_A]: baseConfig({ guards: { dryRunOnly: true } }) } });
    eligible(f);
    const result = await del(f, "janitor", "feat-done");
    expect(result.data).toMatchObject({ dryRun: true, wouldDelete: true });
    expect(f.convex.mutations()).toHaveLength(0);
  });

  it("caps deletions per run and resets for a new run", async () => {
    const f = await setup({ configs: { [COMPANY_A]: baseConfig({ guards: { maxDeletesPerRun: 2 } }) } });
    for (const name of ["a", "b", "c", "d"]) eligible(f, name);
    expect((await del(f, "janitor", "a")).data.deleted).toBe(true);
    expect((await del(f, "janitor", "b")).data.deleted).toBe(true);
    expect((await del(f, "janitor", "c")).error).toMatch(/limit of 2 deletions/i);
    expect(f.convex.deletes()).toHaveLength(2);
    expect((await del(f, "janitor", "c", {}, run("janitor", COMPANY_A, "run-2"))).data.deleted).toBe(true);
  });

  it("rate limits an agent per minute", async () => {
    const f = await setup({ configs: { [COMPANY_A]: baseConfig({ guards: { callsPerMinute: 2 } }) } });
    f.convex.add(deployment("x"));
    const read = () => f.h.executeTool<{ error?: string }>("convex_get_deployment", { name: "x" }, run("observer"));
    expect((await read()).error).toBeUndefined();
    expect((await read()).error).toBeUndefined();
    expect((await read()).error).toMatch(/rate limit/i);
    f.clock.now += 61_000;
    expect((await read()).error).toBeUndefined();
  });
});

describe("expiry", () => {
  it("sets a bounded expiry on a preview", async () => {
    const f = await setup();
    f.convex.add(deployment("feat-x"));
    const result = await f.h.executeTool<{ data?: any; error?: string }>("convex_set_preview_expiry", { name: "feat-x", hours: 48 }, run("janitor"));
    expect(result.data).toMatchObject({ expiresAt: NOW + 48 * HOUR });
    expect(f.convex.deployments.get("feat-x")?.expiresAt).toBe(NOW + 48 * HOUR);
  });

  it("refuses an expiry beyond seven days or sooner than the 30 minute minimum", async () => {
    const f = await setup();
    f.convex.add(deployment("feat-x"));
    expect((await f.h.executeTool<{ error?: string }>("convex_set_preview_expiry", { name: "feat-x", hours: 169 }, run("janitor"))).error).toMatch(/168|7 days/i);
    expect((await f.h.executeTool<{ error?: string }>("convex_set_preview_expiry", { name: "feat-x", hours: 0.25 }, run("janitor"))).error).toMatch(/30 minutes/i);
    expect(f.convex.mutations()).toHaveLength(0);
  });
});

describe("credentials never leave the worker", () => {
  it("keeps every token out of results, activity and logs, even when Convex echoes its credential", async () => {
    const f = await setup();
    f.convex.echoCredentialInErrors = true;
    f.convex.add(deployment("feat-x"));
    f.convex.failDeleteFor.add("feat-x");
    f.github.pulls.push({ number: 1, ref: "feat-x", state: "closed", merged: true });
    const outputs = [
      await del(f, "janitor", "feat-x"),
      await del(f, "janitor", "missing-one"),
      await f.h.executeTool("convex_list_deployments", {}, run("observer")),
      await f.h.executeTool("convex_deployment_health", { name: "feat-x" }, run("observer")),
      await f.h.executeTool("convex_quota", {}, run("observer")),
    ];
    await f.h.performAction("status", {}, member(COMPANY_A));
    await f.h.performAction("deployments.list", {}, member(COMPANY_A));
    const everything = JSON.stringify([outputs, f.h.activity, f.h.logs, await f.h.performAction("reaper.report", {}, member(COMPANY_A))]);
    for (const secret of [TEAM_TOKEN, PROJECT_TOKEN, GITHUB_TOKEN, "Bearer ", "Convex cvx"]) expect(everything).not.toContain(secret);
  });

  it("only sends a deploy credential to Convex cloud hosts", async () => {
    const f = await setup();
    f.convex.add(deployment("feat-x", { deploymentUrl: "https://evil.example.com" }));
    const result = await f.h.executeTool<{ data?: any; error?: string }>("convex_deployment_health", { name: "feat-x" }, run("observer"));
    expect(JSON.stringify(result)).not.toContain(TEAM_TOKEN);
    expect(f.convex.calls.some(call => call.url.includes("evil.example.com"))).toBe(false);
  });

  it("rejects a plaintext token in the config", async () => {
    const f = await setup({ connect: [] });
    f.configs[COMPANY_A] = baseConfig({ teamToken: "cvx_plain_token_value" });
    await expect(f.h.performAction("connection.connect", {}, { companyId: COMPANY_A, actor: { type: "user", userId: "u1", companyId: COMPANY_A, agentId: null, runId: null, isInstanceAdmin: true } }))
      .rejects.toThrow(/secret reference/i);
    expect(ref("x").type).toBe("secret_ref");
  });
});

describe("inventory and health", () => {
  it("lists deployments of mapped projects with their environment class and never another project's", async () => {
    const f = await setup();
    f.convex.add(deployment("feat-x"), deployment("happy-prod", { deploymentType: "prod", isDefault: true, previewIdentifier: null }), deployment("elsewhere", { projectId: 999 }));
    const result = await f.h.executeTool<{ data?: any }>("convex_list_deployments", {}, run("observer"));
    const names = result.data.deployments.map((item: any) => item.name).sort();
    expect(names).toEqual(["feat-x", "happy-prod"]);
    expect(result.data.deployments.find((item: any) => item.name === "happy-prod").environment).toBe("production");
  });

  it("reports health from documented sources and names what is unavailable", async () => {
    const f = await setup();
    f.convex.add(deployment("feat-x"));
    const result = await f.h.executeTool<{ data?: any }>("convex_deployment_health", { name: "feat-x" }, run("observer"));
    expect(result.data).toMatchObject({ name: "feat-x", environment: "preview", lastDeployTime: NOW - 50 * HOUR, usage: expect.anything() });
    expect(result.data.unavailable).toEqual(expect.arrayContaining(["failureRate", "cacheHitRate", "schedulerLag", "functionMetrics"]));
  });

  it("counts deployments against the quota using the team list", async () => {
    const f = await setup();
    for (let i = 0; i < 130; i++) f.convex.add(deployment(`p${i}`));
    const result = await f.h.executeTool<{ data?: any }>("convex_quota", {}, run("observer"));
    expect(result.data).toMatchObject({ count: 130, quota: 300, partial: false });
    expect(result.data.percent).toBeCloseTo(43.3, 1);
  });
});
