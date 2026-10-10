import { definePlugin, runWorker, type EnvSecretRefBinding, type PluginContext, type PluginHealthDiagnostics, type PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { GitHubClient, normalizeAllowedOwnerRecords, repoName, validateAllowedOwners } from "./github.js";
import { GitHubReadCache } from "./read-cache.js";
import { registerRecordTasks } from "./pr-tasks.js";
import { registerTaskLinks } from "./task-links.js";
import { registerManagement } from "./management.js";
import { registerSync } from "./sync.js";
import { registerTaskIssues } from "./task-issues.js";
import { SetupService, boardScope, requireInstanceAdmin as requireAdmin } from "./setup.js";
import { registerAgentBots } from "./agent-bots.js";
import { registerAgentTools } from "./agent-tools.js";
import { registerWriteIdentity } from "./write-identity.js";
import { registerNativeGitHub } from "./native-github.js";
import type { AllowedOwner, AppIdentity, ConnectionState, Status } from "./contracts.js";
import { header, verifyGitHubSignature } from "./github-webhooks.js";

const disconnectedKey = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "connection", stateKey: "disconnected" });
const ownersKey = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "connection", stateKey: "allowed-owners" });
const appRegistryKey = { scopeKind: "instance" as const, namespace: "connection", stateKey: "app-companies" };
type ConfigConnection = { appId: string; appSlug: string; appName: string; privateKey: EnvSecretRefBinding; webhookSecret?: EnvSecretRefBinding };
type AppRegistry = Record<string, string>;

function secretRef(secretId: string): EnvSecretRefBinding {
  return { type: "secret_ref", secretId, version: "latest" };
}
function isSecretRef(value: unknown): value is EnvSecretRefBinding {
  return !!value && typeof value === "object" && (value as any).type === "secret_ref" && typeof (value as any).secretId === "string";
}

const WEBHOOK_REJECTED = "GitHub webhook rejected.";

export function register(ctx: PluginContext, github = new GitHubClient()) {
  const setup = new SetupService(ctx, github);
  let registryQueue = Promise.resolve();
  // One worker owns the plugin. Connect and disconnect for a company run one at
  // a time, so a connect still verifying its key cannot undo a later disconnect.
  const connectionQueues = new Map<string, Promise<unknown>>();
  function serializeConnection<T>(companyId: string, operation: () => Promise<T>): Promise<T> {
    const next = (connectionQueues.get(companyId) ?? Promise.resolve()).catch(() => {}).then(operation);
    connectionQueues.set(companyId, next);
    void next.finally(() => { if (connectionQueues.get(companyId) === next) connectionQueues.delete(companyId); }).catch(() => {});
    return next;
  }
  // Webhook secrets are cached briefly so unauthenticated requests cannot spend
  // the host's per-company secret-resolve budget, which private keys share.
  const webhookSecrets = new Map<string, { secretId: string; value: string; expires: number }>();
  async function webhookSecretValue(companyId: string, ref: EnvSecretRefBinding): Promise<string> {
    const cached = webhookSecrets.get(companyId);
    if (cached && cached.secretId === ref.secretId && cached.expires > Date.now()) return cached.value;
    const value = await ctx.secrets.resolve(ref, { companyId, configPath: "webhookSecret" });
    webhookSecrets.set(companyId, { secretId: ref.secretId, value, expires: Date.now() + 60_000 });
    return value;
  }
  // A company may use its configured App only while the instance registry
  // reserves that App ID for it. Only company-app.connect writes a reservation,
  // after verifying the key, so a config save alone never grants App access.
  async function checkConnection(companyId: string): Promise<{ state: ConnectionState; config?: ConfigConnection }> {
    if (await ctx.state.get(disconnectedKey(companyId)) === true) return { state: "disconnected" };
    const config = await ctx.config.get(companyId);
    if (typeof config.appId !== "string" || !isSecretRef(config.privateKey)) return { state: "not-configured" };
    if ((await appRegistry())[config.appId] !== companyId) return { state: "not-connected" };
    return { state: "connected", config: {
      appId: config.appId,
      appSlug: typeof config.appSlug === "string" ? config.appSlug : `app-${config.appId}`,
      appName: typeof config.appName === "string" ? config.appName : `GitHub App ${config.appId}`,
      privateKey: config.privateKey,
      ...(isSecretRef(config.webhookSecret) ? { webhookSecret: config.webhookSecret } : {}),
    } };
  }
  async function connection(companyId: string): Promise<ConfigConnection | null> {
    return (await checkConnection(companyId)).config ?? null;
  }
  /** Rebuilt from persisted state on every call, so a restarted worker needs no config replay. */
  async function connectedConfigs(): Promise<Array<{ companyId: string; config: ConfigConnection }>> {
    const connected: Array<{ companyId: string; config: ConfigConnection }> = [];
    for (const companyId of new Set(Object.values(await appRegistry()))) {
      try {
        const config = await connection(companyId);
        if (config) connected.push({ companyId, config });
      } catch (error) {
        ctx.logger.warn("GitHub company connection check failed", { companyId, error: error instanceof Error ? error.message : "unknown" });
      }
    }
    return connected;
  }
  async function connectedCompanies(): Promise<string[]> {
    return (await connectedConfigs()).map(entry => entry.companyId);
  }
  async function allowedOwners(companyId: string): Promise<AllowedOwner[]> {
    // allowed-owners.set is the only writer and always pins numeric account IDs.
    // Anything else, including legacy login-only state, fails closed.
    const pinned = normalizeAllowedOwnerRecords(await ctx.state.get(ownersKey(companyId)));
    return pinned.length && pinned.every(owner => owner.id > 0) ? pinned : [];
  }
  function ownersResult(companyId: string, owners: readonly AllowedOwner[]) {
    return { companyId, owners: owners.map(owner => owner.login), accounts: owners.map(owner => ({ id: owner.id, login: owner.login })) };
  }
  async function credentials(companyId: string) {
    const config = await connection(companyId);
    if (!config) throw new Error("Connect a GitHub App for this company first.");
    const pem = await ctx.secrets.resolve(config.privateKey, { companyId, configPath: "privateKey" });
    return { id: config.appId, pem, allowedOwners: await allowedOwners(companyId) };
  }
  // Managed git/gh asks the write identity for a decision on every command, and
  // secret resolution is rate limited per company, so that path keeps the App
  // key for one minute. Connection changes clear it.
  const keys = new Map<string, { expires: number; value: ReturnType<typeof credentials> }>();
  function identityCredentials(companyId: string): ReturnType<typeof credentials> {
    const cached = keys.get(companyId);
    if (cached && cached.expires > Date.now()) return cached.value;
    const value = credentials(companyId);
    keys.set(companyId, { expires: Date.now() + 60_000, value });
    value.catch(() => { if (keys.get(companyId)?.value === value) keys.delete(companyId); });
    return value;
  }
  async function appRegistry(): Promise<AppRegistry> {
    const stored = await ctx.state.get(appRegistryKey);
    return stored && typeof stored === "object" ? { ...(stored as AppRegistry) } : {};
  }
  function updateRegistry(change: (registry: AppRegistry) => boolean): Promise<void> {
    const operation = registryQueue.catch(() => {}).then(async () => {
      const registry = await appRegistry();
      if (change(registry)) await ctx.state.set(appRegistryKey, registry);
    });
    registryQueue = operation.then(() => {}, () => {});
    return operation;
  }
  function reserveAppId(companyId: string, appId: string): Promise<void> {
    return updateRegistry(registry => {
      const owner = registry[appId];
      if (owner && owner !== companyId) throw new Error(`GitHub App ${appId} is already connected to another company.`);
      for (const [registeredId, registeredCompany] of Object.entries(registry)) {
        if (registeredCompany === companyId && registeredId !== appId) delete registry[registeredId];
      }
      registry[appId] = companyId;
      return true;
    });
  }
  function removeCompanyApps(companyId: string): Promise<void> {
    return updateRegistry(registry => {
      let changed = false;
      for (const [appId, registeredCompany] of Object.entries(registry)) {
        if (registeredCompany === companyId) { delete registry[appId]; changed = true; }
      }
      return changed;
    });
  }
  /**
   * Config-change hook. It never changes the App registry: access is decided at
   * read time, and only connect, disconnect and release change reservations.
   */
  async function reconcileConfig(companyId: string): Promise<void> {
    webhookSecrets.delete(companyId);
    keys.delete(companyId);
    cache.invalidate(companyId);
    if ((await checkConnection(companyId)).state === "not-connected") {
      ctx.logger.warn("GitHub App config is not connected for this company; run company-app.connect", { companyId });
    }
  }
  /**
   * Authenticate before any key load or GitHub call: only a request signed with
   * a connected company's webhook secret reaches installation lookup, and only
   * with that company's App. Every rejection returns the same message.
   */
  async function authenticateWebhook(input: PluginWebhookInput): Promise<string> {
    const signature = header(input.headers, "x-hub-signature-256");
    if (!signature || !/^sha256=[0-9a-f]{64}$/.test(signature)) throw new Error(WEBHOOK_REJECTED);
    const signed: string[] = [];
    for (const { companyId, config } of await connectedConfigs()) {
      if (!config.webhookSecret) continue;
      try {
        if (verifyGitHubSignature(input.rawBody, signature, await webhookSecretValue(companyId, config.webhookSecret))) signed.push(companyId);
      } catch (error) {
        ctx.logger.warn("GitHub webhook secret unavailable", { companyId, error: error instanceof Error ? error.message : "unknown" });
      }
    }
    const payload = input.parsedBody && typeof input.parsedBody === "object" ? input.parsedBody as Record<string, unknown> : {};
    const installation = payload.installation && typeof payload.installation === "object" ? payload.installation as Record<string, unknown> : {};
    const installationId = Number(installation.id);
    if (signed.length && Number.isSafeInteger(installation.id) && installationId > 0) {
      for (const companyId of signed) {
        try {
          const auth = await credentials(companyId);
          if (await github.hasInstallation(auth.id, auth.pem, installationId)) return companyId;
        } catch (error) {
          ctx.logger.warn("GitHub webhook installation check failed", { companyId, error: error instanceof Error ? error.message : "unknown" });
        }
      }
    }
    ctx.logger.warn("GitHub webhook rejected", { signedCompanies: signed.length });
    throw new Error(WEBHOOK_REJECTED);
  }
  const cache = new GitHubReadCache();
  const loadCatalog = async (companyId: string, refresh = false) => cache.catalog(companyId, await credentials(companyId), github, refresh);
  // Reads and the issue mirror use the App; writes follow the company's write identity.
  const identity = registerWriteIdentity(ctx, github, identityCredentials,
    async companyId => cache.catalog(companyId, await identityCredentials(companyId), github), undefined,
    companyId => cache.invalidate(companyId));
  // I-RO: a company that writes as its App's user has an App that only reads,
  // so every installation token of that App is read-only and fenced. An App ID
  // is reserved for one company; an unreadable policy throws, which the client
  // treats as an App-user company with an empty fence. Other companies keep
  // their App's write tokens.
  github.appUserFence = async appId => {
    const companyId = (await appRegistry())[appId];
    return companyId === undefined ? null : identity.appUserFence(companyId);
  };
  const sources = registerTaskIssues(ctx, github, credentials, cache, async companyId => Boolean(await connection(companyId)));
  const sync = registerSync(ctx, github, credentials, sources, companyId => cache.invalidate(companyId),
    { connected: connectedCompanies, state: async companyId => (await checkConnection(companyId)).state },
    { writeToken: identity.writeToken, maintain: identity.maintain });
  registerTaskLinks(ctx, github, credentials, cache, sync.linkForTask);
  registerRecordTasks(ctx, github, credentials, cache, sync.ensureTasks);
  registerManagement(ctx, github, credentials, sync.requestSync, cache, sync.ensureTasks, identity.writeToken, identity.appUser);
  // Native Paperclip owns Agent Channels and GitHub bot identity. The legacy
  // mapping actions remain registered for state migration, but are not used by
  // reviewer or agent-facing actions.
  registerAgentBots(ctx);
  registerNativeGitHub(ctx);
  async function appStatus(companyId: string): Promise<Status> {
    const { state, config } = await checkConnection(companyId);
    const owners = await allowedOwners(companyId);
    const app: AppIdentity | null = config ? { id: config.appId, slug: config.appSlug, name: config.appName } : null;
    return { configured: !!config, connection: state, app, allowedOwners: owners.map(owner => owner.login) };
  }

  ctx.actions.register("company-app.status", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    return appStatus(companyId);
  });
  ctx.actions.register("company-app.connect", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    requireAdmin(actor);
    if ("privateKey" in params) throw new Error("company-app.connect accepts a Paperclip company secret ID, never a plaintext private key.");
    if (typeof params.appId !== "string" || !/^[1-9][0-9]*$/.test(params.appId.trim())) throw new Error("Enter a valid GitHub App ID.");
    if (typeof params.privateKeySecretId !== "string" || !params.privateKeySecretId.trim()) throw new Error("privateKeySecretId must reference an existing company secret.");
    const appId = params.appId.trim();
    const privateKey = secretRef(params.privateKeySecretId.trim());
    return serializeConnection(companyId, async () => {
      const configured = await ctx.config.get(companyId);
      if (configured.appId !== appId || !isSecretRef(configured.privateKey) || configured.privateKey.secretId !== privateKey.secretId) {
        throw new Error("Save this company’s GitHub App config before connecting it.");
      }
      const pem = await ctx.secrets.resolve(privateKey, { companyId, configPath: "privateKey" });
      const app = await github.verify(appId, pem);
      if (params.webhookSecretId !== undefined) {
        if (typeof params.webhookSecretId !== "string" || !params.webhookSecretId.trim()) throw new Error("webhookSecretId must reference an existing company secret.");
        if (!isSecretRef(configured.webhookSecret) || configured.webhookSecret.secretId !== params.webhookSecretId.trim()) {
          throw new Error("Save the webhook secret binding in this company’s plugin config before connecting it.");
        }
        await ctx.secrets.resolve(secretRef(params.webhookSecretId.trim()), { companyId, configPath: "webhookSecret" });
      }
      await reserveAppId(companyId, app.id);
      await ctx.state.delete(disconnectedKey(companyId));
      keys.delete(companyId);
      cache.invalidate(companyId);
      const owners = await allowedOwners(companyId);
      await ctx.activity.log({ companyId, message: "GitHub App connected", metadata: { appId: app.id } });
      return { configured: true, connection: "connected", app: { id: app.id, slug: app.slug, name: app.name }, allowedOwners: owners.map(owner => owner.login) } satisfies Status;
    });
  });
  ctx.actions.register("company-app.disconnect", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    requireAdmin(actor);
    return serializeConnection(companyId, async () => {
      // The flag alone already refuses the company, even if releasing the App ID below is interrupted.
      await ctx.state.set(disconnectedKey(companyId), true);
      await removeCompanyApps(companyId);
      webhookSecrets.delete(companyId);
      keys.delete(companyId);
      cache.invalidate(companyId);
      await ctx.activity.log({ companyId, message: "GitHub App disconnected" });
      return { configured: false, connection: "disconnected", app: null, allowedOwners: (await allowedOwners(companyId)).map(owner => owner.login) } satisfies Status;
    });
  });
  ctx.actions.register("company-app.release", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    requireAdmin(actor);
    if (typeof params.appId !== "string" || !/^[1-9][0-9]*$/.test(params.appId.trim())) throw new Error("Enter a valid GitHub App ID.");
    const appId = params.appId.trim();
    // Releases a reservation left by a deleted or abandoned company. Its former
    // owner, if it still exists, fails closed until it is connected again.
    let previousCompanyId: string | undefined;
    await updateRegistry(registry => { previousCompanyId = registry[appId]; delete registry[appId]; return previousCompanyId !== undefined; });
    const released = previousCompanyId !== undefined;
    await ctx.activity.log({ companyId, message: "GitHub App reservation released", metadata: { appId, released, ...(released ? { previousCompanyId } : {}) } });
    return { appId, released };
  });
  ctx.actions.register("allowed-owners.get", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    return ownersResult(companyId, await allowedOwners(companyId));
  });
  ctx.actions.register("allowed-owners.set", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    requireAdmin(actor);
    const requested = validateAllowedOwners(params.owners);
    const auth = requested.length ? await credentials(companyId) : null;
    const resolved = requested.length ? await github.resolveOwners(auth!.id, auth!.pem, requested) : [];
    await ctx.state.set(ownersKey(companyId), resolved);
    cache.invalidate(companyId);
    await ctx.activity.log({ companyId, message: "GitHub owner allowlist updated", metadata: { ownerCount: resolved.length } });
    return ownersResult(companyId, resolved);
  });
  ctx.actions.register("repositories.list", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    const auth = await credentials(companyId);
    const catalog = await cache.catalog(companyId, auth, github, params.refresh === true);
    return catalog;
  });
  ctx.actions.register("sync.trigger", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    if (!await connection(companyId)) throw new Error("Connect a GitHub App for this company first.");
    return { ...await sync.queueSync(companyId, params.refresh === true), companyId };
  });

  ctx.actions.register("install-github-workflow-skill", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    return ctx.skills.managed.reconcile("github-review-workflow", companyId);
  });
  ctx.actions.register("github-workflow-skill-status", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    return ctx.skills.managed.get("github-review-workflow", companyId);
  });
  registerAgentTools(ctx, github, credentials, loadCatalog, identity.writeToken);
  async function linkedNames(companyId: string, params: Record<string, unknown>, companyWide = false): Promise<string[]> {
    let projectId = typeof params.projectId === "string" ? params.projectId : null;
    if (typeof params.issueId === "string") {
      const issue = await ctx.issues.get(params.issueId, companyId);
      if (!issue || issue.companyId !== companyId) throw new Error("This task is not available in this company.");
      projectId = issue.projectId;
    }
    if (!projectId) {
      if (!companyWide || params.issueId !== undefined || params.projectId !== undefined) return [];
      const names = new Map<string, string>();
      for (let offset = 0; ; offset += 100) {
        const projects = await ctx.projects.list({ companyId, limit: 100, offset });
        for (const project of projects) {
          if (project.companyId !== companyId) throw new Error("This project is not available in this company.");
          for (const workspace of await ctx.projects.listWorkspaces(project.id, companyId)) {
            const name = workspace.repoUrl ? repoName(workspace.repoUrl) : null;
            if (name) names.set(name.toLowerCase(), name);
          }
        }
        if (projects.length < 100) break;
      }
      return [...names.values()];
    }
    const project = await ctx.projects.get(projectId, companyId);
    if (!project || project.companyId !== companyId) throw new Error("This project is not available in this company.");
    const workspaces = await ctx.projects.listWorkspaces(projectId, companyId);
    return [...new Set(workspaces.flatMap(w => { const name = w.repoUrl ? repoName(w.repoUrl) : null; return name ? [name] : []; }))];
  }
  ctx.actions.register("start-setup", (params, actor) => setup.start(params, actor));
  ctx.actions.register("complete-setup", (params, actor) => setup.complete(params, actor));
  ctx.actions.register("verify-manual", async (params, actor) => {
    boardScope(params, actor);
    if (typeof params.appId !== "string" || typeof params.privateKey !== "string" || params.privateKey.length > 30_000) throw new Error("Enter an App ID and its PEM private key.");
    return github.verify(params.appId.trim(), params.privateKey.trim());
  });
  ctx.actions.register("status", async (params, actor): Promise<Status> => {
    const { companyId } = boardScope(params, actor);
    return appStatus(companyId);
  });
  ctx.actions.register("catalog", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    return cache.catalog(companyId, await credentials(companyId), github, params.refresh === true);
  });
  ctx.actions.register("project-repositories", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    const connected = await connection(companyId);
    if (!connected) return { repositories: [], connectionCount: 0, failedConnectionCount: 0 };
    const catalog = await cache.catalog(companyId, await credentials(companyId), github, params.refresh === true);
    const warnings = [...catalog.warnings, ...(catalog.truncated ? ["GitHub repository results were limited. Check the App’s repository access."] : [])];
    return {
      repositories: catalog.repositories.map(repo => ({ id: String(repo.id), fullName: repo.fullName, url: repo.url, private: repo.private, connections: [catalog.app.name] })),
      connectionCount: 1, failedConnectionCount: catalog.warnings.length ? 1 : 0, warnings,
    };
  });
  ctx.actions.register("linked-repositories", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    const names = await linkedNames(companyId, params, true);
    if (!names.length) return { repositories: [], warnings: [], linkedCount: 0, truncated: false };
    const catalog = await cache.catalog(companyId, await credentials(companyId), github, params.refresh === true);
    const repositories = catalog.repositories.filter(r => names.some(n => n.toLowerCase() === r.fullName.toLowerCase()));
    const unavailable = names.filter(n => !repositories.some(r => r.fullName.toLowerCase() === n.toLowerCase()));
    return { repositories, linkedCount: names.length, truncated: catalog.truncated,
      warnings: [...catalog.warnings, ...unavailable.map(n => `${n} is not available to this App. Check repository access or unlink it in this project’s settings.`)] };
  });
  ctx.actions.register("issues", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    const page = params.page ?? 1;
    if (!Number.isSafeInteger(page) || Number(page) < 1 || Number(page) > 10000) throw new Error("Invalid issue page.");
    const state = params.state ?? "open";
    if (state !== "open" && state !== "closed" && state !== "all") throw new Error("Invalid issue filter.");
    const names = await linkedNames(companyId, params);
    const auth = await credentials(companyId), { id, pem } = auth;
    const catalog = await cache.catalog(companyId, auth, github, params.refresh === true);
    const repository = catalog.repositories.find(r => r.id === params.repositoryId && names.some(n => n.toLowerCase() === r.fullName.toLowerCase()));
    if (!repository) throw new Error("This repository is not linked to the project or is no longer accessible. Refresh repository access.");
    const result = await cache.read(companyId, { id, pem }, ["issues", repository.id, Number(page), state], () => github.issues(id, pem, repository, Number(page), state), params.refresh === true);
    const refs = await sync.ensureTasks(companyId, repository, result.data.issues);
    return { ...result.data, cache: result.cache, issues: result.data.issues.map(issue => ({ ...issue, ...refs.get(issue.id) })) };
  });
  async function receiveWebhook(input: PluginWebhookInput) {
    if (input.endpointKey !== "github") throw new Error("Unknown GitHub webhook endpoint.");
    const companyId = await authenticateWebhook(input);
    const delivery = header(input.headers, "x-github-delivery") ?? input.requestId;
    try {
      return { companyId, result: await sync.handleWebhook({ companyId, headers: input.headers, parsedBody: input.parsedBody, requestId: delivery }) };
    } catch (error) {
      ctx.logger.error("GitHub webhook processing failed", { companyId, error: error instanceof Error ? error.message : "unknown" });
      throw new Error("GitHub webhook processing failed.");
    }
  }
  async function health(): Promise<PluginHealthDiagnostics> {
    const connected = (await connectedCompanies()).length;
    return connected
      ? { status: "ok", message: `GitHub plugin is running for ${connected} connected ${connected === 1 ? "company" : "companies"}.`, details: { connectedCompanies: connected } }
      : { status: "ok", message: "GitHub plugin is running. No company has a connected GitHub App, so scheduled sync is idle.", details: { connectedCompanies: 0 } };
  }
  return { ...sync, connectedCompanies, invalidateCache: (companyId?: string | null) => cache.invalidate(companyId), reconcileConfig, receiveWebhook, health };
}
let runtime: ReturnType<typeof register> | undefined;
const plugin = definePlugin({
  multiCompanyConfig: true,
  async setup(ctx) { runtime = register(ctx); },
  async onWebhook(input: PluginWebhookInput) {
    if (!runtime) throw new Error(WEBHOOK_REJECTED);
    await runtime.receiveWebhook(input);
  },
  async onConfigChanged(_config, context) {
    if (context?.companyId) await runtime?.reconcileConfig(context.companyId);
  },
  async onHealth() {
    return runtime ? runtime.health() : { status: "degraded", message: "GitHub plugin is starting." };
  }
});
export default plugin;
runWorker(plugin, import.meta.url);
