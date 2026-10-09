import { describe, expect, it } from "vitest";
import { hardDeleteBlock } from "../src/hard-guard.js";
import { normalizeDeployment } from "../src/convex-client.js";
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

  it("blocks a name with letters outside a to z, because look-alike letters can hide a production word", () => {
    expect(block({ name: "ok-name", reference: "dev/pr\u043Ed", previewIdentifier: null })).toMatch(/characters outside/);
  });

  it("matches whole words only, so ordinary names that contain the letters pass", () => {
    for (const name of ["maintenance-page", "domain-fix", "released-notes-ui", "reproduction", "stagingly"]) expect(block({ name, previewIdentifier: name, reference: `preview/${name}` }), name).toBeNull();
  });
});
