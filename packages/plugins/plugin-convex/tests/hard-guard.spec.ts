import { describe, expect, it } from "vitest";
import { hardDeleteBlock } from "../src/hard-guard.js";
import { normalizeDeployment } from "../src/convex-client.js";
import { COMPANY_A, admin, baseConfig, member, run, setup } from "./fixture.js";
import { deployment } from "./fakes.js";

const block = (overrides: Record<string, unknown>) => hardDeleteBlock(normalizeDeployment({ ...deployment("feat-x"), ...overrides })!);

describe("hardDeleteBlock", () => {
  it("lets an ordinary cloud preview or dev deployment through", () => {
    expect(block({})).toBeNull();
    expect(block({ deploymentType: "dev", reference: "dev/ship-3561-x", previewIdentifier: null })).toBeNull();
  });

  it.each([
    [{ deploymentType: "prod" }, /Only preview and dev/],
    [{ deploymentType: "custom" }, /Only preview and dev/],
    [{ deploymentType: "sandbox" }, /Only preview and dev/],
    [{ deploymentType: undefined }, /Only preview and dev/],
    [{ kind: "local" }, /cloud/],
    [{ kind: undefined }, /cloud/],
    [{ isDefault: true }, /default/],
    [{ isDefault: undefined }, /default/],
  ] as const)("blocks %j", (overrides, message) => {
    expect(block(overrides as Record<string, unknown>)).toMatch(message);
  });

  it.each(["prod", "production", "staging", "main", "master", "release", "releases"])("blocks the whole word %s in the name, reference or preview identifier", word => {
    expect(block({ name: `x-${word}-y` })).toMatch(/production, staging, main or release/);
    expect(block({ reference: `dev/${word.toUpperCase()}` })).toMatch(/production, staging, main or release/);
    expect(block({ previewIdentifier: `feat/${word}` })).toMatch(/production, staging, main or release/);
  });

  it.each(["staging2", "prod1", "release2026-10", "releaseCandidate", "mainBranch", "prodDb", "preprod", "PRD", "stage", "stg", "Production2", "2staging", "v3main", "10release"])("blocks %s, where the word is joined to a digit or a capital letter", value => {
    expect(block({ name: "ok-name", reference: `dev/${value}`, previewIdentifier: null }), value).toMatch(/production, staging, main or release/);
  });

  it.each(["PRODdb", "STAGINGapi", "STGenv", "MAINline", "RELEASEnotes", "Prod_DB", "PRODUCTION", "ｐｒｏｄ-db"])("blocks %s, where capitals or full-width letters hide the word", value => {
    expect(block({ name: "ok-name", reference: `dev/${value}`, previewIdentifier: null }), value).toMatch(/production, staging, main or release/);
  });

  it.each(["prOD", "pRoD", "PrOd", "uat", "UAT", "live", "Live-Site", "stAGing"])("blocks %s, mixed case and the synonyms uat and live", value => {
    expect(block({ name: "ok-name", reference: `dev/${value}`, previewIdentifier: null }), value).toMatch(/production, staging, main or release/);
  });

  it("blocks a name with letters outside a to z, because look-alike letters can hide a production word", () => {
    expect(block({ name: "ok-name", reference: "dev/pr\u043Ed", previewIdentifier: null })).toMatch(/characters outside/);
  });

  it("matches whole words only, so ordinary names that contain the letters pass", () => {
    for (const name of ["maintenance-page", "domain-fix", "released-notes-ui", "reproduction", "stagingly"]) expect(block({ name, previewIdentifier: name, reference: `preview/${name}` }), name).toBeNull();
  });
});

describe("the hard delete guard on every delete and expiry path", () => {
  // A closed pull request makes these previews eligible, so only the hard guard keeps them.
  const guarded = async () => {
    const f = await setup({ configs: { [COMPANY_A]: baseConfig({ reaper: { enabled: true } }) } });
    f.convex.add(deployment("release-notes", { previewIdentifier: "feat/release" }), deployment("feat-done"));
    f.github.pulls.push({ number: 5, ref: "feat/release", state: "closed", merged: true }, { number: 6, ref: "feat-done", state: "closed", merged: true });
    return f;
  };

  it("refuses an agent's delete of a preview whose identifier says release, whatever the grants", async () => {
    const f = await guarded();
    const result = await f.h.executeTool<{ error?: string }>("convex_delete_preview", { name: "release-notes" }, run("janitor"));
    expect(result.error).toMatch(/production, staging, main or release/);
    expect(f.convex.deletes()).toHaveLength(0);
  });

  it("refuses a board delete of the same preview, and still deletes an ordinary one", async () => {
    const f = await guarded();
    await expect(f.h.performAction("deployments.delete-preview", { name: "release-notes" }, admin(COMPANY_A))).rejects.toThrow(/production, staging, main or release/);
    expect(f.convex.deletes()).toHaveLength(0);
    await f.h.performAction("deployments.delete-preview", { name: "feat-done" }, admin(COMPANY_A));
    expect(f.convex.deletes()).toHaveLength(1);
  });

  it("refuses to schedule or shorten an expiry on it, because an expiry is a delayed delete", async () => {
    const f = await guarded();
    const result = await f.h.executeTool<{ error?: string }>("convex_set_preview_expiry", { name: "release-notes", hours: 48 }, run("janitor"));
    expect(result.error).toMatch(/production, staging, main or release/);
    expect(f.convex.mutations()).toHaveLength(0);
  });

  it("makes the reaper skip it with the guard's reason, neither deleting it nor giving it an expiry", async () => {
    const f = await guarded();
    await f.h.runJob("convex-reaper");
    expect(f.convex.deletes().map(call => call.url)).toEqual([expect.stringContaining("feat-done")]);
    expect(f.convex.deployments.has("release-notes")).toBe(true);
    expect(f.convex.deployments.get("release-notes")?.expiresAt ?? null).toBeNull();
    const last = await f.h.performAction<any>("reaper.report", {}, member(COMPANY_A));
    expect(last.projects[0].skipped).toEqual([expect.objectContaining({ name: "release-notes", reason: expect.stringMatching(/production, staging, main or release/) })]);
  });
});
