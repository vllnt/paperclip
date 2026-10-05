import { definePlugin, runWorker, type EnvSecretRefBinding, type PluginContext, type PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { GitHubClient, repoName } from "./github.js";
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

export function register(ctx: PluginContext, github = new GitHubClient()) {
  const setup = new SetupService(ctx, github);
  async function credentials(companyId: string) {
    const config = await ctx.config.get(companyId);
    if (typeof config.appId !== "string" || !config.privateKey) throw new Error("Connect a GitHub App in the GitHub plugin first.");
    const pem = await ctx.secrets.resolve(config.privateKey as EnvSecretRefBinding, { companyId, configPath: "privateKey" });
    return { id: config.appId, pem };
  }
  const cache = new GitHubReadCache();
  const sources = registerTaskIssues(ctx, github, credentials, cache);
  const sync = registerSync(ctx, github, credentials, sources, companyId => cache.invalidate(companyId));
  registerTaskLinks(ctx, github, credentials, cache, sync.linkForTask);
  registerRecordTasks(ctx, github, credentials, cache, sync.ensureTasks);
  registerManagement(ctx, github, credentials, sync.sync, cache, sync.ensureTasks);
  // Native Paperclip owns Agent Channels and GitHub bot identity. The legacy
  // mapping actions remain registered for state migration, but are not used by
  // reviewer or agent-facing actions.
  registerAgentBots(ctx);
  registerNativeGitHub(ctx);
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
    const config = await ctx.config.get(companyId);
    const configured = !!config.appId && !!config.privateKey;
    const app: AppIdentity | null = configured ? { id: String(config.appId), slug: String(config.appSlug ?? ""), name: String(config.appName ?? "GitHub App") } : null;
    return { configured, app };
  });
  ctx.actions.register("catalog", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    const { id, pem } = await credentials(companyId);
    return cache.catalog(companyId, { id, pem }, github, params.refresh === true);
  });
  ctx.actions.register("project-repositories", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    const config = await ctx.config.get(companyId);
    if (!config.appId || !config.privateKey) return { repositories: [], connectionCount: 0, failedConnectionCount: 0 };
    const { id, pem } = await credentials(companyId);
    const catalog = await cache.catalog(companyId, { id, pem }, github, params.refresh === true);
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
    const catalog = await cache.catalog(companyId, { id, pem }, github, params.refresh === true);
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
    const catalog = await cache.catalog(companyId, { id, pem }, github, params.refresh === true);
    const repository = catalog.repositories.find(r => r.id === params.repositoryId && names.some(n => n.toLowerCase() === r.fullName.toLowerCase()));
    if (!repository) throw new Error("This repository is not linked to the project or is no longer accessible. Refresh repository access.");
    const result = await cache.read(companyId, { id, pem }, ["issues", repository.id, Number(page), state], () => github.issues(id, pem, repository, Number(page), state), params.refresh === true);
    const refs = await sync.ensureTasks(companyId, repository, result.data.issues);
    return { ...result.data, cache: result.cache, issues: result.data.issues.map(issue => ({ ...issue, ...refs.get(issue.id) })) };
  });
  return { ...sync, invalidateCache: (companyId?: string | null) => cache.invalidate(companyId) };
}
let runtime: ReturnType<typeof register> | undefined;
let pluginContext: PluginContext | undefined;
const plugin = definePlugin({
  async setup(ctx) { pluginContext = ctx; runtime = register(ctx); },
  async onWebhook(input: PluginWebhookInput) {
    if (input.endpointKey !== "github") throw new Error("Unknown GitHub webhook endpoint.");
    if (!runtime || !pluginContext) return;
    const deliveries = input.headers;
    const delivery = header(deliveries, "x-github-delivery") ?? input.requestId;
    const payload = input.parsedBody && typeof input.parsedBody === "object" ? input.parsedBody as Record<string, unknown> : {};
    const installation = payload.installation && typeof payload.installation === "object" ? payload.installation as Record<string, unknown> : {};
    const appId = installation.app_id === undefined ? undefined : String(installation.app_id);
    let matchedConfig = false;
    for (let offset = 0; ; offset += 100) {
      const companies = await pluginContext.companies.list({ limit: 100, offset });
      for (const company of companies) {
        const config = await pluginContext.config.get(company.id);
        if (appId !== undefined && String(config.appId ?? "") !== appId) continue;
        matchedConfig = true;
        let secret: string | undefined;
        if (config.webhookSecret) secret = await pluginContext.secrets.resolve(config.webhookSecret as EnvSecretRefBinding, { companyId: company.id, configPath: "webhookSecret" });
        if (!verifyGitHubSignature(input.rawBody, header(deliveries, "x-hub-signature-256"), secret)) throw new Error("GitHub webhook signature verification failed.");
        // The sync bridge resolves the repository to its owning Paperclip company.
        await runtime.handleWebhook({ headers: deliveries, parsedBody: input.parsedBody, requestId: delivery });
        return;
      }
      if (companies.length < 100) break;
    }
    // Unknown app installations are ignored after signature validation. With no
    // configured secret, this preserves compatibility with older App installs.
    if (!matchedConfig && !verifyGitHubSignature(input.rawBody, header(deliveries, "x-hub-signature-256"), undefined)) throw new Error("GitHub webhook signature verification failed.");
  },
  async onConfigChanged(_config, context) { runtime?.invalidateCache(context?.companyId); },
  async onHealth() { return { status: "ok", message: "GitHub plugin is running. Use Refresh access to verify the GitHub connection." }; }
});
export default plugin;
runWorker(plugin, import.meta.url);
