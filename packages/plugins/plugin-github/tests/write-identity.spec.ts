import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import { register } from "../src/worker.js";
import { GitHubClient, GitHubError, assertReadOnlyInstallationToken } from "../src/github.js";
import { WriteThrottle } from "../src/write-identity.js";
import { parseSshSigningKey } from "../src/ssh-signature.js";
import { RepositoryManager } from "../src/management-repository.js";

const APP = "5203754";
const secretRef = (secretId: string) => ({ type: "secret_ref", secretId, version: "latest" });
const actors = (company: string) => ({
  admin: { companyId: company, actor: { type: "user", userId: "admin", agentId: null, runId: null, companyId: company, isInstanceAdmin: true } } as PluginPerformActionContext,
  member: { companyId: company, actor: { type: "user", userId: "member", agentId: null, runId: null, companyId: company } } as PluginPerformActionContext,
  agent: { companyId: company, actor: { type: "agent", userId: null, agentId: "agent", runId: "run", companyId: company } } as PluginPerformActionContext,
  server: { companyId: company, actor: { type: "system", userId: null, agentId: null, runId: null, companyId: company } } as PluginPerformActionContext,
});
const allBot = { commit: "bot", push: "bot", pullRequest: "bot", comment: "bot" };

afterEach(() => { vi.useRealTimers(); });

describe("GitHub write identity: run user (VLL-477)", () => {
  const { admin, member, agent, server } = actors("vllnt");
  const repo = { id: 22, name: "paperclip", fullName: "vllnt/paperclip", url: "https://github.com/vllnt/paperclip", installationId: 101, owner: "vllnt", ownerId: 1, private: false,
    permissions: { contents: "write", pull_requests: "write", issues: "read", administration: "write" } };

  async function fixture() {
    const h = createTestHarness({ manifest });
    vi.spyOn(h.ctx.config, "get").mockImplementation(async company => company === "vllnt" ? { appId: APP, privateKey: secretRef("v-key") } : {});
    vi.spyOn(h.ctx.secrets, "resolve").mockImplementation(async (ref: any) => `pem-${ref.secretId}`);
    const client = new GitHubClient((async () => { throw new Error("GitHub network is blocked in tests."); }) as unknown as typeof fetch);
    vi.spyOn(client, "verify").mockImplementation(async id => ({ id, slug: "vllnt-agents", name: "vllnt-agents" }));
    vi.spyOn(client, "hasInstallation").mockResolvedValue(true);
    vi.spyOn(client, "catalog").mockImplementation(async id => ({ app: { id, slug: "vllnt-agents", name: "vllnt-agents" }, installations: [], repositories: [repo], warnings: [], truncated: false }));
    const scoped = vi.spyOn(client, "scopedToken").mockResolvedValue("app-token");
    const request = vi.spyOn(client, "request").mockImplementation(async (path: string) => {
      if (path === "/users/vllnt-agents%5Bbot%5D") return { data: { id: 99 } as any, next: false };
      throw new Error(`Unexpected GitHub request ${path}`);
    });
    register(h.ctx, client);
    await h.performAction("company-app.connect", { companyId: "vllnt", appId: APP, privateKeySecretId: "v-key" }, admin);
    await h.ctx.state.set({ scopeKind: "company", scopeId: "vllnt", namespace: "connection", stateKey: "allowed-owners" }, [{ id: 1, login: "vllnt" }]);
    const decide = (params: Record<string, unknown>, actor = server) => h.performAction<any>("repository-write-identity", { companyId: "vllnt", ...params }, actor);
    const setPolicy = (policy: unknown, actor = admin) => h.performAction<any>("write-identity.set", { companyId: "vllnt", policy }, actor);
    return { h, scoped, request, decide, setPolicy };
  }

  it("declares the host-only decision and signing actions", () => {
    expect(manifest.projectRepositories).toMatchObject({ writeIdentityAction: "repository-write-identity", signCommitAction: "repository-sign-commit" });
    expect(manifest.capabilities).toContain("secrets.write-own");
  });

  it("lets board users read the policy and only instance admins change it", async () => {
    const f = await fixture();
    expect(await f.h.performAction("write-identity.get", { companyId: "vllnt" }, member)).toEqual({ companyId: "vllnt", policy: null, invalid: false });
    const policy = { default: allBot, overrides: [{ match: "vllnt/*", push: "user" }], missingUserConnection: "use_bot" };
    await expect(f.setPolicy(policy, member)).rejects.toThrow("administrator");
    await expect(f.setPolicy({ ...policy, default: { ...allBot, push: "someone" } })).rejects.toThrow("push");
    expect(await f.setPolicy(policy)).toMatchObject({ companyId: "vllnt", policy: { ...policy, userSource: "run", enabled: true } });
    expect((await f.h.performAction<any>("write-identity.get", { companyId: "vllnt" }, member)).policy).toMatchObject(policy);
    expect(await f.setPolicy(null)).toEqual({ companyId: "vllnt", policy: null });
  });

  it("answers only the Paperclip server", async () => {
    const f = await fixture();
    for (const caller of [member, admin, agent]) {
      await expect(f.decide({ repository: "vllnt/paperclip", action: "push" }, caller)).rejects.toThrow("only to the Paperclip server");
    }
    await expect(f.decide({ repository: "vllnt/paperclip", action: "deploy" })).rejects.toThrow("Unknown GitHub write action");
    await expect(f.decide({ repository: "../../app", action: "push" })).rejects.toThrow("owner/name");
  });

  it("keeps managed git/gh on the run's user until a policy is saved, reads included", async () => {
    const f = await fixture();
    expect(await f.decide({ repository: "vllnt/paperclip", action: "push" })).toEqual({ identity: "user", missingUserConnection: "fail" });
    expect(await f.decide({ repository: "vllnt/paperclip", access: "read", action: null })).toEqual({ identity: "user", missingUserConnection: "fail" });
    expect(f.scoped).not.toHaveBeenCalled();
  });

  it("mints an App token for one repository with the installation's write permissions", async () => {
    const f = await fixture();
    await f.setPolicy({ default: allBot, overrides: [{ match: "vllnt/*", push: "user" }], missingUserConnection: "fail" });
    expect(await f.decide({ repository: "VLLNT/paperclip", action: "push" })).toEqual({ identity: "user", missingUserConnection: "fail" });
    expect(await f.decide({ repository: "vllnt/paperclip", action: "comment" })).toEqual({
      identity: "bot", credential: { token: "app-token", login: "vllnt-agents[bot]", userId: "99" },
    });
    expect(f.scoped).toHaveBeenCalledWith(APP, "pem-v-key", 101, { metadata: "read", contents: "write", pull_requests: "write", issues: "read" }, 22);
    expect(await f.decide({ repository: "vllnt/paperclip", action: "other" })).toMatchObject({ identity: "bot" });
    expect(await f.decide({ repository: "vllnt/elsewhere", action: "comment" })).toEqual({ identity: "bot", unavailable: "vllnt/elsewhere is not available through the company's GitHub App." });
    expect(await f.decide({ repository: null, action: "comment" })).toMatchObject({ identity: "bot", unavailable: expect.stringContaining("--repo") });
    await f.decide({ repository: "vllnt/paperclip", action: "commit" });
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it("falls back to the App only when the policy allows it", async () => {
    const f = await fixture();
    const userWrites = { commit: "user", push: "user", pullRequest: "user", comment: "user" };
    await f.setPolicy({ default: userWrites, overrides: [], missingUserConnection: "fail" });
    expect(await f.decide({ repository: "vllnt/paperclip", action: "push", fallback: true })).toEqual({ identity: "bot", unavailable: "Connect your GitHub account in Paperclip to write as yourself." });
    await f.setPolicy({ default: userWrites, overrides: [], missingUserConnection: "use_bot" });
    expect(await f.decide({ repository: "vllnt/paperclip", action: "push", fallback: true })).toMatchObject({ identity: "bot", credential: { login: "vllnt-agents[bot]" } });
  });

  it("applies the kill switch and privileged toggles to the run's user too", async () => {
    const f = await fixture();
    const userWrites = { commit: "user", push: "user", pullRequest: "user", comment: "user" };
    await f.setPolicy({ default: userWrites, enabled: false });
    expect(await f.decide({ repository: "vllnt/paperclip", action: "push" })).toMatchObject({ unavailable: expect.stringContaining("kill switch") });
    expect(await f.decide({ repository: "vllnt/paperclip", access: "read", action: null })).toEqual({ identity: "user", missingUserConnection: "fail" });
    await f.setPolicy({ default: userWrites });
    expect(await f.decide({ repository: "vllnt/paperclip", access: "write", action: "other", privileged: ["release"] })).toMatchObject({ unavailable: expect.stringContaining("release") });
    // With an allowlist, a write whose repository is unknown is refused.
    await f.setPolicy({ default: userWrites, allowedRepositories: ["vllnt/paperclip"] });
    expect(await f.decide({ repository: null, access: "write", action: "other", privileged: [] })).toMatchObject({ unavailable: expect.stringContaining("cannot tell") });
    expect(await f.decide({ repository: "vllnt/other", access: "write", action: "push", privileged: [] })).toMatchObject({ unavailable: expect.stringContaining("allowlist") });
  });

  it("N4 (round 2c): checks a privileged action whatever access the classifier reported", async () => {
    const f = await fixture();
    const userWrites = { commit: "user", push: "user", pullRequest: "user", comment: "user" };
    await f.setPolicy({ default: userWrites, allowedRepositories: ["vllnt/paperclip"] });
    expect(await f.decide({ repository: "vllnt/other", access: "none", action: "push", privileged: ["pushToMain"] })).toMatchObject({ unavailable: expect.stringContaining("allowlist") });
    expect(await f.decide({ repository: "vllnt/paperclip", access: "none", action: "push", privileged: ["pushToMain"] })).toMatchObject({ unavailable: expect.stringContaining("(pushToMain)") });
    expect(await f.decide({ repository: "vllnt/paperclip", access: "none", action: "commit", privileged: [] })).toEqual({ identity: "user", missingUserConnection: "fail" });
  });
});

// ---------------------------------------------------------------------------
// App user identity (anthm): reads on the App, writes as the authorizing person
// ---------------------------------------------------------------------------

const USER_ID = "32437578";
const token = (prefix: string, n: number) => `${prefix}_${String(n).padStart(36, "0")}`;
const permissions = { actions: "write", checks: "read", contents: "write", deployments: "write", issues: "write", metadata: "read", organization_projects: "write", pull_requests: "write", statuses: "read" };
const names = ["songtrivia", "anthm-fr", "linkzic", "wordzic", "nextdle"];
const repos = names.map((name, index) => ({ id: 22 + index, name, fullName: `Anthm-FR/${name}`, url: `https://github.com/Anthm-FR/${name}`, installationId: 101, owner: "Anthm-FR", ownerId: 1, private: true, permissions }));
const anthmPolicy = {
  default: { commit: "user", push: "user", pullRequest: "user", comment: "user" },
  userSource: "app",
  // Staged: writes start on songtrivia and anthm-fr; the installation covers all five.
  allowedRepositories: ["Anthm-FR/songtrivia", "Anthm-FR/anthm-fr"],
  installationRepositories: names.map(name => `Anthm-FR/${name}`),
  userLogin: "agent-owner",
  installationPermissions: permissions,
};

function signingKeyPem() {
  return generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}

async function appFixture(options: { revoked?: () => boolean } = {}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-08T08:00:00Z"));
  const { admin, server } = actors("anthm");
  const h = createTestHarness({ manifest });
  const signing = signingKeyPem();
  vi.spyOn(h.ctx.config, "get").mockImplementation(async company => company === "anthm" ? {
    appId: APP, privateKey: secretRef("a-key"), userClientId: "Iv23liAbcdef12", userClientSecret: secretRef("client-secret"),
    userRefreshToken: secretRef("refresh"), signingKey: secretRef("signing"), personalToken: secretRef("pat"),
  } : {});
  const github = {
    refresh: "unset", issued: 0, revoked: false,
    installation: { id: 101, repository_selection: "selected", permissions: { ...permissions } as Record<string, string> },
    installationRepos: names.map(name => `Anthm-FR/${name}`),
    /** Repository IDs GitHub reports to the user (by lowercase full name); none by default. */
    installationRepoIds: {} as Record<string, number>,
    pr: { state: "open", head: { sha: "a".repeat(40) }, base: { ref: "main", sha: "c".repeat(40) } } as Record<string, any>,
    /** The pull request's changed files (GitHub's pulls/{n}/files), and how many GitHub says there are (default: all of them). */
    prFiles: [{ filename: "src/game.ts", status: "modified" }] as Array<Record<string, unknown>>,
    changedFiles: null as number | null,
    /** Files by `owner/name/path@ref` (lowercase repository): text, or an HTTP status GitHub answers instead. */
    contents: {} as Record<string, string | number>,
    /** Pull request reads, to move the head between two of them. */
    prReads: 0,
    rules: [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "lint", integration_id: 15368 }, { context: "typecheck" }] } }] as any[],
    /** Classic protection of main in the shape GitHub's branch read returns (never with enforce_admins): it binds administrators. */
    protection: { enabled: true, required_status_checks: { enforcement_level: "everyone", contexts: [], checks: [] } } as Record<string, unknown>,
    appPermissions: { ...permissions } as Record<string, string>,
    unreachable: false,
    refreshGate: null as Promise<void> | null,
    checkRuns: [{ name: "lint", status: "completed", conclusion: "success", app: { id: 15368 } }, { name: "typecheck", status: "completed", conclusion: "success", app: { id: 15368 } }] as any[],
    statuses: [] as any[],
  };
  const resolve = vi.spyOn(h.ctx.secrets, "resolve").mockImplementation(async (ref: any) =>
    ref.secretId === "refresh" ? github.refresh : ref.secretId === "signing" ? signing : `value-${ref.secretId}`);
  const storeOwn = vi.spyOn(h.ctx.secrets, "storeOwn").mockImplementation(async (value: string) => { github.refresh = value; });
  const client = new GitHubClient((async () => { throw new Error("GitHub network is blocked in tests."); }) as unknown as typeof fetch);
  vi.spyOn(client, "verify").mockImplementation(async id => ({ id, slug: "anthm-agents", name: "anthm-agents" }));
  vi.spyOn(client, "catalog").mockImplementation(async id => ({ app: { id, slug: "anthm-agents", name: "anthm-agents", permissions: github.appPermissions },
    installations: [{ id: 101, login: "Anthm-FR", accountId: 1, accountType: "Organization" as const, suspended: false, permissions }], repositories: repos, warnings: [], truncated: false }));
  const scoped = vi.spyOn(client, "scopedToken").mockImplementation(async () => token("ghs", 1));
  let current = "";
  const userTokens = new Set<string>();
  const oauth = vi.spyOn(client, "oauth").mockImplementation(async (path, body) => {
    if (path === "/login/device/code") return { device_code: "device-code", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 };
    if (body.grant_type === "refresh_token" && github.refreshGate) await github.refreshGate;
    if (body.grant_type === "refresh_token" && (github.revoked || options.revoked?.() || body.refresh_token !== github.refresh)) return { error: "bad_refresh_token" };
    github.issued += 1;
    current = token("ghu", github.issued);
    userTokens.add(current);
    return { access_token: current, refresh_token: token("ghr", github.issued), expires_in: 28_800, refresh_token_expires_in: 15_897_600, token_type: "bearer" };
  });
  const request = vi.spyOn(client, "request").mockImplementation(async (path: string, auth?: string, body?: unknown, method?: string) => {
    const user = !!auth && userTokens.has(auth);
    if (user && github.revoked) throw new GitHubError(401);
    if (user && github.unreachable) throw new Error("GitHub did not return a valid response. Please try again.");
    if (path === "/users/anthm-agents%5Bbot%5D") return { data: { id: 99 } as any, next: false };
    if (path === "/user" && user) return { data: { login: "agent-owner", id: Number(USER_ID) } as any, next: false };
    // The board's personal Projects token (a PAT) for the same person.
    if (path === "/user" && auth === "value-pat") return { data: { login: "agent-owner", id: Number(USER_ID) } as any, next: false };
    if (path.startsWith("/user/installations?") && user) return { data: { installations: [github.installation] } as any, next: false };
    if (path.startsWith("/user/installations/101/repositories?") && user) return { data: { repositories: github.installationRepos.map(full_name => ({ full_name, id: github.installationRepoIds[full_name.toLowerCase()] })) } as any, next: false };
    if (/^\/repos\/anthm-fr\/(songtrivia|anthm-fr)\/pulls\/7$/.test(path)) {
      github.prReads += 1;
      return { data: { ...github.pr, changed_files: github.changedFiles ?? github.prFiles.length } as any, next: false };
    }
    const files = /^\/repos\/anthm-fr\/(songtrivia|anthm-fr)\/pulls\/7\/files\?per_page=100&page=(\d+)$/.exec(path);
    if (files) {
      const page = Number(files[2]);
      return { data: github.prFiles.slice((page - 1) * 100, page * 100) as any, next: github.prFiles.length > page * 100 };
    }
    const content = /^\/repos\/(anthm-fr\/[a-z-]+)\/contents\/(.+)\?ref=([0-9a-f]{40})$/.exec(path);
    if (content) {
      const entry = github.contents[`${content[1]}/${content[2]}@${content[3]}`];
      if (entry === undefined) throw new GitHubError(404);
      if (typeof entry === "number") throw new GitHubError(entry);
      return { data: { type: "file", encoding: "base64", content: Buffer.from(entry).toString("base64") } as any, next: false };
    }
    if (path.startsWith("/repos/anthm-fr/songtrivia/rules/branches/main?per_page=100")) return { data: github.rules as any, next: false };
    if (path === "/repos/anthm-fr/songtrivia/branches/main") return { data: { name: "main", protection: github.protection } as any, next: false };
    if (path.startsWith(`/repos/anthm-fr/songtrivia/commits/${"a".repeat(40)}/check-runs`)) return { data: { check_runs: github.checkRuns } as any, next: false };
    if (path.startsWith(`/repos/anthm-fr/songtrivia/commits/${"a".repeat(40)}/status`)) return { data: { statuses: github.statuses } as any, next: false };
    if (/^\/repos\/Anthm-FR\/[a-z-]+\/issues\/1\/comments$/.test(path) && method === "POST") return { data: { id: 7, auth } as any, next: false };
    throw new Error(`Unexpected GitHub request ${method ?? "GET"} ${path}`);
  });
  register(h.ctx, client);
  await h.performAction("company-app.connect", { companyId: "anthm", appId: APP, privateKeySecretId: "a-key" }, admin);
  await h.ctx.state.set({ scopeKind: "company", scopeId: "anthm", namespace: "connection", stateKey: "allowed-owners" }, [{ id: 1, login: "Anthm-FR" }]);
  const decide = (params: Record<string, unknown>) => h.performAction<any>("repository-write-identity", { companyId: "anthm", ...params }, server);
  const sign = (payload: string) => h.performAction<any>("repository-sign-commit", { companyId: "anthm", payload: Buffer.from(payload).toString("base64") }, server);
  const setPolicy = (policy: unknown) => h.performAction<any>("write-identity.set", { companyId: "anthm", policy }, admin);
  const action = (key: string) => h.performAction<any>(key, { companyId: "anthm" }, admin);
  const write = (repository: string, extra: Record<string, unknown> = {}) => decide({ repository, access: "write", action: "push", privileged: [], ...extra });
  const read = (repository: string | null, extra: Record<string, unknown> = {}) => decide({ repository, access: "read", action: null, privileged: [], ...extra });
  async function authorize() {
    await setPolicy(anthmPolicy);
    expect(await action("user-authorization.start")).toMatchObject({ userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", login: "agent-owner" });
    // Too early: GitHub is not asked before the interval.
    expect(await action("user-authorization.poll")).toMatchObject({ status: "pending" });
    vi.setSystemTime(Date.now() + 6_000);
    const result = await action("user-authorization.poll");
    expect(result).toMatchObject({ status: "authorized", login: "agent-owner", userId: USER_ID, fence: { ok: true, installationId: 101 } });
    return result;
  }
  const policy = async () => (await h.performAction<any>("write-identity.get", { companyId: "anthm" }, admin)).policy;
  return { h, client, github, scoped, oauth, request, resolve, storeOwn, decide, sign, setPolicy, action, write, read, authorize, policy, signing, current: () => current };
}

describe("GitHub write identity: App user (anthm)", () => {
  it("authorizes by device flow, stores the rotating refresh token server-side and passes the fence", async () => {
    const f = await appFixture();
    await f.authorize();
    expect(f.storeOwn).toHaveBeenCalledWith(token("ghr", 1), { companyId: "anthm", configPath: "userRefreshToken" });
    expect(f.h.activity.map(entry => entry.message)).toContain("GitHub user authorized for agent writes");
    expect(JSON.stringify(f.h.activity)).not.toMatch(/gh[ur]_/);
    const status = await f.h.performAction<any>("user-authorization.status", { companyId: "anthm" }, actors("anthm").member);
    expect(status.authorization).toMatchObject({ login: "agent-owner", userId: USER_ID, fence: { ok: true } });
    expect(JSON.stringify(status)).not.toMatch(/gh[ur]_/);
  });

  it("refuses an authorization by another account or without token expiry", async () => {
    const f = await appFixture();
    await f.setPolicy({ ...anthmPolicy, userLogin: "someone-else" });
    await f.action("user-authorization.start");
    vi.setSystemTime(Date.now() + 6_000);
    await expect(f.action("user-authorization.poll")).rejects.toThrow(/Authorize as GitHub user someone-else/);
    expect(f.storeOwn).not.toHaveBeenCalled();
    f.oauth.mockImplementation(async path => path === "/login/device/code"
      ? { device_code: "d", user_code: "U", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 }
      : { access_token: token("ghu", 9), token_type: "bearer" });
    await f.setPolicy(anthmPolicy);
    await f.action("user-authorization.start");
    vi.setSystemTime(Date.now() + 6_000);
    await expect(f.action("user-authorization.poll")).rejects.toThrow(/Expire user authorization tokens/);
    expect(f.storeOwn).not.toHaveBeenCalled();
  });

  it("serves reads with a read-only App token for one fenced repository, and writes with the user token", async () => {
    const f = await appFixture();
    await f.authorize();
    const read = await f.read("Anthm-FR/linkzic");
    expect(read).toMatchObject({ identity: "bot", credential: { token: token("ghs", 1), login: "anthm-agents[bot]", userId: "99" }, author: { login: "agent-owner", userId: USER_ID } });
    expect(f.scoped).toHaveBeenLastCalledWith(APP, "value-a-key", 101,
      { metadata: "read", contents: "read", issues: "read", pull_requests: "read", actions: "read", checks: "read", statuses: "read", organization_projects: "read" }, [24]);
    // Cached per repository: no second mint.
    await f.read("anthm-fr/linkzic");
    expect(f.scoped).toHaveBeenCalledTimes(1);
    // A read naming no repository covers the fenced repositories only (by name, never the whole installation), with org Projects read.
    await f.read(null);
    expect(f.scoped).toHaveBeenLastCalledWith(APP, "value-a-key", 101, expect.objectContaining({ organization_projects: "read", contents: "read" }),
      ["Anthm-FR/anthm-fr", "Anthm-FR/linkzic", "Anthm-FR/nextdle", "Anthm-FR/songtrivia", "Anthm-FR/wordzic"]);
    const push = await f.write("Anthm-FR/songtrivia");
    expect(push).toMatchObject({ identity: "user", credential: { token: f.current(), login: "agent-owner", userId: USER_ID }, bodyFooter: false });
    expect(push.signingKey).toBe(parseSshSigningKey(f.signing).publicKey);
    // Local commands get the identity and signing key, never a token.
    expect(await f.decide({ repository: "anthm-fr/songtrivia", access: "none", action: "commit", privileged: [] }))
      .toMatchObject({ identity: "user", credential: { token: null, login: "agent-owner" }, signingKey: expect.stringMatching(/^ssh-ed25519 /) });
    expect(await f.decide({ repository: null, access: "none", action: null, privileged: [] })).toMatchObject({ credential: { token: null } });
  });

  it("adds org Projects read to a read token that names a repository, when the installation grants it", async () => {
    // `gh project item-list 34 --owner Anthm-FR` inside a songtrivia checkout: the server names the checkout's repository.
    const f = await appFixture();
    await f.authorize();
    await f.read("anthm-fr/songtrivia");
    expect(f.scoped).toHaveBeenLastCalledWith(APP, "value-a-key", 101,
      { metadata: "read", contents: "read", issues: "read", pull_requests: "read", actions: "read", checks: "read", statuses: "read", organization_projects: "read" }, [22]);
  });

  it("leaves org Projects out of every read token when the installation does not grant it", async () => {
    const f = await appFixture();
    const { organization_projects: _, ...granted } = permissions;
    vi.mocked(f.client.catalog).mockImplementation(async id => ({ app: { id, slug: "anthm-agents", name: "anthm-agents", permissions: f.github.appPermissions },
      installations: [{ id: 101, login: "Anthm-FR", accountId: 1, accountType: "Organization" as const, suspended: false, permissions: granted }],
      repositories: repos.map(repo => ({ ...repo, permissions: granted })), warnings: [], truncated: false }));
    await f.authorize();
    await f.read("anthm-fr/songtrivia");
    await f.read(null);
    expect(f.scoped).toHaveBeenCalledTimes(2);
    expect(f.scoped.mock.calls[0]![3]).toEqual({ metadata: "read", contents: "read", issues: "read", pull_requests: "read", actions: "read", checks: "read", statuses: "read" });
    for (const call of f.scoped.mock.calls) expect(call[3]).not.toHaveProperty("organization_projects");
  });

  it("enforces the fence: allowlist, look-alikes, staged repositories and other orgs", async () => {
    const f = await appFixture();
    await f.authorize();
    expect(await f.write("Anthm-FR/anthm-fr")).toMatchObject({ identity: "user", credential: { login: "agent-owner" } });
    for (const name of ["Anthm-FR/songtrivia-old", "Anthm-FR/linkzic", "vllnt/infrastructure", "Anthm-FR/spotzic"]) {
      expect(await f.write(name), name).toMatchObject({ identity: "user", unavailable: expect.stringContaining("allowlist") });
    }
    // Wikis count as their repository; a wiki push also needs the wiki toggle (on by default).
    expect(await f.write("Anthm-FR/songtrivia.wiki", { privileged: ["wiki"], wiki: true })).toMatchObject({ credential: { login: "agent-owner" } });
    expect(await f.write("Anthm-FR/linkzic.wiki", { privileged: ["wiki"], wiki: true })).toMatchObject({ unavailable: expect.stringContaining("allowlist") });
    // Staged repositories stay readable; other repositories are outside the fence for reads too.
    expect(await f.read("Anthm-FR/linkzic")).toMatchObject({ identity: "bot", credential: { login: "anthm-agents[bot]" } });
    expect(await f.read("vllnt/infrastructure")).toMatchObject({ unavailable: expect.stringContaining("outside this company's GitHub fence") });
    expect(await f.read("Anthm-FR/songtrivia-old")).toMatchObject({ unavailable: expect.stringContaining("outside") });
    // A write the fence cannot check is refused; org Projects writes name no repository.
    expect(await f.decide({ repository: null, access: "write", action: "other", privileged: [] })).toMatchObject({ unavailable: expect.stringContaining("Name the repository") });
    expect(await f.decide({ repository: null, access: "write", action: "project", privileged: [] })).toMatchObject({ credential: { login: "agent-owner" } });
  });

  it("keeps release and tag pushes off by default, and other privileged actions per toggle", async () => {
    const f = await appFixture();
    await f.authorize();
    for (const privileged of ["release", "tagPush", "pushToMain", "editWorkflows"]) {
      expect(await f.write("anthm-fr/songtrivia", { privileged: [privileged] }), privileged).toMatchObject({ unavailable: expect.stringContaining(`(${privileged})`) });
    }
    for (const privileged of ["deploymentApproval", "workflowDispatch"]) {
      expect(await f.write("anthm-fr/songtrivia", { action: "other", privileged: [privileged] }), privileged).toMatchObject({ credential: { login: "agent-owner" } });
    }
    await f.setPolicy({ ...anthmPolicy, privileged: { tagPush: true, deploymentApproval: false } });
    expect(await f.write("anthm-fr/songtrivia", { privileged: ["tagPush"] })).toMatchObject({ credential: { login: "agent-owner" } });
    expect(await f.write("anthm-fr/songtrivia", { action: "other", privileged: ["deploymentApproval"] })).toMatchObject({ unavailable: expect.stringContaining("deploymentApproval") });
  });

  it("guards an admin merge: expected head SHA and every required check green, with evidence", async () => {
    const f = await appFixture();
    await f.authorize();
    const merge = (extra: Record<string, unknown>) => f.write("anthm-fr/songtrivia", { action: "pullRequest", privileged: ["adminMerge"], ...extra });
    expect(await merge({})).toMatchObject({ unavailable: expect.stringContaining("--match-head-commit") });
    expect(await merge({ pullRequest: 7, expectedHeadSha: "b".repeat(40) })).toMatchObject({ unavailable: expect.stringContaining("not the expected"), evidence: { headSha: "a".repeat(40) } });
    const granted = await merge({ pullRequest: 7, expectedHeadSha: "a".repeat(40) });
    expect(granted).toMatchObject({ identity: "user", credential: { login: "agent-owner" }, evidence: { adminMerge: {
      pullRequest: 7, headSha: "a".repeat(40), enforcementLevel: "everyone", requiredChecks: ["lint", "typecheck"],
      checks: [{ name: "lint", result: "success" }, { name: "typecheck", result: "success" }],
    } } });
    // The pinned integration must report it; a failing or pending required check blocks the merge.
    f.github.checkRuns = [{ name: "lint", status: "completed", conclusion: "success", app: { id: 1 } }, { name: "typecheck", status: "completed", conclusion: "success", app: { id: 15368 } }];
    expect(await merge({ pullRequest: 7, expectedHeadSha: "a".repeat(40) })).toMatchObject({ unavailable: expect.stringContaining("lint"), evidence: { failing: ["lint"] } });
    f.github.checkRuns = [{ name: "lint", status: "completed", conclusion: "success", app: { id: 15368 } }, { name: "typecheck", status: "in_progress", conclusion: null, app: { id: 15368 } }];
    expect(await merge({ pullRequest: 7, expectedHeadSha: "a".repeat(40) })).toMatchObject({ unavailable: expect.stringContaining("typecheck") });
    // Only the latest run counts: an old success does not hide a failed rerun.
    f.github.checkRuns = [
      { id: 1, name: "lint", status: "completed", conclusion: "success", app: { id: 15368 } },
      { id: 2, name: "lint", status: "completed", conclusion: "failure", app: { id: 15368 } },
      { id: 3, name: "typecheck", status: "completed", conclusion: "success", app: { id: 15368 } },
    ];
    expect(await merge({ pullRequest: 7, expectedHeadSha: "a".repeat(40) })).toMatchObject({ unavailable: expect.stringContaining("lint") });
    // Classic branch protection adds required checks the ruleset does not list.
    f.github.rules = [];
    f.github.protection = { enabled: true, required_status_checks: { enforcement_level: "everyone", contexts: ["e2e"], checks: [{ context: "e2e", app_id: 15368 }] } };
    f.github.checkRuns = [{ id: 4, name: "lint", status: "completed", conclusion: "success", app: { id: 15368 } }];
    expect(await merge({ pullRequest: 7, expectedHeadSha: "a".repeat(40) })).toMatchObject({ unavailable: expect.stringContaining("e2e"), evidence: { requiredChecks: ["e2e"] } });
    f.github.checkRuns = [];
    expect(await merge({ pullRequest: 7, expectedHeadSha: "a".repeat(40) })).toMatchObject({ unavailable: expect.stringContaining("No check has reported") });
    f.github.checkRuns = [{ id: 5, name: "e2e", status: "completed", conclusion: "success", app: { id: 15368 } }];
    expect(await merge({ pullRequest: 7, expectedHeadSha: "a".repeat(40) })).toMatchObject({ credential: { login: "agent-owner" }, evidence: { adminMerge: { requiredChecks: ["e2e"] } } });
  });

  it("counts a required check that was skipped as passing, as GitHub does, and no other result that is not a success", async () => {
    const f = await appFixture();
    await f.authorize();
    const merge = () => f.write("anthm-fr/songtrivia", { action: "pullRequest", privileged: ["adminMerge"], pullRequest: 7, expectedHeadSha: "a".repeat(40) });
    const run = (name: string, conclusion: string | null, extra: Record<string, unknown> = {}) => ({ name, status: "completed", conclusion, app: { id: 15368 }, ...extra });
    // A docs-only change: the job behind "typecheck" is skipped by its path filter. Both checks are required.
    f.github.checkRuns = [run("lint", "success"), run("typecheck", "skipped")];
    expect(await merge()).toMatchObject({ credential: { login: "agent-owner" }, evidence: { adminMerge: {
      requiredChecks: ["lint", "typecheck"], checks: [{ name: "lint", result: "success" }, { name: "typecheck", result: "skipped" }],
    } } });
    f.github.checkRuns = [run("lint", "skipped"), run("typecheck", "skipped")];
    expect(await merge()).toMatchObject({ credential: { login: "agent-owner" } });
    // A skipped check does not cover another required check, and every other result still blocks the merge.
    const blocked: Array<[string, unknown[], string[]]> = [
      ["a skipped check next to a failed one", [run("lint", "skipped"), run("typecheck", "failure")], ["typecheck"]],
      ["a required check that never reported", [run("lint", "skipped")], ["typecheck"]],
      ["a required check in progress", [run("lint", "skipped"), run("typecheck", null, { status: "in_progress" })], ["typecheck"]],
      ["a required check queued", [run("lint", "success"), run("typecheck", null, { status: "queued" })], ["typecheck"]],
      ...["neutral", "cancelled", "timed_out", "action_required", "stale", "startup_failure", "failure"].map((conclusion): [string, unknown[], string[]] =>
        [`a ${conclusion} required check`, [run("lint", "success"), run("typecheck", conclusion)], ["typecheck"]]),
      // The ruleset pins lint to one integration: a skipped run from another app is not that check.
      ["a skipped run from another app than the pinned one", [run("lint", "skipped", { app: { id: 1 } }), run("typecheck", "success")], ["lint"]],
    ];
    for (const [label, runs, failing] of blocked) {
      f.github.checkRuns = runs;
      const decision = await merge();
      expect(decision, label).toMatchObject({ identity: "user", unavailable: expect.stringContaining(failing.join(", ")), evidence: { failing } });
      expect(decision, label).not.toHaveProperty("credential");
    }
    // Only the latest run of a check counts: a skipped rerun after a failure passes, a failed rerun after a skip does not.
    f.github.checkRuns = [{ id: 1, ...run("lint", "failure") }, { id: 2, ...run("lint", "skipped") }, run("typecheck", "success")];
    expect(await merge()).toMatchObject({ credential: { login: "agent-owner" } });
    f.github.checkRuns = [{ id: 1, ...run("lint", "skipped") }, { id: 2, ...run("lint", "failure") }, run("typecheck", "success")];
    expect(await merge()).toMatchObject({ unavailable: expect.stringContaining("lint"), evidence: { failing: ["lint"] } });
    // A commit status has no skipped state: only success counts there.
    f.github.checkRuns = [run("lint", "success")];
    f.github.statuses = [{ context: "typecheck", state: "skipped" }];
    expect(await merge()).toMatchObject({ unavailable: expect.stringContaining("typecheck"), evidence: { failing: ["typecheck"] } });
    f.github.statuses = [{ context: "typecheck", state: "success" }];
    expect(await merge()).toMatchObject({ credential: { login: "agent-owner" } });
  });

  // An admin merge is bounded only where the base branch binds administrators and requires a check.
  async function adminMergeFixture() {
    const f = await appFixture();
    await f.authorize();
    const merge = () => f.write("anthm-fr/songtrivia", { action: "pullRequest", privileged: ["adminMerge"], pullRequest: 7, expectedHeadSha: "a".repeat(40) });
    const refused = async (reason: string, evidence: Record<string, unknown>) => {
      const decision = await merge();
      expect(decision).toMatchObject({ identity: "user", unavailable: expect.stringContaining(reason), evidence });
      expect(decision).not.toHaveProperty("credential");
    };
    return { ...f, merge, refused };
  }

  it("allows an admin merge on GitHub's live branch shape: enforcement_level everyone and no enforce_admins key (regression)", async () => {
    const f = await adminMergeFixture();
    // GET /branches/{branch} as GitHub returns it live, even to an owner: enforce_admins is never part of it.
    f.github.protection = { enabled: true, required_status_checks: { enforcement_level: "everyone", contexts: ["lint", "typecheck"], checks: [{ context: "lint", app_id: 15368 }, { context: "typecheck", app_id: 15368 }] } };
    expect(Object.keys(f.github.protection)).toEqual(["enabled", "required_status_checks"]);
    const decision = await f.merge();
    expect(decision).toMatchObject({ identity: "user", credential: { login: "agent-owner" }, evidence: { adminMerge: { headSha: "a".repeat(40), enforcementLevel: "everyone", requiredChecks: ["lint", "typecheck"] } } });
    expect(decision.evidence.adminMerge).not.toHaveProperty("enforceAdmins");
  });

  it("refuses an admin merge where administrators may bypass the base branch protection (enforcement_level not everyone)", async () => {
    const f = await adminMergeFixture();
    // Required checks green or not, --admin would skip every rule of such a branch.
    const cases: Array<[string, unknown, string, Record<string, unknown>]> = [
      ["administrators exempt, no required check (live shape)", { enabled: true, required_status_checks: { enforcement_level: "non_admins", contexts: [], checks: [] } }, "enforcement_level non_admins", { base: "main", enforcementLevel: "non_admins" }],
      ["administrators exempt from required checks", { enabled: true, required_status_checks: { enforcement_level: "non_admins", contexts: ["lint"], checks: [] } }, "enforcement_level non_admins", { enforcementLevel: "non_admins" }],
      ["required checks off", { enabled: true, required_status_checks: { enforcement_level: "off", contexts: [], checks: [] } }, "enforcement_level off", { enforcementLevel: "off" }],
      ["enforcement_level missing", { enabled: true, required_status_checks: { contexts: ["lint"], checks: [] } }, "enforcement_level not reported", { enforcementLevel: null }],
      ["an unprotected branch", { enabled: false, required_status_checks: { enforcement_level: "off", contexts: [], checks: [] } }, "branch protection off", { enforcementLevel: "off" }],
      ["protection off, whatever the level says", { enabled: false, required_status_checks: { enforcement_level: "everyone", contexts: ["lint"], checks: [] } }, "branch protection off", { enforcementLevel: "everyone" }],
      ["no protection object", undefined, "enforcement_level not reported", { enforcementLevel: null }],
      ["enforce_admins reported off", { enabled: true, enforce_admins: { enabled: false }, required_status_checks: { enforcement_level: "everyone", contexts: ["lint"], checks: [] } }, "enforce_admins off", { enforceAdmins: false }],
    ];
    for (const [label, protection, reason, evidence] of cases) {
      f.github.protection = protection as Record<string, unknown>;
      const decision = await f.merge();
      expect(decision, label).toMatchObject({ identity: "user", unavailable: expect.stringContaining(reason), evidence });
      expect(decision.unavailable, label).toContain('enforcement_level "everyone"');
      expect(decision, label).not.toHaveProperty("credential");
    }
  });

  it("refuses an admin merge when enforce_admins says on but an explicit enforcement_level says administrators are exempt (regression)", async () => {
    const f = await adminMergeFixture();
    // Contradictory data fails closed: an explicit enforcement_level decides, enforce_admins counts only when the level is absent.
    for (const level of ["non_admins", "off"]) {
      f.github.protection = { enabled: true, enforce_admins: { enabled: true }, required_status_checks: { enforcement_level: level, contexts: ["lint"], checks: [] } };
      const decision = await f.merge();
      expect(decision, level).toMatchObject({ identity: "user", unavailable: expect.stringContaining(`enforcement_level ${level}`), evidence: { enforcementLevel: level, enforceAdmins: true } });
      expect(decision, level).not.toHaveProperty("credential");
    }
  });

  it("refuses an admin merge when GitHub does not let Paperclip read the base branch protection", async () => {
    const f = await adminMergeFixture();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (path: string, ...rest: any[]) => {
      if (path === "/repos/anthm-fr/songtrivia/branches/main") throw new GitHubError(403);
      return (original as any)(path, ...rest);
    });
    await f.refused("cannot read the base branch protection", { base: "main" });
  });

  it("refuses an admin merge when the base branch requires no check, even with every reported check green", async () => {
    const f = await adminMergeFixture();
    f.github.rules = [];
    await f.refused("requires no status check", { enforcementLevel: "everyone", requiredChecks: [] });
    f.github.rules = [{ type: "required_status_checks", parameters: { required_status_checks: [] } }];
    await f.refused("requires no status check", { requiredChecks: [] });
  });

  it("allows an admin merge bound by enforcement_level everyone, or by enforce_admins if GitHub reports it, with green required checks; a merge without --admin ignores both", async () => {
    const f = await adminMergeFixture();
    expect(await f.merge()).toMatchObject({ credential: { login: "agent-owner" }, evidence: { adminMerge: { headSha: "a".repeat(40), enforcementLevel: "everyone", requiredChecks: ["lint", "typecheck"] } } });
    // enforce_admins is accepted when a response carries it, not required.
    f.github.protection = { enabled: true, enforce_admins: { enabled: true }, required_status_checks: { contexts: [], checks: [] } };
    expect(await f.merge()).toMatchObject({ credential: { login: "agent-owner" }, evidence: { adminMerge: { enforceAdmins: true, enforcementLevel: null } } });
    f.github.protection = { enabled: true, required_status_checks: { enforcement_level: "non_admins", contexts: [], checks: [] } };
    f.github.rules = [];
    expect(await f.write("anthm-fr/songtrivia", { action: "pullRequest", privileged: [], merge: true, pullRequest: 7, expectedHeadSha: "a".repeat(40) }))
      .toMatchObject({ credential: { login: "agent-owner" } });
  });

  it("kill switch: denies every user-identity write and keeps reads", async () => {
    const f = await appFixture();
    await f.authorize();
    await f.setPolicy({ ...anthmPolicy, enabled: false });
    expect(await f.write("anthm-fr/songtrivia")).toEqual({ identity: "user", unavailable: expect.stringContaining("kill switch") });
    expect(await f.read("anthm-fr/songtrivia")).toMatchObject({ identity: "bot", credential: { token: token("ghs", 1) } });
    // Local commits keep their author but are not signed while writes are off.
    expect(await f.decide({ repository: "anthm-fr/songtrivia", access: "none", action: "commit", privileged: [] })).not.toHaveProperty("signingKey");
    expect(await f.sign("tree 1\n")).toMatchObject({ unavailable: expect.stringContaining("kill switch") });
  });

  it("throttles user-identity writes per GitHub user and recovers after the window", async () => {
    const f = await appFixture();
    await f.authorize();
    await f.setPolicy({ ...anthmPolicy, throttle: { perMinute: 2, perHour: 3 } });
    expect(await f.write("anthm-fr/songtrivia")).toHaveProperty("credential");
    expect(await f.write("anthm-fr/songtrivia")).toHaveProperty("credential");
    expect(await f.write("anthm-fr/songtrivia")).toMatchObject({ unavailable: expect.stringMatching(/^rate_limited: .* retry in \d+ seconds/) });
    // Reads are never throttled.
    expect(await f.read("anthm-fr/songtrivia")).toHaveProperty("credential");
    vi.setSystemTime(Date.now() + 61_000);
    expect(await f.write("anthm-fr/songtrivia")).toHaveProperty("credential");
    vi.setSystemTime(Date.now() + 61_000);
    expect(await f.write("anthm-fr/songtrivia")).toMatchObject({ unavailable: expect.stringContaining("rate_limited") });
    const throttle = new WriteThrottle();
    expect(throttle.take("u", { perMinute: 1, perHour: 10 }, 0)).toBeNull();
    expect(throttle.take("u", { perMinute: 1, perHour: 10 }, 30_000)).toBe(30);
    expect(throttle.take("v", { perMinute: 1, perHour: 10 }, 30_000)).toBeNull();
  });

  it("refreshes the 8-hour user token under one lock and rotates the stored refresh token", async () => {
    const f = await appFixture();
    await f.authorize();
    const first = f.current();
    expect((await f.write("anthm-fr/songtrivia")).credential.token).toBe(first);
    // The hourly fence check at 6 hours still uses the first token.
    vi.setSystemTime(Date.now() + 6 * 3_600_000);
    await f.h.runJob("github-sync");
    expect(f.oauth.mock.calls.filter(([, body]) => body.grant_type === "refresh_token")).toHaveLength(0);
    // Within 5 minutes of the 8-hour expiry, two concurrent writes share one refresh.
    vi.setSystemTime(Date.now() + 3_600_000 + 56 * 60_000);
    const [a, b] = await Promise.all([f.write("anthm-fr/songtrivia"), f.write("anthm-fr/anthm-fr")]);
    expect(a.credential.token).toBe(token("ghu", 2));
    expect(b.credential.token).toBe(token("ghu", 2));
    expect(f.oauth.mock.calls.filter(([, body]) => body.grant_type === "refresh_token")).toHaveLength(1);
    expect(f.oauth).toHaveBeenLastCalledWith("/login/oauth/access_token", { client_id: "Iv23liAbcdef12", client_secret: "value-client-secret", grant_type: "refresh_token", refresh_token: token("ghr", 1) });
    expect(f.storeOwn).toHaveBeenLastCalledWith(token("ghr", 2), { companyId: "anthm", configPath: "userRefreshToken" });
  });

  it("revoke drill: after a revocation the next mint fails, writes are denied, reads continue", async () => {
    const f = await appFixture();
    await f.authorize();
    expect(await f.write("anthm-fr/songtrivia")).toHaveProperty("credential");
    // agent-owner revokes the App under GitHub Settings → Applications → Authorized GitHub Apps.
    // GitHub rejects every token it issued; the refresh token is dead too.
    f.github.revoked = true;
    vi.setSystemTime(Date.now() + 8 * 3_600_000);
    // The next mint (refresh) fails, so the hourly check fails closed and switches writes off.
    await f.h.runJob("github-sync");
    expect(f.oauth.mock.calls.filter(([, body]) => body.grant_type === "refresh_token")).toHaveLength(1);
    expect(f.h.activity).toContainEqual(expect.objectContaining({ message: "github.fence_violation", metadata: expect.objectContaining({
      writesDisabled: true, reason: expect.stringContaining("refused to refresh"),
    }) }));
    expect((await f.policy()).enabled).toBe(false);
    const denied = await f.write("anthm-fr/songtrivia");
    expect(denied).toMatchObject({ identity: "user", unavailable: expect.stringContaining("kill switch") });
    expect(denied).not.toHaveProperty("credential");
    // Reads continue on the App installation.
    expect(await f.read("anthm-fr/songtrivia")).toMatchObject({ identity: "bot", credential: { login: "anthm-agents[bot]" } });
    // Re-enabling does not help until someone authorizes again: the check fails and writes stay off.
    const again = await f.setPolicy(anthmPolicy);
    expect(again.fence).toMatchObject({ ok: false, reason: expect.stringContaining("Authorize the GitHub user again") });
    expect(again.policy.enabled).toBe(false);
    // Re-authorizing passes the fence; an administrator then turns writes back on.
    f.github.revoked = false;
    await f.authorize();
    expect(await f.write("anthm-fr/songtrivia")).toMatchObject({ unavailable: expect.stringContaining("kill switch") });
    expect((await f.setPolicy(anthmPolicy)).fence).toMatchObject({ ok: true });
    expect(await f.write("anthm-fr/songtrivia")).toMatchObject({ credential: { login: "agent-owner" } });
  });

  it("revoke in Paperclip forgets the token, overwrites the stored refresh token and switches writes off", async () => {
    const f = await appFixture();
    await f.authorize();
    const revoked = await f.action("user-authorization.revoke");
    expect(revoked.authorization.needsReauthorization).toMatch(/revoked/);
    expect(f.github.refresh).toBe("revoked");
    expect((await f.policy()).enabled).toBe(false);
    expect(await f.write("anthm-fr/songtrivia")).toMatchObject({ unavailable: expect.stringContaining("kill switch") });
    expect(await f.read("anthm-fr/songtrivia")).toHaveProperty("credential");
  });

  it.each([
    ["an extra repository", (g: any) => { g.installationRepos.push("Anthm-FR/spotzic"); }, /extra: anthm-fr\/spotzic/],
    ["a missing repository", (g: any) => { g.installationRepos.pop(); }, /missing: anthm-fr\/nextdle/],
    ["all repositories selected", (g: any) => { g.installation.repository_selection = "all"; }, /all repositories/],
    ["statuses write", (g: any) => { g.installation.permissions.statuses = "write"; }, /statuses write/],
    ["workflows write that was not approved", (g: any) => { g.installation.permissions.workflows = "write"; }, /workflows: write \(approved none\)/],
    ["administration", (g: any) => { g.installation.permissions.administration = "read"; }, /administration/],
    ["an App account permission (SSH keys)", (g: any) => { g.appPermissions.git_ssh_keys = "write"; }, /App permissions differ: git_ssh_keys: write/],
  ])("drift check: %s turns writes off", async (_label, drift, reason) => {
    const f = await appFixture();
    await f.authorize();
    drift(f.github);
    vi.setSystemTime(Date.now() + 61 * 60_000);
    await f.h.runJob("github-sync");
    expect((await f.policy()).enabled).toBe(false);
    const status = await f.h.performAction<any>("user-authorization.status", { companyId: "anthm" }, actors("anthm").member);
    expect(status.authorization.fence).toMatchObject({ ok: false, reason: expect.stringMatching(reason) });
    expect(f.h.activity).toContainEqual(expect.objectContaining({ message: "github.fence_violation" }));
    expect(await f.write("anthm-fr/songtrivia")).toMatchObject({ unavailable: expect.any(String) });
    expect(await f.read("anthm-fr/songtrivia")).toHaveProperty("credential");
  });

  it("checks the fence at most hourly and refuses writes when the last check is stale", async () => {
    const f = await appFixture();
    await f.authorize();
    const calls = () => f.request.mock.calls.filter(([path]) => path === "/user").length;
    const before = calls();
    await f.h.runJob("github-sync");
    expect(calls()).toBe(before);
    vi.setSystemTime(Date.now() + 3 * 3_600_000 + 60_000);
    expect(await f.write("anthm-fr/songtrivia")).toMatchObject({ unavailable: expect.stringContaining("out of date") });
    await f.h.runJob("github-sync");
    expect(calls()).toBe(before + 1);
    expect(await f.write("anthm-fr/songtrivia")).toHaveProperty("credential");
  });

  it("never falls back to the App bot for a write", async () => {
    const f = await appFixture();
    await expect(f.setPolicy({ ...anthmPolicy, missingUserConnection: "use_bot" })).rejects.toThrow(/never falls back/);
    await f.setPolicy(anthmPolicy);
    // Not authorized yet, with and without the fallback flag: no credential at all.
    for (const extra of [{}, { fallback: true }]) {
      const decision = await f.write("anthm-fr/songtrivia", extra);
      expect(decision).toMatchObject({ identity: "user", unavailable: expect.stringContaining("Authorize the GitHub user") });
      expect(decision).not.toHaveProperty("credential");
    }
    expect(f.scoped).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), expect.objectContaining({ contents: "write" }), expect.anything());
  });

  it("signs only the authorized user's commits, never tags, verifiable with ssh-keygen", async () => {
    const f = await appFixture();
    await f.authorize();
    const committer = `agent-owner <${USER_ID}+agent-owner@users.noreply.github.com> ${Math.floor(Date.now() / 1000)} +0000`;
    const commit = `tree ${"4b825dc642cb6eb9a060e54bf8d69288fbee4904"}\nauthor ${committer}\ncommitter ${committer}\n\nWork\n`;
    const signed = await f.sign(commit);
    expect(signed).toMatchObject({ signature: expect.stringMatching(/^-----BEGIN SSH SIGNATURE-----\n/), keyFingerprint: parseSshSigningKey(f.signing).fingerprint });
    expect(await f.sign(`object ${"a".repeat(40)}\ntype commit\ntag v1\ntagger ${committer}\n\nv1\n`)).toMatchObject({ unavailable: expect.stringContaining("not tags") });
    expect(await f.sign(commit.replace(`committer ${committer}`, `committer Mallory <m@example.test> ${Math.floor(Date.now() / 1000)} +0000`))).toMatchObject({ unavailable: expect.stringContaining("agent-owner") });
    expect(await f.sign("not a git object")).toMatchObject({ unavailable: expect.any(String) });
    let keygen = true;
    try { execFileSync("ssh-keygen", ["-?"], { stdio: "ignore" }); } catch (error: any) { keygen = error?.code !== "ENOENT"; }
    if (!keygen) return;
    const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-sshsig-"));
    try {
      writeFileSync(path.join(dir, "allowed"), `agent-owner ${parseSshSigningKey(f.signing).publicKey}\n`);
      writeFileSync(path.join(dir, "sig"), signed.signature);
      const out = execFileSync("ssh-keygen", ["-Y", "verify", "-f", path.join(dir, "allowed"), "-I", "agent-owner", "-n", "git", "-s", path.join(dir, "sig")], { input: commit, encoding: "utf8" });
      expect(out).toContain('Good "git" signature for agent-owner');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("pauses writes on a network failure without switching them off, and resumes after a good check", async () => {
    const f = await appFixture();
    await f.authorize();
    f.github.unreachable = true;
    vi.setSystemTime(Date.now() + 61 * 60_000);
    await f.h.runJob("github-sync");
    expect((await f.policy()).enabled).toBe(true);
    expect(f.h.activity.map(entry => entry.message)).not.toContain("github.fence_violation");
    expect(await f.write("anthm-fr/songtrivia")).toMatchObject({ unavailable: expect.stringContaining("could not be reached") });
    f.github.unreachable = false;
    expect((await f.action("user-authorization.check")).fence).toMatchObject({ ok: true });
    expect(await f.write("anthm-fr/songtrivia")).toHaveProperty("credential");
  });

  it("discards a refresh that was in flight when the authorization was revoked", async () => {
    const f = await appFixture();
    await f.authorize();
    vi.setSystemTime(Date.now() + 6 * 3_600_000);
    await f.h.runJob("github-sync");
    let release!: () => void;
    f.github.refreshGate = new Promise<void>(resolve => { release = resolve; });
    vi.setSystemTime(Date.now() + 3_600_000 + 56 * 60_000);
    const pending = f.write("anthm-fr/songtrivia");
    await vi.waitFor(() => expect(f.oauth.mock.calls.some(([, body]) => body.grant_type === "refresh_token")).toBe(true));
    const revoking = f.action("user-authorization.revoke");
    release();
    await revoking;
    expect(await pending).toMatchObject({ unavailable: expect.stringContaining("revoked") });
    // The revocation stands: the refresh token stays overwritten, no token is cached and writes are off.
    expect(f.github.refresh).toBe("revoked");
    expect(await f.write("anthm-fr/songtrivia")).toMatchObject({ unavailable: expect.stringContaining("kill switch") });
  });

  it("routes the plugin's own writes through the same gates and records them for the digest", async () => {
    const f = await appFixture();
    await f.authorize();
    const tool = (repository: string) => f.h.executeTool<any>("github_comment", { repository, number: 1, body: "Refs: ANT-1" }, { companyId: "anthm", agentId: "agent-1", projectId: "p1", runId: "run-1" });
    expect((await tool("Anthm-FR/songtrivia")).error).toBeUndefined();
    expect(f.request).toHaveBeenCalledWith("/repos/Anthm-FR/songtrivia/issues/1/comments", f.current(), { body: "Refs: ANT-1" }, "POST");
    expect(f.h.activity).toContainEqual(expect.objectContaining({ message: "github.user_identity_write", metadata: expect.objectContaining({
      repository: "anthm-fr/songtrivia", action: "comment", source: "tool", agentId: "agent-1", runId: "run-1", login: "agent-owner",
    }) }));
    expect((await tool("Anthm-FR/linkzic")).error).toMatch(/allowlist/);
    expect(f.h.activity).toContainEqual(expect.objectContaining({ message: "github.write_identity_denied" }));
    expect(JSON.stringify(f.h.activity)).not.toMatch(/gh[urs]_/);
  });
});

// ---------------------------------------------------------------------------
// Security review, round 2: each test is an attack the previous code let through.
// ---------------------------------------------------------------------------

describe("security review round 2 (attack regressions)", () => {
  const me = () => `agent-owner <${USER_ID}+agent-owner@users.noreply.github.com> ${Math.floor(Date.now() / 1000)} +0000`;
  const at = (offsetSeconds: number) => `agent-owner <${USER_ID}+agent-owner@users.noreply.github.com> ${Math.floor(Date.now() / 1000) + offsetSeconds} +0000`;
  const TREE = `tree ${"4b825dc642cb6eb9a060e54bf8d69288fbee4904"}`;
  const PARENT = `parent ${"1".repeat(40)}`;

  it("F5: signs only a strictly formed commit written now by the user, never a crafted payload", async () => {
    const f = await appFixture();
    await f.authorize();
    const good = `${TREE}\n${PARENT}\nauthor ${me()}\ncommitter ${me()}\n\nWork\n`;
    expect(await f.sign(good)).toHaveProperty("signature");
    expect(await f.sign(`${TREE}\n${PARENT}\n${PARENT.replace("1", "2")}\nauthor ${at(-86_400)}\ncommitter ${me()}\nencoding UTF-8\n\nMerge, amended a day later\n`)).toHaveProperty("signature");
    const attacks: Array<[string, string]> = [
      ["another author", `${TREE}\nauthor Mallory <m@example.test> ${Math.floor(Date.now() / 1000)} +0000\ncommitter ${me()}\n\nx\n`],
      ["no author", `${TREE}\ncommitter ${me()}\n\nx\n`],
      ["an unknown header", `${TREE}\nauthor ${me()}\ncommitter ${me()}\nx-evil arbitrary bytes\n\nx\n`],
      ["an existing gpgsig", `${TREE}\nauthor ${me()}\ncommitter ${me()}\ngpgsig -----BEGIN SSH SIGNATURE-----\n U1NIU0lH\n -----END SSH SIGNATURE-----\n\nx\n`],
      ["a mergetag", `${TREE}\n${PARENT}\nauthor ${me()}\ncommitter ${me()}\nmergetag object ${"a".repeat(40)}\n type commit\n tag v1\n\nx\n`],
      ["two trees", `${TREE}\n${TREE}\nauthor ${me()}\ncommitter ${me()}\n\nx\n`],
      ["a malformed parent", `${TREE}\nparent zzz\nauthor ${me()}\ncommitter ${me()}\n\nx\n`],
      ["mixed SHA-1 and SHA-256 IDs", `${TREE}\nparent ${"2".repeat(64)}\nauthor ${me()}\ncommitter ${me()}\n\nx\n`],
      ["headers out of order", `${TREE}\ncommitter ${me()}\nauthor ${me()}\n\nx\n`],
      ["a backdated committer", `${TREE}\nauthor ${at(-86_400)}\ncommitter ${at(-86_400)}\n\nx\n`],
      ["a future committer", `${TREE}\nauthor ${me()}\ncommitter ${at(3_600)}\n\nx\n`],
      ["an author older than 30 days", `${TREE}\nauthor ${at(-31 * 86_400)}\ncommitter ${me()}\n\nx\n`],
      ["a bad time zone", `${TREE}\nauthor ${me().replace("+0000", "+9900")}\ncommitter ${me()}\n\nx\n`],
      ["a NUL byte", `${TREE}\nauthor ${me()}\ncommitter ${me()}\n\nx\u0000y\n`],
      ["CRLF headers", `${TREE}\r\nauthor ${me()}\r\ncommitter ${me()}\r\n\r\nx\r\n`],
      ["no message separator", `${TREE}\nauthor ${me()}\ncommitter ${me()}\n`],
      ["a tag of an unknown type", `object ${"a".repeat(40)}\ntype evil\ntag v1\ntagger ${me()}\n\nv1\n`],
      ["a tag by someone else", `object ${"a".repeat(40)}\ntype commit\ntag v1\ntagger Mallory <m@example.test> ${Math.floor(Date.now() / 1000)} +0000\n\nv1\n`],
      ["a tag with a malformed name", `object ${"a".repeat(40)}\ntype commit\ntag ../../evil\ntagger ${me()}\n\nv1\n`],
      ["not a git object", "SSH signatures are only for git objects\n\nx\n"],
    ];
    for (const [label, payload] of attacks) expect(await f.sign(payload), label).toMatchObject({ unavailable: expect.stringContaining("refused because") });
    const invalidUtf8 = Buffer.concat([Buffer.from(`${TREE}\nauthor ${me()}\ncommitter ${me()}\n\n`), Buffer.from([0xff, 0xfe, 0x0a])]);
    expect(await f.h.performAction<any>("repository-sign-commit", { companyId: "anthm", payload: invalidUtf8.toString("base64") }, actors("anthm").server))
      .toMatchObject({ unavailable: expect.stringContaining("UTF-8") });
  });

  it("F6: an admin merge needs the full head SHA, compared exactly", async () => {
    const f = await appFixture();
    await f.authorize();
    const merge = (expectedHeadSha: string) => f.write("anthm-fr/songtrivia", { action: "pullRequest", privileged: ["adminMerge"], pullRequest: 7, expectedHeadSha });
    for (const sha of ["aaaaaaa", "a".repeat(39), `${"a".repeat(40)}0`, "a".repeat(63)]) {
      const decision = await merge(sha);
      expect(decision, sha).toMatchObject({ identity: "user", unavailable: expect.stringContaining("full expected head commit SHA") });
      expect(decision, sha).not.toHaveProperty("credential");
    }
    expect(await merge("A".repeat(40))).toMatchObject({ credential: { login: "agent-owner" } });
    expect(await merge("a".repeat(40))).toMatchObject({ credential: { login: "agent-owner" } });
  });

  it("F7: never writes personal Projects with a personal token while the company writes as its App user", async () => {
    const f = await appFixture();
    await f.authorize();
    const graphql = vi.spyOn(f.client, "graphql").mockImplementation(async () => ({
      user: { id: "U_1", projectsV2: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }, createProjectV2: { projectV2: { id: "PVT_1" } },
    }) as any);
    await expect(f.h.performAction("manage-project", { companyId: "anthm", op: "create", owner: "agent-owner", ownerType: "User", title: "Exfil", requestId: "request-0001" }, actors("anthm").admin))
      .rejects.toThrow(/Personal Projects writes are off/);
    expect(graphql).not.toHaveBeenCalled();
    // Reads of a personal Project still use the board's own token.
    await f.h.performAction("manage-project", { companyId: "anthm", op: "list", owner: "agent-owner", ownerType: "User" }, actors("anthm").admin);
    expect(graphql).toHaveBeenCalledWith("value-pat", expect.stringContaining("projectsV2"), expect.anything());
  });

  it("F9: fails the fence and admin merges closed when GitHub has more pages than Paperclip reads", async () => {
    const f = await appFixture();
    await f.authorize();
    const original = f.request.getMockImplementation()!;
    // Page 11 of the installation's repositories adds a repository outside the fence.
    f.request.mockImplementation(async (path: string, ...rest: any[]) => {
      const page = /^\/user\/installations\/101\/repositories\?per_page=100&page=(\d+)$/.exec(path);
      if (page) {
        const number = Number(page[1]);
        const repositories = number === 1 ? names.map(name => ({ full_name: `Anthm-FR/${name}` })) : number === 11 ? [{ full_name: "Anthm-FR/spotzic" }] : [];
        return { data: { repositories } as any, next: number < 11 };
      }
      return (original as any)(path, ...rest);
    });
    vi.setSystemTime(Date.now() + 61 * 60_000);
    await f.h.runJob("github-sync");
    expect((await f.policy()).enabled).toBe(false);
    const status = await f.h.performAction<any>("user-authorization.status", { companyId: "anthm" }, actors("anthm").member);
    expect(status.authorization.fence).toMatchObject({ ok: false, reason: expect.stringContaining("more than 10 pages") });
    expect(f.h.activity).toContainEqual(expect.objectContaining({ message: "github.fence_violation" }));
    // Check runs: a merge guard that cannot read every run refuses.
    f.request.mockImplementation(async (path: string, ...rest: any[]) => path.includes("/check-runs?")
      ? { data: { check_runs: f.github.checkRuns } as any, next: true }
      : (original as any)(path, ...rest));
    f.github.installationRepos = names.map(name => `Anthm-FR/${name}`);
    expect((await f.setPolicy(anthmPolicy)).fence).toMatchObject({ ok: true });
    expect(await f.write("anthm-fr/songtrivia", { action: "pullRequest", privileged: ["adminMerge"], pullRequest: 7, expectedHeadSha: "a".repeat(40) }))
      .toMatchObject({ unavailable: expect.stringContaining("more than 10 pages of check runs") });
  });

  it("R8 (round 2b): reads every page of commit statuses and branch rules for an admin merge, or refuses", async () => {
    const f = await appFixture();
    await f.authorize();
    const original = f.request.getMockImplementation()!;
    const merge = () => f.write("anthm-fr/songtrivia", { action: "pullRequest", privileged: ["adminMerge"], pullRequest: 7, expectedHeadSha: "a".repeat(40) });
    // A required status reported on page 2 counts: failing it blocks the merge, passing it lets the merge through.
    f.github.rules = [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "security/scan" }] } }];
    f.github.statuses = Array.from({ length: 100 }, (_, n) => ({ context: `ci/${n}`, state: "success" }));
    let scan = "failure";
    f.request.mockImplementation(async (path: string, ...rest: any[]) => path === `/repos/anthm-fr/songtrivia/commits/${"a".repeat(40)}/status?per_page=100&page=2`
      ? { data: { statuses: [{ context: "security/scan", state: scan }] } as any, next: false }
      : path.startsWith(`/repos/anthm-fr/songtrivia/commits/${"a".repeat(40)}/status`) ? { data: { statuses: f.github.statuses } as any, next: true }
      : (original as any)(path, ...rest));
    expect(await merge()).toMatchObject({ unavailable: expect.stringContaining("security/scan") });
    scan = "success";
    expect(await merge()).toMatchObject({ credential: { login: "agent-owner" } });
    // More pages of rules than Paperclip reads: refused.
    f.request.mockImplementation(async (path: string, ...rest: any[]) => path.startsWith("/repos/anthm-fr/songtrivia/rules/branches/main?")
      ? { data: [] as any, next: true } : (original as any)(path, ...rest));
    expect(await merge()).toMatchObject({ unavailable: expect.stringContaining("more than 10 pages of branch rules") });
  });

  it.each([
    ["a 30-day access token", { expires_in: 30 * 86_400 }, /longer than 8 hours/],
    ["no refresh token expiry", { refresh_token_expires_in: undefined }, /Expire user authorization tokens/],
    ["a refresh token without a valid expiry", { refresh_token_expires_in: 0 }, /refresh token without a valid expiry/],
  ] as const)("F10: refuses an authorization with %s", async (_label, override, reason) => {
    const f = await appFixture();
    const original = f.oauth.getMockImplementation()!;
    f.oauth.mockImplementation(async (path, body) => {
      const data = await original(path, body);
      return path === "/login/device/code" ? data : { ...data, ...override };
    });
    await f.setPolicy(anthmPolicy);
    await f.action("user-authorization.start");
    vi.setSystemTime(Date.now() + 6_000);
    await expect(f.action("user-authorization.poll")).rejects.toThrow(reason);
    expect(f.storeOwn).not.toHaveBeenCalled();
  });

  it("F10: refuses a refreshed token that lives longer than 8 hours", async () => {
    const f = await appFixture();
    await f.authorize();
    const original = f.oauth.getMockImplementation()!;
    f.oauth.mockImplementation(async (path, body) => {
      const data = await original(path, body);
      return body.grant_type === "refresh_token" ? { ...data, expires_in: 90 * 86_400 } : data;
    });
    vi.setSystemTime(Date.now() + 6 * 3_600_000);
    await f.h.runJob("github-sync");
    vi.setSystemTime(Date.now() + 3_600_000 + 56 * 60_000);
    const decision = await f.write("anthm-fr/songtrivia");
    expect(decision).toMatchObject({ unavailable: expect.stringContaining("longer than 8 hours") });
    expect(decision).not.toHaveProperty("credential");
  });

  it("F10: a refresh that rotates the refresh token can never overwrite a revocation", async () => {
    const f = await appFixture();
    await f.authorize();
    vi.setSystemTime(Date.now() + 6 * 3_600_000);
    await f.h.runJob("github-sync");
    // GitHub has rotated the refresh token; storing the new one is slow.
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.storeOwn.mockImplementation(async (value: string) => { if (value !== "revoked") await gate; f.github.refresh = value; });
    vi.setSystemTime(Date.now() + 3_600_000 + 56 * 60_000);
    const pending = f.write("anthm-fr/songtrivia");
    await vi.waitFor(() => expect(f.storeOwn).toHaveBeenCalledWith(token("ghr", 2), expect.anything()));
    // The administrator revokes while the rotation is being stored.
    const revoking = f.action("user-authorization.revoke");
    await new Promise(resolve => setTimeout(resolve, 50));
    release();
    await revoking;
    // The revocation stands: the stored refresh token is overwritten and nothing is handed out.
    expect(f.github.refresh).toBe("revoked");
    expect(await pending).toMatchObject({ unavailable: expect.stringContaining("revoked") });
    expect(await f.write("anthm-fr/songtrivia")).toMatchObject({ unavailable: expect.stringContaining("kill switch") });
    expect((await f.h.performAction<any>("user-authorization.status", { companyId: "anthm" }, actors("anthm").member)).authorization.needsReauthorization).toMatch(/revoked/);
  });
});

describe("I-RO: installation tokens of an App-user company's App only read", () => {
  const rsaPem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs1" }).toString();
  const repo = { id: 22, name: "songtrivia", fullName: "Anthm-FR/songtrivia", url: "https://github.com/Anthm-FR/songtrivia", installationId: 101, owner: "Anthm-FR", ownerId: 1, private: true };
  const fence = names.map(name => `anthm-fr/${name}`);
  const reads = { metadata: "read", contents: "read", issues: "read", pull_requests: "read", actions: "read", checks: "read", statuses: "read" };
  /** A client whose installation-token requests are recorded instead of sent. */
  function recordingClient(appUserFence: (appId: string) => Promise<string[] | null>) {
    const client = new GitHubClient((async () => { throw new Error("GitHub network is blocked in tests."); }) as unknown as typeof fetch);
    const bodies: Array<{ path: string; body: any }> = [];
    vi.spyOn(client, "request").mockImplementation(async (path: string, _auth?: string, body?: unknown) => {
      bodies.push({ path, body });
      return { data: path.endsWith("/access_tokens") ? { token: "ghs_minted" } : { number: 1, id: 1, title: "x", state: "open" } as any, next: false };
    });
    client.appUserFence = appUserFence;
    return { client, bodies };
  }

  it("allows only an explicit read-only subset naming one repository, or fenced repositories by name", () => {
    expect(() => assertReadOnlyInstallationToken({ metadata: "read", contents: "read", organization_projects: "read" }, [22], fence)).not.toThrow();
    expect(() => assertReadOnlyInstallationToken({ metadata: "read", organization_projects: "read" }, ["Anthm-FR/songtrivia", "Anthm-FR/linkzic"], fence)).not.toThrow();
    expect(() => assertReadOnlyInstallationToken({ metadata: "read", contents: "write" }, [22], fence)).toThrow(/contents write is not read-only/);
    expect(() => assertReadOnlyInstallationToken({ issues: "admin" }, [22], fence)).toThrow(/not read-only/);
    expect(() => assertReadOnlyInstallationToken({}, [22], fence)).toThrow(/explicit read-only permission subset/);
    expect(() => assertReadOnlyInstallationToken(undefined, [22], fence)).toThrow(/explicit read-only permission subset/);
    expect(() => assertReadOnlyInstallationToken({ metadata: "read", administration: "read" }, [22], fence)).toThrow(/not a read scope/);
    // Never installation-wide, never several repositories by ID, never outside the fence.
    expect(() => assertReadOnlyInstallationToken({ metadata: "read" }, [], fence)).toThrow(/never the whole installation/);
    expect(() => assertReadOnlyInstallationToken({ metadata: "read", issues: "read" }, [22, 23], fence)).toThrow(/names exactly one/);
    expect(() => assertReadOnlyInstallationToken({ metadata: "read" }, ["Anthm-FR/spotzic"], fence)).toThrow(/anthm-fr\/spotzic|Anthm-FR\/spotzic is outside/);
    expect(() => assertReadOnlyInstallationToken({ metadata: "read" }, ["Anthm-FR/songtrivia", "vllnt/songtrivia"], [...fence, "vllnt/songtrivia"])).toThrow(/one installation owner/);
    expect(() => assertReadOnlyInstallationToken({ metadata: "read" }, [22, "Anthm-FR/songtrivia"], fence)).toThrow(/mixes/);
  });

  it("(a) refuses write scopes, a missing subset and unscoped tokens before calling GitHub; (b) other companies' Apps are unchanged", async () => {
    const { client, bodies } = recordingClient(async id => id === APP ? fence : null);
    for (const [label, mint] of [
      ["a write scope", () => client.scopedToken(APP, rsaPem, 101, { metadata: "read", contents: "write" }, 22)],
      ["no subset", () => client.scopedToken(APP, rsaPem, 101, {}, 22)],
      ["the whole installation", () => client.scopedToken(APP, rsaPem, 101, { metadata: "read", issues: "read" })],
      ["two repositories by ID", () => client.scopedToken(APP, rsaPem, 101, { metadata: "read", issues: "write" }, [22, 23])],
      ["an issues write token", () => client.token(APP, rsaPem, 101, 22, true)],
      ["sync write-back without the App user's token", () => client.createIssue(APP, rsaPem, { ...repo, permissions } as never, { title: "x", body: "y" })],
      ["sync edit without the App user's token", () => client.updateIssue(APP, rsaPem, { ...repo, permissions } as never, 1, { title: "x" })],
    ] as const) await expect(mint(), label).rejects.toThrow(/Refused to mint/);
    expect(bodies).toEqual([]);
    expect(await client.scopedToken(APP, rsaPem, 101, { metadata: "read", contents: "read", pull_requests: "read" }, 22)).toBe("ghs_minted");
    expect(await client.scopedToken(APP, rsaPem, 101, { metadata: "read", organization_projects: "read" }, ["Anthm-FR/songtrivia", "Anthm-FR/linkzic"])).toBe("ghs_minted");
    expect(bodies).toEqual([
      { path: "/app/installations/101/access_tokens", body: { permissions: { metadata: "read", contents: "read", pull_requests: "read" }, repository_ids: [22] } },
      { path: "/app/installations/101/access_tokens", body: { permissions: { metadata: "read", organization_projects: "read" }, repositories: ["songtrivia", "linkzic"] } },
    ]);
    // (b) An App whose company does not write as its App user keeps its write tokens.
    expect(await client.scopedToken("999", rsaPem, 101, { metadata: "read", contents: "write" }, 22)).toBe("ghs_minted");
    expect(await client.createIssue("999", rsaPem, { ...repo, permissions } as never, { title: "x", body: "y" }).catch(error => error)).not.toBeInstanceOf(Error);
    // When Paperclip cannot tell, the App counts as an App-user company with an empty fence.
    client.appUserFence = async () => { throw new Error("state unavailable"); };
    await expect(client.scopedToken("999", rsaPem, 101, { contents: "write" }, 22)).rejects.toThrow(/not read-only/);
    await expect(client.scopedToken("999", rsaPem, 101, { metadata: "read" }, ["Anthm-FR/songtrivia"])).rejects.toThrow(/outside the company's GitHub fence/);
  });

  it("lists only the fenced repositories of an App-user company's installation", async () => {
    const { client, bodies } = recordingClient(async () => ["anthm-fr/songtrivia", "anthm-fr/linkzic"]);
    vi.mocked(client.request).mockImplementation(async (path: string, _auth?: string, body?: unknown) => {
      bodies.push({ path, body });
      if (path === "/app") return { data: { id: Number(APP), slug: "anthm-agents", name: "anthm-agents", permissions } as any, next: false };
      if (path.startsWith("/app/installations?")) return { data: [{ id: 101, account: { login: "Anthm-FR", id: 1, type: "Organization" }, permissions }, { id: 202, account: { login: "other", id: 2, type: "Organization" }, permissions }] as any, next: false };
      if (path.endsWith("/access_tokens")) return { data: { token: "ghs_list" } as any, next: false };
      if (path.startsWith("/installation/repositories?")) return { data: { repositories: [{ id: 22, name: "songtrivia", html_url: "https://github.com/Anthm-FR/songtrivia", private: true }] } as any, next: false };
      throw new Error(`Unexpected ${path}`);
    });
    const catalog = await client.catalog(APP, rsaPem, [{ id: 1, login: "Anthm-FR" }, { id: 2, login: "other" }]);
    expect(catalog.repositories.map(entry => entry.fullName)).toEqual(["Anthm-FR/songtrivia"]);
    // One listing token, for installation 101 only, scoped to the fence by name; the other owner's installation is not listed.
    expect(bodies.filter(entry => entry.path.endsWith("/access_tokens"))).toEqual([
      { path: "/app/installations/101/access_tokens", body: { permissions: { metadata: "read" }, repositories: ["songtrivia", "linkzic"] } },
    ]);
  });

  it("(a) the worker marks only App-user companies' Apps, and every token it mints for them is read-only and fenced", async () => {
    const f = await appFixture();
    await f.authorize();
    expect(await f.client.appUserFence(APP)).toEqual(fence);
    expect(await f.client.appUserFence("424242")).toBeNull();
    const resolve = f.resolve.getMockImplementation()!;
    f.resolve.mockImplementation(async (ref: any, options: any) => ref.secretId === "a-key" ? rsaPem : (resolve as any)(ref, options));
    vi.setSystemTime(Date.now() + 61_000); // the cached App key expires
    f.scoped.mockRestore();
    const minted: any[] = [];
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (path: string, ...rest: any[]) => {
      if (/^\/app\/installations\/\d+\/access_tokens$/.test(path)) { minted.push(rest[1]); return { data: { token: token("ghs", 7) } as any, next: false }; }
      if (path.startsWith("/repos/Anthm-FR/songtrivia/issues?")) return { data: [] as any, next: false };
      if (path === "/repos/Anthm-FR/songtrivia/issues/1/comments") return { data: { id: 7 } as any, next: false };
      if (path === "/graphql") return { data: { data: { organization: { id: "O", projectsV2: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } as any, next: false };
      return (original as any)(path, ...rest);
    });
    // Managed reads: one named repository by ID; a read naming none gets the fenced repositories by name.
    expect(await f.read("Anthm-FR/linkzic")).toMatchObject({ identity: "bot", credential: { token: token("ghs", 7) } });
    expect(await f.read(null)).toMatchObject({ identity: "bot", credential: { token: token("ghs", 7) } });
    // The issue mirror reads one repository.
    await f.client.issues(APP, rsaPem, { ...repo, permissions } as never, 1, "open");
    // A board organization Project read names the fenced repositories, never the whole installation.
    await f.h.performAction("manage-project", { companyId: "anthm", op: "list", owner: "Anthm-FR" }, actors("anthm").admin);
    // Writes use the App user's token: the board, an agent tool and sync write-back mint nothing.
    await f.h.performAction("manage-repository", { companyId: "anthm", repositoryId: 22, op: "comment", number: 1, body: "Refs: ANT-1", requestId: "request-0002" }, actors("anthm").admin);
    expect((await f.h.executeTool<any>("github_comment", { repository: "Anthm-FR/songtrivia", number: 1, body: "Refs: ANT-1" }, { companyId: "anthm", agentId: "agent-1", projectId: "p1", runId: "run-1" })).error).toBeUndefined();
    // Without the App user's token, nothing can fall back to an App write.
    await expect(f.client.createIssue(APP, rsaPem, { ...repo, permissions } as never, { title: "x", body: "y" })).rejects.toThrow(/Refused to mint/);
    await expect(new RepositoryManager(f.client, { id: APP, pem: rsaPem }, { ...repo, permissions } as never).run("comment", { number: 1, body: "x" })).rejects.toThrow(/Refused to mint/);
    expect(minted).toEqual([
      { permissions: { ...reads, organization_projects: "read" }, repository_ids: [24] },
      { permissions: { ...reads, organization_projects: "read" }, repositories: ["anthm-fr", "linkzic", "nextdle", "songtrivia", "wordzic"] },
      { permissions: { metadata: "read", issues: "read" }, repository_ids: [22] },
      { permissions: { organization_projects: "read", metadata: "read", issues: "read", pull_requests: "read", contents: "read" }, repositories: ["anthm-fr", "linkzic", "nextdle", "songtrivia", "wordzic"] },
    ]);
    for (const body of minted) expect(JSON.stringify(body.permissions)).not.toMatch(/write|admin/);
  });

  it("(c) a company that switches to its App user loses every App write at once, and its cached catalog is dropped", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { admin, server } = actors("vllnt");
    const h = createTestHarness({ manifest });
    vi.spyOn(h.ctx.config, "get").mockImplementation(async company => company === "vllnt" ? { appId: APP, privateKey: secretRef("v-key") } : {});
    vi.spyOn(h.ctx.secrets, "resolve").mockImplementation(async () => rsaPem);
    const client = new GitHubClient((async () => { throw new Error("GitHub network is blocked in tests."); }) as unknown as typeof fetch);
    const vllntRepo = { id: 22, name: "paperclip", fullName: "vllnt/paperclip", url: "https://github.com/vllnt/paperclip", installationId: 101, owner: "vllnt", ownerId: 1, private: false,
      permissions: { contents: "write", pull_requests: "write", issues: "write" } };
    vi.spyOn(client, "verify").mockImplementation(async id => ({ id, slug: "vllnt-agents", name: "vllnt-agents" }));
    vi.spyOn(client, "hasInstallation").mockResolvedValue(true);
    const catalog = vi.spyOn(client, "catalog").mockImplementation(async id => ({ app: { id, slug: "vllnt-agents", name: "vllnt-agents" }, installations: [], repositories: [vllntRepo], warnings: [], truncated: false }));
    const minted: any[] = [];
    vi.spyOn(client, "request").mockImplementation(async (path: string, _auth?: string, body?: unknown) => {
      if (path.endsWith("/access_tokens")) { minted.push(body); return { data: { token: "ghs_app" } as any, next: false }; }
      if (path === "/users/vllnt-agents%5Bbot%5D") return { data: { id: 99 } as any, next: false };
      throw new Error(`Unexpected GitHub request ${path}`);
    });
    register(h.ctx, client);
    await h.performAction("company-app.connect", { companyId: "vllnt", appId: APP, privateKeySecretId: "v-key" }, admin);
    await h.ctx.state.set({ scopeKind: "company", scopeId: "vllnt", namespace: "connection", stateKey: "allowed-owners" }, [{ id: 1, login: "vllnt" }]);
    const decide = (params: Record<string, unknown>) => h.performAction<any>("repository-write-identity", { companyId: "vllnt", ...params }, server);
    // (b) Before: the App writes as itself (VLL-477 run mode, bot identity).
    await h.performAction("write-identity.set", { companyId: "vllnt", policy: { default: allBot } }, admin);
    expect(await decide({ repository: "vllnt/paperclip", access: "write", action: "comment", privileged: [] })).toMatchObject({ identity: "bot", credential: { token: "ghs_app" } });
    expect(minted.at(-1)).toMatchObject({ permissions: { contents: "write", pull_requests: "write", issues: "write" }, repository_ids: [22] });
    const catalogsBefore = catalog.mock.calls.length;
    // The switch: the next mint is checked against the new policy, and the cached catalog is dropped.
    await h.performAction("write-identity.set", { companyId: "vllnt", policy: {
      default: { commit: "user", push: "user", pullRequest: "user", comment: "user" }, userSource: "app", allowedRepositories: ["vllnt/paperclip"],
      userLogin: "agent-owner", installationPermissions: { contents: "write", metadata: "read" },
    } }, admin);
    const count = minted.length;
    await expect(client.scopedToken(APP, rsaPem, 101, { metadata: "read", contents: "write" }, 22)).rejects.toThrow(/Refused to mint/);
    await expect(client.createIssue(APP, rsaPem, vllntRepo as never, { title: "x", body: "y" })).rejects.toThrow(/Refused to mint/);
    // No App write and no user authorization yet: the write is refused, never a bot fallback.
    const write = await decide({ repository: "vllnt/paperclip", access: "write", action: "comment", privileged: [] });
    expect(write).toMatchObject({ identity: "user", unavailable: expect.stringContaining("Authorize the GitHub user") });
    expect(write).not.toHaveProperty("credential");
    // Reads now use a read-only token for one repository.
    expect(await decide({ repository: "vllnt/paperclip", access: "read", action: null, privileged: [] })).toMatchObject({ identity: "bot", credential: { token: "ghs_app" } });
    expect(catalog.mock.calls.length).toBeGreaterThan(catalogsBefore);
    expect(minted.slice(count)).toEqual([{ permissions: { metadata: "read", contents: "read", issues: "read", pull_requests: "read" }, repository_ids: [22] }]);
  });
});

// ---------------------------------------------------------------------------
// Security review, round 3: each test is an attack 45f8d6287 let through.
// ---------------------------------------------------------------------------

describe("security review round 3 (attack regressions)", () => {
  const rsaPem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs1" }).toString();
  const appUserPolicy = {
    default: { commit: "user", push: "user", pullRequest: "user", comment: "user" }, userSource: "app", allowedRepositories: ["vllnt/paperclip"],
    userLogin: "agent-owner", installationPermissions: { contents: "write", metadata: "read" },
  };
  /** A run-mode company (vllnt) whose App mints real write tokens; GitHub's token endpoints are recorded. */
  async function runModeCompany() {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { admin, server } = actors("vllnt");
    const h = createTestHarness({ manifest });
    vi.spyOn(h.ctx.config, "get").mockImplementation(async company => company === "vllnt" ? { appId: APP, privateKey: secretRef("v-key") } : {});
    vi.spyOn(h.ctx.secrets, "resolve").mockImplementation(async () => rsaPem);
    const client = new GitHubClient((async () => { throw new Error("GitHub network is blocked in tests."); }) as unknown as typeof fetch);
    const vllntRepo = { id: 22, name: "paperclip", fullName: "vllnt/paperclip", url: "https://github.com/vllnt/paperclip", installationId: 101, owner: "vllnt", ownerId: 1, private: false,
      permissions: { contents: "write", pull_requests: "write", issues: "write" } };
    vi.spyOn(client, "verify").mockImplementation(async id => ({ id, slug: "vllnt-agents", name: "vllnt-agents" }));
    vi.spyOn(client, "hasInstallation").mockResolvedValue(true);
    vi.spyOn(client, "catalog").mockImplementation(async id => ({ app: { id, slug: "vllnt-agents", name: "vllnt-agents" }, installations: [], repositories: [vllntRepo], warnings: [], truncated: false }));
    const gh = { minted: 0, mintGate: null as Promise<void> | null, minting: false, revoked: [] as string[] };
    vi.spyOn(client, "request").mockImplementation(async (path: string, auth?: string, _body?: unknown, method?: string) => {
      if (path.endsWith("/access_tokens")) {
        gh.minting = true;
        if (gh.mintGate) await gh.mintGate;
        gh.minted += 1;
        return { data: { token: `ghs_write_${gh.minted}` } as any, next: false };
      }
      if (path === "/installation/token" && method === "DELETE") { gh.revoked.push(auth!); return { data: null as any, next: false }; }
      if (path === "/users/vllnt-agents%5Bbot%5D") return { data: { id: 99 } as any, next: false };
      throw new Error(`Unexpected GitHub request ${method ?? "GET"} ${path}`);
    });
    register(h.ctx, client);
    await h.performAction("company-app.connect", { companyId: "vllnt", appId: APP, privateKeySecretId: "v-key" }, admin);
    await h.ctx.state.set({ scopeKind: "company", scopeId: "vllnt", namespace: "connection", stateKey: "allowed-owners" }, [{ id: 1, login: "vllnt" }]);
    await h.performAction("write-identity.set", { companyId: "vllnt", policy: { default: allBot } }, admin);
    const decide = (params: Record<string, unknown>) => h.performAction<any>("repository-write-identity", { companyId: "vllnt", ...params }, server);
    const switchToAppUser = () => h.performAction("write-identity.set", { companyId: "vllnt", policy: appUserPolicy }, admin);
    return { h, client, gh, decide, switchToAppUser };
  }

  it("M1: a write token GitHub mints while the company switches to its App user is revoked, never handed out", async () => {
    const f = await runModeCompany();
    let release!: () => void;
    f.gh.mintGate = new Promise<void>(resolve => { release = resolve; });
    const pending = f.decide({ repository: "vllnt/paperclip", access: "write", action: "comment", privileged: [] }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(f.gh.minting).toBe(true));
    await f.switchToAppUser();
    release();
    const decision = await pending;
    expect(JSON.stringify(decision instanceof Error ? decision.message : decision)).not.toContain("ghs_write_1");
    expect(f.gh.revoked).toEqual(["ghs_write_1"]);
  });

  it("M1: App write tokens minted before the switch to the App user are revoked at the switch", async () => {
    const f = await runModeCompany();
    expect(await f.decide({ repository: "vllnt/paperclip", access: "write", action: "comment", privileged: [] })).toMatchObject({ identity: "bot", credential: { token: "ghs_write_1" } });
    expect(f.gh.revoked).toEqual([]);
    await f.switchToAppUser();
    expect(f.gh.revoked).toEqual(["ghs_write_1"]);
  });

  it("m2: a device-flow poll GitHub answers after an administrator revoked does not restore the authorization", async () => {
    const f = await appFixture();
    await f.authorize();
    await f.action("user-authorization.revoke");
    await f.setPolicy(anthmPolicy);
    await f.action("user-authorization.start");
    vi.setSystemTime(Date.now() + 6_000);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = f.oauth.getMockImplementation()!;
    let polling = false;
    f.oauth.mockImplementation(async (path, body) => {
      if (body.grant_type === "urn:ietf:params:oauth:grant-type:device_code") { polling = true; await gate; }
      return (original as any)(path, body);
    });
    const poll = f.action("user-authorization.poll").catch((error: Error) => error);
    await vi.waitFor(() => expect(polling).toBe(true));
    await f.action("user-authorization.revoke");
    release();
    const result = await poll;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/revoked/);
    expect(f.github.refresh).toBe("revoked");
    expect((await f.h.performAction<any>("user-authorization.status", { companyId: "anthm" }, actors("anthm").member)).authorization.needsReauthorization).toMatch(/revoked/);
    await f.setPolicy(anthmPolicy);
    expect(await f.write("anthm-fr/songtrivia")).not.toHaveProperty("credential");
  });

  it("m3: after a revoke, a new authorization keeps writes off until an administrator turns them back on", async () => {
    const f = await appFixture();
    await f.authorize();
    await f.action("user-authorization.revoke");
    expect((await f.policy()).enabled).toBe(false);
    // Someone completes a new device flow without the administrator re-enabling writes.
    await f.action("user-authorization.start");
    vi.setSystemTime(Date.now() + 6_000);
    expect(await f.action("user-authorization.poll")).toMatchObject({ status: "authorized", fence: { ok: true } });
    expect(await f.write("anthm-fr/songtrivia")).toMatchObject({ unavailable: expect.stringContaining("kill switch") });
    expect(await f.write("anthm-fr/songtrivia")).not.toHaveProperty("credential");
    await f.setPolicy(anthmPolicy);
    expect(await f.write("anthm-fr/songtrivia")).toHaveProperty("credential");
  });

  it("m4: never signs a tag (a signed tag can name any object)", async () => {
    const f = await appFixture();
    await f.authorize();
    const me = `agent-owner <${USER_ID}+agent-owner@users.noreply.github.com> ${Math.floor(Date.now() / 1000)} +0000`;
    for (const type of ["commit", "tree", "blob", "tag"]) {
      const result = await f.sign(`object ${"a".repeat(40)}\ntype ${type}\ntag v1.0.0\ntagger ${me}\n\nv1\n`);
      expect(result, type).toMatchObject({ unavailable: expect.stringContaining("not tags") });
      expect(result, type).not.toHaveProperty("signature");
    }
  });

  it("m6: a fenced name that now points at another repository (deleted and recreated) turns writes off", async () => {
    const f = await appFixture();
    names.forEach((name, index) => { f.github.installationRepoIds[`anthm-fr/${name}`] = 22 + index; });
    await f.authorize();
    expect(await f.write("anthm-fr/songtrivia")).toHaveProperty("credential");
    // songtrivia is deleted and another repository is created under the same name: GitHub (user and App) reports a new ID.
    f.github.installationRepoIds["anthm-fr/songtrivia"] = 9_001;
    vi.mocked(f.client.catalog).mockImplementation(async id => ({ app: { id, slug: "anthm-agents", name: "anthm-agents", permissions: f.github.appPermissions },
      installations: [{ id: 101, login: "Anthm-FR", accountId: 1, accountType: "Organization" as const, suspended: false, permissions }],
      repositories: repos.map(repo => repo.name === "songtrivia" ? { ...repo, id: 9_001 } : repo), warnings: [], truncated: false }));
    vi.setSystemTime(Date.now() + 61 * 60_000);
    await f.h.runJob("github-sync");
    expect((await f.policy()).enabled).toBe(false);
    const status = await f.h.performAction<any>("user-authorization.status", { companyId: "anthm" }, actors("anthm").member);
    expect(status.authorization.fence).toMatchObject({ ok: false, reason: expect.stringContaining("anthm-fr/songtrivia is now a different repository (ID 9001, was 22)") });
    expect(await f.write("anthm-fr/songtrivia")).not.toHaveProperty("credential");
    // An administrator saving the policy accepts the new repository.
    expect((await f.setPolicy(anthmPolicy)).fence).toMatchObject({ ok: true });
    expect(await f.write("anthm-fr/songtrivia")).toHaveProperty("credential");
  });

  it("m6: a fenced name the user and the App see as different repositories turns writes off", async () => {
    const f = await appFixture();
    names.forEach((name, index) => { f.github.installationRepoIds[`anthm-fr/${name}`] = 22 + index; });
    f.github.installationRepoIds["anthm-fr/linkzic"] = 7_777;
    await f.setPolicy(anthmPolicy);
    await f.action("user-authorization.start");
    vi.setSystemTime(Date.now() + 6_000);
    expect(await f.action("user-authorization.poll")).toMatchObject({ status: "authorized", fence: { ok: false, reason: expect.stringContaining("anthm-fr/linkzic has ID 7777 for the user but 24 for the App") } });
    expect(await f.write("anthm-fr/songtrivia")).not.toHaveProperty("credential");
  });

  it("m7: a kill switch flipped during the slow admin-merge check refuses the merge", async () => {
    const f = await appFixture();
    await f.authorize();
    await f.setPolicy({ ...anthmPolicy, privileged: { adminMerge: true } });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let checking = false;
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (path: string, ...rest: any[]) => {
      if (path.includes("/check-runs")) { checking = true; await gate; }
      return (original as any)(path, ...rest);
    });
    const merge = f.write("anthm-fr/songtrivia", { action: "pullRequest", privileged: ["adminMerge"], pullRequest: 7, expectedHeadSha: "a".repeat(40) });
    await vi.waitFor(() => expect(checking).toBe(true));
    await f.setPolicy({ ...anthmPolicy, privileged: { adminMerge: true }, enabled: false });
    release();
    const decision = await merge;
    expect(decision).toMatchObject({ unavailable: expect.stringContaining("kill switch") });
    expect(decision).not.toHaveProperty("credential");
  });

  it("m7: a board write that waited in the company's queue gets no user token once the kill switch is flipped", async () => {
    const f = await appFixture();
    await f.authorize();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const posts: Array<string | undefined> = [];
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (path: string, auth?: string, body?: unknown, method?: string) => {
      if (path === "/repos/Anthm-FR/songtrivia/issues/1/comments" && method === "POST") {
        posts.push(auth);
        if (posts.length === 1) await gate;
      }
      return (original as any)(path, auth, body, method);
    });
    const comment = (requestId: string) => f.h.performAction<any>("manage-repository",
      { companyId: "anthm", repositoryId: 22, op: "comment", number: 1, body: "Refs: ANT-1", requestId }, actors("anthm").admin).catch((error: Error) => error);
    const first = comment("request-r3-0001");
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    const second = comment("request-r3-0002");
    await new Promise(resolve => setTimeout(resolve, 50));
    await f.setPolicy({ ...anthmPolicy, enabled: false });
    release();
    expect(await first).not.toBeInstanceOf(Error);
    const refused = await second;
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toMatch(/kill switch/);
    expect(posts).toHaveLength(1);
  });

  it("m8: a read token minted while the fence narrowed is neither cached nor handed out", async () => {
    const f = await appFixture();
    await f.authorize();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let minting = false, n = 0;
    const revoked: string[] = [];
    f.scoped.mockImplementation(async () => { n += 1; const minted = token("ghs", n); if (n === 1) { minting = true; await gate; } return minted; });
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (path: string, auth?: string, body?: unknown, method?: string) => {
      if (path === "/installation/token" && method === "DELETE") { revoked.push(auth!); return { data: null as any, next: false }; }
      return (original as any)(path, auth, body, method);
    });
    const pending = f.read(null);
    await vi.waitFor(() => expect(minting).toBe(true));
    // The installation and the fence shrink to two repositories while GitHub mints the five-repository token.
    const narrowed = ["Anthm-FR/songtrivia", "Anthm-FR/anthm-fr"];
    f.github.installationRepos = [...narrowed];
    expect((await f.setPolicy({ ...anthmPolicy, installationRepositories: narrowed })).fence).toMatchObject({ ok: true });
    release();
    const stale = await pending;
    expect(stale).not.toHaveProperty("credential");
    expect(stale).toMatchObject({ unavailable: expect.stringContaining("changed while") });
    expect(revoked).toEqual([token("ghs", 1)]);
    // The next read mints for the narrowed fence only.
    expect(await f.read(null)).toMatchObject({ credential: { token: token("ghs", 2) } });
    expect(f.scoped).toHaveBeenLastCalledWith(APP, "value-a-key", 101, expect.anything(), ["Anthm-FR/anthm-fr", "Anthm-FR/songtrivia"]);
  });
});

// ---------------------------------------------------------------------------
// Round 4, P4b: agents never merge a pull request that touches protected paths.
// ---------------------------------------------------------------------------

describe("P4b protected-path merge guard (round 4)", () => {
  const head = "a".repeat(40), base = "c".repeat(40);
  const tiersFile = (paths: string[]) => `version: 1\n# Change tiers.\ntiers:\n  - id: T0\n    covers:\n      - wording\n    approval: gate\nprotectedPaths:\n${paths.map(path => `  - ${path}`).join("\n")}\n  # a comment inside the list\nrules:\n  - one rule\n`;
  const merge = (f: Awaited<ReturnType<typeof appFixture>>, repository = "anthm-fr/anthm-fr", extra: Record<string, unknown> = {}) =>
    f.write(repository, { action: "pullRequest", privileged: [], merge: true, pullRequest: 7, expectedHeadSha: head, ...extra });
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  async function controlRepo() {
    const f = await appFixture();
    await f.authorize();
    f.github.contents[`anthm-fr/anthm-fr/paperclip/tiers.yaml@${base}`] = tiersFile(["paperclip/**", "plugins/anthm/skills/anthm-base/**", "data/company/monetisation/**/*goals*", "data/products/*/knowledge/wiki-history/**"]);
    return f;
  }

  it("refuses an agent merge, admin or not, whose diff touches a protected path, names the files and says a human must merge it", async () => {
    const f = await controlRepo();
    for (const [label, files, expected] of [
      ["a control-plane file", [{ filename: "paperclip/gates.yaml" }], "paperclip/gates.yaml"],
      ["a protected skill listed in tiers.yaml", [{ filename: "plugins/anthm/skills/anthm-base/SKILL.md" }], "plugins/anthm/skills/anthm-base/SKILL.md"],
      ["a rename out of scripts/", [{ filename: "tools/deploy.sh", previous_filename: "scripts/deploy.sh", status: "renamed" }], "scripts/deploy.sh"],
      ["a deleted CODEOWNERS", [{ filename: "CODEOWNERS", status: "removed" }], "CODEOWNERS"],
      ["a workflow", [{ filename: ".github/workflows/ci.yml" }], ".github/workflows/ci.yml"],
      ["a goals file deep in monetisation", [{ filename: "data/company/monetisation/2026/q4-goals.md" }], "data/company/monetisation/2026/q4-goals.md"],
      ["a wiki history page", [{ filename: "data/products/linkzic/knowledge/wiki-history/home.md" }], "data/products/linkzic/knowledge/wiki-history/home.md"],
      ["another case", [{ filename: "Paperclip/gates.yaml" }], "Paperclip/gates.yaml"],
      ["the minimum list, also without tiers.yaml", [{ filename: "ROADMAP.md" }], "ROADMAP.md"],
    ] as const) {
      f.github.prFiles = [{ filename: "src/ok.ts" }, ...files];
      for (const privileged of [[], ["adminMerge"]]) {
        const decision = await merge(f, "anthm-fr/anthm-fr", { privileged });
        expect(decision, `${label} ${privileged}`).toMatchObject({
          unavailable: expect.stringMatching(new RegExp(`protected paths \\(.*${escape(expected)}.*\\); agents cannot merge it, a human must merge it: agent-owner in the GitHub web UI`)),
          evidence: { protectedFiles: [expected] },
        });
        expect(decision).not.toHaveProperty("credential");
      }
    }
    // The plugin's own merge tool goes through the same guard.
    f.github.prFiles = [{ filename: "paperclip/gates.yaml" }];
    const tool = await f.h.executeTool<any>("github_merge_pull_request", { repository: "Anthm-FR/anthm-fr", number: 7, sha: head, method: "squash", confirm: "Anthm-FR/anthm-fr#7" },
      { companyId: "anthm", agentId: "agent-1", projectId: "p1", runId: "run-1" });
    expect(tool.error).toMatch(/protected paths \(paperclip\/gates\.yaml\)/);
    // A diff that touches nothing protected merges, with the check recorded.
    f.github.prFiles = [{ filename: "src/ok.ts" }, { filename: "data/company/objectives-notes.md" }, { filename: "plugins/anthm/skills/assistant/SKILL.md" }];
    expect(await merge(f)).toMatchObject({ credential: { login: "agent-owner" }, evidence: { protectedPaths: { pullRequest: 7, headSha: head, baseSha: base, files: 3 } } });
  });

  it("reads the protected list from the base branch only, never from the pull request's head", async () => {
    const f = await controlRepo();
    // The head would drop every protected path; Paperclip never reads it.
    f.github.contents[`anthm-fr/anthm-fr/paperclip/tiers.yaml@${head}`] = tiersFile(["nothing/**"]);
    f.github.prFiles = [{ filename: "data/products/wordzic/knowledge/wiki-history/a.md" }, { filename: "paperclip/tiers.yaml" }];
    expect(await merge(f)).toMatchObject({ unavailable: expect.stringContaining("paperclip/tiers.yaml") });
    const tiersReads = f.request.mock.calls.map(([path]) => String(path)).filter(path => path.includes("/contents/paperclip/tiers.yaml"));
    expect(tiersReads.length).toBeGreaterThan(0);
    expect(tiersReads.every(path => path.endsWith(`?ref=${base}`))).toBe(true);
  });

  it("fails closed when tiers.yaml cannot be read or parsed, and keeps the minimum list without one", async () => {
    const f = await controlRepo();
    f.github.prFiles = [{ filename: "src/ok.ts" }];
    for (const [label, content] of [
      ["GitHub fails", 500],
      ["a flow list", "protectedPaths: [paperclip/**, scripts/**]\n"],
      ["an anchor", "protectedPaths:\n  - &p paperclip/**\n"],
      ["a nested map", "protectedPaths:\n  - path: paperclip/**\n"],
      ["two lists", "protectedPaths:\n  - a\nprotectedPaths:\n  - b\n"],
      ["no list", "version: 1\n"],
      ["a path outside the repository", "protectedPaths:\n  - ../escape\n"],
    ] as const) {
      f.github.contents[`anthm-fr/anthm-fr/paperclip/tiers.yaml@${base}`] = content;
      expect(await merge(f), label).toMatchObject({ unavailable: expect.stringMatching(/cannot read paperclip\/tiers\.yaml on the base branch.*a human must merge it/) });
    }
    // No tiers file at all: the control repository keeps its minimum list; a game repository keeps .github/** and CODEOWNERS.
    delete f.github.contents[`anthm-fr/anthm-fr/paperclip/tiers.yaml@${base}`];
    f.github.prFiles = [{ filename: "paperclip/gates.yaml" }];
    expect(await merge(f)).toMatchObject({ unavailable: expect.stringContaining("paperclip/gates.yaml") });
    f.github.prFiles = [{ filename: "scripts/build.sh" }, { filename: "paperclip/notes.md" }];
    expect(await merge(f, "anthm-fr/songtrivia")).toHaveProperty("credential");
    for (const filename of [".github/workflows/deploy.yml", "CODEOWNERS", "docs/CODEOWNERS", ".github/CODEOWNERS"]) {
      f.github.prFiles = [{ filename }];
      expect(await merge(f, "anthm-fr/songtrivia"), filename).toMatchObject({ unavailable: expect.stringContaining(filename) });
    }
  });

  it("refuses when the file list is cut or the head moves during the check, and binds the merge to the head SHA", async () => {
    const f = await controlRepo();
    f.github.prFiles = Array.from({ length: 3000 }, (_, n) => ({ filename: `src/file-${n}.ts` }));
    expect(await merge(f)).toMatchObject({ unavailable: expect.stringMatching(/listed 3000 of the 3000 files|more files than GitHub lists/) });
    f.github.prFiles = Array.from({ length: 3100 }, (_, n) => ({ filename: `src/file-${n}.ts` }));
    expect(await merge(f)).toMatchObject({ unavailable: expect.stringContaining("more files than GitHub lists (3,000)") });
    f.github.prFiles = [{ filename: "src/ok.ts" }];
    f.github.changedFiles = 2;
    expect(await merge(f)).toMatchObject({ unavailable: expect.stringContaining("listed 1 of the 2 files") });
    f.github.changedFiles = null;
    // Without the full head SHA there is nothing to bind the merge to.
    expect(await merge(f, "anthm-fr/anthm-fr", { expectedHeadSha: null })).toMatchObject({ unavailable: expect.stringContaining("--match-head-commit") });
    expect(await merge(f, "anthm-fr/anthm-fr", { expectedHeadSha: "b".repeat(40) })).toMatchObject({ unavailable: expect.stringContaining("not the expected") });
    // A push between the file list and the second read refuses.
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (path: string, ...rest: any[]) => {
      const result = await (original as any)(path, ...rest);
      if (/\/pulls\/7$/.test(path) && f.github.prReads === 1) f.github.pr = { ...f.github.pr, head: { sha: "b".repeat(40) } };
      return result;
    });
    f.github.prReads = 0;
    expect(await merge(f)).toMatchObject({ unavailable: expect.stringContaining("changed while Paperclip checked it") });
  });

  it("refuses auto-merge and the merge queue as the App user, and a direct push to main stays refused", async () => {
    const f = await controlRepo();
    f.github.prFiles = [{ filename: "src/ok.ts" }];
    expect(await merge(f, "anthm-fr/anthm-fr", { autoMerge: true })).toMatchObject({ unavailable: expect.stringMatching(/auto-merge or the merge queue: a human must merge/) });
    const tool = await f.h.executeTool<any>("github_enable_auto_merge", { repository: "Anthm-FR/anthm-fr", number: 7, sha: head, method: "squash", confirm: "Anthm-FR/anthm-fr#7" },
      { companyId: "anthm", agentId: "agent-1", projectId: "p1", runId: "run-1" });
    expect(tool.error).toMatch(/auto-merge or the merge queue/);
    // The guard does not replace pushToMain: a direct push to main is still off.
    expect(await f.write("anthm-fr/anthm-fr", { privileged: ["pushToMain"] })).toMatchObject({ unavailable: expect.stringContaining("(pushToMain)") });
  });

  it("allows the one exception: skills.lock snapshot hashes of changed, unprotected anthm skills", async () => {
    const f = await controlRepo();
    const lock = (entries: Array<Record<string, unknown>>) => JSON.stringify({ version: 1, hashFormat: "sha256", skills: entries }, null, 2);
    const entry = (name: string, hash: string, owner = "ab9aff55") => ({ skillPath: `plugins/anthm/skills/${name}`, snapshotHash: hash.repeat(64), paperclipSkillId: null, owner });
    f.github.contents[`anthm-fr/anthm-fr/paperclip/skills.lock@${base}`] = lock([entry("assistant", "1"), entry("anthm-base", "2"), entry("backlog-management", "3")]);
    const at = (entries: Array<Record<string, unknown>>) => { f.github.contents[`anthm-fr/anthm-fr/paperclip/skills.lock@${head}`] = lock(entries); };
    f.github.prFiles = [{ filename: "paperclip/skills.lock" }, { filename: "plugins/anthm/skills/assistant/SKILL.md" }];
    at([entry("assistant", "9"), entry("anthm-base", "2"), entry("backlog-management", "3")]);
    expect(await merge(f)).toMatchObject({ credential: { login: "agent-owner" }, evidence: { protectedPaths: { skillsLockSnapshotOnly: true } } });
    for (const [label, entries, files, reason] of [
      ["the owner changes too", [entry("assistant", "9", "6a32c408"), entry("anthm-base", "2"), entry("backlog-management", "3")], undefined, "more than the snapshot hash"],
      ["a skill this pull request does not change", [entry("assistant", "1"), entry("anthm-base", "2"), entry("backlog-management", "9")], undefined, "does not change"],
      ["a protected skill", [entry("assistant", "1"), entry("anthm-base", "9"), entry("backlog-management", "3")], [{ filename: "paperclip/skills.lock" }, { filename: "plugins/anthm/skills/anthm-base/SKILL.md" }], "protected paths"],
      ["an added skill", [entry("assistant", "9"), entry("anthm-base", "2"), entry("backlog-management", "3"), entry("new-skill", "4")], undefined, "adds or removes"],
      ["another protected file alongside", [entry("assistant", "9"), entry("anthm-base", "2"), entry("backlog-management", "3")], [{ filename: "paperclip/skills.lock" }, { filename: "plugins/anthm/skills/assistant/SKILL.md" }, { filename: "paperclip/gates.yaml" }], "paperclip/gates.yaml, paperclip/skills.lock"],
    ] as const) {
      at([...entries]);
      f.github.prFiles = [...(files ?? [{ filename: "paperclip/skills.lock" }, { filename: "plugins/anthm/skills/assistant/SKILL.md" }])];
      const decision = await merge(f);
      expect(decision, label).toMatchObject({ unavailable: expect.stringContaining(reason) });
      expect(decision.unavailable, label).toContain("a human must merge it: agent-owner in the GitHub web UI");
    }
  });
});

describe("security review round 5 (attack regressions)", () => {
  const head = "a".repeat(40), base = "c".repeat(40);
  const merge = (f: Awaited<ReturnType<typeof appFixture>>, extra: Record<string, unknown> = {}) =>
    f.write("anthm-fr/anthm-fr", { action: "pullRequest", privileged: [], merge: true, pullRequest: 7, expectedHeadSha: head, ...extra });

  it("m2: an open pull request's base branch never changes as the App user (managed, board and tool)", async () => {
    const f = await appFixture();
    await f.authorize();
    expect(await f.write("anthm-fr/songtrivia", { action: "pullRequest", retarget: true })).toMatchObject({ unavailable: expect.stringMatching(/base branch: a human must, agent-owner in the GitHub web UI/) });
    expect(await f.write("anthm-fr/songtrivia", { action: "pullRequest" })).toHaveProperty("credential");
    const tool = await f.h.executeTool<any>("github_update_pull_request", { repository: "Anthm-FR/songtrivia", number: 7, base: "main" },
      { companyId: "anthm", agentId: "agent-1", projectId: "p1", runId: "run-1" });
    expect(tool.error).toMatch(/base branch/);
    const board = await f.h.performAction("manage-repository", { companyId: "anthm", repositoryId: 22, op: "edit-pr", number: 7, base: "main", requestId: "request-r5-0001" }, actors("anthm").admin).catch((error: Error) => error);
    expect((board as Error).message).toMatch(/base branch/);
  });

  it("m3: a duplicate key in skills.lock cannot hide a change", async () => {
    const f = await appFixture();
    await f.authorize();
    const entry = (owner: string) => `{"skillPath":"plugins/anthm/skills/assistant","snapshotHash":"${"1".repeat(64)}","paperclipSkillId":null,"owner":"${owner}"}`;
    f.github.contents[`anthm-fr/anthm-fr/paperclip/skills.lock@${base}`] = `{"version":1,"skills":[${entry("ab9aff55")}]}`;
    f.github.contents[`anthm-fr/anthm-fr/paperclip/skills.lock@${head}`] = `{"version":1,"skills":[{"skillPath":"plugins/anthm/skills/assistant","snapshotHash":"${"9".repeat(64)}","paperclipSkillId":null,"owner":"evil","owner":"ab9aff55"}]}`;
    f.github.prFiles = [{ filename: "paperclip/skills.lock" }, { filename: "plugins/anthm/skills/assistant/SKILL.md" }];
    expect(await merge(f)).toMatchObject({ unavailable: expect.stringContaining("not a lock file Paperclip can read") });
  });

  it("m4: a pull request without a file count refuses the merge", async () => {
    const f = await appFixture();
    await f.authorize();
    f.github.prFiles = [{ filename: "src/ok.ts" }];
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (path: string, ...rest: any[]) => {
      const result = await (original as any)(path, ...rest);
      if (/\/pulls\/7$/.test(path)) delete (result.data as Record<string, unknown>).changed_files;
      return result;
    });
    expect(await merge(f)).toMatchObject({ unavailable: expect.stringContaining("cannot check them all") });
  });

  it("m5: a file, symlink or submodule named like a protected directory is protected too", async () => {
    const f = await appFixture();
    await f.authorize();
    for (const filename of ["paperclip", ".github", "scripts"]) {
      f.github.prFiles = [{ filename }];
      expect(await merge(f), filename).toMatchObject({ unavailable: expect.stringContaining(`protected paths (${filename})`) });
    }
  });
});

// ---------------------------------------------------------------------------
// A push may carry workflow changes without editWorkflows only when all the history it adds is the base branch's own.
// ---------------------------------------------------------------------------

describe("workflow changes that arrive by merging the base branch", () => {
  const W = ".github/workflows";
  type Entry = { mode: string; oid: string };
  const blob = (text: string, mode = "100644"): Entry => ({ mode, oid: createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0${text}`).digest("hex") });
  const id = (n: number) => n.toString(16).padStart(40, "0");
  const change = (file: string, entry: Entry | null) => ({ path: `${W}/${file}`, mode: entry?.mode ?? null, oid: entry?.oid ?? null });
  const listed = (files: Record<string, Entry>) => Object.entries(files).map(([file, entry]) => ({ path: `${W}/${file}`, ...entry })).sort((a, b) => a.path < b.path ? -1 : 1);
  // main moved on: it edited ci.yml, added deploy.yml and deleted release.yml, which feature/x still has.
  const oldCi = blob("on: push # before\n"), ci = blob("on: push\n"), deploy = blob("on: workflow_dispatch\n"), release = blob("on: release\n"), releaseCi = blob("on: [push, release]\n");
  const mainOld = id(900), featureOld = id(901), earlier = id(902), mergeSha = id(5000), evilSha = id(5001), restoreSha = id(5002), unknown = id(5003), localSha = id(5004);
  const toggle = "editWorkflows";
  const edit = blob("on: push\nenv:\n  EVIL: 1\n");

  async function pushFixture() {
    const f = await appFixture();
    await f.authorize();
    const state = {
      /** The workflow files of each branch on GitHub, by name under .github/workflows; feature/x is the pushed branch. */
      branches: {
        main: { "ci.yml": ci, "deploy.yml": deploy },
        "release/1": { "ci.yml": releaseCi },
        wip: { "ci.yml": blob("on: unreviewed\n") },
        "feature/x": { "ci.yml": oldCi, "release.yml": release },
      } as Record<string, Record<string, Entry>>,
      /** Branches with branch protection (the default branch, main, has none here). */
      protectedBranches: new Set(["release/1"]),
      /** Whether the pushed branch exists on GitHub yet. */
      destination: true,
      /** The open pull requests of the pushed branch feature/x (their base; a fork's head repository is another one; ref is their head branch). */
      prs: [] as Array<{ base: string; fork?: boolean; ref?: string }>,
      defaultBranch: "main",
      /** Requests GitHub fails on. */
      failing: [] as RegExp[],
      truncated: false,
      githubDirectory: "tree" as "tree" | "none" | "symlink",
      /** The commits GitHub has, by their parents. */
      graph: {} as Record<string, string[]>,
      /** Every request the checks made. */
      calls: [] as string[],
    };
    const names = () => Object.keys(state.branches);
    const ids = (name: string) => { const first = 100 + names().indexOf(name) * 10; return { commit: id(first + 1), root: id(first + 2), github: id(first + 3), workflows: id(first + 4) }; };
    const tip = (name: string) => ids(name).commit;
    state.graph = { [tip("main")]: [mainOld], [mainOld]: [earlier], [earlier]: [], [tip("feature/x")]: [featureOld], [featureOld]: [earlier], [tip("release/1")]: [earlier], [tip("wip")]: [earlier] };
    const ancestors = (sha: string) => {
      const seen = new Set<string>();
      const walk = (at: string) => { for (const parent of state.graph[at] ?? []) if (!seen.has(parent)) { seen.add(parent); walk(parent); } };
      walk(sha);
      return seen;
    };
    const repo = "/repos/anthm-fr/songtrivia";
    const original = f.request.getMockImplementation()!;
    const answer = (data: unknown) => ({ data: data as any, next: false });
    f.request.mockImplementation(async (path: string, ...rest: any[]) => {
      const mine = path === repo || path.startsWith(`${repo}/pulls?`) || path.startsWith(`${repo}/git/trees/`) || path.startsWith(`${repo}/compare/`)
        || path.startsWith(`${repo}/branches/`) && names().some(name => path === `${repo}/branches/${encodeURIComponent(name)}`);
      if (!mine) return (original as any)(path, ...rest);
      state.calls.push(path);
      if (state.failing.some(pattern => pattern.test(path))) throw new GitHubError(500);
      if (path.startsWith(`${repo}/pulls?`)) {
        return answer(state.prs.map(pr => ({ base: { ref: pr.base }, head: { ref: pr.ref ?? "feature/x", repo: { full_name: pr.fork ? "someone/songtrivia" : "Anthm-FR/songtrivia" } } })));
      }
      if (path === repo) return answer({ default_branch: state.defaultBranch });
      const compared = /\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})\?per_page=1$/.exec(path);
      if (compared) {
        const [, a, b] = compared as unknown as [string, string, string];
        if (!(a in state.graph) || !(b in state.graph)) throw new GitHubError(404);
        return answer({ status: a === b ? "identical" : ancestors(b).has(a) ? "ahead" : ancestors(a).has(b) ? "behind" : "diverged" });
      }
      const branch = names().find(name => path === `${repo}/branches/${encodeURIComponent(name)}`);
      if (branch) {
        if (branch === "feature/x" && !state.destination) throw new GitHubError(404);
        return answer({ name: branch, protected: state.protectedBranches.has(branch), commit: { sha: ids(branch).commit, commit: { tree: { sha: ids(branch).root } } } });
      }
      const [, sha, recursive] = /\/git\/trees\/([0-9a-f]{40})(\?recursive=1)?$/.exec(path) ?? [];
      const entry = (name: string, mode: string, type: string, oid: string) => ({ path: name, mode, type, sha: oid });
      for (const name of names()) {
        const tree = ids(name);
        if (sha === tree.root) {
          const github = state.githubDirectory === "tree" ? [entry(".github", "040000", "tree", tree.github)] : state.githubDirectory === "symlink" ? [entry(".github", "120000", "blob", id(7))] : [];
          return answer({ sha, truncated: false, tree: [entry("README.md", "100644", "blob", id(1)), ...github] });
        }
        if (sha === tree.github) return answer({ sha, truncated: false, tree: [entry("CODEOWNERS", "100644", "blob", id(2)), entry("workflows", "040000", "tree", tree.workflows)] });
        if (sha === tree.workflows) {
          if (!recursive) throw new Error("The workflow files are read recursively.");
          const files = state.githubDirectory === "none" ? {} : state.branches[name]!;
          return answer({ sha, truncated: state.truncated, tree: Object.entries(files).map(([file, found]) => entry(file, found.mode, "blob", found.oid)) });
        }
      }
      throw new GitHubError(404);
    });
    /** The push of one commit to feature/x that merges `base` into it: the base's files, and the paths where they differ from the branch's. */
    const mergeOf = (base = "main", extra: Record<string, unknown> = {}) => {
      const files = state.branches[base]!, dest = state.branches["feature/x"]!;
      const same = (a?: Entry, b?: Entry) => a?.mode === b?.mode && a?.oid === b?.oid;
      const changes = [...new Set([...Object.keys(files), ...Object.keys(dest)])].sort().filter(file => !same(files[file], dest[file])).map(file => change(file, files[file] ?? null));
      return {
        branch: "feature/x", tip: mergeSha, files: listed(files),
        commits: [{ sha: mergeSha, parents: [tip("feature/x"), tip(base)], changes }], entries: [tip("feature/x"), tip(base)], ...extra,
      };
    };
    const push = (workflowPush: unknown, extra: Record<string, unknown> = {}) => f.write("anthm-fr/songtrivia", { action: "push", privileged: [toggle], workflowPush, ...extra });
    const refused = (decision: any, reason: string | RegExp) => {
      expect(decision).toMatchObject({ identity: "user", unavailable: typeof reason === "string" ? expect.stringContaining(reason) : expect.stringMatching(reason) });
      expect(decision).not.toHaveProperty("credential");
      return decision;
    };
    return { ...f, state, ids, tip, push, mergeOf, refused };
  }

  it("allows a merge of the base branch with the toggle off, and reads the base fresh for every push", async () => {
    const f = await pushFixture();
    const granted = await f.push(f.mergeOf());
    expect(granted).toMatchObject({ identity: "user", credential: { login: "agent-owner" }, evidence: { workflowBaseMerge: {
      branch: "feature/x", tip: mergeSha, base: "main", baseSha: f.tip("main"), destinationSha: f.tip("feature/x"), commits: [mergeSha],
      paths: [`${W}/ci.yml`, `${W}/deploy.yml`, `${W}/release.yml`],
    } } });
    expect((await f.policy()).privileged.editWorkflows).toBe(false);
    // The pushed branch's pull requests, the base branch, the branch and their trees are read from GitHub for this push.
    const lookup = new URLSearchParams(f.state.calls.find(call => call.includes("/pulls?"))!.split("?")[1]);
    expect(lookup.get("state")).toBe("open");
    expect(lookup.get("head")).toBe("Anthm-FR:feature/x");
    expect(f.state.calls.filter(call => call.includes("/git/trees/"))).toHaveLength(6);
    // A merge of an older commit of the base branch (main has not touched workflows since) is a merge of the base branch too.
    f.state.calls.length = 0;
    const older = f.mergeOf("main", { commits: [{ ...f.mergeOf().commits[0], parents: [f.tip("feature/x"), mainOld] }], entries: [f.tip("feature/x"), mainOld] });
    expect(await f.push(older)).toMatchObject({ credential: { login: "agent-owner" } });
    expect(f.state.calls.some(call => call.includes("/compare/"))).toBe(true);
    // The next push reads the base again: main moved on its ci.yml after the checkout fetched it.
    const fetched = f.mergeOf();
    const reads = f.state.calls.length;
    f.state.branches.main["ci.yml"] = blob("on: pull_request\n");
    f.refused(await f.push(fetched), `${W}/ci.yml`);
    expect(f.state.calls.length).toBeGreaterThan(reads);
  });

  it("refuses a clean tip that hides an earlier workflow edit in a commit the push adds (regression)", async () => {
    const f = await pushFixture();
    // A edits ci.yml and B puts main's file back: the tip alone is exactly the base branch's.
    const laundered = {
      branch: "feature/x", tip: restoreSha, files: listed({ "ci.yml": ci, "deploy.yml": deploy }),
      commits: [
        { sha: restoreSha, parents: [evilSha], changes: [change("ci.yml", ci)] },
        { sha: evilSha, parents: [f.tip("feature/x")], changes: [change("ci.yml", edit)] },
      ],
      entries: [f.tip("feature/x")],
    };
    const decision = f.refused(await f.push(laundered), new RegExp(`Commit ${restoreSha.slice(0, 8)} changes workflow files.*is not a merge of main.*editWorkflows is turned off`, "s"));
    expect(decision.evidence).toMatchObject({ base: "main", offendingCommits: [restoreSha, evilSha] });
    // The same push with the earlier commit the only change is refused too.
    f.refused(await f.push({ ...laundered, tip: evilSha, files: listed({ "ci.yml": edit, "deploy.yml": deploy }), commits: [laundered.commits[1]] }), new RegExp(`Commit ${evilSha.slice(0, 8)}`));
  });

  it("judges a new branch on an existing commit by where it joins GitHub: the base branch's own history passes, another branch's does not (regression)", async () => {
    const f = await pushFixture();
    f.state.destination = false;
    // The launcher reports a ref created on a commit GitHub has (nothing is new) as a push whose history joins GitHub at that commit.
    const onto = (commit: string, files: Record<string, Entry>) => ({ branch: "feature/x", tip: commit, files: listed(files), commits: [], entries: [commit] });
    // The base branch's tip, and an older commit of it: its own workflow files, so the toggle can stay off.
    expect(await f.push(onto(f.tip("main"), f.state.branches.main!))).toMatchObject({ credential: { login: "agent-owner" }, evidence: { workflowBaseMerge: { base: "main", commits: [], paths: [] } } });
    expect(await f.push(onto(mainOld, f.state.branches.main!))).toMatchObject({ credential: { login: "agent-owner" } });
    // A commit that only another branch has (wip, never reviewed), whatever its files: refused, with the board's grant to ask for.
    f.refused(await f.push(onto(f.tip("wip"), f.state.branches.wip!)), /builds on commit .*not part of main.*editWorkflows is turned off/s);
    // A commit GitHub does not have at all.
    f.refused(await f.push(onto(unknown, { "ci.yml": edit })), /builds on commit .*not part of main/);
    expect((await f.policy()).privileged.editWorkflows).toBe(false);
  });

  it("refuses moving the branch to a commit GitHub has when its workflow files differ from the branch's and are not the base branch's (regression)", async () => {
    const f = await pushFixture();
    // The branch is clean now; behind it is a commit with an edit, which GitHub has as part of the branch's history.
    f.state.branches["feature/x"] = { "ci.yml": ci, "deploy.yml": deploy };
    f.state.graph[evilSha] = [featureOld];
    f.state.graph[f.tip("feature/x")] = [evilSha];
    const rewind = { branch: "feature/x", tip: evilSha, files: listed({ "ci.yml": edit, "deploy.yml": deploy }), commits: [], entries: [evilSha] };
    f.refused(await f.push(rewind), /differ from main \(\.github\/workflows\/ci\.yml\).*editWorkflows is turned off/s);
    // Moving it to an older commit with the same files as the branch has changes no workflow file.
    const harmless = await f.push({ ...rewind, tip: featureOld, files: listed({ "ci.yml": ci, "deploy.yml": deploy }), entries: [featureOld] });
    expect(harmless).toMatchObject({ credential: { login: "agent-owner" }, evidence: { workflowBaseMerge: { paths: [], commits: [] } } });
  });

  it("refuses a merge of more than two parents, whatever else is right about it", async () => {
    const f = await pushFixture();
    const octopus = f.mergeOf("main", { commits: [{ ...f.mergeOf().commits[0], parents: [f.tip("feature/x"), f.tip("main"), f.tip("release/1")] }], entries: [f.tip("feature/x"), f.tip("main"), f.tip("release/1")] });
    f.refused(await f.push(octopus), new RegExp(`Commit ${mergeSha.slice(0, 8)} merges more than two parents.*editWorkflows is turned off`, "s"));
  });

  it("refuses a merge whose second parent is not part of the base branch, on GitHub or not (regression)", async () => {
    const f = await pushFixture();
    // wip has the same ci.yml as main now in the merge, but wip is not part of main.
    const crafted = (second: string) => f.mergeOf("main", { commits: [{ ...f.mergeOf().commits[0], parents: [f.tip("feature/x"), second] }], entries: [f.tip("feature/x"), second] });
    f.refused(await f.push(crafted(f.tip("wip"))), new RegExp(`${f.tip("wip").slice(0, 8)}, which is not part of main.*editWorkflows is turned off`, "s"));
    f.refused(await f.push(crafted(unknown)), new RegExp(`${unknown.slice(0, 8)}, which is not part of main`));
  });

  it("refuses new history that builds on a commit GitHub does not have, or one that is on neither the branch nor the base", async () => {
    const f = await pushFixture();
    // The first parent is where the new history joins what exists: it must be the branch (or part of it) or part of the base.
    const built = (first: string) => f.mergeOf("main", { commits: [{ ...f.mergeOf().commits[0], parents: [first, f.tip("main")] }], entries: [first, f.tip("main")] });
    f.refused(await f.push(built(unknown)), new RegExp(`builds on commit ${unknown.slice(0, 8)}, which is neither on feature/x nor on main on GitHub.*editWorkflows is turned off`, "s"));
    f.refused(await f.push(built(f.tip("wip"))), /neither on feature\/x nor on main/);
    // Part of the branch's own history, or of main, is fine.
    expect(await f.push(built(featureOld))).toMatchObject({ credential: { login: "agent-owner" } });
    expect(await f.push(built(mainOld))).toMatchObject({ credential: { login: "agent-owner" } });
  });

  it("refuses an agent's own workflow edit, a merge that resolves to something else, a rename and a mode change", async () => {
    const f = await pushFixture();
    const dest = f.tip("feature/x");
    // One commit editing ci.yml is not a merge of main.
    f.refused(await f.push({ branch: "feature/x", tip: evilSha, files: listed({ "ci.yml": edit, "release.yml": release }), commits: [{ sha: evilSha, parents: [dest], changes: [change("ci.yml", edit)] }], entries: [dest] }), /is not a merge of main/);
    // A merge of main that ends up with an edit of the agent's own in a workflow file.
    const resolved = (changes: unknown[], files: Record<string, Entry>) => f.mergeOf("main", { files: listed(files), commits: [{ ...f.mergeOf().commits[0], changes }] });
    f.refused(await f.push(resolved([change("ci.yml", edit), change("deploy.yml", deploy), change("release.yml", null)], { "ci.yml": edit, "deploy.yml": deploy })), /differ from main \(\.github\/workflows\/ci\.yml\)/);
    // A rename of ci.yml: the old name gone, a new name main does not have.
    f.refused(await f.push(resolved([change("ci.yml", null), change("build.yml", ci), change("deploy.yml", deploy), change("release.yml", null)], { "build.yml": ci, "deploy.yml": deploy })), /build\.yml/);
    // A mode change keeps the blob and differs in the mode.
    f.refused(await f.push(resolved([change("ci.yml", { ...ci, mode: "100755" }), change("deploy.yml", deploy), change("release.yml", null)], { "ci.yml": { ...ci, mode: "100755" }, "deploy.yml": deploy })), `${W}/ci.yml`);
    // A deletion main does not share.
    f.refused(await f.push(resolved([change("ci.yml", ci), change("deploy.yml", null), change("release.yml", null)], { "ci.yml": ci })), `${W}/deploy.yml`);
    // The base branch with the same rename or mode passes.
    f.state.branches.main = { "build.yml": ci, "deploy.yml": { ...deploy, mode: "100755" } };
    expect(await f.push(f.mergeOf())).toMatchObject({ credential: { login: "agent-owner" } });
  });

  it("never lets a symlink, a submodule or a symlinked directory through, even when the base branch has the same", async () => {
    const f = await pushFixture();
    const link = { mode: "120000", oid: id(55) }, module = { mode: "160000", oid: id(56) };
    f.state.branches.main = { "link.yml": link, "module.yml": module };
    for (const [label, changes] of [
      ["a symlink the base has", [change("link.yml", link)]],
      ["a symlink the base lacks", [change("other.yml", link)]],
      ["a submodule", [change("module.yml", module)]],
      ["the directory replaced by a symlink", [{ path: W, mode: "120000", oid: id(57) }]],
    ] as const) {
      f.refused(await f.push(f.mergeOf("main", { commits: [{ ...f.mergeOf().commits[0], changes }] })), /not regular files/);
      expect(f.state.calls, label).toEqual([]);
    }
  });

  it("refuses when it cannot read what it must compare: pull requests, branches, trees, ancestry, or a base that is no directory", async () => {
    const f = await pushFixture();
    const older = () => f.mergeOf("main", { commits: [{ ...f.mergeOf().commits[0], parents: [f.tip("feature/x"), mainOld] }], entries: [f.tip("feature/x"), mainOld] });
    for (const [label, pattern] of [["the pull request lookup", /\/pulls\?/], ["a branch", /\/branches\//], ["a tree", /\/git\/trees\//], ["an ancestry check", /\/compare\//]] as const) {
      f.state.failing = [pattern];
      f.refused(await f.push(older()), /cannot read the workflow files of .*editWorkflows is turned off/s);
      expect(f.state.calls.length, label).toBeGreaterThan(0);
      f.state.calls.length = 0;
    }
    // Without a pull request the default branch is read; failing that refuses too.
    f.state.failing = [/^\/repos\/anthm-fr\/songtrivia$/];
    f.refused(await f.push(f.mergeOf()), /cannot read the workflow files/);
    f.state.failing = [];
    // A branch GitHub does not know.
    f.state.prs = [{ base: "ghost" }];
    f.refused(await f.push(f.mergeOf()), /cannot read the workflow files of ghost/);
    f.state.prs = [];
    // A tree GitHub cut short does not show every workflow file.
    f.state.truncated = true;
    f.refused(await f.push(f.mergeOf()), /cannot read the workflow files/);
    f.state.truncated = false;
    // A branch whose .github is no directory cannot be compared.
    f.state.githubDirectory = "symlink";
    f.refused(await f.push(f.mergeOf()), /cannot read the workflow files/);
    // Neither branch has workflow files: only what leaves them as they are passes.
    f.state.githubDirectory = "none";
    f.refused(await f.push(f.mergeOf()), `${W}/ci.yml`);
    expect(await f.push({ ...f.mergeOf(), files: [], commits: [{ ...f.mergeOf().commits[0], changes: [change("ci.yml", null)] }] })).toMatchObject({ credential: { login: "agent-owner" } });
    // Fixed, the same push passes.
    f.state.githubDirectory = "tree";
    expect(await f.push(f.mergeOf())).toMatchObject({ credential: { login: "agent-owner" } });
  });

  it("allows a new branch that merges the base branch, and refuses one that builds on anything else", async () => {
    const f = await pushFixture();
    f.state.destination = false;
    // The agent's own commit on top of an older main (no workflow change in it), then a merge of main.
    const fresh = f.mergeOf("main", { commits: [{ ...f.mergeOf().commits[0], parents: [localSha, f.tip("main")] }], entries: [mainOld, f.tip("main")] });
    expect(await f.push(fresh)).toMatchObject({ credential: { login: "agent-owner" }, evidence: { workflowBaseMerge: { base: "main", destinationSha: null, commits: [mergeSha] } } });
    f.refused(await f.push({ ...fresh, entries: [f.tip("wip"), f.tip("main")] }), /builds on commit .*not part of main/);
    f.refused(await f.push({ ...fresh, entries: [unknown, f.tip("main")] }), /builds on commit .*not part of main/);
  });

  it("compares with the pull request's base, with the default branch when there is none, and refuses when the base is unclear", async () => {
    const f = await pushFixture();
    // The pull request into release/1 is compared with release/1, not with main.
    f.state.prs = [{ base: "release/1" }];
    f.refused(await f.push(f.mergeOf("main")), /differ from release\/1/);
    expect(await f.push(f.mergeOf("release/1"))).toMatchObject({ evidence: { workflowBaseMerge: { base: "release/1", baseSha: f.tip("release/1") } } });
    // Two pull requests into one base are one base; two bases are none.
    f.state.prs = [{ base: "main" }, { base: "main" }];
    expect(await f.push(f.mergeOf())).toMatchObject({ evidence: { workflowBaseMerge: { base: "main" } } });
    f.state.prs = [{ base: "main" }, { base: "release/1" }];
    f.refused(await f.push(f.mergeOf()), /more than one base branch \(main, release\/1\).*editWorkflows is turned off/s);
    // A pull request from a fork, or from another branch, is not this branch's.
    f.state.prs = [{ base: "release/1", fork: true }];
    expect(await f.push(f.mergeOf())).toMatchObject({ evidence: { workflowBaseMerge: { base: "main" } } });
    f.state.prs = [{ base: "release/1", ref: "other" }];
    expect(await f.push(f.mergeOf())).toMatchObject({ evidence: { workflowBaseMerge: { base: "main" } } });
    // No pull request: the repository's default branch.
    f.state.prs = [];
    f.state.defaultBranch = "release/1";
    f.refused(await f.push(f.mergeOf("main")), /differ from release\/1/);
    expect(await f.push(f.mergeOf("release/1"))).toMatchObject({ evidence: { workflowBaseMerge: { base: "release/1" } } });
  });

  it("takes a pull request's base only when it is the default branch or protected, since whoever opens the pull request chooses it", async () => {
    const f = await pushFixture();
    // An agent can open a pull request into any branch; workflow files on a branch nobody protects are not reviewed.
    f.state.prs = [{ base: "wip" }];
    f.refused(await f.push(f.mergeOf("wip")), /wip is neither the default branch nor protected.*editWorkflows is turned off/s);
    f.state.protectedBranches.add("wip");
    expect(await f.push(f.mergeOf("wip"))).toMatchObject({ evidence: { workflowBaseMerge: { base: "wip" } } });
    f.state.prs = [{ base: "main" }];
    expect(await f.push(f.mergeOf())).toMatchObject({ evidence: { workflowBaseMerge: { base: "main" } } });
    // A default branch GitHub does not name cannot be told from any other unprotected branch.
    f.state.protectedBranches.delete("wip");
    f.state.prs = [{ base: "wip" }];
    f.state.defaultBranch = "";
    f.refused(await f.push(f.mergeOf("wip")), /neither the default branch nor protected/);
  });

  it("leaves the run identity as it was: the toggle decides and GitHub is not asked", async () => {
    const f = await pushFixture();
    await f.setPolicy({ ...anthmPolicy, userSource: "run" });
    f.refused(await f.push(f.mergeOf()), /privileged GitHub action \(editWorkflows\) and it is turned off/);
    expect(f.state.calls).toEqual([]);
  });

  it("asks nothing of GitHub when the company allows workflow edits, and falls back to the toggle without a usable report", async () => {
    const f = await pushFixture();
    const good = f.mergeOf();
    const commit = good.commits[0]!;
    const file = good.files[0]!;
    // The toggle decides when the report is missing or not exactly what the launcher sends.
    for (const workflowPush of [undefined, null, "ci.yml", { branch: "feature/x" }, { ...good, branch: "" }, { ...good, tip: "xyz" }, { ...good, files: "x" }, { ...good, files: [{ ...file, oid: null }] },
      { ...good, files: [{ ...file, path: "src/app.ts" }] }, { ...good, files: Array.from({ length: 101 }, () => file) }, { ...good, commits: "x" }, { ...good, commits: Array.from({ length: 101 }, () => commit) },
      { ...good, commits: [{ ...commit, sha: "xyz" }] }, { ...good, commits: [{ ...commit, parents: ["xyz"] }] }, { ...good, commits: [{ ...commit, parents: Array.from({ length: 17 }, () => commit.sha) }] },
      { ...good, commits: [{ ...commit, changes: [] }] }, { ...good, commits: [{ ...commit, changes: [{ path: "src/app.ts", mode: null, oid: null }] }] },
      { ...good, commits: [{ ...commit, changes: [{ path: `${W}/ci.yml`, mode: "100644", oid: null }] }] }, { ...good, commits: [{ ...commit, changes: [{ path: `${W}/ci.yml`, mode: null, oid: ci.oid }] }] },
      { ...good, commits: [{ ...commit, changes: [{ path: `${W}/${"x".repeat(300)}.yml`, mode: null, oid: null }] }] },
      { ...good, entries: [] }, { ...good, entries: ["xyz"] }, { ...good, entries: Array.from({ length: 9 }, () => commit.sha) }]) {
      const decision = await f.write("anthm-fr/songtrivia", { action: "push", privileged: [toggle], ...(workflowPush === undefined ? {} : { workflowPush }) });
      f.refused(decision, /privileged GitHub action \(editWorkflows\) and it is turned off/);
    }
    expect(f.state.calls).toEqual([]);
    // With the toggle on, anything goes through without a comparison.
    await f.setPolicy({ ...anthmPolicy, privileged: { editWorkflows: true } });
    expect(await f.push({ ...good, commits: [{ sha: evilSha, parents: [f.tip("feature/x")], changes: [change("ci.yml", edit)] }] })).toMatchObject({ credential: { login: "agent-owner" } });
    expect(await f.write("anthm-fr/songtrivia", { action: "push", privileged: [toggle] })).toMatchObject({ credential: { login: "agent-owner" } });
    expect(f.state.calls).toEqual([]);
  });

  it("does not unlock any other privileged action, and the kill switch still refuses", async () => {
    const f = await pushFixture();
    const decision = f.refused(await f.push(f.mergeOf(), { privileged: [toggle, "pushToMain"] }), /\(pushToMain\)/);
    expect(decision.unavailable).not.toContain("editWorkflows");
    f.refused(await f.push(f.mergeOf(), { privileged: [toggle, "tagPush"] }), /\(tagPush\)/);
    expect(f.state.calls).toEqual([]);
    // The kill switch flipped during the base read refuses the push.
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let waiting = false;
    const inner = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (path: string, ...rest: any[]) => {
      if (path.includes("/git/trees/")) { waiting = true; await gate; }
      return (inner as any)(path, ...rest);
    });
    const racing = f.push(f.mergeOf());
    await vi.waitFor(() => expect(waiting).toBe(true));
    await f.setPolicy({ ...anthmPolicy, enabled: false });
    release();
    f.refused(await racing, /kill switch/);
  });

  it("keeps a refusal within the server's 500 characters however many files and commits differ, and keeps them all in the evidence", async () => {
    const f = await pushFixture();
    const other = blob("on: other\n");
    const files = Array.from({ length: 60 }, (_, index) => `agent-workflow-with-a-rather-long-name-number-${index}.yml`);
    const many = f.mergeOf("main", { commits: [{ ...f.mergeOf().commits[0], changes: files.map(file => change(file, other)) }] });
    const decision = f.refused(await f.push(many), /differ from main/);
    expect(decision.unavailable.length).toBeLessThanOrEqual(500);
    expect(decision.unavailable).toMatch(/and 5\d more/);
    expect(decision.evidence.offending).toHaveLength(60);
    f.state.prs = [{ base: "release/1" }];
    const long = `${"x".repeat(250)}.yml`;
    expect((await f.push(f.mergeOf("release/1", { commits: [{ ...f.mergeOf("release/1").commits[0], changes: [change(long, other)] }] }))).unavailable.length).toBeLessThanOrEqual(500);
    for (const [label, push] of [
      ["a clean tip", { ...f.mergeOf("release/1"), commits: [{ sha: restoreSha, parents: [evilSha], changes: [change(long, other)] }] }],
      ["history on nothing GitHub has", { ...f.mergeOf("release/1"), entries: [unknown, f.tip("release/1")], commits: [{ ...f.mergeOf("release/1").commits[0], parents: [unknown, f.tip("release/1")] }] }],
      ["an octopus", { ...f.mergeOf("release/1"), commits: [{ ...f.mergeOf("release/1").commits[0], parents: [f.tip("feature/x"), f.tip("release/1"), f.tip("wip")], changes: files.map(file => change(file, other)) }] }],
    ] as const) {
      expect((await f.push(push)).unavailable.length, label).toBeLessThanOrEqual(500);
    }
  });
});
