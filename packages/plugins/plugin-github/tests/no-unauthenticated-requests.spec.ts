import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import { register } from "../src/worker.js";
import { GitHubClient } from "../src/github.js";
import { seedConnection } from "./connection.js";

// GitHub allows 60 unauthenticated REST requests an hour per IP address, and every client behind one egress IP shares them. The
// plugin sends a request without credentials only for the one-time App manifest conversion, and these tests record every
// request that reaches `fetch` to prove it.

const companyId = "c1";
const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const secretRef = (secretId: string) => ({ type: "secret_ref", secretId, version: "latest" });
const actor: PluginPerformActionContext = { companyId, actor: { type: "user", userId: "u1", agentId: null, runId: null, companyId, isInstanceAdmin: true } };
const SCOPE_ERROR = "Plugin worker call denied: the worker referenced a missing, expired, or unknown invocation scope";

type Recorded = { method: string; url: string; authorization: string | undefined; body?: BodyInit | null };

/** A `fetch` that answers the calls of a sync for one repository, and records every request it receives. */
function recordingFetch() {
  const requests: Recorded[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({ method: init?.method ?? "GET", url, authorization: headers.Authorization, body: init?.body });
    const path = new URL(url).pathname;
    if (path === "/app") return json({ id: 12, slug: "app", name: "App", permissions: { issues: "read" } });
    if (path === "/app/installations") return json([{ id: 33, account: { login: "org", id: 1, type: "Organization" }, permissions: { issues: "read" } }]);
    if (path === "/app/installations/33/access_tokens") return json({ token: "installation-token-for-the-test" }, 201);
    if (path === "/installation/repositories") return json({ repositories: [{ id: 22, name: "repo", html_url: "https://github.com/org/repo", private: true }] });
    if (path === "/repos/org/repo/issues") return json([]);
    if (path === "/user") return json({ login: "someone" });
    if (/^\/app-manifests\/[^/]+\/conversions$/.test(path)) return json({ id: 12, slug: "app", name: "App", pem: "pem" }, 201);
    return json({}, 404);
  });
  return { fetcher, requests, client: new GitHubClient(fetcher as unknown as typeof fetch) };
}

/** A harness with one connected company that has one project linked to org/repo; `real` is what the secret store hands out. */
async function scheduled(options: { config?: Record<string, unknown>; secret?: (options: any) => string } = {}) {
  const h = createTestHarness({ manifest });
  h.seed({ projects: [{ id: "p1", companyId, name: "One" }] as any, projectWorkspaces: [{ id: "w1", companyId, projectId: "p1", repoUrl: "https://github.com/org/repo" }] as any });
  const config = options.config ?? { appId: "12", privateKey: secretRef("key") };
  vi.spyOn(h.ctx.config, "get").mockImplementation(async () => config);
  vi.spyOn(h.ctx.secrets, "resolve").mockImplementation(async (_ref: any, resolveOptions: any) => (options.secret ? options.secret(resolveOptions) : pem));
  const wire = recordingFetch();
  register(h.ctx, wire.client);
  await seedConnection(h, companyId, "12");
  return { h, ...wire, config };
}

describe("the scheduled GitHub sync sends nothing without credentials", () => {
  it("sends every request of a sync with an App JWT or an installation token", async () => {
    const f = await scheduled();

    await expect(f.h.runJob("github-sync")).resolves.toBeUndefined();

    // The sync really talked to GitHub: the App, its installations, a token, the repositories and the issues.
    expect(f.requests.map((request) => new URL(request.url).pathname)).toEqual(expect.arrayContaining([
      "/app", "/app/installations", "/app/installations/33/access_tokens", "/installation/repositories", "/repos/org/repo/issues",
    ]));
    expect(f.requests.filter((request) => !request.authorization)).toEqual([]);
    expect(f.requests.every((request) => /^Bearer \S{20,}$/.test(request.authorization ?? ""))).toBe(true);
  });

  it("sends nothing when the company's config cannot be read (the worker's invocation scope is gone)", async () => {
    const f = await scheduled();
    vi.spyOn(f.h.ctx.config, "get").mockRejectedValue(new Error(SCOPE_ERROR));

    await expect(f.h.runJob("github-sync")).resolves.toBeUndefined();

    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty string", ""],
    ["a blank string", "   "],
  ])("sends nothing when the App's private key reads as %s", async (_name, value) => {
    const f = await scheduled({ secret: () => value });

    await expect(f.h.runJob("github-sync")).resolves.toBeUndefined();

    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("sends nothing when the secret store cannot be read", async () => {
    const f = await scheduled();
    vi.spyOn(f.h.ctx.secrets, "resolve").mockRejectedValue(new Error(SCOPE_ERROR));

    await expect(f.h.runJob("github-sync")).resolves.toBeUndefined();

    expect(f.fetcher).not.toHaveBeenCalled();
  });
});

describe("GitHubClient.request", () => {
  it.each([
    ["no token", undefined],
    ["an empty token", ""],
    ["a blank token", "   "],
  ])("refuses to send a request with %s", async (_name, token) => {
    const { client, fetcher } = recordingFetch();

    await expect(client.request("/user", token)).rejects.toThrow(/without credentials/);
    await expect(client.request("/repos/org/repo/issues", token, { title: "x" })).rejects.toThrow(/without credentials/);

    expect(fetcher).not.toHaveBeenCalled();
  });

  it("still sends the one-time App manifest conversion without credentials", async () => {
    const { client, requests } = recordingFetch();
    vi.spyOn(client, "verify").mockResolvedValue({ id: "12", slug: "app", name: "App" } as any);

    await client.convert("abcdefghij0123456789");

    expect(requests).toEqual([{ method: "POST", url: "https://api.github.com/app-manifests/abcdefghij0123456789/conversions", authorization: undefined, body: "{}" }]);
  });

  describe("on the manifest conversion path, without a token", () => {
    const path = "/app-manifests/abcdefghij0123456789/conversions";

    it.each([
      ["a GET", undefined, undefined],
      ["a DELETE", undefined, "DELETE" as const],
      ["a PATCH with the empty body", {}, "PATCH" as const],
      ["a PUT with the empty body", {}, "PUT" as const],
      ["a DELETE with the empty body", {}, "DELETE" as const],
    ])("refuses %s", async (_name, body, method) => {
      const { client, fetcher } = recordingFetch();

      await expect(client.request(path, undefined, body, method)).rejects.toThrow(/without credentials/);

      expect(fetcher).not.toHaveBeenCalled();
    });

    it.each([
      ["a body with a field", { title: "x" }],
      ["an array", []],
      ["a string", "{}"],
      ["null", null],
      ["a function, which serializes to nothing", () => 1],
    ])("refuses a POST with %s as the body", async (_name, body) => {
      const { client, fetcher } = recordingFetch();

      await expect(client.request(path, undefined, body)).rejects.toThrow(/without credentials/);
      await expect(client.request(path, "   ", body, "POST")).rejects.toThrow(/without credentials/);

      expect(fetcher).not.toHaveBeenCalled();
    });

    it.each([
      ["another endpoint", "/repos/org/repo/issues"],
      ["a conversion path with a short code", "/app-manifests/short/conversions"],
      ["a conversion path with a query", "/app-manifests/abcdefghij0123456789/conversions?x=1"],
      ["a path below the conversion path", "/app-manifests/abcdefghij0123456789/conversions/extra"],
    ])("refuses a POST with the empty body to %s", async (_name, other) => {
      const { client, fetcher } = recordingFetch();

      await expect(client.request(other, undefined, {})).rejects.toThrow(/without credentials/);

      expect(fetcher).not.toHaveBeenCalled();
    });

    it("refuses a POST with no body", async () => {
      const { client, fetcher } = recordingFetch();

      await expect(client.request(path, undefined, undefined, "POST")).rejects.toThrow(/without credentials/);

      expect(fetcher).not.toHaveBeenCalled();
    });

    it("sends a POST with the empty body, and nothing else, without credentials", async () => {
      const { client, requests } = recordingFetch();

      await client.request(path, undefined, {});
      await client.request(path, "", {}, "POST");

      expect(requests).toEqual([
        { method: "POST", url: `https://api.github.com${path}`, authorization: undefined, body: "{}" },
        { method: "POST", url: `https://api.github.com${path}`, authorization: undefined, body: "{}" },
      ]);
    });

    // The check must read the bytes that are sent: the body is serialized once, before the credential decision, and that same
    // string is sent. Each probe below has no enumerable key, so a check on the keys accepts it, yet it serializes to content.
    const hidden = (value: unknown) => Object.defineProperty({}, "toJSON", { value: () => value, enumerable: false });
    const armedProxy = (value: unknown) => { // looks empty until the check has read its keys, then serializes to `value`
      let armed = false;
      return new Proxy({}, { ownKeys: () => { armed = true; return []; }, get: (_target, key) => (armed && key === "toJSON" ? () => value : undefined) });
    };
    it.each([
      ["a Date", () => new Date(0)],
      ["an object with a non-enumerable toJSON", () => hidden({ title: "x" })],
      ["a Proxy whose toJSON is not an own key", () => new Proxy({}, { get: (_target, key) => (key === "toJSON" ? () => ({ title: "x" }) : undefined) })],
      ["a body that changes once its keys were read", () => armedProxy({ title: "x" })],
    ])("sends nothing without credentials for %s as the body", async (_name, make) => {
      const { client, requests } = recordingFetch();

      await client.request(path, undefined, make()).catch(() => undefined);

      // Either nothing went out, or what went out is the empty object and nothing else.
      expect(requests.filter((request) => !request.authorization && request.body !== "{}")).toEqual([]);
    });

    it("refuses a Date, and a body that is empty to the check but not when sent", async () => {
      const { client, fetcher } = recordingFetch();

      await expect(client.request(path, undefined, new Date(0))).rejects.toThrow(/without credentials/);
      await expect(client.request(path, undefined, hidden({ title: "x" }))).rejects.toThrow(/without credentials/);

      expect(fetcher).not.toHaveBeenCalled();
    });

    it("sends nothing for a body that cannot be serialized", async () => {
      const { client, fetcher } = recordingFetch();

      await expect(client.request(path, undefined, { id: 1n })).rejects.toThrow();

      expect(fetcher).not.toHaveBeenCalled();
    });

    it("serializes the body once, and sends that string", async () => {
      const { client, requests } = recordingFetch();
      let serialized = 0;
      const body = Object.defineProperty({}, "toJSON", { value: () => { serialized += 1; return {}; }, enumerable: false });

      await client.request(path, undefined, body);

      expect(serialized).toBe(1);
      expect(requests).toEqual([{ method: "POST", url: `https://api.github.com${path}`, authorization: undefined, body: "{}" }]);
    });
  });

  it("sends a request that has a token with that token", async () => {
    const { client, requests } = recordingFetch();

    await client.request("/user", "a-token-for-the-test");

    expect(requests).toEqual([{ method: "GET", url: "https://api.github.com/user", authorization: "Bearer a-token-for-the-test" }]);
  });

  it("sends the body of a request that has a token as the string it serialized, once", async () => {
    const { client, requests } = recordingFetch();
    let serialized = 0;
    const body = { title: "x", toJSON() { serialized += 1; return { title: this.title }; } };

    await client.request("/repos/org/repo/issues", "a-token-for-the-test", body);

    expect(serialized).toBe(1);
    expect(requests).toEqual([{ method: "POST", url: "https://api.github.com/repos/org/repo/issues", authorization: "Bearer a-token-for-the-test", body: '{"title":"x"}' }]);
  });
});

describe("the personal access token of the Projects management", () => {
  it("is not used when the secret reads as empty: GitHub is not asked", async () => {
    const f = await scheduled({
      config: { appId: "12", privateKey: secretRef("key"), personalToken: secretRef("personal") },
      secret: (options) => (options?.configPath === "personalToken" ? "" : pem),
    });
    vi.spyOn(f.client, "catalog").mockResolvedValue({ app: { id: "12", slug: "app", name: "App" }, installations: [], repositories: [], warnings: [], truncated: false });

    const options = await f.h.performAction<any>("management-options", { companyId }, actor);

    expect(f.requests.filter((request) => !request.authorization)).toEqual([]);
    expect(options.personal).toBeNull();
    expect(options.warnings).toContain("Personal Projects access needs attention. Update its token in connection settings.");
  });
});
