import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { generateKeyPairSync, verify } from "node:crypto";
import manifest from "../src/manifest.js";
import { register } from "../src/worker.js";
import { GitHubClient, appJwt, repoName } from "../src/github.js";
import { SetupService, boardScope, callbackUrl } from "../src/setup.js";

const companyId = "company-one";
const actor: PluginPerformActionContext = { companyId, actor: { type: "user", userId: "user-one", agentId: null, runId: null, companyId } };
const returnUrl = "https://paperclip.example/ACME/github-projects";
const options = { companyId, actor: actor.actor };
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const app = { id: 12, slug: "paperclip-test", name: "Paperclip test" };
const repository = { id: 22, name: "repo", fullName: "acme/repo", url: "https://github.com/acme/repo", installationId: 33, owner: "acme", private: true };
const json = (data: unknown, status = 200, next = false) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...(next ? { link: '<https://api.github.com/next>; rel="next"' } : {}) } });

function setupFixture() {
  const harness = createTestHarness({ manifest });
  const client = new GitHubClient();
  const convert = vi.spyOn(client, "convert").mockResolvedValue({ id: "12", slug: app.slug, name: app.name, privateKey: pem });
  let now = 1000;
  const setup = new SetupService(harness.ctx, client, () => now);
  return { harness, client, convert, setup, expire: () => { now += 60 * 60_000; } };
}

describe("guided App registration", () => {
  it("prefills management permissions and public webhook subscriptions", async () => {
    const { setup, harness } = setupFixture();
    const start = await setup.start({ companyId, returnUrl, owner: "acme", name: "Paperclip test" }, actor);
    expect(start.actionUrl).toMatch(/^https:\/\/github.com\/organizations\/acme\/settings\/apps\/new\?state=/);
    expect(start.manifest).toMatchObject({ default_permissions: { metadata: "read", issues: "write" },
      redirect_url: returnUrl, setup_url: returnUrl, request_oauth_on_install: false, hook_attributes: { active: true, url: `${new URL(returnUrl).origin}/api/plugins/vllnt.paperclip-github/webhooks/github` },
      default_events: ["issues", "pull_request", "pull_request_review", "pull_request_review_comment", "issue_comment", "check_run"] });
    expect(start.manifest.default_permissions).toEqual({ metadata: "read", issues: "write", pull_requests: "write", contents: "write", checks: "write", statuses: "read", organization_projects: "write" });
    const stored = harness.getState({ scopeKind: "company", scopeId: companyId, namespace: "setup", stateKey: "user-one" });
    expect(JSON.stringify(stored)).not.toContain(start.state);
    expect(JSON.stringify(stored)).not.toContain("PRIVATE KEY");
  });
  it.each(["http://localhost:3199", "http://127.0.0.1:3100", "http://[::1]:3100"])("keeps delivery disabled for local callback %s", async (origin) => {
    const { setup } = setupFixture();
    const localReturn = `${origin}/ACME/github-projects`;
    const start = await setup.start({ companyId, returnUrl: localReturn }, actor);
    const hook = start.manifest.hook_attributes as { url: string; active: boolean };
    expect(new URL(hook.url).hostname).toBe("example.com");
    expect(hook.active).toBe(false);
    expect(start.manifest.default_events).toEqual([]);
  });
  it("enables delivery for a public HTTPS callback", async () => {
    const { setup } = setupFixture();
    const localReturn = "https://paperclip.example/ACME/github-projects";
    const start = await setup.start({ companyId, returnUrl: localReturn }, actor);
    const hook = start.manifest.hook_attributes as { url: string; active: boolean };
    expect(hook.url).toBe("https://paperclip.example/api/plugins/vllnt.paperclip-github/webhooks/github");
    expect(hook.active).toBe(true);
    expect(start.manifest.default_events).toContain("issues");
  });
  it("binds setup to the authenticated user, company and return URL", async () => {
    const { setup, convert } = setupFixture();
    const start = await setup.start({ companyId, returnUrl }, actor);
    const params = { companyId, returnUrl, state: start.state, code: "a_valid_code" };
    await expect(setup.complete({ ...params, state: "wrong" }, actor)).rejects.toThrow("expired");
    await expect(setup.complete(params, { ...actor, actor: { ...actor.actor, userId: "someone-else" } })).rejects.toThrow("expired");
    await expect(setup.complete({ ...params, returnUrl: returnUrl.replace("paperclip.example", "another.example") }, actor)).rejects.toThrow("expired");
    await expect(setup.complete({ ...params, companyId: "another-company" }, actor)).rejects.toThrow("selected company");
    expect(convert).not.toHaveBeenCalled();
    expect(await setup.complete(params, actor)).toMatchObject({ id: "12" });
    await expect(setup.complete(params, actor)).rejects.toThrow("expired");
    expect(convert).toHaveBeenCalledTimes(1);
  });
  it("rejects expired state and concurrent replay", async () => {
    const fixture = setupFixture();
    const start = await fixture.setup.start({ companyId, returnUrl }, actor);
    fixture.expire();
    await expect(fixture.setup.complete({ companyId, returnUrl, state: start.state }, actor)).rejects.toThrow("expired");
    const newer = await fixture.setup.start({ companyId, returnUrl }, actor);
    const results = await Promise.allSettled([1,2].map(() => fixture.setup.complete({ companyId, returnUrl, state: newer.state, code: "a_valid_code" }, actor)));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(fixture.convert).toHaveBeenCalledTimes(1);
  });
  it("consumes state even when exchange fails and never persists credentials", async () => {
    const { setup, harness, convert } = setupFixture();
    const start = await setup.start({ companyId, returnUrl }, actor);
    convert.mockRejectedValueOnce(new Error("Provider unavailable"));
    const params = { companyId, returnUrl, state: start.state, code: "a_valid_code" };
    await expect(setup.complete(params, actor)).rejects.toThrow("Provider unavailable");
    await expect(setup.complete(params, actor)).rejects.toThrow("expired");
    expect(harness.getState({ scopeKind: "company", scopeId: companyId, namespace: "setup", stateKey: "user-one" })).toBeUndefined();
    expect(JSON.stringify(harness.logs)).not.toContain("PRIVATE KEY");
  });
  it("accepts local callbacks and rejects unsafe URLs and malformed owners", async () => {
    expect(callbackUrl("http://localhost:3100/github-projects")).toContain("localhost");
    for (const url of ["http://public.example/github-projects", "javascript:alert(1)", returnUrl + "?redirect=evil", returnUrl.replace("https://", "https://user:pass@"), "https://paperclip.example/other"]) {
      expect(() => callbackUrl(url)).toThrow();
    }
    const { setup } = setupFixture();
    await expect(setup.start({ companyId, returnUrl, owner: "evil/../../" }, actor)).rejects.toThrow("organization");
  });
  it("denies agents, system actors and forged company params", () => {
    for (const type of ["agent", "system"] as const) expect(() => boardScope({ companyId }, { ...actor, actor: { ...actor.actor, type } })).toThrow();
    expect(() => boardScope({ companyId: "other" }, actor)).toThrow();
  });
});

describe("GitHub transport and access", () => {
  it("signs a short-lived RSA JWT without sending the private key", async () => {
    const jwt = appJwt("12", pem, 1000000);
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({ iss: "12", iat: 940, exp: 1540 });
    expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url"))).toBe(true);
    const fetcher = vi.fn().mockResolvedValue(json(app));
    await new GitHubClient(fetcher).verify("12", pem);
    expect(fetcher.mock.calls[0][0]).toBe("https://api.github.com/app");
    expect(fetcher.mock.calls[0][1].redirect).toBe("error");
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("PRIVATE KEY");
  });
  it("verifies the App identity and sanitizes provider and network errors", async () => {
    await expect(new GitHubClient(vi.fn().mockResolvedValue(json({ ...app, id: 13 }))).verify("12", pem)).rejects.toThrow("does not match");
    for (const response of [json({ message: "secret-should-not-leak" }, 401), json({ error: "secret-should-not-leak" }, 500)]) {
      const result = new GitHubClient(vi.fn().mockResolvedValue(response)).verify("12", pem);
      await expect(result).rejects.not.toThrow("secret-should-not-leak");
    }
    await expect(new GitHubClient(vi.fn().mockRejectedValue(new Error(pem))).verify("12", pem)).rejects.toThrow("valid response");
    await expect(new GitHubClient().verify("12", "bad PEM")).rejects.toThrow("RSA PEM");
  });
  it("discovers multiple repository pages and exposes suspended or failed installations", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("/app")) return json(app);
      if (url.includes("/app/installations?")) return json([{ id: 33, account: { login: "acme" } }, { id: 44, account: { login: "paused" }, suspended_at: "today" }, { id: 55, account: { login: "denied" } }]);
      if (url.includes("/55/access_tokens")) return json({}, 403);
      if (url.endsWith("/access_tokens")) return json({ token: "installation-token" });
      if (url.endsWith("page=1")) return json({ repositories: [{ id: 22, name: "repo", html_url: repository.url, private: true }] }, 200, true);
      return json({ repositories: [{ id: 23, name: "other", html_url: "https://github.com/acme/other" }] });
    });
    const catalog = await new GitHubClient(fetcher as typeof fetch).catalog("12", pem, ["acme", "paused", "denied"]);
    expect(catalog.repositories.map(r => r.id)).toEqual([23,22]);
    expect(catalog.warnings).toHaveLength(2);
    expect(catalog.truncated).toBe(false);
  });
  it("uses repository-scoped tokens, excludes PRs and preserves next-page information", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ token: "short-lived" })).mockResolvedValueOnce(json([
      { id: 1, number: 1, title: "Issue", state: "open", updated_at: "now", assignees: [{ login: "me" }] },
      { id: 2, number: 2, title: "PR", pull_request: {} }
    ], 200, true));
    const result = await new GitHubClient(fetcher).issues("12", pem, repository, 1, "open");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ repository_ids: [22], permissions: { metadata: "read", issues: "read" } });
    expect(result.issues).toHaveLength(1); expect(result.issues[0].assignees).toEqual(["me"]); expect(result.nextPage).toBe(2);
  });
  it("validates repository URLs instead of trusting mutable workspace names", () => {
    expect(repoName("https://github.com/acme/repo.git")).toBe("acme/repo");
    for (const url of ["https://evil.example/acme/repo", "https://github.com/acme/repo/issues", "https://token@github.com/acme/repo", "https://github.com/acme/repo?token=secret"]) expect(repoName(url)).toBeNull();
  });
});

describe("managed GitHub workflow skill", () => {
  it("reports, installs and re-reads the company skill without exposing secrets", async () => {
    const h = createTestHarness({ manifest });
    register(h.ctx, new GitHubClient());
    const before = await h.performAction<any>("github-workflow-skill-status", { companyId }, options);
    expect(before).toMatchObject({ pluginKey: manifest.id, resourceKind: "skill", resourceKey: "github-review-workflow", companyId, status: "missing", skillId: null });
    const installed = await h.performAction<any>("install-github-workflow-skill", { companyId }, options);
    expect(installed).toMatchObject({ pluginKey: manifest.id, resourceKind: "skill", resourceKey: "github-review-workflow", companyId, status: "created" });
    expect(installed.skill?.markdown).toContain("# GitHub review workflow");
    const after = await h.performAction<any>("github-workflow-skill-status", { companyId }, options);
    expect(after).toMatchObject({ status: "resolved", skillId: installed.skillId });
    expect(JSON.stringify(after)).not.toContain("PRIVATE KEY");
  });
});

describe("company-scoped project and task integration", () => {
  function fixture() {
    const h = createTestHarness({ manifest, config: { appId: "12", privateKey: { type: "secret_ref", secretId: "secret" } } });
    vi.spyOn(h.ctx.secrets, "resolve").mockResolvedValue(pem);
    h.seed({ projects: [{ id: "p1", companyId, name: "Project" } as any], issues: [{ id: "i1", companyId, projectId: "p1" } as any],
      projectWorkspaces: [{ id: "w1", companyId, projectId: "p1", name: "renamed by user", repoUrl: repository.url } as any] });
    const client = new GitHubClient();
    const catalog = vi.spyOn(client, "catalog").mockResolvedValue({ app: { ...app, id: "12" }, installations: [], repositories: [repository], warnings: [], truncated: false });
    const issues = vi.spyOn(client, "issues").mockResolvedValue({ issues: [], nextPage: null, repository: repository.fullName });
    register(h.ctx, client);
    return { h, catalog, issues };
  }
  it("supplies native Projects with the company App catalog", async () => {
    const { h } = fixture();
    const result = await h.performAction<any>("project-repositories", {}, options);
    expect(result).toMatchObject({ connectionCount: 1, failedConnectionCount: 0,
      repositories: [{ id: "22", fullName: "acme/repo", url: repository.url, private: true }] });
    expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
    await expect(h.performAction("project-repositories", {}, { companyId, actor: { type: "agent", companyId } })).rejects.toThrow();
  });
  it("reports an unconfigured company without fetching GitHub or resolving a secret", async () => {
    const h = createTestHarness({ manifest });
    const client = new GitHubClient();
    const catalog = vi.spyOn(client, "catalog");
    register(h.ctx, client);
    expect(await h.performAction("project-repositories", {}, options)).toEqual({ repositories: [], connectionCount: 0, failedConnectionCount: 0 });
    expect(catalog).not.toHaveBeenCalled();
  });
  it("derives the linked repo from a task's project and denies unlinked or revoked access", async () => {
    const { h, catalog, issues } = fixture();
    const linked = await h.performAction<any>("linked-repositories", { issueId: "i1" }, options);
    expect(linked.repositories[0].id).toBe(22);
    await h.performAction("issues", { issueId: "i1", repositoryId: 22 }, options);
    expect(issues).toHaveBeenCalledTimes(1);
    await expect(h.performAction("issues", { issueId: "i1", repositoryId: 999 }, options)).rejects.toThrow("not linked");
    catalog.mockResolvedValue({ app: { ...app, id: "12" }, installations: [], repositories: [], warnings: ["revoked"], truncated: false });
    await expect(h.performAction("issues", { issueId: "i1", repositoryId: 22, refresh: true }, options)).rejects.toThrow("not linked");
    expect(issues).toHaveBeenCalledTimes(1);
  });
  it("rejects foreign tasks and agent access before resolving any secrets", async () => {
    const { h } = fixture();
    h.seed({ issues: [{ id: "foreign", companyId: "other-company", projectId: "p1" } as any] });
    await expect(h.performAction("linked-repositories", { issueId: "foreign" }, options)).rejects.toThrow();
    await expect(h.performAction("catalog", {}, { companyId, actor: { type: "agent", companyId } })).rejects.toThrow();
    expect(h.ctx.secrets.resolve).not.toHaveBeenCalled();
  });
  it("returns a clear empty state for projectless tasks without fetching GitHub", async () => {
    const { h, catalog } = fixture();
    h.seed({ issues: [{ id: "i2", companyId, projectId: null } as any] });
    expect(await h.performAction("linked-repositories", { issueId: "i2" }, options)).toMatchObject({ linkedCount: 0, repositories: [] });
    expect(catalog).not.toHaveBeenCalled();
  });
});

it("creates and patches issues with repository-scoped write tokens and preserves body metadata", async () => {
  const raw = { id: 99, number: 4, title: "Published", body: "Body", state: "open", labels: [{ name: "bug" }], assignees: [{ login: "alex" }], updated_at: "now" };
  const fetcher = vi.fn().mockResolvedValueOnce(json({ token: "installation-token" })).mockResolvedValueOnce(json(raw))
    .mockResolvedValueOnce(json({ token: "installation-token" })).mockResolvedValueOnce(json({ ...raw, state: "closed", state_reason: "completed" }));
  const client = new GitHubClient(fetcher);
  expect(await client.createIssue("12", pem, repository, { title: "Published", body: "Body" })).toMatchObject({ id: 99, body: "Body", labels: ["bug"], assignees: ["alex"] });
  await client.updateIssue("12", pem, repository, 4, { state: "closed", state_reason: "completed" });
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ permissions: { metadata: "read", issues: "write" }, repository_ids: [22] });
  expect(fetcher.mock.calls[1][0]).toBe("https://api.github.com/repos/acme/repo/issues");
  expect(fetcher.mock.calls[3][1].method).toBe("PATCH");
  expect(JSON.stringify(fetcher.mock.calls)).not.toContain(pem);
});

describe("company GitHub App actions", () => {
  const admin = (company: string): PluginPerformActionContext => ({ companyId: company, actor: { type: "user", userId: "admin", agentId: null, runId: null, companyId: company, isInstanceAdmin: true } });
  const member = (company: string): PluginPerformActionContext => ({ companyId: company, actor: { type: "user", userId: "member", agentId: null, runId: null, companyId: company } });

  it("connects only through an existing company secret ref and never returns the key", async () => {
    const h = createTestHarness({ manifest });
    const client = new GitHubClient();
    vi.spyOn(h.ctx.secrets, "resolve").mockResolvedValue("-----BEGIN " + "PRIVATE KEY----- secret -----END " + "PRIVATE KEY-----");
    vi.spyOn(client, "verify").mockResolvedValue({ id: "5203754", slug: "v-agents", name: "v-agents" });
    register(h.ctx, client);
    const result = await h.performAction<any>("company-app.connect", { companyId, appId: "5203754", privateKeySecretId: "secret-vllnt" }, admin(companyId));
    expect(result).toMatchObject({ configured: true, app: { id: "5203754", slug: "v-agents" } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
    expect(await h.ctx.state.get({ scopeKind: "company", scopeId: companyId, namespace: "connection", stateKey: "app" })).toEqual(expect.objectContaining({
      appId: "5203754", privateKey: { type: "secret_ref", secretId: "secret-vllnt", version: "latest" },
    }));
    expect(JSON.stringify(await h.ctx.state.get({ scopeKind: "company", scopeId: companyId, namespace: "connection", stateKey: "app" }))).not.toContain("PRIVATE KEY");
    await expect(h.performAction("company-app.connect", { companyId, appId: "5203754", privateKey: "-----BEGIN " + "PRIVATE KEY-----" }, admin(companyId))).rejects.toThrow("never a plaintext private key");
    await expect(h.performAction("company-app.connect", { companyId, appId: "5203754", privateKeySecretId: "secret-vllnt" }, member(companyId))).rejects.toThrow("administrator");
  });

  it("enforces a case-insensitive owner allowlist and fails closed", async () => {
    const h = createTestHarness({ manifest });
    const client = new GitHubClient();
    register(h.ctx, client);
    await expect(h.performAction("allowed-owners.set", { companyId, owners: ["vllnt", "bad owner"] }, admin(companyId))).rejects.toThrow("Invalid GitHub owner");
    await expect(h.performAction<any>("allowed-owners.set", { companyId, owners: ["VLLNT", "maiaos", "vllnt"] }, admin(companyId))).resolves.toEqual({ companyId, owners: ["vllnt", "maiaos"] });
    await expect(h.performAction<any>("allowed-owners.get", { companyId }, member(companyId))).resolves.toEqual({ companyId, owners: ["vllnt", "maiaos"] });
    await expect(h.performAction<any>("allowed-owners.set", { companyId, owners: [] }, admin(companyId))).resolves.toEqual({ companyId, owners: [] });
  });

  it("selects each company's App and filters repositories before exposure", async () => {
    const configs: Record<string, Record<string, unknown>> = {
      vllnt: { appId: "5203754", privateKey: { type: "secret_ref", secretId: "v-key" }, allowedOwners: ["vllnt"] },
      anthm: { appId: "5203763", privateKey: { type: "secret_ref", secretId: "a-key" }, allowedOwners: ["Anthm-FR"] },
    };
    const h = createTestHarness({ manifest });
    vi.spyOn(h.ctx.config, "get").mockImplementation(async (id?: string) => configs[id ?? ""] ?? {});
    vi.spyOn(h.ctx.secrets, "resolve").mockImplementation(async (_ref, options) => `${options?.companyId}-pem`);
    const client = new GitHubClient();
    const calls: string[] = [];
    vi.spyOn(client, "catalog").mockImplementation(async (id, _pem, owners) => {
      const allowlist = owners ?? [];
      calls.push(`${id}:${allowlist.join(",")}`);
      const owner = allowlist[0] ?? "none";
      return { app: { id, slug: owner, name: owner }, installations: [], repositories: [
        { id: 1, name: "allowed", fullName: `${owner}/allowed`, owner, url: `https://github.com/${owner}/allowed`, installationId: 1, private: true },
        { id: 2, name: "foreign", fullName: "foreign/repo", owner: "foreign", url: "https://github.com/foreign/repo", installationId: 2, private: true },
      ], warnings: [], truncated: false };
    });
    register(h.ctx, client);
    await h.ctx.state.set({ scopeKind: "company", scopeId: "vllnt", namespace: "connection", stateKey: "app" }, {
      appId: "5203754", appSlug: "v-agents", appName: "v-agents", privateKey: { type: "secret_ref", secretId: "v-key" },
    });
    await h.ctx.state.set({ scopeKind: "company", scopeId: "anthm", namespace: "connection", stateKey: "app" }, {
      appId: "5203763", appSlug: "anthm-agents", appName: "anthm-agents", privateKey: { type: "secret_ref", secretId: "a-key" },
    });
    const v = await h.performAction<any>("repositories.list", { companyId: "vllnt" }, member("vllnt"));
    const a = await h.performAction<any>("repositories.list", { companyId: "anthm" }, member("anthm"));
    expect(calls).toEqual(["5203754:vllnt", "5203763:Anthm-FR"]);
    expect(v.repositories.map((repo: any) => repo.fullName)).toEqual(["vllnt/allowed"]);
    expect(a.repositories.map((repo: any) => repo.fullName)).toEqual(["Anthm-FR/allowed"]);
    await expect(h.performAction("manage-repository", { companyId: "vllnt", op: "metadata", repositoryId: 2 }, member("vllnt"))).rejects.toThrow("not accessible through this company");
  });

  it("returns a clear connection error when a company triggers sync without an App", async () => {
    const h = createTestHarness({ manifest });
    register(h.ctx, new GitHubClient());
    await expect(h.performAction("sync.trigger", { companyId }, member(companyId))).rejects.toThrow("Connect a GitHub App for this company first.");
  });

  it("runs scheduled sync only for configured company IDs, never wildcard companies.list", async () => {
    const configs: Record<string, Record<string, unknown>> = {
      vllnt: { appId: "5203754", privateKey: { type: "secret_ref", secretId: "v-key" }, allowedOwners: ["vllnt"] },
      anthm: { appId: "5203763", privateKey: { type: "secret_ref", secretId: "a-key" }, allowedOwners: ["Anthm-FR"] },
    };
    const h = createTestHarness({ manifest });
    vi.spyOn(h.ctx.config, "get").mockImplementation(async (id?: string) => configs[id ?? ""] ?? {});
    vi.spyOn(h.ctx.secrets, "resolve").mockResolvedValue("pem");
    const client = new GitHubClient();
    vi.spyOn(client, "catalog").mockImplementation(async (id) => ({ app: { id, slug: "app", name: "App" }, installations: [], repositories: [], warnings: [], truncated: false }));
    register(h.ctx, client);
    await h.ctx.state.set({ scopeKind: "company", scopeId: "vllnt", namespace: "connection", stateKey: "app" }, {
      appId: "5203754", appSlug: "v-agents", appName: "v-agents", privateKey: { type: "secret_ref", secretId: "v-key" },
    });
    await h.ctx.state.set({ scopeKind: "company", scopeId: "anthm", namespace: "connection", stateKey: "app" }, {
      appId: "5203763", appSlug: "anthm-agents", appName: "anthm-agents", privateKey: { type: "secret_ref", secretId: "a-key" },
    });
    await h.performAction("catalog", { companyId: "vllnt" }, member("vllnt"));
    await h.performAction("catalog", { companyId: "anthm" }, member("anthm"));
    const listCompanies = vi.spyOn(h.ctx.companies, "list").mockRejectedValue(new Error("company context is required"));
    await expect(h.runJob("github-sync")).resolves.toBeUndefined();
    expect(listCompanies).not.toHaveBeenCalled();
  });
});
