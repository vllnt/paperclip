import { describe, expect, it } from "vitest";
import { COMPANY_A, admin, baseConfig, member, run, setup, type Fixture } from "./fixture.js";
import { HOUR, NOW, deployment } from "./fakes.js";

function seedPreviews(f: Fixture) {
  f.convex.add(
    deployment("closed-pr", { lastDeployTime: NOW - 30 * HOUR }),
    deployment("open-pr", { lastDeployTime: NOW - 10 * HOUR }),
    deployment("open-old", { lastDeployTime: NOW - 80 * HOUR }),
    deployment("active-branch", { lastDeployTime: NOW - 5 * HOUR }),
    deployment("gone-idle", { lastDeployTime: NOW - 48 * HOUR }),
    deployment("gone-fresh", { lastDeployTime: NOW - 1 * HOUR }),
    deployment("staging-app", { lastDeployTime: NOW - 90 * HOUR }),
    deployment("happy-prod", { deploymentType: "prod", isDefault: true, previewIdentifier: null }),
    deployment("dev-sam", { deploymentType: "dev", previewIdentifier: null, reference: "dev/sam" }),
  );
  f.github.pulls.push({ number: 1, ref: "closed-pr", state: "closed", merged: true }, { number: 2, ref: "open-pr" }, { number: 3, ref: "open-old" });
  f.github.branches.set("active-branch", new Date(NOW - 2 * HOUR).toISOString());
}

const enabled = (extra: Record<string, unknown> = {}) => baseConfig({ reaper: { enabled: true }, ...extra });
const report = async (f: Fixture) => f.h.performAction<any>("reaper.report", {}, member(COMPANY_A));

describe("reaper", () => {
  it("is a dry run until the company enables it: it plans but changes nothing", async () => {
    const f = await setup();
    seedPreviews(f);
    await f.h.runJob("convex-reaper");
    expect(f.convex.mutations()).toHaveLength(0);
    const last = await report(f);
    expect(last.dryRun).toBe(true);
    const project = last.projects[0];
    expect(project.delete.map((item: any) => item.name).sort()).toEqual(["closed-pr", "gone-idle"]);
    expect(project.deleted).toEqual([]);
  });

  it("deletes previews whose PR is closed or whose branch is gone and idle, and keeps the rest", async () => {
    const f = await setup({ configs: { [COMPANY_A]: enabled() } });
    seedPreviews(f);
    await f.h.runJob("convex-reaper");
    const gone = ["closed-pr", "gone-idle"];
    expect(f.convex.deletes().map(call => decodeURIComponent(call.url.split("/deployments/")[1].replace("/delete", ""))).sort()).toEqual(gone);
    for (const name of ["open-pr", "open-old", "active-branch", "gone-fresh", "staging-app", "happy-prod", "dev-sam"]) {
      expect(f.convex.deployments.has(name)).toBe(true);
    }
    expect((await report(f)).dryRun).toBe(false);
  });

  it("sets expiresAt to lastDeployTime + 36h on kept previews and never touches production, dev or staging", async () => {
    const f = await setup({ configs: { [COMPANY_A]: enabled() } });
    seedPreviews(f);
    await f.h.runJob("convex-reaper");
    expect(f.convex.deployments.get("open-pr")?.expiresAt).toBe(NOW - 10 * HOUR + 36 * HOUR);
    expect(f.convex.deployments.get("active-branch")?.expiresAt).toBe(NOW - 5 * HOUR + 36 * HOUR);
    expect(f.convex.deployments.get("gone-fresh")?.expiresAt).toBe(NOW - 1 * HOUR + 36 * HOUR);
    // lastDeployTime + 36h is already past: never schedule a guarded preview for deletion within the hour. Cap it at now + 36h only when it has no expiry.
    expect(f.convex.deployments.get("open-old")?.expiresAt).toBe(NOW + 36 * HOUR);
    for (const name of ["staging-app", "happy-prod", "dev-sam"]) expect(f.convex.deployments.get(name)?.expiresAt ?? null).toBeNull();
  });

  it("does not extend an expiry that is already sooner", async () => {
    const f = await setup({ configs: { [COMPANY_A]: enabled() } });
    f.convex.add(deployment("soon", { lastDeployTime: NOW - 1 * HOUR, expiresAt: NOW + 3 * HOUR }));
    f.github.branches.set("soon", new Date(NOW - 1 * HOUR).toISOString());
    await f.h.runJob("convex-reaper");
    expect(f.convex.deployments.get("soon")?.expiresAt).toBe(NOW + 3 * HOUR);
  });

  it("stops at the per-run deletion cap and reports what it left", async () => {
    const f = await setup({ configs: { [COMPANY_A]: enabled({ guards: { maxDeletesPerRun: 3 } }) } });
    for (let i = 0; i < 7; i++) {
      f.convex.add(deployment(`old-${i}`));
      f.github.pulls.push({ number: 100 + i, ref: `old-${i}`, state: "closed", merged: true });
    }
    await f.h.runJob("convex-reaper");
    expect(f.convex.deletes()).toHaveLength(3);
    const project = (await report(f)).projects[0];
    expect(project.deleted).toHaveLength(3);
    expect(project.skipped.filter((item: any) => /limit/i.test(item.reason))).toHaveLength(4);
  });

  it("records a failed deletion and carries on", async () => {
    const f = await setup({ configs: { [COMPANY_A]: enabled() } });
    for (const name of ["a", "b"]) {
      f.convex.add(deployment(name));
      f.github.pulls.push({ number: 1, ref: name, state: "closed", merged: true });
    }
    f.convex.failDeleteFor.add("a");
    await f.h.runJob("convex-reaper");
    const project = (await report(f)).projects[0];
    expect(project.deleted).toEqual(["b"]);
    expect(project.failed).toHaveLength(1);
    expect(project.failed[0].name).toBe("a");
  });

  it("deletes nothing when GitHub is unreadable", async () => {
    const f = await setup({ configs: { [COMPANY_A]: enabled() } });
    seedPreviews(f);
    f.github.down = true;
    await f.h.runJob("convex-reaper");
    expect(f.convex.deletes()).toHaveLength(0);
    expect((await report(f)).projects[0].error).toMatch(/GitHub/i);
  });

  it("raises an issue once the team reaches the alert threshold", async () => {
    const f = await setup({ configs: { [COMPANY_A]: baseConfig({ projects: [{ convexProjectId: "100", name: "app", repository: "org/app", paperclipProjectId: "pp-1" }] }) } });
    for (let i = 0; i < 250; i++) f.convex.add(deployment(`p${i}`));
    await f.h.runJob("convex-reaper");
    const last = await report(f);
    expect(last.quota).toMatchObject({ count: 250, quota: 300, alert: true });
    expect(f.issue).toHaveBeenCalledTimes(1);
    expect(f.issue.mock.calls[0][0]).toMatchObject({ companyId: COMPANY_A, projectId: "pp-1", title: expect.stringContaining("83%") });
    expect(f.h.activity.some(item => /quota/i.test(item.message))).toBe(true);
  });

  it("does not raise an issue below the threshold", async () => {
    const f = await setup();
    for (let i = 0; i < 20; i++) f.convex.add(deployment(`p${i}`));
    await f.h.runJob("convex-reaper");
    expect(f.issue).not.toHaveBeenCalled();
    expect((await report(f)).quota).toMatchObject({ count: 20, alert: false });
  });

  it("runs on demand through the action, and refuses a real run while disabled", async () => {
    const f = await setup();
    seedPreviews(f);
    await expect(f.h.performAction("reaper.run", { dryRun: false }, admin(COMPANY_A))).rejects.toThrow(/enable/i);
    const dry = await f.h.performAction<any>("reaper.run", { dryRun: true }, member(COMPANY_A));
    expect(dry.dryRun).toBe(true);
    expect(f.convex.mutations()).toHaveLength(0);
  });

  it("exposes the reaper to an authorised agent as a tool, dry-run first", async () => {
    const f = await setup({ configs: { [COMPANY_A]: enabled() } });
    seedPreviews(f);
    const planned = await f.h.executeTool<{ data?: any; error?: string }>("convex_reap_previews", { dryRun: true }, run("janitor"));
    expect(planned.data.projects[0].delete).toHaveLength(2);
    expect(f.convex.mutations()).toHaveLength(0);
    expect((await f.h.executeTool<{ error?: string }>("convex_reap_previews", {}, run("nogrant"))).error).toMatch(/grant/i);
  });
});
