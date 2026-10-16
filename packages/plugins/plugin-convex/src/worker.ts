import { definePlugin, runWorker, type PluginContext, type PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { registerAgentTools } from "./agent-tools.js";
import { ConvexClient, type FetchLike } from "./convex-client.js";
import { GitHubReader } from "./github-reader.js";
import { Refusal } from "./preview-guard.js";
import { reportKey, runReaper } from "./reaper.js";
import { ConvexService, isShowable, type Actor } from "./service.js";
import type { ReaperReport } from "./contracts.js";

export interface WorkerDeps { fetch?: FetchLike; githubFetch?: FetchLike; now?: () => number }

/** Board actions: a board user of the company the host authorised. Agents use the tools instead. */
function boardScope(params: Record<string, unknown>, context: PluginPerformActionContext): { companyId: string; userId: string | null } {
  if (context.actor.type !== "user" || !context.companyId || context.actor.companyId !== context.companyId || params.companyId !== context.companyId) {
    throw new Refusal("Open this plugin as a Paperclip board user in the selected company.");
  }
  return { companyId: context.companyId, userId: context.actor.userId };
}
function requireAdmin(context: PluginPerformActionContext): void {
  if (context.actor.type !== "user" || context.actor.isInstanceAdmin !== true) throw new Refusal("Instance administrator access is required for this Convex change.");
}

export function register(ctx: PluginContext, deps: WorkerDeps = {}) {
  const service = new ConvexService({
    ctx, now: deps.now ?? Date.now,
    convex: new ConvexClient(deps.fetch ?? ((url, init) => ctx.http.fetch(url, init))),
    github: new GitHubReader(deps.githubFetch ?? ((url, init) => ctx.http.fetch(url, init))),
  });
  registerAgentTools(ctx, service);

  /** Action errors reach the board; only guard and Convex messages (which carry no credential) pass through. */
  function action(key: string, handler: (params: Record<string, unknown>, context: PluginPerformActionContext) => Promise<unknown>) {
    ctx.actions.register(key, async (params, context) => {
      try { return await handler(params, context); }
      catch (error) {
        if (isShowable(error)) throw error;
        ctx.logger.error("Convex action failed", { key, error: error instanceof Error ? error.name : "unknown" });
        throw new Error("The Convex action failed.");
      }
    });
  }
  const boardActor = (companyId: string, userId: string | null): Actor => ({ kind: "board", companyId, userId });

  action("status", async (params, context) => {
    const { companyId } = boardScope(params, context);
    let state;
    try { state = await service.connectionState(companyId); }
    catch (error) { return { connection: "not-configured", configError: error instanceof Error ? error.message : "Invalid config.", projects: [], lastReport: null }; }
    const { config } = state;
    const last = await ctx.state.get(reportKey(companyId)) as ReaperReport | null;
    return {
      connection: state.state, teamId: config?.teamId ?? null,
      projects: (config?.projects ?? []).map(project => ({ convexProjectId: project.convexProjectId, name: project.name, repository: project.repository, paperclipProjectId: project.paperclipProjectId, reserved: state.reserved.has(project.convexProjectId) })),
      credentials: { teamToken: !!config?.teamToken, github: !!config?.githubToken },
      grants: config?.grants.length ?? 0, guards: config?.guards ?? null, reaper: config?.reaper ?? null,
      lastReport: last ? { at: last.at, dryRun: last.dryRun, quota: last.quota } : null,
    };
  });
  action("connection.connect", async (params, context) => {
    const { companyId } = boardScope(params, context);
    requireAdmin(context);
    return service.connect(companyId);
  });
  action("connection.disconnect", async (params, context) => {
    const { companyId } = boardScope(params, context);
    requireAdmin(context);
    await service.disconnect(companyId);
    return { connection: "disconnected" };
  });
  action("deployments.list", async (params, context) => {
    const { companyId, userId } = boardScope(params, context);
    const { config, reserved } = await service.requireConnected(companyId);
    return service.listDeployments(boardActor(companyId, userId), config, reserved, {
      ...(typeof params.convexProjectId === "string" ? { convexProjectId: params.convexProjectId } : {}),
      ...(typeof params.deploymentType === "string" ? { deploymentType: params.deploymentType } : {}),
    });
  });
  action("deployments.delete-preview", async (params, context) => {
    const { companyId, userId } = boardScope(params, context);
    requireAdmin(context);
    const { config, reserved } = await service.requireConnected(companyId);
    return service.deletePreview(boardActor(companyId, userId), config, reserved, String(params.name ?? ""), { dryRun: params.dryRun === true });
  });
  action("reaper.run", async (params, context) => {
    const { companyId, userId } = boardScope(params, context);
    const real = params.dryRun === false;
    if (real) {
      requireAdmin(context);
      if (!(await service.requireConnected(companyId)).config.reaper.enabled) throw new Refusal("Enable the reaper (reaper.enabled) in this company's Convex config before a real run.");
    }
    return runReaper(service, companyId, { trigger: "api", dryRun: !real, actor: boardActor(companyId, userId) });
  });
  action("reaper.report", async (params, context) => {
    const { companyId } = boardScope(params, context);
    return (await ctx.state.get(reportKey(companyId))) ?? null;
  });

  ctx.jobs.register("convex-reaper", async job => {
    for (const companyId of await service.connectedCompanies()) {
      try { await runReaper(service, companyId, { trigger: job.trigger }); }
      catch (error) { ctx.logger.warn("Convex reaper failed for a company", { companyId, error: isShowable(error) ? error.message : "unknown" }); }
    }
  });

  return { service };
}

const plugin = definePlugin({
  multiCompanyConfig: true,
  async setup(ctx) { register(ctx); },
  async onHealth() { return { status: "ok", message: "Convex plugin is running." }; },
});
export default plugin;
runWorker(plugin, import.meta.url);
