import { describe, expect, it } from "vitest";
import { COMPANY_A, admin, baseConfig, member, run, setup, type Fixture } from "./fixture.js";
import { HOUR, NOW, deployment } from "./fakes.js";

const tool = (f: Fixture, name: string, input: Record<string, unknown>, agent = "janitor") => f.h.executeTool<{ data?: any; error?: string }>(name, input, run(agent));
const closedPr = (f: Fixture, name: string, number = 5) => {
  f.convex.add(deployment(name));
  f.github.pulls.push({ number, ref: name, state: "closed", merged: true });
};
const enabled = (extra: Record<string, unknown> = {}) => baseConfig({ reaper: { enabled: true }, ...extra });
const lastReport = (f: Fixture) => f.h.performAction<any>("reaper.report", {}, member(COMPANY_A));

describe("a missing dryRun means plan only", () => {
  it("plans for an agent's convex_delete_preview and deletes only with dryRun: false", async () => {
    const f = await setup();
    closedPr(f, "feat-done");
    const planned = await tool(f, "convex_delete_preview", { name: "feat-done" });
    expect(planned.data).toMatchObject({ dryRun: true, wouldDelete: true, deleted: false });
    expect(f.convex.deletes()).toHaveLength(0);
    expect((await tool(f, "convex_delete_preview", { name: "feat-done", dryRun: false })).data).toMatchObject({ dryRun: false, deleted: true });
    expect(f.convex.deletes()).toHaveLength(1);
  });

  it("gives an agent no way to delete a preview that has no evidence its work is finished", async () => {
    const f = await setup();
    f.convex.add(deployment("feat-quiet"));
    f.github.branches.set("feat-quiet", new Date(NOW - 60 * HOUR).toISOString());
    expect((await tool(f, "convex_delete_preview", { name: "feat-quiet", dryRun: false })).error).toMatch(/No closed pull request and no idle gone branch/);
    expect(f.convex.deletes()).toHaveLength(0);
  });

  it("plans for convex_reap_previews called with no input, even while the reaper is enabled", async () => {
    const f = await setup({ configs: { [COMPANY_A]: enabled() } });
    closedPr(f, "feat-done");
    const planned = await tool(f, "convex_reap_previews", {});
    expect(planned.data.dryRun).toBe(true);
    expect(planned.data.projects[0].delete.map((item: any) => item.name)).toEqual(["feat-done"]);
    expect(f.convex.mutations()).toHaveLength(0);
    expect((await tool(f, "convex_reap_previews", { dryRun: false })).data.projects[0].deleted).toEqual(["feat-done"]);
  });

  it("plans for the board's delete-preview and reaper.run without dryRun", async () => {
    const f = await setup({ configs: { [COMPANY_A]: enabled() } });
    closedPr(f, "feat-done");
    expect(await f.h.performAction<any>("deployments.delete-preview", { name: "feat-done" }, admin(COMPANY_A))).toMatchObject({ dryRun: true, deleted: false });
    expect((await f.h.performAction<any>("reaper.run", {}, admin(COMPANY_A))).dryRun).toBe(true);
    expect(f.convex.mutations()).toHaveLength(0);
  });

  it("refuses a real convex_reap_previews while the reaper is off, with the same words as the board", async () => {
    const f = await setup();
    closedPr(f, "feat-done");
    const agent = await tool(f, "convex_reap_previews", { dryRun: false });
    expect(agent.error).toMatch(/Enable the reaper \(reaper\.enabled\)/);
    await expect(f.h.performAction("reaper.run", { dryRun: false }, admin(COMPANY_A))).rejects.toThrow(agent.error!);
    expect(f.convex.mutations()).toHaveLength(0);
  });
});

describe("guards.dryRunOnly holds every change to a plan", () => {
  const held = () => setup({ configs: { [COMPANY_A]: enabled({ guards: { dryRunOnly: true } }) } });

  it("holds convex_set_preview_expiry and says so", async () => {
    const f = await held();
    f.convex.add(deployment("feat-x"));
    const result = await tool(f, "convex_set_preview_expiry", { name: "feat-x", hours: 48, dryRun: false });
    expect(result.data).toMatchObject({ dryRun: true, expiresAt: NOW + 48 * HOUR, note: expect.stringMatching(/dry-run-only/) });
    expect(f.convex.mutations()).toHaveLength(0);
  });

  it("holds convex_delete_preview and says so", async () => {
    const f = await held();
    closedPr(f, "feat-done");
    const result = await tool(f, "convex_delete_preview", { name: "feat-done", dryRun: false });
    expect(result.data).toMatchObject({ dryRun: true, deleted: false, note: expect.stringMatching(/dry-run-only/) });
    expect(f.convex.mutations()).toHaveLength(0);
  });

  it("holds the scheduled job, a real reaper.run and convex_reap_previews, although the reaper is enabled", async () => {
    const f = await held();
    closedPr(f, "feat-done");
    f.convex.add(deployment("feat-x"));
    await f.h.runJob("convex-reaper");
    expect((await lastReport(f)).dryRun).toBe(true);
    expect((await f.h.performAction<any>("reaper.run", { dryRun: false }, admin(COMPANY_A))).dryRun).toBe(true);
    expect((await tool(f, "convex_reap_previews", { dryRun: false })).data.dryRun).toBe(true);
    expect(f.convex.mutations()).toHaveLength(0);
  });
});

describe("the reaper's own hard guard", () => {
  it("lists a hard-blocked preview as skipped, never as a planned delete, in a dry run", async () => {
    const f = await setup();
    f.convex.add(deployment("release-notes", { previewIdentifier: "feat/release" }), deployment("feat-done"));
    f.github.pulls.push({ number: 5, ref: "feat/release", state: "closed", merged: true }, { number: 6, ref: "feat-done", state: "closed", merged: true });
    await f.h.runJob("convex-reaper");
    const project = (await lastReport(f)).projects[0];
    expect(project.delete.map((item: any) => item.name)).toEqual(["feat-done"]);
    expect(project.skipped).toEqual([expect.objectContaining({ name: "release-notes", reason: expect.stringMatching(/production, staging, main or release/) })]);
    expect(f.convex.mutations()).toHaveLength(0);
  });
});

describe("expiry dry runs say what counts as a deletion", () => {
  it("reports countsAsDeletion and the earliest expiry that is free", async () => {
    const f = await setup();
    f.convex.add(deployment("feat-x"));
    const short = await tool(f, "convex_set_preview_expiry", { name: "feat-x", hours: 1, dryRun: true });
    // The preview was last deployed 50 hours ago, so the reaper's own deadline for it is now + 36 hours.
    expect(short.data).toMatchObject({ dryRun: true, countsAsDeletion: true, earliestFreeExpiresAt: NOW + 36 * HOUR });
    const long = await tool(f, "convex_set_preview_expiry", { name: "feat-x", hours: 48, dryRun: true });
    expect(long.data).toMatchObject({ countsAsDeletion: false, earliestFreeExpiresAt: NOW + 36 * HOUR });
    expect(f.convex.mutations()).toHaveLength(0);
  });
});
