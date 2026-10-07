import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PluginPerformActionContext, PluginWebhookInput } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import { register } from "../src/worker.js";
import { GitHubClient } from "../src/github.js";
import { verifyGitHubSignature } from "../src/github-webhooks.js";

const V_APP = "5203754";
const A_APP = "5203763";
const registryKey = { scopeKind: "instance" as const, namespace: "connection", stateKey: "app-companies" };
const ownersKey = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "connection", stateKey: "allowed-owners" });
const disconnectedKey = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "connection", stateKey: "disconnected" });
const secretRef = (secretId: string) => ({ type: "secret_ref", secretId, version: "latest" });
const admin = (company: string): PluginPerformActionContext => ({ companyId: company, actor: { type: "user", userId: "admin", agentId: null, runId: null, companyId: company, isInstanceAdmin: true } });
const member = (company: string): PluginPerformActionContext => ({ companyId: company, actor: { type: "user", userId: "member", agentId: null, runId: null, companyId: company } });
const REJECTED = "GitHub webhook rejected.";

function fixture() {
  const configs: Record<string, Record<string, unknown>> = {
    vllnt: { appId: V_APP, privateKey: secretRef("v-key"), webhookSecret: secretRef("v-hook") },
    anthm: { appId: A_APP, privateKey: secretRef("a-key"), webhookSecret: secretRef("a-hook") },
  };
  const h = createTestHarness({ manifest });
  vi.spyOn(h.ctx.config, "get").mockImplementation(async company => configs[company ?? ""] ?? {});
  const resolve = vi.spyOn(h.ctx.secrets, "resolve").mockImplementation(async (ref: any, options: any) =>
    options?.configPath === "webhookSecret" ? `hook-${ref.secretId}` : `pem-${ref.secretId}`);
  // Any real GitHub request fails loudly; tests assert it is never reached.
  const fetcher = vi.fn(async () => { throw new Error("GitHub network is blocked in tests."); });
  const client = new GitHubClient(fetcher as unknown as typeof fetch);
  vi.spyOn(client, "verify").mockImplementation(async id => ({ id, slug: id === V_APP ? "v-agents" : "anthm-agents", name: id === V_APP ? "v-agents" : "anthm-agents" }));
  const catalog = vi.spyOn(client, "catalog").mockImplementation(async id => ({ app: { id, slug: "app", name: "App" }, installations: [], repositories: [], warnings: [], truncated: false }));
  const hasInstallation = vi.spyOn(client, "hasInstallation").mockImplementation(async (id, _pem, installationId) =>
    (id === V_APP && installationId === 101) || (id === A_APP && installationId === 202));
  const actionKeys: string[] = [];
  const toolNames: string[] = [];
  const registerAction = h.ctx.actions.register.bind(h.ctx.actions);
  vi.spyOn(h.ctx.actions, "register").mockImplementation((key, handler) => { actionKeys.push(key); return registerAction(key, handler); });
  const registerTool = h.ctx.tools.register.bind(h.ctx.tools);
  vi.spyOn(h.ctx.tools, "register").mockImplementation((name, declaration, handler) => { toolNames.push(name); return registerTool(name, declaration, handler); });
  const service = register(h.ctx, client);
  const connect = (companyId: string, appId: string, secretId: string) =>
    h.performAction<any>("company-app.connect", { companyId, appId, privateKeySecretId: secretId }, admin(companyId));
  const keyResolutions = () => resolve.mock.calls.filter(([, options]: any[]) => options?.configPath === "privateKey" || options?.configPath === "personalToken");
  return { h, configs, resolve, fetcher, client, catalog, hasInstallation, service, connect, keyResolutions, actionKeys, toolNames };
}

function webhook(body: Record<string, unknown>, secret?: string): PluginWebhookInput {
  const rawBody = JSON.stringify(body);
  const headers: Record<string, string> = { "x-github-delivery": `delivery-${Math.random().toString(36).slice(2)}` };
  if (secret !== undefined) headers["x-hub-signature-256"] = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  return { endpointKey: "github", rawBody, parsedBody: JSON.parse(rawBody), requestId: headers["x-github-delivery"], headers };
}
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

describe("one GitHub App per company (registry is authoritative)", () => {
  it("refuses a company whose config names another company's App", async () => {
    const f = fixture();
    await f.connect("vllnt", V_APP, "v-key");
    // Operator mistake: anthm's config is saved with v-agents' App ID.
    f.configs.anthm = { appId: V_APP, privateKey: secretRef("a-key") };
    await f.service.reconcileConfig("anthm", f.configs.anthm);
    await expect(f.connect("anthm", V_APP, "a-key")).rejects.toThrow("already connected to another company");
    f.resolve.mockClear(); f.catalog.mockClear();

    expect(await f.h.performAction<any>("company-app.status", { companyId: "anthm" }, member("anthm"))).toMatchObject({ configured: false, app: null });
    await expect(f.h.performAction("repositories.list", { companyId: "anthm" }, member("anthm"))).rejects.toThrow("Connect a GitHub App for this company first.");
    await expect(f.h.performAction("sync.trigger", { companyId: "anthm" }, member("anthm"))).rejects.toThrow("Connect a GitHub App for this company first.");
    const tool = await f.h.executeTool<any>("github_read_issue", { repository: "vllnt/repo", number: 1 }, { companyId: "anthm", agentId: "agent", projectId: "p1", runId: "run" });
    expect(tool.error ?? tool.content).toMatch(/Connect a GitHub App/);
    await f.h.runJob("github-sync");
    await flush();
    expect(f.keyResolutions().map(([ref]: any[]) => ref.secretId)).not.toContain("a-key");
    expect(f.catalog.mock.calls.every(([, pem]) => pem === "pem-v-key")).toBe(true);
    expect(await f.service.connectedCompanies()).toEqual(["vllnt"]);
    expect(await f.h.ctx.state.get(registryKey)).toEqual({ [V_APP]: "vllnt" });
  });

  it("never lets a config save claim an App ID; only a verified connect reserves it", async () => {
    const f = fixture();
    f.configs.typo = { appId: V_APP, privateKey: secretRef("garbage-key") };
    await f.service.reconcileConfig("typo", f.configs.typo);
    expect(await f.h.ctx.state.get(registryKey)).toBeNull();
    expect(await f.h.performAction<any>("company-app.status", { companyId: "typo" }, member("typo"))).toMatchObject({ configured: false });

    vi.mocked(f.client.verify).mockRejectedValueOnce(new Error("The App ID and private key do not match."));
    await expect(f.connect("vllnt", V_APP, "v-key")).rejects.toThrow("do not match");
    expect(await f.h.ctx.state.get(registryKey)).toBeNull();

    await f.connect("vllnt", V_APP, "v-key");
    expect(await f.h.ctx.state.get(registryKey)).toEqual({ [V_APP]: "vllnt" });
    expect(await f.service.connectedCompanies()).toEqual(["vllnt"]);
  });

  it("drops a company whose config moves onto another company's App from webhook routing", async () => {
    const f = fixture();
    await f.connect("vllnt", V_APP, "v-key");
    await f.connect("anthm", A_APP, "a-key");
    f.configs.vllnt = { appId: A_APP, privateKey: secretRef("v-key2"), webhookSecret: secretRef("v-hook") };
    await f.service.reconcileConfig("vllnt", f.configs.vllnt);
    expect(await f.service.connectedCompanies()).toEqual(["anthm"]);
    f.hasInstallation.mockClear();

    const routed = await f.service.receiveWebhook(webhook({ installation: { id: 202 } }, "hook-a-hook"));
    expect(routed?.companyId).toBe("anthm");
    expect(f.hasInstallation.mock.calls.map(([id, pem]) => `${id}:${pem}`)).toEqual([`${A_APP}:pem-a-key`]);
    // vllnt's own webhook secret no longer authenticates anything.
    await expect(f.service.receiveWebhook(webhook({ installation: { id: 202 } }, "hook-v-hook"))).rejects.toThrow(REJECTED);

    // Restoring vllnt's config restores its still-reserved App.
    f.configs.vllnt = { appId: V_APP, privateKey: secretRef("v-key"), webhookSecret: secretRef("v-hook") };
    await f.service.reconcileConfig("vllnt", f.configs.vllnt);
    expect((await f.service.connectedCompanies()).sort()).toEqual(["anthm", "vllnt"]);
  });

  it("lets an instance administrator release a stale reservation, such as a deleted company's", async () => {
    const f = fixture();
    await f.h.ctx.state.set(registryKey, { [V_APP]: "deleted-company" });
    await expect(f.connect("vllnt", V_APP, "v-key")).rejects.toThrow("already connected to another company");
    await expect(f.h.performAction("company-app.release", { companyId: "vllnt", appId: V_APP }, member("vllnt"))).rejects.toThrow("administrator");
    expect(await f.h.performAction("company-app.release", { companyId: "vllnt", appId: V_APP }, admin("vllnt"))).toEqual({ appId: V_APP, released: true });
    expect(await f.h.ctx.state.get(registryKey)).toEqual({});
    await f.connect("vllnt", V_APP, "v-key");
    expect(await f.service.connectedCompanies()).toEqual(["vllnt"]);
  });
});

describe("scheduled sync after a worker restart", () => {
  it("rebuilds the company set from the persisted registry without a config replay", async () => {
    const first = fixture();
    await first.connect("vllnt", V_APP, "v-key");
    await first.connect("anthm", A_APP, "a-key");
    // A crash auto-restart runs setup() again but does not resend configChanged.
    const restarted = fixture();
    await restarted.h.ctx.state.set(registryKey, await first.h.ctx.state.get(registryKey));
    expect((await restarted.service.connectedCompanies()).sort()).toEqual(["anthm", "vllnt"]);
    await restarted.h.runJob("github-sync");
    for (const companyId of ["vllnt", "anthm"]) {
      expect(restarted.h.getState({ scopeKind: "company", scopeId: companyId, namespace: "sync", stateKey: "report" })).toMatchObject({ at: expect.any(String) });
    }
  });

  it("reports distinctly when no company is connected, without loading private keys", async () => {
    const f = fixture();
    expect(await f.service.health()).toMatchObject({ status: "ok", message: expect.stringContaining("No company has a connected GitHub App"), details: { connectedCompanies: 0 } });
    expect(await f.h.performAction<any>("sync-status", { companyId: "vllnt" }, member("vllnt"))).toMatchObject({ configured: false, connection: "not-connected" });
    await f.connect("vllnt", V_APP, "v-key");
    f.resolve.mockClear();
    expect(await f.service.health()).toMatchObject({ status: "ok", details: { connectedCompanies: 1 } });
    expect(await f.h.performAction<any>("sync-status", { companyId: "vllnt" }, member("vllnt"))).toMatchObject({ configured: true, connection: "connected" });
    await f.h.performAction("company-app.disconnect", { companyId: "vllnt" }, admin("vllnt"));
    expect(await f.h.performAction<any>("sync-status", { companyId: "vllnt" }, member("vllnt"))).toMatchObject({ configured: false, connection: "disconnected" });
    delete f.configs.anthm.privateKey;
    expect(await f.h.performAction<any>("sync-status", { companyId: "anthm" }, member("anthm"))).toMatchObject({ configured: false, connection: "not-configured" });
    expect(f.keyResolutions()).toEqual([]);
  });
});

describe("webhook authentication before any GitHub call", () => {
  it("rejects immediately when no company has a webhook secret", async () => {
    const f = fixture();
    delete f.configs.vllnt.webhookSecret; delete f.configs.anthm.webhookSecret;
    await f.connect("vllnt", V_APP, "v-key");
    await f.connect("anthm", A_APP, "a-key");
    f.resolve.mockClear();
    await expect(f.service.receiveWebhook(webhook({ installation: { id: 101 } }, "guess"))).rejects.toThrow(REJECTED);
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.hasInstallation).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("checks each company's signature first and returns one uniform error", async () => {
    const f = fixture();
    await f.connect("vllnt", V_APP, "v-key");
    await f.connect("anthm", A_APP, "a-key");
    f.resolve.mockClear();
    const attempts = [
      webhook({ installation: { id: 101 } }),
      webhook({ installation: { id: 101 } }, "wrong-secret"),
      webhook({ installation: { id: 999 } }, "hook-a-hook"),
      webhook({ installation: { id: 101 } }, "hook-a-hook"),
      webhook({}, "hook-a-hook"),
    ];
    const messages: string[] = [];
    for (const attempt of attempts) {
      await f.service.receiveWebhook(attempt).then(() => messages.push("accepted"), (error: Error) => messages.push(error.message));
    }
    expect(messages).toEqual(Array(attempts.length).fill(REJECTED));
    // Unsigned or wrongly signed requests never load a private key or call GitHub.
    // Correctly signed ones confirm the installation only with the signing company's App.
    expect(f.hasInstallation.mock.calls.map(([id, , installationId]) => `${id}:${installationId}`)).toEqual([`${A_APP}:999`, `${A_APP}:101`]);
    expect(f.keyResolutions().map(([ref]: any[]) => ref.secretId)).toEqual(["a-key", "a-key"]);
    expect(f.fetcher).not.toHaveBeenCalled();

    const routed = await f.service.receiveWebhook(webhook({ installation: { id: 101 } }, "hook-v-hook"));
    expect(routed?.companyId).toBe("vllnt");
  });

  it("treats an empty webhook secret as unconfigured", async () => {
    const f = fixture();
    f.resolve.mockImplementation(async (ref: any, options: any) => options?.configPath === "webhookSecret" ? "" : `pem-${ref.secretId}`);
    await f.connect("vllnt", V_APP, "v-key");
    await expect(f.service.receiveWebhook(webhook({ installation: { id: 101 } }, ""))).rejects.toThrow(REJECTED);
    expect(f.hasInstallation).not.toHaveBeenCalled();
    const body = JSON.stringify({ installation: { id: 101 } });
    expect(verifyGitHubSignature(body, `sha256=${createHmac("sha256", "").update(body).digest("hex")}`, "")).toBe(false);
  });

  it("records per-company processing failures as failures", async () => {
    const f = fixture();
    await f.connect("vllnt", V_APP, "v-key");
    f.catalog.mockRejectedValue(new Error("GitHub unavailable"));
    f.h.seed({ projects: [{ id: "p1", companyId: "vllnt", name: "P" } as any], projectWorkspaces: [{ id: "w1", companyId: "vllnt", projectId: "p1", repoUrl: "https://github.com/vllnt/repo" } as any] });
    const delivery = { installation: { id: 101 }, action: "opened", repository: { id: 22 }, issue: { id: 5, number: 5, title: "Issue", state: "open", updated_at: "now", assignees: [] } };
    await expect(f.service.handleWebhook({ companyId: "vllnt", headers: {}, requestId: "r1", parsedBody: delivery })).rejects.toThrow();
    await expect(f.service.receiveWebhook(webhook(delivery, "hook-v-hook"))).rejects.toThrow("GitHub webhook processing failed.");
  });
});

describe("disconnect kill switch", () => {
  it("refuses every action, tool, job and webhook path and releases the App", async () => {
    const f = fixture();
    f.h.seed({
      projects: [{ id: "p1", companyId: "vllnt", name: "Project" } as any],
      projectWorkspaces: [{ id: "w1", companyId: "vllnt", projectId: "p1", repoUrl: "https://github.com/vllnt/repo" } as any],
      issues: [{ id: "i1", companyId: "vllnt", projectId: "p1", title: "Task", status: "todo" } as any],
    });
    const repo = { id: 22, name: "repo", fullName: "vllnt/repo", url: "https://github.com/vllnt/repo", installationId: 101, owner: "vllnt", ownerId: 1, private: true, issuesWrite: true, permissions: { issues: "write" } };
    f.catalog.mockImplementation(async id => ({ app: { id, slug: "app", name: "App" }, installations: [], repositories: [repo], warnings: [], truncated: false }));
    await f.connect("vllnt", V_APP, "v-key");
    await f.h.ctx.state.set(ownersKey("vllnt"), [{ id: 1, login: "vllnt" }]);
    const params = { companyId: "vllnt", issueId: "i1", projectId: "p1", repositoryId: 22, destinationId: "22", number: 1, op: "metadata", requestId: "request-0001", owners: ["vllnt"], keep: "github", state: "open", page: 1 };
    const skipped = new Set(["company-app.connect", "company-app.disconnect", "company-app.release"]);
    const runActions = async () => {
      const reached: string[] = [];
      for (const key of f.actionKeys.filter(key => !skipped.has(key))) {
        const before = f.keyResolutions().length;
        await f.h.performAction(key, params, admin("vllnt")).catch(() => {});
        await flush();
        if (f.keyResolutions().length > before) reached.push(key);
      }
      for (const name of f.toolNames) {
        const before = f.keyResolutions().length;
        await f.h.executeTool(name, { repository: "vllnt/repo", number: 1 }, { companyId: "vllnt", agentId: "agent", projectId: "p1", runId: "run" }).catch(() => {});
        if (f.keyResolutions().length > before) reached.push(name);
      }
      return reached;
    };

    const connected = await runActions();
    expect(connected).toEqual(expect.arrayContaining(["repositories.list", "catalog", "sync.trigger", "allowed-owners.set", "manage-repository", "github_read_issue"]));

    await f.h.performAction("company-app.disconnect", { companyId: "vllnt" }, admin("vllnt"));
    expect(await f.h.ctx.state.get(registryKey)).toEqual({});
    await flush();
    f.resolve.mockClear(); f.catalog.mockClear(); f.hasInstallation.mockClear(); f.fetcher.mockClear();

    expect(await runActions()).toEqual([]);
    await f.h.runJob("github-sync");
    await expect(f.service.receiveWebhook(webhook({ installation: { id: 101 } }, "hook-v-hook"))).rejects.toThrow(REJECTED);
    await flush();
    expect(f.keyResolutions()).toEqual([]);
    expect(f.catalog).not.toHaveBeenCalled();
    expect(f.hasInstallation).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(await f.service.connectedCompanies()).toEqual([]);
  });

  it("stays effective when a disconnect stopped before releasing the App", async () => {
    const f = fixture();
    await f.connect("vllnt", V_APP, "v-key");
    // Crash between setting the disconnect flag and releasing the registry entry.
    await f.h.ctx.state.set(disconnectedKey("vllnt"), true);
    expect(await f.h.ctx.state.get(registryKey)).toEqual({ [V_APP]: "vllnt" });
    f.resolve.mockClear();
    await expect(f.h.performAction("repositories.list", { companyId: "vllnt" }, member("vllnt"))).rejects.toThrow("Connect a GitHub App for this company first.");
    expect(await f.h.performAction<any>("company-app.status", { companyId: "vllnt" }, member("vllnt"))).toMatchObject({ configured: false });
    expect(await f.service.connectedCompanies()).toEqual([]);
    await expect(f.service.receiveWebhook(webhook({ installation: { id: 101 } }, "hook-v-hook"))).rejects.toThrow(REJECTED);
    expect(f.keyResolutions()).toEqual([]);
  });
});

describe("owner allowlist and setup authority", () => {
  it("keeps owner pins only in state and returns pinned account IDs", async () => {
    const f = fixture();
    expect(manifest.instanceConfigSchema?.properties).not.toHaveProperty("allowedOwners");
    f.configs.vllnt.allowedOwners = [{ id: 1, login: "vllnt" }];
    await f.connect("vllnt", V_APP, "v-key");
    await f.h.performAction("repositories.list", { companyId: "vllnt" }, member("vllnt"));
    expect(f.catalog).toHaveBeenLastCalledWith(V_APP, "pem-v-key", []);
    vi.spyOn(f.client, "resolveOwners").mockResolvedValue([{ id: 1, login: "vllnt" }, { id: 7, login: "maiaos" }]);
    const accounts = [{ id: 1, login: "vllnt" }, { id: 7, login: "maiaos" }];
    expect(await f.h.performAction("allowed-owners.set", { companyId: "vllnt", owners: ["vllnt", "maiaos"] }, admin("vllnt"))).toEqual({ companyId: "vllnt", owners: ["vllnt", "maiaos"], accounts });
    expect(await f.h.performAction("allowed-owners.get", { companyId: "vllnt" }, member("vllnt"))).toEqual({ companyId: "vllnt", owners: ["vllnt", "maiaos"], accounts });
  });

  it("returns a converted App private key only to an instance administrator", async () => {
    const f = fixture();
    const convert = vi.spyOn(f.client, "convert").mockResolvedValue({ id: V_APP, slug: "v-agents", name: "v-agents", privateKey: "pem" });
    const returnUrl = "https://paperclip.example/VLL/github-projects";
    await expect(f.h.performAction("start-setup", { companyId: "vllnt", returnUrl }, member("vllnt"))).rejects.toThrow("administrator");
    const started = await f.h.performAction<any>("start-setup", { companyId: "vllnt", returnUrl }, admin("vllnt"));
    await expect(f.h.performAction("complete-setup", { companyId: "vllnt", returnUrl, state: started.state, code: "code" }, member("vllnt"))).rejects.toThrow("administrator");
    expect(convert).not.toHaveBeenCalled();
    expect(await f.h.performAction("complete-setup", { companyId: "vllnt", returnUrl, state: started.state, code: "code" }, admin("vllnt"))).toMatchObject({ id: V_APP });
  });
});
