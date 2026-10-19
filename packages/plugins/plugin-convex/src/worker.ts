import { definePlugin, runWorker, type PluginContext, type PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { registerAgentTools } from "./agent-tools.js";
import { ConvexClient, type FetchLike } from "./convex-client.js";
import { GitHubReader } from "./github-reader.js";
import { Refusal } from "./preview-guard.js";
import { ConfigError, parseConfig } from "./config.js";
import { PASS_BUDGET_MS, REAPER_OFF_MESSAGE, reportKey, runReaper } from "./reaper.js";
import { ConvexService, isShowable, LIST_MAX, type Actor } from "./service.js";
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
    catch (error) {
      // The same fields as below, empty, so a caller never has to know which branch it got.
      return {
        connection: "not-configured", configError: error instanceof ConfigError ? error.message : "The Convex config is invalid.", teamId: null, projects: [],
        credentials: null, grants: null, guards: null, reaper: null, lastReport: null,
      };
    }
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
      ...(typeof params.limit === "number" && Number.isFinite(params.limit) ? { limit: Math.min(LIST_MAX, Math.max(1, Math.trunc(params.limit))) } : {}),
      ...(typeof params.cursor === "string" && params.cursor.length <= 128 ? { cursor: params.cursor } : {}),
    });
  });
  action("deployments.delete-preview", async (params, context) => {
    const { companyId, userId } = boardScope(params, context);
    requireAdmin(context);
    const { config, reserved } = await service.requireConnected(companyId);
    // Only an explicit `dryRun: false` deletes, here and in the reaper action; a missing flag is a plan.
    return service.deletePreview(boardActor(companyId, userId), config, reserved, String(params.name ?? ""), { dryRun: params.dryRun !== false });
  });
  action("reaper.run", async (params, context) => {
    const { companyId, userId } = boardScope(params, context);
    const real = params.dryRun === false;
    if (real) {
      requireAdmin(context);
      if (!(await service.requireConnected(companyId)).config.reaper.enabled) throw new Refusal(REAPER_OFF_MESSAGE);
    }
    return runReaper(service, companyId, { trigger: "api", dryRun: !real, actor: boardActor(companyId, userId) });
  });
  action("reaper.report", async (params, context) => {
    const { companyId } = boardScope(params, context);
    return (await ctx.state.get(reportKey(companyId))) ?? null;
  });

  ctx.jobs.register("convex-reaper", async job => {
    // The host stops a job after five minutes. The companies share one pass budget, the one whose report is oldest goes first, and the rest wait for the next hour.
    const endsAt = service.d.now() + PASS_BUDGET_MS;
    const last = new Map<string, string>();
    const companies = await service.connectedCompanies();
    for (const companyId of companies) last.set(companyId, ((await ctx.state.get(reportKey(companyId)).catch(() => null)) as ReaperReport | null)?.at ?? "");
    for (const companyId of companies.sort((a, b) => (last.get(a)! < last.get(b)! ? -1 : last.get(a)! > last.get(b)! ? 1 : 0))) {
      if (service.stopping || service.d.now() >= endsAt) break;
      try { await runReaper(service, companyId, { trigger: job.trigger, endsAt }); }
      catch (error) { ctx.logger.warn("Convex reaper failed for a company", { companyId, error: isShowable(error) ? error.message : "unknown" }); }
    }
  });

  return { service };
}

let service: ConvexService | null = null;
const plugin = definePlugin({
  multiCompanyConfig: true,
  async setup(ctx) { service = register(ctx).service; },
  async onHealth() { return { status: "ok", message: "Convex plugin is running." }; },
  // The same strict parse the plugin applies at call time, so a typo is reported when the config is saved, not when an agent first hits it.
  async onValidateConfig(config) {
    let parsed;
    try { parsed = parseConfig(config); }
    catch (error) { return { ok: false, errors: [error instanceof ConfigError ? error.message : "The Convex config is invalid."] }; }
    const warnings: string[] = [];
    if (parsed.reaper.enabled && parsed.guards.dryRunOnly) warnings.push("reaper.enabled is on, but guards.dryRunOnly holds every pass to a dry run.");
    for (const [index, grant] of parsed.grants.entries()) if (grant.role) warnings.push(`grants[${index}] applies to every agent with the role "${grant.role}", including agents added later.`);
    return { ok: true, ...(warnings.length ? { warnings } : {}) };
  },
  // Stop starting destructive work; a write already sent to Convex is allowed to finish.
  async onShutdown() { if (service) service.stopping = true; },
});
export default plugin;
runWorker(plugin, import.meta.url);
