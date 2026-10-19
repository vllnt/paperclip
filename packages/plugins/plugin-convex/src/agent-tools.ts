import type { PluginContext, ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import { HOUR_MS, type ReaperReport } from "./contracts.js";
import { ConvexApiError } from "./convex-client.js";
import { isGranted } from "./grants.js";
import { clean, projectAuditEvents, projectClasses, projectCustomDomains, projectDeploymentInfo, projectDeployKeys, projectRegions, projectUsage, projectUsageLimits } from "./projection.js";
import { Refusal } from "./preview-guard.js";
import { REAPER_OFF_MESSAGE, runReaper } from "./reaper.js";
import { isShowable, LIST_MAX, type ConvexService } from "./service.js";
import { TOOL_DECLARATIONS } from "./tool-declarations.js";

/** How many entries of each list a reaper tool call returns. The full report is on the Convex page. */
export const REPORT_LIST_CAP = 25;
const AUDIT_WINDOW_MS = 24 * HOUR_MS;

type Access = Awaited<ReturnType<ConvexService["agentActor"]>>;

const reply = (data: unknown): ToolResult => ({ data, content: JSON.stringify(data) });
const failure = (ctx: PluginContext, tool: string, error: unknown): ToolResult => {
  if (isShowable(error)) return { error: error.message };
  ctx.logger.error("Convex tool failed", { tool, error: error instanceof Error ? error.name : "unknown" });
  return { error: "The Convex action failed." };
};
const record = (params: unknown): Record<string, unknown> => params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : {};

/** The deployment an agent named. A missing or misnamed field gets a message that says how to call the tool. */
function deploymentName(input: Record<string, unknown>): string {
  if (typeof input.name !== "string" || !input.name.trim()) throw new Refusal("Pass the deployment as { name } (see convex_list_deployments).");
  return input.name.trim();
}

/** A reaper report an agent can read in one go: counts per project and the first entries of each list. */
export function boundedReport(report: ReaperReport) {
  const first = <T>(items: T[]) => items.slice(0, REPORT_LIST_CAP);
  const item = <T extends { previewIdentifier: string | null }>(entry: T): T => ({ ...entry, previewIdentifier: entry.previewIdentifier === null ? null : clean(entry.previewIdentifier) });
  return {
    ...report,
    projects: report.projects.map(project => ({
      convexProjectId: project.convexProjectId, name: project.name, previews: project.previews, kept: project.kept,
      counts: { delete: project.delete.length, setExpiry: project.setExpiry.length, deleted: project.deleted.length, expirySet: project.expirySet.length, failed: project.failed.length, skipped: project.skipped.length },
      delete: first(project.delete).map(item), setExpiry: first(project.setExpiry), deleted: first(project.deleted), expirySet: first(project.expirySet),
      failed: first(project.failed), skipped: first(project.skipped).map(item),
      truncated: [project.delete, project.setExpiry, project.deleted, project.expirySet, project.failed, project.skipped].some(list => list.length > REPORT_LIST_CAP),
      ...(project.deferred ? { deferred: project.deferred } : {}), ...(project.error ? { error: project.error } : {}),
    })),
  };
}

/**
 * Agent-facing Convex tools. Every call re-derives the company from the host's run context, checks the agent's grant for the
 * deployment's environment class, and audits itself. Credentials are resolved inside the worker and never appear in a result.
 * Names, descriptions and input schemas come from `tool-declarations.ts`, which the manifest publishes.
 */
export function registerAgentTools(ctx: PluginContext, service: ConvexService) {
  function define(name: string, handler: (input: Record<string, unknown>, access: Access) => Promise<unknown>) {
    const declared = TOOL_DECLARATIONS.find(tool => tool.name === name);
    if (!declared) throw new Error(`Convex tool ${name} has no declaration.`);
    ctx.tools.register(name, { displayName: declared.displayName, description: declared.description, parametersSchema: declared.parametersSchema }, async (params: unknown, runCtx: ToolRunContext) => {
      try {
        const access = await service.agentActor(params, runCtx, declared.capability);
        return reply(await handler(record(params), access));
      } catch (error) { return failure(ctx, name, error); }
    });
  }
  const read = async (access: Access, tool: string, capability: Parameters<ConvexService["requireGrant"]>[3], name: string) => {
    const target = await service.resolveTarget(access.actor, access.config, access.reserved, name);
    service.requireGrant(access.actor, access.config, target.environment, capability);
    await service.audit(access.actor, `Convex read: ${tool}`, { tool, capability, environment: target.environment, deployment: name }, name);
    return target;
  };

  define("convex_list_projects", async (_input, { actor, config, reserved }) => {
    await service.audit(actor, "Convex read: list_projects", { tool: "list_projects", capability: "meta-read" });
    return { projects: config.projects.filter(project => reserved.has(project.convexProjectId)).map(project => ({ convexProjectId: project.convexProjectId, name: project.name, repository: project.repository })) };
  });

  define("convex_list_deployments", async (input, { actor, config, reserved }) => {
    if (input.cursor !== undefined && (typeof input.cursor !== "string" || input.cursor.length > 128)) throw new Refusal("cursor must be the nextCursor of the previous page.");
    if (input.limit !== undefined && (typeof input.limit !== "number" || !Number.isFinite(input.limit) || input.limit < 1 || input.limit > LIST_MAX)) throw new Refusal(`limit must be a number from 1 to ${LIST_MAX}.`);
    const result = await service.listDeployments(actor, config, reserved, {
      ...(typeof input.convexProjectId === "string" ? { convexProjectId: input.convexProjectId } : {}),
      ...(typeof input.deploymentType === "string" ? { deploymentType: input.deploymentType } : {}),
      ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
      ...(typeof input.cursor === "string" ? { cursor: input.cursor } : {}),
    });
    await service.audit(actor, "Convex read: list_deployments", { tool: "list_deployments", capability: "meta-read", count: result.deployments.length });
    return result;
  });

  define("convex_get_deployment", async (input, access) => {
    const target = await read(access, "get_deployment", "meta-read", deploymentName(input));
    return service.summary(target.deployment, target.environment, target.reason);
  });

  define("convex_quota", async (_input, { actor, config, reserved }) => {
    const quota = await service.quotaCached(config, actor.companyId, reserved);
    await service.audit(actor, "Convex read: quota", { tool: "quota", capability: "meta-read", count: quota.count });
    return quota;
  });

  const deploymentApi = async (access: Access, input: Record<string, unknown>, tool: string, paths: Array<"deployment_info" | "get_current_usage" | "list_usage_limits" | "list_audit_log_events">, capability: Parameters<ConvexService["requireGrant"]>[3] = "health-read", query = "") => {
    const target = await read(access, tool, capability, deploymentName(input));
    const token = await service.listToken(access.config, access.actor.companyId, target.project, target.projectIndex);
    const { name, deploymentUrl } = target.deployment;
    const answers = await Promise.all(paths.map(async (path): Promise<[string, unknown]> => {
      try {
        if (!deploymentUrl) throw new ConvexApiError(0, "Convex returned no deployment URL.");
        return [path, await service.d.convex.deploymentGet(token, { name, deploymentUrl }, path, query)];
      } catch (error) { return [path, { error: isShowable(error) ? error.message : "Convex could not answer this request." }]; }
    }));
    return { target, out: Object.fromEntries(answers) as Record<string, unknown> };
  };

  define("convex_deployment_health", async (input, access) => {
    const { target, out } = await deploymentApi(access, input, "deployment_health", ["deployment_info", "get_current_usage", "list_usage_limits"]);
    const now = service.d.now();
    const { deployment } = target;
    return {
      name: deployment.name, environment: target.environment, lastDeployTime: deployment.lastDeployTime, createTime: deployment.createTime, expiresAt: deployment.expiresAt,
      expired: deployment.expiresAt !== null && deployment.expiresAt <= now, region: deployment.region, deploymentClass: deployment.deploymentClass,
      info: projectDeploymentInfo(out.deployment_info), usage: projectUsage(out.get_current_usage), usageLimits: projectUsageLimits(out.list_usage_limits),
      unavailable: ["failureRate", "cacheHitRate", "schedulerLag", "functionMetrics", "insights"],
    };
  });

  define("convex_get_usage", async (input, access) => {
    const { target, out } = await deploymentApi(access, input, "get_usage", ["get_current_usage"]);
    return { name: target.deployment.name, environment: target.environment, usage: projectUsage(out.get_current_usage) };
  });

  define("convex_list_usage_limits", async (input, access) => {
    const { target, out } = await deploymentApi(access, input, "list_usage_limits", ["list_usage_limits"]);
    return { name: target.deployment.name, environment: target.environment, usageLimits: projectUsageLimits(out.list_usage_limits) };
  });

  define("convex_list_custom_domains", async (input, access) => {
    const target = await read(access, "list_custom_domains", "meta-read", deploymentName(input));
    const token = await service.listToken(access.config, access.actor.companyId, target.project, target.projectIndex);
    return { name: target.deployment.name, environment: target.environment, domains: projectCustomDomains(await service.d.convex.listCustomDomains(token, target.deployment.name)) };
  });

  define("convex_list_deploy_keys", async (input, access) => {
    const target = await read(access, "list_deploy_keys", "meta-read", deploymentName(input));
    const token = await service.listToken(access.config, access.actor.companyId, target.project, target.projectIndex);
    return { name: target.deployment.name, environment: target.environment, keys: projectDeployKeys(await service.d.convex.listDeployKeys(token, target.deployment.name)) };
  });

  define("convex_list_classes_regions", async (_input, { actor, config }) => {
    if (!config.teamToken || !config.teamId) throw new Refusal("A team token and team id are needed to list classes and regions.");
    const token = await service.teamToken(config, actor.companyId);
    await service.audit(actor, "Convex read: list_classes_regions", { tool: "list_classes_regions", capability: "meta-read" });
    const [classes, regions] = await Promise.all([service.d.convex.listDeploymentClasses(token, config.teamId), service.d.convex.listDeploymentRegions(token, config.teamId)]);
    return { classes: projectClasses(classes), regions: projectRegions(regions) };
  });

  define("convex_list_audit_events", async (input, access) => {
    // Without a lower bound Convex returns the whole log, which is long and mostly old.
    const from = typeof input.from === "number" && Number.isFinite(input.from) ? Math.trunc(input.from) : service.d.now() - AUDIT_WINDOW_MS;
    const { target, out } = await deploymentApi(access, input, "list_audit_events", ["list_audit_log_events"], "logs-read", `?from=${from}`);
    const raw = out.list_audit_log_events;
    if (raw && typeof raw === "object" && "error" in raw && Object.keys(raw).length === 1) return { name: target.deployment.name, environment: target.environment, from, error: (raw as { error: string }).error };
    const pii = isGranted(access.config, access.actor.agent, target.environment, "data-read-pii");
    return { name: target.deployment.name, environment: target.environment, from, ...projectAuditEvents(raw, pii) };
  });

  define("convex_set_preview_expiry", async (input, { actor, config, reserved }) => {
    if (typeof input.hours !== "number" || !Number.isFinite(input.hours)) throw new Refusal("Pass hours as a number from 0.5 to 168: the hours from now until the preview expires.");
    return service.setPreviewExpiry(actor, config, reserved, deploymentName(input), input.hours, input.dryRun === true);
  });

  // An agent deletes only with evidence the work is finished, and only when it says dryRun: false.
  define("convex_delete_preview", async (input, { actor, config, reserved }) =>
    service.deletePreview(actor, config, reserved, deploymentName(input), { dryRun: input.dryRun !== false, requireReapEvidence: true }));

  define("convex_reap_previews", async (input, { actor, config }) => {
    service.requireGrant(actor, config, "preview", "lifecycle");
    const dryRun = input.dryRun !== false;
    if (!dryRun && !config.reaper.enabled) throw new Refusal(REAPER_OFF_MESSAGE);
    return boundedReport(await runReaper(service, actor.companyId, { trigger: "api", dryRun, actor }));
  });
}
