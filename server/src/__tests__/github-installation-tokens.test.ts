import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, pluginConfig, pluginState, plugins } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { assertNativeGitHubAppAllowed, githubAppUserFence, mintNativeGitHubInstallationToken } from "../services/github-installation-tokens.js";
import { githubBotCredentials, githubBotRepositoryToken } from "../services/chat-github-client.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// I-RO holds by code: the shared mint function is the only place that asks GitHub for an installation token.
describe("GitHub App installation tokens (security review round 3, I-RO)", () => {
  it("are minted only by the shared mint function", () => {
    const sources: string[] = [];
    const walk = (directory: string) => {
      for (const name of readdirSync(directory)) {
        const file = path.join(directory, name);
        if (name === "node_modules" || name === "dist" || name === "__tests__") continue;
        if (statSync(file).isDirectory()) walk(file);
        else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name) && !/\.(test|spec)\.[a-z]+$/.test(name)) sources.push(file);
      }
    };
    for (const directory of ["server/src", "packages/shared/src", "packages/adapter-utils/src", "packages/plugins"]) walk(path.join(root, directory));
    const minting = sources.filter(file => /access_tokens/.test(readFileSync(file, "utf8"))).map(file => path.relative(root, file));
    expect(minting).toEqual(["packages/shared/src/github-installation-token.ts"]);
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("native GitHub code under an App-user company (security review round 3, I-RO)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-github-installation-tokens-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); }, 60_000);

  const APP = "5203754";
  const userWrites = { commit: "user", push: "user", pullRequest: "user", comment: "user" };
  async function fixture() {
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId, pluginKey: `github-${pluginId}`, packageName: "github", version: "1.0.0", status: "ready" as never,
      manifestJson: {
        id: `github-${pluginId}`, apiVersion: 1, version: "1.0.0", displayName: "GitHub", description: "", author: "", categories: ["connector"],
        capabilities: ["ui.action.register"], entrypoints: { worker: "./worker.js" },
        projectRepositories: { listAction: "list", writeIdentityAction: "repository-write-identity" },
      } as never,
    });
    const company = async (policy: unknown, appId: string | null) => {
      const id = randomUUID();
      await db.insert(companies).values({ id, name: id, issuePrefix: id.slice(0, 8) });
      if (policy !== undefined) await db.insert(pluginState).values({ pluginId, scopeKind: "company", scopeId: id, namespace: "identity", stateKey: "write-identity", valueJson: policy as never });
      if (appId) await db.insert(pluginConfig).values({ pluginId, companyId: id, configJson: { appId } });
      return id;
    };
    const anthm = await company({ default: userWrites, userSource: "app", allowedRepositories: ["Anthm-FR/songtrivia"],
      installationRepositories: ["Anthm-FR/songtrivia", "Anthm-FR/linkzic"], userLogin: "agent-owner", installationPermissions: { contents: "write", metadata: "read" } }, APP);
    const vllnt = await company({ default: { commit: "bot", push: "bot", pullRequest: "bot", comment: "bot" } }, "999");
    const unconfigured = await company(undefined, null);
    const broken = await company({ userSource: "nonsense" }, "777");
    return { pluginId, anthm, vllnt, unconfigured, broken, cleanup: () => db.delete(plugins).where(eq(plugins.id, pluginId)) };
  }

  it("resolves the fence of the company, and of any App-user company using the same App; others keep none", async () => {
    const f = await fixture();
    try {
      expect(await githubAppUserFence(db, { companyId: f.anthm })).toEqual(["anthm-fr/songtrivia", "anthm-fr/linkzic"]);
      // Another company connecting the App-user App natively gets the App-user company's fence.
      expect(await githubAppUserFence(db, { companyId: f.unconfigured, appId: APP })).toEqual(["anthm-fr/songtrivia", "anthm-fr/linkzic"]);
      expect(await githubAppUserFence(db, { companyId: f.vllnt, appId: APP })).toEqual(["anthm-fr/songtrivia", "anthm-fr/linkzic"]);
      // Not App-user: unchanged.
      expect(await githubAppUserFence(db, { companyId: f.vllnt, appId: "999" })).toBeNull();
      expect(await githubAppUserFence(db, { companyId: f.unconfigured, appId: "424242" })).toBeNull();
      // A policy Paperclip cannot read counts as an App-user company with an empty fence.
      expect(await githubAppUserFence(db, { companyId: f.broken })).toEqual([]);
      expect(await githubAppUserFence(db, { companyId: f.unconfigured, appId: "777" })).toEqual([]);
    } finally { await f.cleanup(); }
  });

  it("refuses write scopes and unscoped tokens on every native path; other companies keep today's tokens", async () => {
    const f = await fixture();
    const sent: unknown[] = [];
    const send = async (call: { body: unknown }) => { sent.push(call.body); return "ghs_native"; };
    const bot = { contents: "read", metadata: "read", issues: "write", pull_requests: "write", checks: "write" };
    try {
      for (const [label, companyId, appId] of [["App-user company", f.anthm, "1"], ["App-user App", f.vllnt, APP]] as const) {
        // Bot repository tokens and repository verification (write scopes, one repository).
        await expect(mintNativeGitHubInstallationToken(db, { companyId, appId, installationId: 101, repositories: [22], permissions: bot }, send), label).rejects.toThrow(/not read-only/);
        // Inventory and receipt reactions (the whole installation, every permission).
        await expect(mintNativeGitHubInstallationToken(db, { companyId, appId, installationId: 101 }, send), label).rejects.toThrow(/explicit read-only permission subset/);
        await expect(mintNativeGitHubInstallationToken(db, { companyId, appId, installationId: 101, permissions: { metadata: "read" } }, send), label).rejects.toThrow(/never the whole installation/);
        // Webhook recovery: read-only, inside the fence only.
        await expect(mintNativeGitHubInstallationToken(db, { companyId, appId, installationId: 101, repositories: ["vllnt/paperclip"], permissions: { issues: "read" } }, send), label).rejects.toThrow(/outside the company's GitHub fence/);
        expect(await mintNativeGitHubInstallationToken(db, { companyId, appId, installationId: 101, repositories: ["Anthm-FR/songtrivia"], permissions: { issues: "read", pull_requests: "read" } }, send), label).toBe("ghs_native");
      }
      expect(sent).toEqual([{ repositories: ["songtrivia"], permissions: { issues: "read", pull_requests: "read" } }, { repositories: ["songtrivia"], permissions: { issues: "read", pull_requests: "read" } }]);
      // A company that does not write as its App user, with its own App: the same requests as before.
      sent.length = 0;
      expect(await mintNativeGitHubInstallationToken(db, { companyId: f.vllnt, appId: "999", installationId: 101, repositories: [22], permissions: bot }, send)).toBe("ghs_native");
      expect(await mintNativeGitHubInstallationToken(db, { companyId: f.vllnt, appId: "999", installationId: 101 }, send)).toBe("ghs_native");
      expect(sent).toEqual([{ repository_ids: [22], permissions: bot }, {}]);
    } finally { await f.cleanup(); }
  });

  it("switches the native GitHub connector off for an App-user company and its App, with a clear error", async () => {
    const f = await fixture();
    try {
      for (const call of [() => githubBotCredentials(db, f.anthm, randomUUID()), () => githubBotRepositoryToken(db, f.anthm, randomUUID(), "22")]) {
        await expect(call()).rejects.toMatchObject({ status: 409, message: expect.stringContaining("native GitHub connector cannot use App tokens") });
      }
      await expect(assertNativeGitHubAppAllowed(db, { companyId: f.vllnt, appId: APP })).rejects.toMatchObject({ status: 409 });
      await expect(assertNativeGitHubAppAllowed(db, { companyId: f.vllnt, appId: "999" })).resolves.toBeUndefined();
      // Elsewhere the connector behaves as before (here: no endpoint, so it is unavailable).
      await expect(githubBotCredentials(db, f.vllnt, randomUUID())).rejects.toMatchObject({ status: 409, message: "GitHub bot connection is unavailable" });
    } finally { await f.cleanup(); }
  });
});
