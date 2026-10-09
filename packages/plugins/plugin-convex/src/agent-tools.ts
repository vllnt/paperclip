import type { PluginContext, ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import type { Capability } from "./contracts.js";
import { ConvexApiError } from "./convex-client.js";
import { runReaper } from "./reaper.js";
import { isShowable, type ConvexService } from "./service.js";

const NAME = { type: "string", minLength: 1, maxLength: 128, description: "Convex deployment name, for example happy-otter-123." };
const DRY_RUN = { type: "boolean", description: "Run every guard and report what would happen without changing anything." };
const schema = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: "object", additionalProperties: false, properties, required });

const reply = (data: unknown): ToolResult => ({ data, content: JSON.stringify(data) });
const failure = (ctx: PluginContext, tool: string, error: unknown): ToolResult => {
  if (isShowable(error)) return { error: error.message };
  ctx.logger.error("Convex tool failed", { tool, error: error instanceof Error ? error.name : "unknown" });
  return { error: "The Convex action failed." };
};
const record = (params: unknown): Record<string, unknown> => params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : {};

/**
 * Agent-facing Convex tools. Every call re-derives the company from the host's run context, checks the agent's grant for the
 * deployment's environment class, and audits itself. Credentials are resolved inside the worker and never appear in a result.
 */
export function registerAgentTools(ctx: PluginContext, service: ConvexService) {
  function define(name: string, displayName: string, description: string, parametersSchema: Record<string, unknown>, capability: Capability,
    handler: (input: Record<string, unknown>, access: Awaited<ReturnType<ConvexService["agentActor"]>>) => Promise<unknown>) {
    ctx.tools.register(name, { displayName, description, parametersSchema }, async (params: unknown, runCtx: ToolRunContext) => {
      try {
        const access = await service.agentActor(params, runCtx, capability);
        return reply(await handler(record(params), access));
      } catch (error) { return failure(ctx, name, error); }
    });
  }
  const read = async (access: Awaited<ReturnType<ConvexService["agentActor"]>>, tool: string, capability: Capability, name: string) => {
    const target = await service.resolveTarget(access.actor, access.config, access.reserved, name);
    service.requireGrant(access.actor, access.config, target.environment, capability);
    await service.audit(access.actor, `Convex read: ${tool}`, { tool, capability, environment: target.environment, deployment: name }, name);
    return target;
  };

  define("convex_list_projects", "List Convex projects", "List the Convex projects mapped to this company.", schema(), "meta-read", async (_input, { actor, config, reserved }) => {
    await service.audit(actor, "Convex read: list_projects", { tool: "list_projects", capability: "meta-read" });
    return { projects: config.projects.filter(project => reserved.has(project.convexProjectId)).map(project => ({ convexProjectId: project.convexProjectId, name: project.name, repository: project.repository })) };
  });

  define("convex_list_deployments", "List Convex deployments", "List deployments of the company's Convex projects with their environment class. Only environments you hold a meta-read grant for are shown.",
    schema({ convexProjectId: { type: "string" }, deploymentType: { enum: ["preview", "dev", "prod", "custom"] } }), "meta-read", async (input, { actor, config, reserved }) => {
      const result = await service.listDeployments(actor, config, reserved, {
        ...(typeof input.convexProjectId === "string" ? { convexProjectId: input.convexProjectId } : {}),
        ...(typeof input.deploymentType === "string" ? { deploymentType: input.deploymentType } : {}),
      });
      await service.audit(actor, "Convex read: list_deployments", { tool: "list_deployments", capability: "meta-read", count: result.deployments.length });
      return result;
    });

  define("convex_get_deployment", "Get a Convex deployment", "Read one deployment: type, reference, preview identifier, last deploy, expiry, class and region.",
    schema({ name: NAME }, ["name"]), "meta-read", async (input, access) => {
      const target = await read(access, "get_deployment", "meta-read", String(input.name));
      return service.summary(target.deployment, target.environment, target.reason);
    });

  define("convex_quota", "Convex deployment quota", "Count the team's deployments against the quota.", schema(), "meta-read", async (_input, { actor, config, reserved }) => {
    const quota = await service.quota(config, actor.companyId, reserved);
    await service.audit(actor, "Convex read: quota", { tool: "quota", capability: "meta-read", count: quota.count });
    return quota;
  });

  const deploymentApi = async (access: Awaited<ReturnType<ConvexService["agentActor"]>>, name: string, tool: string, paths: Array<"deployment_info" | "get_current_usage" | "list_usage_limits">) => {
    const target = await read(access, tool, "health-read", name);
    const token = await service.listToken(access.config, access.actor.companyId, target.project, target.projectIndex);
    const out: Record<string, unknown> = {};
    for (const path of paths) {
      try {
        if (!target.deployment.deploymentUrl) throw new ConvexApiError(0, "Convex returned no deployment URL.");
        out[path] = await service.d.convex.deploymentGet(token, target.deployment.deploymentUrl, path);
      } catch (error) { out[path] = { error: isShowable(error) ? error.message : "Convex could not answer this request." }; }
    }
    return { target, out };
  };

  define("convex_deployment_health", "Convex deployment health", "Health from documented Convex APIs: last deploy, expiry, current usage and usage limits. Failure rate, cache hit rate, scheduler lag and function metrics have no documented API and are listed as unavailable.",
    schema({ name: NAME }, ["name"]), "health-read", async (input, access) => {
      const { target, out } = await deploymentApi(access, String(input.name), "deployment_health", ["deployment_info", "get_current_usage", "list_usage_limits"]);
      const now = service.d.now();
      const { deployment } = target;
      return {
        name: deployment.name, environment: target.environment, lastDeployTime: deployment.lastDeployTime, createTime: deployment.createTime, expiresAt: deployment.expiresAt,
        expired: deployment.expiresAt !== null && deployment.expiresAt <= now, region: deployment.region, deploymentClass: deployment.deploymentClass,
        info: out.deployment_info, usage: out.get_current_usage, usageLimits: out.list_usage_limits,
        unavailable: ["failureRate", "cacheHitRate", "schedulerLag", "functionMetrics", "insights"],
      };
    });

  define("convex_get_usage", "Convex deployment usage", "Current-day and current-month usage per metric (Convex marks this endpoint beta).", schema({ name: NAME }, ["name"]), "health-read", async (input, access) => {
    const { target, out } = await deploymentApi(access, String(input.name), "get_usage", ["get_current_usage"]);
    return { name: target.deployment.name, environment: target.environment, usage: out.get_current_usage };
  });

  define("convex_list_usage_limits", "Convex usage limits", "List the deployment's configured usage limits.", schema({ name: NAME }, ["name"]), "health-read", async (input, access) => {
    const { target, out } = await deploymentApi(access, String(input.name), "list_usage_limits", ["list_usage_limits"]);
    return { name: target.deployment.name, environment: target.environment, usageLimits: out.list_usage_limits };
  });

  define("convex_set_preview_expiry", "Set Convex preview expiry", "Set when a preview deployment expires: 30 minutes to 168 hours (7 days) from now. Previews only.",
    schema({ name: NAME, hours: { type: "number", minimum: 0.5, maximum: 168 }, dryRun: DRY_RUN }, ["name", "hours"]), "lifecycle", async (input, { actor, config, reserved }) => {
      if (typeof input.hours !== "number" || !Number.isFinite(input.hours)) throw new ConvexApiError(0, "Provide the number of hours until the preview expires.");
      return service.setPreviewExpiry(actor, config, reserved, String(input.name), input.hours, input.dryRun === true);
    });

  define("convex_delete_preview", "Delete a Convex preview", "Irreversibly delete a preview deployment and all its data. Refused for production, staging, dev and custom deployments, for previews of open pull requests or recently active branches, and past the per-run limit. Use dryRun first.",
    schema({ name: NAME, dryRun: DRY_RUN }, ["name"]), "lifecycle", async (input, { actor, config, reserved }) =>
      service.deletePreview(actor, config, reserved, String(input.name), { dryRun: input.dryRun === true }));

  define("convex_reap_previews", "Reap Convex previews", "Delete previews whose pull request is closed (or whose branch is gone and idle) and shorten the expiry of the rest. Dry run unless dryRun is false and the company enabled the reaper.",
    schema({ dryRun: DRY_RUN }), "lifecycle", async (input, { actor, config }) => {
      service.requireGrant(actor, config, "preview", "lifecycle");
      return runReaper(service, actor.companyId, { trigger: "api", dryRun: input.dryRun !== false, actor });
    });
}
