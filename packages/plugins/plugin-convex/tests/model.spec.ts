import { describe, expect, it } from "vitest";
import { classifyDeployment } from "../src/classify.js";
import { parseConfig } from "../src/config.js";
import { isGranted } from "../src/grants.js";
import { assertConvexCloudUrl, ConvexClient, normalizeDeployment } from "../src/convex-client.js";
import { baseConfig, ref } from "./fixture.js";
import { NOW, deployment } from "./fakes.js";

const project = parseConfig(baseConfig()).projects[0];
const classify = (overrides: Record<string, unknown>) => classifyDeployment(normalizeDeployment({ ...deployment("d"), ...overrides })!, project).environment;

describe("environment classification fails closed", () => {
  it.each([
    [{ deploymentType: "preview" }, "preview"],
    [{ deploymentType: "dev", reference: "dev/sam" }, "dev"],
    [{ deploymentType: "dev", isDefault: true }, "dev"],
    [{ deploymentType: "custom" }, "custom"],
    [{ deploymentType: "prod" }, "production"],
    [{ deploymentType: "prod", isDefault: true }, "production"],
    [{ deploymentType: "preview", isDefault: true }, "production"],
    [{ deploymentType: "custom", isDefault: true }, "production"],
    [{ deploymentType: "sandbox" }, "production"],
    [{ deploymentType: undefined }, "production"],
    [{ isDefault: undefined }, "production"],
    [{ kind: "local" }, "production"],
    [{ kind: undefined }, "production"],
    [{ name: "prod-app" }, "production"],
    [{ name: "staging-app" }, "staging"],
    [{ name: "x", reference: "staging-app" }, "staging"],
    [{ name: "x", previewIdentifier: "prod-app" }, "production"],
    [{ name: "staging-app", deploymentType: "prod", isDefault: true }, "production"],
  ] as const)("%j is %s", (overrides, expected) => {
    expect(classify(overrides as Record<string, unknown>)).toBe(expected);
  });
});

describe("config", () => {
  it("applies safe defaults", () => {
    const config = parseConfig({});
    expect(config.projects).toEqual([]);
    expect(config.guards).toEqual({ activityHours: 24, maxDeletesPerRun: 20, callsPerMinute: 60, dryRunOnly: false });
    expect(config.reaper).toEqual({ enabled: false, ttlHours: 36, quota: 300, alertPercent: 80 });
    expect(config.grants).toEqual([]);
  });

  it.each([
    [{ teamToken: "plain" }, /secret reference/],
    [{ github: { token: "plain" } }, /secret reference/],
    [{ projects: [{ convexProjectId: "1", token: "plain" }] }, /secret reference/],
    [{ projects: [{ convexProjectId: "1" }, { convexProjectId: "1" }] }, /once per company/],
    [{ projects: [{ convexProjectId: "abc" }] }, /numeric/],
    [{ projects: [{ convexProjectId: "1", repository: "not a repo" }] }, /owner\/name/],
    [{ grants: [{ agentId: "a", role: "r", preset: "observer", environments: ["preview"] }] }, /exactly one/],
    [{ grants: [{ agentId: "a", preset: "observer", environments: ["staging-x"] }] }, /environment classes/],
    [{ grants: [{ agentId: "a", preset: "janitor", environments: ["preview", "dev"] }] }, /lifecycle can only be granted on preview/],
    [{ grants: [{ agentId: "a", capabilities: ["env-write"], environments: ["production"] }] }, /per-call/],
    [{ grants: [{ agentId: "a", environments: ["preview"] }] }, /grants nothing/],
    [{ reaper: { ttlHours: 200 } }, /ttlHours/],
    [{ guards: { maxDeletesPerRun: 0 } }, /maxDeletesPerRun/],
    [{ guards: { activityHours: 169 } }, /activityHours/],
  ])("rejects %j", (raw, message) => {
    expect(() => parseConfig(raw as Record<string, unknown>)).toThrow(message);
  });

  it("accepts a production write grant only with a per-call approval", () => {
    const config = parseConfig({ grants: [{ agentId: "a", capabilities: ["env-write"], environments: ["production"], approval: "per-call" }] });
    expect(config.grants[0].approval).toBe("per-call");
    expect(ref("x").secretId).toBe("x");
  });
});

describe("grants", () => {
  const config = parseConfig(baseConfig({ grants: [
    { agentId: "a1", capabilities: ["meta-read"], environments: ["preview"] },
    { role: "devops", preset: "janitor", environments: ["preview"] },
  ] }));
  it("is default deny", () => {
    expect(isGranted(config, { id: "zz", role: "ceo" }, "preview", "meta-read")).toBe(false);
  });
  it("matches by agent id or role, class and capability", () => {
    expect(isGranted(config, { id: "a1", role: null }, "preview", "meta-read")).toBe(true);
    expect(isGranted(config, { id: "a1", role: null }, "production", "meta-read")).toBe(false);
    expect(isGranted(config, { id: "a1", role: null }, "preview", "lifecycle")).toBe(false);
    expect(isGranted(config, { id: "b", role: "devops" }, "preview", "lifecycle")).toBe(true);
  });
  it("never grants lifecycle outside previews", () => {
    const forced = { ...config, grants: [{ agentId: "a1", role: null, environments: ["production" as const], capabilities: ["lifecycle" as const], approval: null }] };
    expect(isGranted(forced, { id: "a1", role: null }, "production", "lifecycle")).toBe(false);
  });
  it("does not use a grant that waits for a per-call approval", () => {
    const pending = parseConfig({ grants: [{ agentId: "a", capabilities: ["env-write"], environments: ["production"], approval: "per-call" }] });
    expect(isGranted(pending, { id: "a", role: null }, "production", "env-write")).toBe(false);
  });
});

describe("Convex client", () => {
  it("accepts only Convex cloud deployment URLs", () => {
    expect(assertConvexCloudUrl("https://happy-otter-123.convex.cloud").hostname).toBe("happy-otter-123.convex.cloud");
    expect(assertConvexCloudUrl("https://happy-otter-123.eu-west-1.convex.cloud").hostname).toContain("eu-west-1");
    for (const bad of ["http://a.convex.cloud", "https://a.convex.cloud.evil.com", "https://evil.com", "https://user:pw@a.convex.cloud", "https://a.convex.cloud:8443", "not a url", "https://convex.cloud"]) {
      expect(() => assertConvexCloudUrl(bad), bad).toThrow();
    }
  });

  it("redacts the credential from API errors and ignores non-JSON bodies", async () => {
    const token = "cvx_super_secret_value";
    const client = new ConvexClient(async () => new Response(JSON.stringify({ code: "Nope", message: `bad ${token}` }), { status: 403 }));
    const error = await client.getDeployment(token, "x").catch(e => e);
    expect(error.message).toContain("403");
    expect(error.message).not.toContain(token);
    const html = new ConvexClient(async () => new Response(`<html>${token}</html>`, { status: 502 }));
    expect((await html.getDeployment(token, "x").catch(e => e)).message).toBe("Convex answered 502.");
    const down = new ConvexClient(async () => { throw new Error(`socket closed with ${token}`); });
    expect((await down.getDeployment(token, "x").catch(e => e)).message).not.toContain(token);
  });

  it("normalizes millisecond timestamps and numeric ids", () => {
    const item = normalizeDeployment({ ...deployment("d"), projectId: 100, creator: 7 })!;
    expect(item).toMatchObject({ projectId: "100", creator: "7", lastDeployTime: NOW - 50 * 3_600_000, deploymentUrl: "https://d.convex.cloud" });
    expect(normalizeDeployment({ nope: true })).toBeNull();
  });
});
