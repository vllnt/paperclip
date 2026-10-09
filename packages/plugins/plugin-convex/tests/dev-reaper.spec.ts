import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMPANY_A, PREVIEW_KEY, PROJECT_TOKEN, admin, baseConfig, member, ref, run, setup, type Fixture } from "./fixture.js";
import { HOUR, NOW, deployment } from "./fakes.js";

const DAY = 24 * HOUR;
/** A dev deployment last deployed `ageDays` ago. */
const dev = (name: string, reference: string, ageDays: number | null, extra: Record<string, unknown> = {}) => deployment(name, {
  deploymentType: "dev", reference, previewIdentifier: null, isDefault: false,
  lastDeployTime: ageDays === null ? null : NOW - ageDays * DAY, createTime: NOW - ((ageDays ?? 0) + 1) * DAY, ...extra,
});
const config = (devPolicy: Record<string, unknown> = {}, reaper: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  baseConfig({ reaper: { enabled: true, dev: { enabled: true, onlyPatterns: ["dev/*"], ...devPolicy }, ...reaper }, ...extra });
const report = (f: Fixture) => f.h.performAction<any>("reaper.report", {}, member(COMPANY_A));
const deleted = (f: Fixture) => f.convex.deletes().map(call => decodeURIComponent(call.url.split("/deployments/")[1].replace("/delete", ""))).sort();
const closed = (f: Fixture, name: string, number: number, extra: Record<string, unknown> = {}) => {
  f.convex.add(deployment(name, extra));
  f.github.pulls.push({ number, ref: name, state: "closed", merged: true });
};

describe("hard delete guard (regardless of grants or config)", () => {
  it("never deletes a preview that references production, staging, main or release, even with a closed pull request", async () => {
    const f = await setup({ configs: { [COMPANY_A]: config() } });
    for (const [index, name] of ["release-1-2", "feat-staging-fix", "fix-main-nav", "hotfix-production"].entries()) closed(f, name, 10 + index);
    f.convex.add(deployment("abc123", { previewIdentifier: "feat/release-notes" }));
    f.github.pulls.push({ number: 99, ref: "feat/release-notes", state: "closed", merged: true });
    f.convex.add(deployment("xyz789", { reference: "preview/staging" }));
    f.github.pulls.push({ number: 98, ref: "xyz789", state: "closed", merged: true });
    closed(f, "feat-ok", 50);
    const plan = await f.h.performAction<any>("reaper.run", { dryRun: true }, member(COMPANY_A));
    expect(plan.projects[0].delete.map((item: any) => item.name)).toEqual(["feat-ok"]);
    expect(plan.projects[0].setExpiry.map((item: any) => item.name)).not.toEqual(expect.arrayContaining(["release-1-2"]));
    await f.h.runJob("convex-reaper");
    expect(deleted(f)).toEqual(["feat-ok"]);
  });

  it("refuses to delete or expire such a preview through the tools, for an agent granted everything on previews", async () => {
    const f = await setup();
    closed(f, "release-1-2", 7);
    const del = await f.h.executeTool<{ error?: string }>("convex_delete_preview", { name: "release-1-2" }, run("janitor"));
    const expire = await f.h.executeTool<{ error?: string }>("convex_set_preview_expiry", { name: "release-1-2", hours: 100 }, run("janitor"));
    expect(del.error).toMatch(/production, staging, main or release/i);
    expect(expire.error).toMatch(/production, staging, main or release/i);
    expect(f.convex.mutations()).toHaveLength(0);
  });

  it("never deletes prod, custom, default, local or staging-named deployments through the dev path, whatever the config says", async () => {
    const f = await setup({ configs: { [COMPANY_A]: config({ protect: [], onlyPatterns: ["*"], maxAgeDays: 1 }) } });
    f.convex.add(
      dev("happy-prod", "prod", 30, { deploymentType: "prod", isDefault: false }),
      dev("custom-one", "custom/one", 30, { deploymentType: "custom" }),
      dev("my-default", "dev/someone", 30, { isDefault: true }),
      dev("local-one", "dev/other", 30, { kind: "local" }),
      dev("stage-dev", "dev/staging-tools", 30),
      dev("main-dev", "dev/main", 30),
    );
    const { service } = f.runtime;
    const { config: cfg, reserved } = await service.requireConnected(COMPANY_A);
    for (const name of ["happy-prod", "custom-one", "my-default", "local-one", "stage-dev", "main-dev"]) {
      await expect(service.deleteDev({ kind: "reaper", companyId: COMPANY_A }, cfg, reserved, name, { dryRun: false }), name).rejects.toThrow();
    }
    await f.h.runJob("convex-reaper");
    expect(f.convex.deletes()).toHaveLength(0);
  });

  it("never lets an agent delete a dev deployment, directly or through the reap tool", async () => {
    const f = await setup({ configs: { [COMPANY_A]: config() } });
    f.convex.add(dev("old-dev", "dev/ship-3561-x", 30));
    const { service } = f.runtime;
    const { config: cfg, reserved } = await service.requireConnected(COMPANY_A);
    await expect(service.deleteDev({ kind: "agent", companyId: COMPANY_A, agent: { id: "janitor", role: "devops" }, runId: "r" }, cfg, reserved, "old-dev", { dryRun: false })).rejects.toThrow(/agent/i);
    const result = await f.h.executeTool<{ data?: any }>("convex_reap_previews", { dryRun: false }, run("janitor"));
    expect(result.data.projects[0].dev.delete.map((item: any) => item.name)).toEqual(["old-dev"]);
    expect(result.data.projects[0].dev.deleted).toEqual([]);
    expect(result.data.projects[0].dev.executed).toBe(false);
    expect(f.convex.deletes()).toHaveLength(0);
  });
});

describe("dev policy", () => {
  it("deletes dev deployments older than seven days, using createTime when never deployed, and keeps younger or undated ones", async () => {
    const f = await setup({ configs: { [COMPANY_A]: config() } });
    f.convex.add(
      dev("old", "dev/ship-3561-a", 8), dev("young", "dev/ship-3562-b", 6), dev("edge", "dev/ship-3563-c", 6.9),
      dev("never-deployed", "dev/issue-3555-d", null, { lastDeployTime: null, createTime: NOW - 9 * DAY }),
      dev("undated", "dev/issue-3556-e", null, { lastDeployTime: null, createTime: null }),
    );
    await f.h.runJob("convex-reaper");
    expect(deleted(f)).toEqual(["never-deployed", "old"]);
    expect(f.convex.deployments.has("undated")).toBe(true);
  });

  it("uses the company's age limit", async () => {
    const f = await setup({ configs: { [COMPANY_A]: config({ maxAgeDays: 3 }) } });
    f.convex.add(dev("four-days", "dev/ship-1-a", 4), dev("two-days", "dev/ship-2-b", 2));
    await f.h.runJob("convex-reaper");
    expect(deleted(f)).toEqual(["four-days"]);
  });

  it("protects defaults, personal developers, shared pools and the company's own list", async () => {
    const f = await setup({ configs: { [COMPANY_A]: config({ protect: ["dev/keep-*", "dev/pinned"] }) } });
    f.convex.add(
      dev("human-1", "dev/alice", 90, { isDefault: true }), dev("human-2", "dev/sam-k", 90, { isDefault: true }),
      dev("pool-1", "dev/paperclip-agents", 90), dev("pool-2", "dev/local-abc", 90), dev("pool-3", "dev/qa-songtrivia", 90),
      dev("mine-1", "dev/keep-this-one", 90), dev("mine-2", "dev/pinned", 90), dev("mine-3", "DEV/Keep-Upper", 90),
      dev("agent-made", "dev/songtrivia-3444-feature", 90),
    );
    await f.h.runJob("convex-reaper");
    expect(deleted(f)).toEqual(["agent-made"]);
  });

  it("can be limited to an allow list of reference patterns", async () => {
    const f = await setup({ configs: { [COMPANY_A]: config({ onlyPatterns: ["dev/ship-*", "dev/issue-*"] }) } });
    f.convex.add(dev("a", "dev/ship-1-a", 30), dev("b", "dev/issue-2-b", 30), dev("c", "dev/songtrivia-3-c", 30), dev("d", "dev/someone-else", 30));
    await f.h.runJob("convex-reaper");
    expect(deleted(f)).toEqual(["a", "b"]);
  });

  it("is a plan only until both the reaper and the dev policy are enabled, and in a dry run or dryRunOnly", async () => {
    const seed = (f: Fixture) => f.convex.add(dev("old", "dev/ship-1-a", 30));
    const reaperOff = await setup({ configs: { [COMPANY_A]: baseConfig({ reaper: { dev: { enabled: true, onlyPatterns: ["dev/*"] } } }) } });
    seed(reaperOff);
    await reaperOff.h.runJob("convex-reaper");
    expect(reaperOff.convex.deletes()).toHaveLength(0);
    expect((await report(reaperOff)).projects[0].dev.delete.map((item: any) => item.name)).toEqual(["old"]);

    const devOff = await setup({ configs: { [COMPANY_A]: baseConfig({ reaper: { enabled: true, dev: { onlyPatterns: ["dev/*"] } } }) } });
    seed(devOff);
    await devOff.h.runJob("convex-reaper");
    expect(devOff.convex.deletes()).toHaveLength(0);
    expect((await report(devOff)).projects[0].dev.delete.map((item: any) => item.name)).toEqual(["old"]);

    const dry = await setup({ configs: { [COMPANY_A]: config() } });
    seed(dry);
    await dry.h.performAction("reaper.run", { dryRun: true }, member(COMPANY_A));
    expect(dry.convex.deletes()).toHaveLength(0);

    const only = await setup({ configs: { [COMPANY_A]: config({}, {}, { guards: { dryRunOnly: true } }) } });
    seed(only);
    await only.h.runJob("convex-reaper");
    expect(only.convex.deletes()).toHaveLength(0);
  });

  it("caps dev deletions per run separately from previews and reports what it left", async () => {
    const f = await setup({ configs: { [COMPANY_A]: config({ maxDeletes: 2 }) } });
    for (let i = 0; i < 5; i++) f.convex.add(dev(`old-${i}`, `dev/ship-${i}-x`, 30));
    for (let i = 0; i < 3; i++) closed(f, `done-${i}`, 100 + i);
    await f.h.runJob("convex-reaper");
    expect(deleted(f).filter(name => name.startsWith("old-"))).toHaveLength(2);
    expect(deleted(f).filter(name => name.startsWith("done-"))).toHaveLength(3);
    const entry = (await report(f)).projects[0].dev;
    expect(entry.deleted).toHaveLength(2);
    expect(entry.skipped.filter((item: any) => /limit/i.test(item.reason))).toHaveLength(3);
  });

  it("audits every dev deletion with the before-state", async () => {
    const f = await setup({ configs: { [COMPANY_A]: config() } });
    f.convex.add(dev("old-a", "dev/ship-1-a", 30), dev("old-b", "dev/issue-2-b", 12));
    await f.h.runJob("convex-reaper");
    const entries = f.h.activity.filter(item => item.message === "Convex dev deployment deleted");
    expect(entries).toHaveLength(2);
    expect(entries[0].metadata).toMatchObject({ reaper: true, environment: "dev", outcome: "deleted", before: expect.objectContaining({ deploymentType: "dev", reference: expect.stringMatching(/^dev\//) }) });
    expect(JSON.stringify(entries)).not.toContain("deploymentUrl");
  });

  it("checks that the deployment is really gone after the delete", async () => {
    const f = await setup({ configs: { [COMPANY_A]: config() } });
    f.convex.add(dev("sticky", "dev/ship-1-a", 30), dev("fine", "dev/ship-2-b", 30));
    f.convex.keepAfterDelete.add("sticky");
    await f.h.runJob("convex-reaper");
    const entry = (await report(f)).projects[0].dev;
    expect(entry.deleted).toEqual(["fine"]);
    expect(entry.failed).toEqual([{ name: "sticky", error: expect.stringMatching(/still exists/i) }]);
  });

  it("re-fetches the deployment right before deleting, so a redeploy after listing keeps it", async () => {
    const f = await setup({ configs: { [COMPANY_A]: config() } });
    f.convex.add(dev("old", "dev/ship-1-a", 30));
    const { service } = f.runtime;
    const { config: cfg, reserved } = await service.requireConnected(COMPANY_A);
    f.convex.deployments.get("old")!.lastDeployTime = NOW - HOUR;
    await expect(service.deleteDev({ kind: "reaper", companyId: COMPANY_A }, cfg, reserved, "old", { dryRun: false })).rejects.toThrow(/younger|age/i);
    expect(f.convex.deletes()).toHaveLength(0);
  });
});

describe("dev credential", () => {
  const rich = (devPolicy: Record<string, unknown> = {}) => config(devPolicy, {}, {
    projects: [{ convexProjectId: "100", name: "app", repository: "org/app", token: ref("s-project"), previewDeployKey: ref("s-preview") }],
  });

  it("lists and deletes dev deployments with the company's token, never the preview deploy key", async () => {
    const f = await setup({ configs: { [COMPANY_A]: rich() } });
    f.convex.validTokens.add(PREVIEW_KEY);
    f.convex.add(dev("old", "dev/ship-1-a", 30));
    await f.h.runJob("convex-reaper");
    expect(deleted(f)).toEqual(["old"]);
    const devCalls = f.convex.calls.filter(call => call.method === "POST" || new URL(call.url).searchParams.get("deploymentType") === "dev");
    expect(devCalls.length).toBeGreaterThan(0);
    expect(devCalls.map(call => call.authorization)).not.toContain(`Bearer ${PREVIEW_KEY}`);
    expect(f.convex.deletes()[0].authorization).toBe(`Bearer ${PROJECT_TOKEN}`);
  });

  it("reports that dev deployments need a team access token when listing is denied, and still reaps previews", async () => {
    const f = await setup({ configs: { [COMPANY_A]: config() } });
    f.convex.listDenied.add("dev");
    closed(f, "feat-done", 5);
    await f.h.runJob("convex-reaper");
    expect(deleted(f)).toEqual(["feat-done"]);
    const entry = (await report(f)).projects[0];
    expect(entry.dev.error).toMatch(/team access token/i);
    expect(entry.error).toBeUndefined();
  });
});

describe("superseded previews of open pull requests", () => {
  const PATTERN = "^pr(?<pr>\\d+)-run(?<run>\\d+)-s(?<shard>\\d+)-a(?<attempt>\\d+)$";
  const ci = (pr: number, run: number, shard: number, attempt: number, hoursAgo: number) =>
    deployment(`pr${pr}-run${run}-s${shard}-a${attempt}`, { previewIdentifier: `pr${pr}-run${run}-s${shard}-a${attempt}`, lastDeployTime: NOW - hoursAgo * HOUR, createTime: NOW - (hoursAgo + 0.2) * HOUR });
  const withPattern = (extra: Record<string, unknown> = {}) => config({}, { pullRequestPattern: PATTERN, ...extra });

  it("deletes older runs and attempts of an open pull request and keeps every shard of the newest", async () => {
    const f = await setup({ configs: { [COMPANY_A]: withPattern() } });
    f.convex.add(ci(4320, 100, 1, 1, 5), ci(4320, 100, 2, 1, 5), ci(4320, 101, 1, 1, 3), ci(4320, 101, 2, 1, 3), ci(4320, 101, 1, 2, 2), ci(4320, 101, 2, 2, 2), ci(4321, 99, 1, 1, 9));
    f.github.pulls.push({ number: 4320, ref: "feature/x" }, { number: 4321, ref: "feature/y" });
    await f.h.runJob("convex-reaper");
    expect(deleted(f)).toEqual(["pr4320-run100-s1-a1", "pr4320-run100-s2-a1", "pr4320-run101-s1-a1", "pr4320-run101-s2-a1"]);
    const entry = (await report(f)).projects[0];
    expect(entry.delete.find((item: any) => item.name === "pr4320-run100-s1-a1")?.reason).toMatch(/superseded by pr4320-run101-s\d-a2/);
    for (const kept of ["pr4320-run101-s1-a2", "pr4320-run101-s2-a2", "pr4321-run99-s1-a1"]) expect(f.convex.deployments.has(kept), kept).toBe(true);
  });

  it("waits until an older preview has been idle for the minimum age", async () => {
    const f = await setup({ configs: { [COMPANY_A]: withPattern({ supersededMinAgeMinutes: 60 }) } });
    f.convex.add({ ...ci(4320, 100, 1, 1, 0.2) }, ci(4320, 101, 1, 1, 0.1));
    f.github.pulls.push({ number: 4320, ref: "feature/x" });
    await f.h.runJob("convex-reaper");
    expect(f.convex.deletes()).toHaveLength(0);
  });

  it("does nothing about open pull requests when no pattern is configured", async () => {
    const f = await setup({ configs: { [COMPANY_A]: config() } });
    // Within the idle window, so only the superseded rule could remove the older one, and it needs a pattern.
    f.convex.add(ci(4320, 100, 1, 1, 5), ci(4320, 101, 1, 1, 2));
    f.github.pulls.push({ number: 4320, ref: "feature/x" });
    await f.h.runJob("convex-reaper");
    expect(f.convex.deletes()).toHaveLength(0);
  });

  it("deletes every preview of a pull request once it is closed, matching them by the pattern", async () => {
    const f = await setup({ configs: { [COMPANY_A]: withPattern() } });
    f.convex.add(ci(4320, 100, 1, 1, 30), ci(4320, 101, 1, 1, 3));
    f.github.pulls.push({ number: 4320, ref: "feature/x", state: "closed", merged: true });
    await f.h.runJob("convex-reaper");
    expect(deleted(f)).toEqual(["pr4320-run100-s1-a1", "pr4320-run101-s1-a1"]);
  });

  it("is not available to an agent deleting one preview by hand", async () => {
    const f = await setup({ configs: { [COMPANY_A]: withPattern() } });
    f.convex.add(ci(4320, 100, 1, 1, 5), ci(4320, 101, 1, 1, 2));
    f.github.pulls.push({ number: 4320, ref: "feature/x" });
    const result = await f.h.executeTool<{ error?: string }>("convex_delete_preview", { name: "pr4320-run100-s1-a1" }, run("janitor"));
    expect(result.error).toMatch(/open pull request #4320/i);
    expect(f.convex.deletes()).toHaveLength(0);
  });

  it("re-checks that the newer preview still exists right before deleting", async () => {
    const f = await setup({ configs: { [COMPANY_A]: withPattern() } });
    f.convex.add(ci(4320, 100, 1, 1, 5));
    f.github.pulls.push({ number: 4320, ref: "feature/x" });
    const { service } = f.runtime;
    const { config: cfg, reserved } = await service.requireConnected(COMPANY_A);
    await expect(service.deletePreview({ kind: "reaper", companyId: COMPANY_A }, cfg, reserved, "pr4320-run100-s1-a1", {
      dryRun: false, supersededBy: { name: "pr4320-run101-s1-a1", pr: 4320 },
    })).rejects.toThrow(/newer preview/i);
    expect(f.convex.deletes()).toHaveLength(0);
  });
});

describe("superseded override stays tied to the blocking pull request", () => {
  it("does not let a newer preview of one pull request clear the open-PR block of another", async () => {
    const f = await setup({ configs: { [COMPANY_A]: config({}, { pullRequestPattern: "^pr(?<pr>\\d+)-run(?<run>\\d+)-s(?<shard>\\d+)-a(?<attempt>\\d+)$" }) } });
    f.convex.add(deployment("pr4320-run100-s1-a1", { previewIdentifier: "pr4320-run100-s1-a1", lastDeployTime: NOW - 5 * HOUR }), deployment("pr9999-run200-s1-a1", { previewIdentifier: "pr9999-run200-s1-a1", lastDeployTime: NOW - 1 * HOUR }));
    f.github.pulls.push({ number: 4320, ref: "feature/x" }, { number: 9999, ref: "feature/y" });
    const { service } = f.runtime;
    const { config: cfg, reserved } = await service.requireConnected(COMPANY_A);
    await expect(service.deletePreview({ kind: "reaper", companyId: COMPANY_A }, cfg, reserved, "pr4320-run100-s1-a1", {
      dryRun: false, supersededBy: { name: "pr9999-run200-s1-a1", pr: 9999 },
    })).rejects.toThrow(/open pull request #4320/i);
    expect(f.convex.deletes()).toHaveLength(0);
  });
});

describe("configuration", () => {
  it("accepts the new settings and rejects bad ones", async () => {
    const { parseConfig } = await import("../src/config.js");
    const parsed = parseConfig({ reaper: { dev: { enabled: true, maxAgeDays: 14, protect: ["dev/a*"], onlyPatterns: ["dev/ship-*"], maxDeletes: 5 }, pullRequestPattern: "^pr(?<pr>\\d+)-x$", supersededMinAgeMinutes: 90 } });
    expect(parsed.reaper.dev).toEqual({ enabled: true, maxAgeDays: 14, protect: ["dev/a*"], onlyPatterns: ["dev/ship-*"], maxDeletes: 5 });
    expect(parsed.reaper.supersededMinAgeMinutes).toBe(90);
    expect(parseConfig({}).reaper.dev).toEqual({ enabled: false, maxAgeDays: 7, protect: [], onlyPatterns: [], maxDeletes: 20 });
    for (const bad of [
      { reaper: { dev: { maxAgeDays: 0 } } }, { reaper: { dev: { maxAgeDays: 91 } } }, { reaper: { dev: { protect: "dev/a" } } },
      { reaper: { dev: { onlyPatterns: [5] } } }, { reaper: { dev: { maxDeletes: 0 } } }, { reaper: { dev: { enabled: "yes" } } },
      { reaper: { pullRequestPattern: "no named group" } }, { reaper: { pullRequestPattern: "(?<pr>\\d+)" } }, { reaper: { pullRequestPattern: "^(?<pr>\\d+)-x" } },
      { reaper: { pullRequestPattern: "^(?<pr>\\d+)(a+)+$" } }, { reaper: { pullRequestPattern: "^(?<pr>\\d+)(?:-(\\w+){2,})$" } },
      { reaper: { dev: { protect: ["*alice*"] } } }, { reaper: { dev: { onlyPatterns: ["dev/*-pinned"] } } }, { reaper: { dev: { protect: ["a**"] } } }, { reaper: { pullRequestPattern: "(?<pr>[" } }, { reaper: { pullRequestPattern: "x".repeat(300) } },
      { reaper: { supersededMinAgeMinutes: 5 } },
    ]) expect(() => parseConfig(bad as Record<string, unknown>), JSON.stringify(bad)).toThrow();
  });

  it("parses the example config printed in the design doc", async () => {
    const { parseConfig } = await import("../src/config.js");
    const doc = readFileSync(new URL("../../../../docs/plugins/convex.md", import.meta.url), "utf8");
    const example = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(doc)![1]);
    const parsed = parseConfig(example);
    expect(parsed.reaper.dev.maxAgeDays).toBe(7);
    expect(parsed.reaper.pullRequestPattern).toContain("(?<pr>");
    expect(parsed.projects[0].repository).toBe("org/app");
  });
});

describe("review fixes (PR #46)", () => {
  const PATTERN = "^pr(?<pr>\\d+)-run(?<run>\\d+)-s(?<shard>\\d+)-a(?<attempt>\\d+)$";
  const ci = (pr: number, run: number, shard: number, attempt: number, hoursAgo: number) =>
    deployment(`pr${pr}-run${run}-s${shard}-a${attempt}`, { previewIdentifier: `pr${pr}-run${run}-s${shard}-a${attempt}`, lastDeployTime: NOW - hoursAgo * HOUR, createTime: NOW - (hoursAgo + 0.2) * HOUR });

  it("deletes only what the allow list names, so a person's second dev deployment and unnamed pools are safe", async () => {
    const f = await setup({ configs: { [COMPANY_A]: config({ onlyPatterns: ["dev/ship-*", "dev/issue-*"] }) } });
    f.convex.add(dev("agent-1", "dev/ship-1-a", 30), dev("alice-second", "dev/alice-perf", 90), dev("pool", "dev/paperclip-agents", 90), dev("no-ref", "dev/ignored", 90, { reference: null }));
    await f.h.runJob("convex-reaper");
    expect(deleted(f)).toEqual(["agent-1"]);
  });

  it("deletes no dev deployment until an allow list is configured, and lists what it would need to decide", async () => {
    const f = await setup({ configs: { [COMPANY_A]: baseConfig({ reaper: { enabled: true, dev: { enabled: true } } }) } });
    f.convex.add(dev("agent-1", "dev/ship-1-a", 30), dev("alice-second", "dev/alice-perf", 90));
    await f.h.runJob("convex-reaper");
    expect(f.convex.deletes()).toHaveLength(0);
    const entry = (await report(f)).projects[0].dev;
    expect(entry.delete).toEqual([]);
    expect(entry.skipped.map((item: any) => item.name).sort()).toEqual(["agent-1", "alice-second"]);
    expect(entry.skipped[0].reason).toMatch(/allow list/i);
  });

  it("shares one dev deletion cap across all projects in a run", async () => {
    const projects = [{ convexProjectId: "100", name: "a", repository: "org/a" }, { convexProjectId: "200", name: "b", repository: "org/b" }];
    const f = await setup({ configs: { [COMPANY_A]: config({ maxDeletes: 3 }, {}, { projects }) } });
    for (let i = 0; i < 4; i++) f.convex.add(dev(`a-${i}`, `dev/ship-${i}-a`, 30), dev(`b-${i}`, `dev/ship-${i}-b`, 30, { projectId: 200 }));
    await f.h.runJob("convex-reaper");
    expect(f.convex.deletes()).toHaveLength(3);
  });

  it("does not delete a dev deployment whose name hides a production word behind a digit or a capital", async () => {
    const f = await setup({ configs: { [COMPANY_A]: config() } });
    f.convex.add(dev("a", "dev/staging2", 30), dev("b", "dev/releaseCandidate", 30), dev("c", "dev/ship-1-ok", 30));
    await f.h.runJob("convex-reaper");
    expect(deleted(f)).toEqual(["c"]);
  });

  it("never uses the preview deploy key for dev deployments, not even for the first read", async () => {
    const f = await setup({ configs: { [COMPANY_A]: config({}, {}, { projects: [{ convexProjectId: "100", name: "app", repository: "org/app", token: ref("s-project"), previewDeployKey: ref("s-preview") }] }) } });
    f.convex.validTokens.add(PREVIEW_KEY);
    f.convex.add(dev("old", "dev/ship-1-a", 30));
    await f.h.runJob("convex-reaper");
    expect(deleted(f)).toEqual(["old"]);
    expect(f.convex.calls.map(call => call.authorization)).not.toContain(`Bearer ${PREVIEW_KEY}`);
  });

  it("takes the pull request from the pattern alone, so an unrelated closed pull request with the same branch name is not evidence", async () => {
    const f = await setup({ configs: { [COMPANY_A]: config({}, { pullRequestPattern: "^pr(?<pr>\\d+)-x$" }) } });
    f.convex.add(deployment("pr123-x", { previewIdentifier: "pr123-x", lastDeployTime: NOW - 50 * HOUR }));
    f.github.pulls.push({ number: 77, ref: "pr123-x", state: "closed", merged: true });
    const result = await f.h.executeTool<{ data?: any }>("convex_delete_preview", { name: "pr123-x", dryRun: true }, run("janitor"));
    expect(result.data.evidence.prState).toBe("none");
    expect(result.data.reason).toMatch(/branch is gone/i);
  });

  it("re-checks idle time and run order on the fresh records before deleting a superseded preview", async () => {
    const f = await setup({ configs: { [COMPANY_A]: config({}, { pullRequestPattern: PATTERN }) } });
    f.convex.add(ci(4320, 100, 1, 1, 0.1), ci(4320, 101, 1, 1, 0.05), ci(4320, 90, 1, 1, 5));
    f.github.pulls.push({ number: 4320, ref: "feature/x" });
    const { service } = f.runtime;
    const { config: cfg, reserved } = await service.requireConnected(COMPANY_A);
    const reaper = { kind: "reaper" as const, companyId: COMPANY_A };
    // Redeployed six minutes ago: in use, so not deleted even though the plan once called it superseded.
    await expect(service.deletePreview(reaper, cfg, reserved, "pr4320-run100-s1-a1", { dryRun: false, supersededBy: { name: "pr4320-run101-s1-a1", pr: 4320 } })).rejects.toThrow(/idle|recent|in use/i);
    // The "newer" preview is really older (run 90): not a replacement.
    await expect(service.deletePreview(reaper, cfg, reserved, "pr4320-run101-s1-a1", { dryRun: false, supersededBy: { name: "pr4320-run90-s1-a1", pr: 4320 } })).rejects.toThrow(/newer preview/i);
    expect(f.convex.deletes()).toHaveLength(0);
  });

  it("only compares run numbers with run numbers, and times with times", async () => {
    const pattern = "^pr(?<pr>\\d+)(?:-run(?<run>\\d+))?-s(?<shard>\\d+)$";
    const f = await setup({ configs: { [COMPANY_A]: config({}, { pullRequestPattern: pattern }) } });
    const make = (name: string, hoursAgo: number) => deployment(name, { previewIdentifier: name, lastDeployTime: NOW - hoursAgo * HOUR, createTime: NOW - (hoursAgo + 0.2) * HOUR });
    // PR 4320 mixes named runs with an unnumbered one: only run 3 is older than run 5; the unnumbered one is never compared.
    f.convex.add(make("pr4320-run5-s1", 9), make("pr4320-s1", 4), make("pr4320-run3-s1", 6));
    // PR 4321 has no run numbers: the older one is replaced by one made at least the minimum age later.
    f.convex.add(make("pr4321-s1", 8), make("pr4321-s2", 2));
    f.github.pulls.push({ number: 4320, ref: "a" }, { number: 4321, ref: "b" });
    await f.h.runJob("convex-reaper");
    expect(deleted(f)).toEqual(["pr4320-run3-s1", "pr4321-s1"]);
  });

  it("reports a delete as unverified, not failed, when the follow-up read cannot tell", async () => {
    const f = await setup({ configs: { [COMPANY_A]: config() } });
    f.convex.add(dev("old", "dev/ship-1-a", 30));
    f.convex.flakyAfterDelete.add("old");
    await f.h.runJob("convex-reaper");
    expect((await report(f)).projects[0].dev.deleted).toEqual(["old"]);
    expect(f.h.activity.some(item => item.metadata?.outcome === "deleted-unverified")).toBe(true);
  });

  it("lets an expiry the plugin set keep following redeploys on a preview the hard guard now covers, but never schedules one", async () => {
    const f = await setup({ configs: { [COMPANY_A]: baseConfig({ reaper: { enabled: true } }) } });
    f.convex.add(deployment("feat-stage-x", { lastDeployTime: NOW - 10 * HOUR, expiresAt: NOW + 26 * HOUR }));
    await f.h.ctx.state.set({ scopeKind: "company", scopeId: COMPANY_A, namespace: "reaper", stateKey: "managed-expiry" }, { "feat-stage-x": NOW + 26 * HOUR });
    f.clock.now += 10 * HOUR;
    f.convex.deployments.get("feat-stage-x")!.lastDeployTime = f.clock.now - HOUR;
    await f.h.runJob("convex-reaper");
    expect(f.convex.deployments.get("feat-stage-x")?.expiresAt).toBe(f.clock.now - HOUR + 36 * HOUR);
    // An agent can extend it too, but cannot shorten it.
    const tool = (hours: number) => f.h.executeTool<{ data?: any; error?: string }>("convex_set_preview_expiry", { name: "feat-stage-x", hours }, run("janitor"));
    expect((await tool(100)).data.expiresAt).toBe(f.clock.now + 100 * HOUR);
    expect((await tool(40)).error).toMatch(/production, staging, main or release/i);
    f.convex.add(deployment("feat-release-y", { expiresAt: null }));
    expect((await f.h.executeTool<{ error?: string }>("convex_set_preview_expiry", { name: "feat-release-y", hours: 100 }, run("janitor"))).error).toMatch(/production, staging, main or release/i);
  });
});
