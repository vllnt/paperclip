import { definePlugin, runWorker, type EnvSecretRefBinding, type PluginContext, type PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { GitHubClient, normalizeAllowedOwners, repoName, validateAllowedOwners } from "./github.js";
import { GitHubReadCache } from "./read-cache.js";
import { registerRecordTasks } from "./pr-tasks.js";
import { registerTaskLinks } from "./task-links.js";
import { registerManagement } from "./management.js";
import { registerSync } from "./sync.js";
import { registerTaskIssues } from "./task-issues.js";
import { SetupService, boardScope } from "./setup.js";
import { registerAgentBots } from "./agent-bots.js";
import { registerAgentTools } from "./agent-tools.js";
import { registerNativeGitHub } from "./native-github.js";
import type { AppIdentity, Status } from "./contracts.js";
import { header, verifyGitHubSignature } from "./github-webhooks.js";

const connectionKey = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "connection", stateKey: "app" });
const disconnectedKey = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "connection", stateKey: "disconnected" });
const ownersKey = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "connection", stateKey: "allowed-owners" });
type StoredConnection = { appId: string; appSlug: string; appName: string; privateKey: EnvSecretRefBinding; webhookSecret?: EnvSecretRefBinding };
let activeConfiguredCompanyIds: Set<string> | undefined;

function secretRef(secretId: string): EnvSecretRefBinding {
  return { type: "secret_ref", secretId, version: "latest" };
}
function isSecretRef(value: unknown): value is EnvSecretRefBinding {
  return !!value && typeof value === "object" && (value as any).type === "secret_ref" && typeof (value as any).secretId === "string";
}

export function register(ctx: PluginContext, github = new GitHubClient()) {
  const setup = new SetupService(ctx, github);
  const configuredCompanyIds = new Set<string>();
  async function connection(companyId: string): Promise<StoredConnection | null> {
    configuredCompanyIds.add(companyId);
    const disconnected = await ctx.state.get(disconnectedKey(companyId));
    if (disconnected === true) return null;
    const stored = await ctx.state.get(connectionKey(companyId)) as StoredConnection | null;
    if (stored && typeof stored.appId === "string" && isSecretRef(stored.privateKey)) return stored;
    // The old instance-level config is safe only while this worker has one
    // company in its host-authorized scope. A second company must connect its
    // own App through company-app.connect instead of inheriting the fallback.
    if (configuredCompanyIds.size !== 1) return null;
    const config = await ctx.config.get(companyId);
    if (typeof config.appId !== "string" || !isSecretRef(config.privateKey)) return null;
    return {
      appId: config.appId,
      appSlug: typeof config.appSlug === "string" ? config.appSlug : "",
      appName: typeof config.appName === "string" ? config.appName : "GitHub App",
      privateKey: config.privateKey,
      ...(isSecretRef(config.webhookSecret) ? { webhookSecret: config.webhookSecret } : {}),
    };
  }
  async function allowedOwners(companyId: string): Promise<string[] | undefined> {
    const stored = await ctx.state.get(ownersKey(companyId));
    if (stored !== null && stored !== undefined) return normalizeAllowedOwners(stored);
    // A newly connected company has an explicit connection state. Until its
    // owner list is set, fail closed. A company that still uses the old
    // instance-level config keeps its legacy behavior until it migrates.
    const config = await ctx.config.get(companyId);
    if (config.allowedOwners !== undefined) return normalizeAllowedOwners(config.allowedOwners);
    const storedConnection = await ctx.state.get(connectionKey(companyId));
    if (storedConnection) return [];
    return undefined;
  }
  async function credentials(companyId: string) {
    const config = await connection(companyId);
    if (!config) throw new Error("Connect a GitHub App for this company first.");
    const pem = await ctx.secrets.resolve(config.privateKey, { companyId, configPath: "privateKey" });
    const owners = await allowedOwners(companyId);
    return { id: config.appId, pem, ...(owners === undefined ? {} : { allowedOwners: owners }) };
  }
  const cache = new GitHubReadCache();
  const sources = registerTaskIssues(ctx, github, credentials, cache, async companyId => Boolean(await connection(companyId)));
  const sync = registerSync(ctx, github, credentials, sources, companyId => cache.invalidate(companyId), () => [...configuredCompanyIds]);
  registerTaskLinks(ctx, github, credentials, cache, sync.linkForTask);
  registerRecordTasks(ctx, github, credentials, cache, sync.ensureTasks);
  registerManagement(ctx, github, credentials, sync.sync, cache, sync.ensureTasks);
  // Native Paperclip owns Agent Channels and GitHub bot identity. The legacy
  // mapping actions remain registered for state migration, but are not used by
  // reviewer or agent-facing actions.
  registerAgentBots(ctx);
  registerNativeGitHub(ctx);
  function requireAdmin(context: import("@paperclipai/plugin-sdk").PluginPerformActionContext): void {
    if (context.actor.type !== "user" || context.actor.isInstanceAdmin !== true) {
      throw new Error("Instance administrator access is required for GitHub connection changes.");
    }
  }
  async function appStatus(companyId: string): Promise<Status> {
    const config = await connection(companyId);
    const owners = await allowedOwners(companyId);
    const app: AppIdentity | null = config ? { id: config.appId, slug: config.appSlug, name: config.appName } : null;
    return { configured: !!config, app, allowedOwners: owners ?? [] };
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
    const privateKey = secretRef(params.privateKeySecretId.trim());
    const pem = await ctx.secrets.resolve(privateKey, { companyId, configPath: "privateKey" });
    const app = await github.verify(params.appId.trim(), pem);
    let webhookSecret: EnvSecretRefBinding | undefined;
    if (params.webhookSecretId !== undefined) {
      if (typeof params.webhookSecretId !== "string" || !params.webhookSecretId.trim()) throw new Error("webhookSecretId must reference an existing company secret.");
      webhookSecret = secretRef(params.webhookSecretId.trim());
      await ctx.secrets.resolve(webhookSecret, { companyId, configPath: "webhookSecret" });
    }
    await ctx.state.set(connectionKey(companyId), { appId: app.id, appSlug: app.slug, appName: app.name, privateKey, ...(webhookSecret ? { webhookSecret } : {}) } satisfies StoredConnection);
    await ctx.state.delete(disconnectedKey(companyId));
    configuredCompanyIds.add(companyId); cache.invalidate(companyId);
    await ctx.activity.log({ companyId, message: "GitHub App connected", metadata: { appId: app.id } });
    return { configured: true, app: { id: app.id, slug: app.slug, name: app.name }, allowedOwners: (await allowedOwners(companyId)) ?? [] } satisfies Status;
  });
  ctx.actions.register("company-app.disconnect", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    requireAdmin(actor);
    await ctx.state.set(disconnectedKey(companyId), true);
    cache.invalidate(companyId);
    await ctx.activity.log({ companyId, message: "GitHub App disconnected" });
    return { configured: false, app: null, allowedOwners: (await allowedOwners(companyId)) ?? [] } satisfies Status;
  });
  ctx.actions.register("allowed-owners.get", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    return { companyId, owners: (await allowedOwners(companyId)) ?? [] };
  });
  ctx.actions.register("allowed-owners.set", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    requireAdmin(actor);
    const owners = validateAllowedOwners(params.owners);
    await ctx.state.set(ownersKey(companyId), owners);
    cache.invalidate(companyId);
    await ctx.activity.log({ companyId, message: "GitHub owner allowlist updated", metadata: { ownerCount: owners.length } });
    return { companyId, owners };
  });
  ctx.actions.register("repositories.list", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    const auth = await credentials(companyId);
    const catalog = await cache.catalog(companyId, auth, github, params.refresh === true);
    return catalog;
  });
  ctx.actions.register("sync.trigger", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    await credentials(companyId);
    if (params.refresh === true) cache.invalidate(companyId);
    void sync.sync(companyId).catch(() => {});
    return { started: true, companyId };
  });

  ctx.actions.register("install-github-workflow-skill", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    return ctx.skills.managed.reconcile("github-review-workflow", companyId);
  });
  ctx.actions.register("github-workflow-skill-status", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    return ctx.skills.managed.get("github-review-workflow", companyId);
  });
  registerAgentTools(ctx, github, credentials, async (companyId, refresh = false) => {
    const auth = await credentials(companyId);
    return cache.catalog(companyId, auth, github, refresh);
  });
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
    const { id, pem } = await credentials(companyId);
    return cache.catalog(companyId, { id, pem, allowedOwners: await allowedOwners(companyId) }, github, params.refresh === true);
  });
  ctx.actions.register("project-repositories", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    const connected = await connection(companyId);
    if (!connected) return { repositories: [], connectionCount: 0, failedConnectionCount: 0 };
    const { id, pem } = await credentials(companyId);
    const catalog = await cache.catalog(companyId, { id, pem, allowedOwners: await allowedOwners(companyId) }, github, params.refresh === true);
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
    const { id, pem } = await credentials(companyId);
    const catalog = await cache.catalog(companyId, { id, pem, allowedOwners: await allowedOwners(companyId) }, github, params.refresh === true);
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
    const { id, pem } = await credentials(companyId);
    const catalog = await cache.catalog(companyId, { id, pem, allowedOwners: await allowedOwners(companyId) }, github, params.refresh === true);
    const repository = catalog.repositories.find(r => r.id === params.repositoryId && names.some(n => n.toLowerCase() === r.fullName.toLowerCase()));
    if (!repository) throw new Error("This repository is not linked to the project or is no longer accessible. Refresh repository access.");
    const result = await cache.read(companyId, { id, pem }, ["issues", repository.id, Number(page), state], () => github.issues(id, pem, repository, Number(page), state), params.refresh === true);
    const refs = await sync.ensureTasks(companyId, repository, result.data.issues);
    return { ...result.data, cache: result.cache, issues: result.data.issues.map(issue => ({ ...issue, ...refs.get(issue.id) })) };
  });
  return { ...sync, companyIds: configuredCompanyIds, invalidateCache: (companyId?: string | null) => cache.invalidate(companyId) };
}
let runtime: ReturnType<typeof register> | undefined;
let pluginContext: PluginContext | undefined;
const plugin = definePlugin({
  multiCompanyConfig: true,
  async setup(ctx) { pluginContext = ctx; runtime = register(ctx); activeConfiguredCompanyIds = runtime.companyIds; },
  async onWebhook(input: PluginWebhookInput) {
    if (input.endpointKey !== "github") throw new Error("Unknown GitHub webhook endpoint.");
    if (!runtime || !pluginContext) return;
    const deliveries = input.headers;
    const delivery = header(deliveries, "x-github-delivery") ?? input.requestId;
    const payload = input.parsedBody && typeof input.parsedBody === "object" ? input.parsedBody as Record<string, unknown> : {};
    const installation = payload.installation && typeof payload.installation === "object" ? payload.installation as Record<string, unknown> : {};
    const appId = installation.app_id === undefined ? undefined : String(installation.app_id);
    let matchedConfig = false;
    for (const companyId of activeConfiguredCompanyIds ?? []) {
      if (await pluginContext.state.get(disconnectedKey(companyId)) === true) continue;
      const config = await pluginContext.config.get(companyId);
      const stored = await pluginContext.state.get(connectionKey(companyId)) as StoredConnection | null;
      if (appId !== undefined && String(stored?.appId ?? config.appId ?? "") !== appId) continue;
      matchedConfig = true;
      let secret: string | undefined;
      const secretRefValue = stored?.webhookSecret ?? config.webhookSecret;
      if (isSecretRef(secretRefValue)) secret = await pluginContext.secrets.resolve(secretRefValue, { companyId, configPath: "webhookSecret" });
      if (!verifyGitHubSignature(input.rawBody, header(deliveries, "x-hub-signature-256"), secret)) throw new Error("GitHub webhook signature verification failed.");
      await runtime.handleWebhook({ companyId, headers: deliveries, parsedBody: input.parsedBody, requestId: delivery });
      return;
    }
    // Unknown app installations are ignored after signature validation. With no
    // configured secret, this preserves compatibility with older App installs.
    if (!matchedConfig && !verifyGitHubSignature(input.rawBody, header(deliveries, "x-hub-signature-256"), undefined)) throw new Error("GitHub webhook signature verification failed.");
  },
  async onConfigChanged(config, context) {
    if (context?.companyId) {
      activeConfiguredCompanyIds?.add(context.companyId);
      runtime?.companyIds.add(context.companyId);
      // Startup and live config delivery are the host-authorized company list.
      // Never discover companies through a wildcard worker call.
      runtime?.invalidateCache(context.companyId);
    }
  },
  async onHealth() { return { status: "ok", message: "GitHub plugin is running. Use Refresh access to verify the GitHub connection." }; }
});
export default plugin;
runWorker(plugin, import.meta.url);
