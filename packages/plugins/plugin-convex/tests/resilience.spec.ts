import { describe, expect, it, vi } from "vitest";
import plugin from "../src/worker.js";
import { COMPANY_A, admin, baseConfig, member, run, setup, type Fixture } from "./fixture.js";
import { HOUR, NOW, deployment } from "./fakes.js";

const enabled = (extra: Record<string, unknown> = {}) => baseConfig({ reaper: { enabled: true }, ...extra });
const closedPr = (f: Fixture, name: string, number: number) => {
  f.convex.add(deployment(name));
  f.github.pulls.push({ number, ref: name, state: "closed", merged: true });
};
const del = (f: Fixture, name: string) => f.h.executeTool<{ data?: any; error?: string }>("convex_delete_preview", { name, dryRun: false }, run("janitor"));
const live = (f: Fixture) => f.h.performAction<any>("reaper.run", { dryRun: false }, admin(COMPANY_A));
const passes = (f: Fixture) => f.h.activity.filter(item => item.message === "Convex reaper run").length;
const managed = (f: Fixture) => f.h.getState({ scopeKind: "company", scopeId: COMPANY_A, namespace: "reaper", stateKey: "managed-expiry" }) ?? {};

describe("passes", () => {
  it("joins requests that arrive together into one pass", async () => {
    const f = await setup();
    closedPr(f, "feat-done", 1);
    const reports = await Promise.all([1, 2, 3].map(() => f.h.performAction<any>("reaper.run", { dryRun: true }, member(COMPANY_A))));
    expect(passes(f)).toBe(1);
    expect(new Set(reports.map(report => report.at)).size).toBe(1);
  });

  it("lets one pass run and one wait behind it, and joins later requests to the waiting one", async () => {
    const f = await setup();
    closedPr(f, "feat-done", 1);
    const convex = f.runtime.service.d.convex;
    const original = convex.listProjectDeployments.bind(convex);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const listing = vi.spyOn(convex, "listProjectDeployments").mockImplementation(async (...args) => { await gate; return original(...args); });
    const first = f.h.performAction("reaper.run", { dryRun: true }, member(COMPANY_A));
    await vi.waitFor(() => expect(listing).toHaveBeenCalledTimes(1));
    const rest = [f.h.performAction("reaper.run", { dryRun: true }, member(COMPANY_A)), f.h.performAction("reaper.run", { dryRun: true }, member(COMPANY_A))];
    release();
    await Promise.all([first, ...rest]);
    expect(passes(f)).toBe(2);
  });

  it("keeps a plan and a real run apart", async () => {
    const f = await setup({ configs: { [COMPANY_A]: enabled() } });
    closedPr(f, "feat-done", 1);
    const [plan, real] = await Promise.all([f.h.performAction<any>("reaper.run", { dryRun: true }, admin(COMPANY_A)), live(f)]);
    expect(plan.dryRun).toBe(true);
    expect(real.dryRun).toBe(false);
    expect(passes(f)).toBe(2);
  });

  it("stops starting work at the time budget, oldest previews first, and says so", async () => {
    const f = await setup();
    // Added newest first, so only sorting puts p0 at the front.
    for (let i = 29; i >= 0; i--) closedPr(f, `p${i}`, i + 1), (f.convex.deployments.get(`p${i}`)!.lastDeployTime = NOW - (100 - i) * HOUR);
    const service = f.runtime.service;
    const original = service.assess.bind(service);
    // Each GitHub check takes a minute of the pass's four.
    vi.spyOn(service, "assess").mockImplementation(async (...args) => { f.clock.now += 60_000; return original(...args); });
    await f.h.runJob("convex-reaper");
    const last = await f.h.performAction<any>("reaper.report", {}, member(COMPANY_A));
    expect(last.incomplete).toMatch(/time budget of 4 minutes/);
    expect(last.projects[0]).toMatchObject({ previews: 30, deferred: 26 });
    expect(last.projects[0].delete.map((item: any) => item.name)).toEqual(["p0", "p1", "p2", "p3"]);
  });

  it("changes at most 100 expiries per project in one pass and reports what is left", async () => {
    const f = await setup({ configs: { [COMPANY_A]: enabled() } });
    for (let i = 0; i < 130; i++) f.convex.add(deployment(`k${i}`, { lastDeployTime: NOW - 2 * HOUR }));
    const report = await live(f);
    expect(report.projects[0].expirySet).toHaveLength(100);
    expect(report.projects[0].deferred).toBe(30);
    expect(report.incomplete).toMatch(/At most 100 expiry changes/);
    expect(Object.keys(managed(f))).toHaveLength(100);
  });

  it("stops a project's writes after three transport failures in a row", async () => {
    const f = await setup({ configs: { [COMPANY_A]: enabled() } });
    for (let i = 0; i < 6; i++) { closedPr(f, `d${i}`, i + 1); f.convex.failDeleteFor.add(`d${i}`); }
    const report = await live(f);
    expect(f.convex.deletes()).toHaveLength(3);
    expect(report.projects[0]).toMatchObject({ deferred: 3, error: expect.stringMatching(/failed 3 times in a row/) });
    expect(report.projects[0].failed).toHaveLength(3);
  });

  it("does not count a refusal as a transport failure", async () => {
    const f = await setup({ configs: { [COMPANY_A]: enabled() } });
    for (let i = 0; i < 5; i++) { closedPr(f, `d${i}`, i + 1); f.convex.refuseChangeFor.add(`d${i}`); }
    const report = await live(f);
    expect(f.convex.deletes()).toHaveLength(5);
    expect(report.projects[0].failed).toHaveLength(5);
    expect(report.projects[0].error).toBeUndefined();
  });

  it("reads the config again before every write: turning the reaper off stops a pass in progress", async () => {
    const f = await setup({ configs: { [COMPANY_A]: enabled() } });
    for (let i = 0; i < 5; i++) closedPr(f, `d${i}`, i + 1);
    const convex = f.runtime.service.d.convex;
    const original = convex.deleteDeployment.bind(convex);
    vi.spyOn(convex, "deleteDeployment").mockImplementation(async (...args) => {
      f.configs[COMPANY_A] = baseConfig({ reaper: { enabled: false } });
      return original(...args);
    });
    const report = await live(f);
    expect(f.convex.deletes()).toHaveLength(1);
    expect(report.incomplete).toMatch(/reaper was turned off during the pass/);
    expect(report.projects[0].deferred).toBe(4);
  });

  it("stops at once when the worker is shutting down, and refuses new changes", async () => {
    const f = await setup({ configs: { [COMPANY_A]: enabled() } });
    closedPr(f, "feat-done", 1);
    f.runtime.service.stopping = true;
    expect((await del(f, "feat-done")).error).toMatch(/shutting down/);
    const report = await live(f);
    expect(report.incomplete).toMatch(/shutting down/);
    await f.h.runJob("convex-reaper");
    expect(passes(f)).toBe(1);
    expect(f.convex.mutations()).toHaveLength(0);
    expect(typeof plugin.definition.onShutdown).toBe("function");
  });
});

describe("a delete that Convex answers 404 or refuses", () => {
  it("counts a 404 as deleted once a look confirms the deployment is gone, and gives the allowance back", async () => {
    const f = await setup({ configs: { [COMPANY_A]: baseConfig({ guards: { maxDeletesPerRun: 1 } }) } });
    closedPr(f, "already-gone", 1);
    closedPr(f, "real", 2);
    f.convex.goneOnDelete.add("already-gone");
    expect((await del(f, "already-gone")).data.deleted).toBe(true);
    expect(f.h.activity.some(item => item.metadata?.outcome === "deleted-verified")).toBe(true);
    expect((await del(f, "real")).data.deleted).toBe(true);
  });

  it("gives the allowance back after a definitive refusal", async () => {
    const f = await setup({ configs: { [COMPANY_A]: baseConfig({ guards: { maxDeletesPerRun: 1 } }) } });
    closedPr(f, "refused", 1);
    closedPr(f, "real", 2);
    f.convex.refuseChangeFor.add("refused");
    expect((await del(f, "refused")).error).toMatch(/Convex answered 400/);
    expect((await del(f, "real")).data.deleted).toBe(true);
  });

  it("keeps the allowance spent when the outcome is unknown", async () => {
    const f = await setup({ configs: { [COMPANY_A]: baseConfig({ guards: { maxDeletesPerRun: 1 } }) } });
    closedPr(f, "unknown", 1);
    closedPr(f, "real", 2);
    f.convex.failDeleteFor.add("unknown");
    expect((await del(f, "unknown")).error).toMatch(/did not confirm/);
    expect((await del(f, "real")).error).toMatch(/limit of 1 deletions/);
  });

  it("does not charge the reaper's pass budget for a deployment that was already gone", async () => {
    const f = await setup({ configs: { [COMPANY_A]: enabled({ guards: { maxDeletesPerRun: 1 } }) } });
    closedPr(f, "already-gone", 1);
    closedPr(f, "real", 2);
    f.convex.goneOnDelete.add("already-gone");
    const report = await live(f);
    expect(report.projects[0].deleted.sort()).toEqual(["already-gone", "real"]);
  });
});

describe("the managed-expiry record", () => {
  const keepers = (f: Fixture, count = 3) => { for (let i = 0; i < count; i++) f.convex.add(deployment(`k${i}`, { lastDeployTime: NOW - 2 * HOUR })); };
  const spyManaged = (f: Fixture) => {
    const original = f.h.ctx.state.set.bind(f.h.ctx.state);
    const writes: unknown[] = [];
    let failFirst = false;
    vi.spyOn(f.h.ctx.state, "set").mockImplementation(async (key, value) => {
      if (key.stateKey === "managed-expiry") {
        writes.push(value);
        if (failFirst && writes.length === 1) throw new Error("state unavailable");
      }
      return original(key, value);
    });
    return { writes, failTheFirst: () => { failFirst = true; } };
  };

  it("is written once for a whole project before Convex is changed", async () => {
    const f = await setup({ configs: { [COMPANY_A]: enabled() } });
    keepers(f);
    const { writes } = spyManaged(f);
    const report = await live(f);
    expect(report.projects[0].expirySet.sort()).toEqual(["k0", "k1", "k2"]);
    // One write-ahead for the three expiries, one prune at the end.
    expect(writes).toHaveLength(2);
    expect(writes[0]).toEqual({ k0: NOW + 34 * HOUR, k1: NOW + 34 * HOUR, k2: NOW + 34 * HOUR });
  });

  it("changes nothing for a project whose plan could not be recorded", async () => {
    const f = await setup({ configs: { [COMPANY_A]: enabled() } });
    keepers(f);
    spyManaged(f).failTheFirst();
    const report = await live(f);
    expect(f.convex.mutations()).toHaveLength(0);
    expect(report.projects[0]).toMatchObject({ expirySet: [], deferred: 3, error: expect.stringMatching(/could not record the planned expiries/) });
  });

  it("takes a change back out when Convex refuses it, and keeps the others", async () => {
    const f = await setup({ configs: { [COMPANY_A]: enabled() } });
    keepers(f);
    f.convex.refuseChangeFor.add("k1");
    const report = await live(f);
    expect(report.projects[0].expirySet.sort()).toEqual(["k0", "k2"]);
    expect(report.projects[0].failed).toEqual([expect.objectContaining({ name: "k1" })]);
    expect(Object.keys(managed(f)).sort()).toEqual(["k0", "k2"]);
  });
});

describe("the quota alert", () => {
  const alertConfig = () => baseConfig({ projects: [{ convexProjectId: "100", name: "app", repository: "org/app", paperclipProjectId: "pp-1" }], reaper: { quota: 10 } });
  const alerts = (f: Fixture) => f.h.activity.filter(item => /quota at/i.test(item.message)).length;

  it("raises one issue per alert level, not one per day", async () => {
    const f = await setup({ configs: { [COMPANY_A]: alertConfig() } });
    for (let i = 0; i < 8; i++) f.convex.add(deployment(`p${i}`));
    await f.h.runJob("convex-reaper");
    f.clock.now += HOUR;
    await f.h.runJob("convex-reaper");
    expect(f.issue).toHaveBeenCalledTimes(1);
    expect(f.issue.mock.calls[0][0]).toMatchObject({ idempotencyKey: `convex-quota-alert:${COMPANY_A}:80` });
    expect(alerts(f)).toBe(1);
    // Nine of ten is the next level and a new issue.
    f.convex.add(deployment("p8"));
    await f.h.runJob("convex-reaper");
    expect(f.issue).toHaveBeenCalledTimes(2);
    expect(f.issue.mock.calls[1][0]).toMatchObject({ idempotencyKey: `convex-quota-alert:${COMPANY_A}:90` });
    // At the same level the log line comes back after a day, and the issue key stays the same.
    f.clock.now += 25 * HOUR;
    await f.h.runJob("convex-reaper");
    expect(alerts(f)).toBe(3);
    expect(f.issue.mock.calls[2][0]).toMatchObject({ idempotencyKey: `convex-quota-alert:${COMPANY_A}:90` });
  });

  it("says when the team has more deployments than the page budget could count", async () => {
    const f = await setup();
    const convex = f.runtime.service.d.convex;
    vi.spyOn(convex, "listTeamDeploymentsPage").mockResolvedValue({ items: [{ name: "x" } as never], nextCursor: "more" });
    const { config, reserved } = await f.runtime.service.requireConnected(COMPANY_A);
    expect(await f.runtime.service.quota(config, COMPANY_A, reserved)).toMatchObject({ count: 100, lowerBound: true });
  });
});

describe("bookkeeping", () => {
  it("drops rate-limit entries of callers that have gone quiet", async () => {
    const f = await setup();
    f.convex.add(deployment("x"));
    const calls = () => (f.runtime.service as unknown as { calls: Map<string, number[]> }).calls;
    await f.h.executeTool("convex_get_deployment", { name: "x" }, run("observer"));
    await f.h.executeTool("convex_get_deployment", { name: "x" }, run("preview-reader"));
    expect(calls().size).toBe(2);
    f.clock.now += 61_000;
    await f.h.executeTool("convex_get_deployment", { name: "x" }, run("observer"));
    expect(calls().size).toBe(1);
  });
});
