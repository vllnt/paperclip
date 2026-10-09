import { HOUR_MS, type ConnectionConfig, type ReaperProjectReport, type ReaperReport } from "./contracts.js";
import { classifyDeployment } from "./classify.js";
import { GITHUB_UNREADABLE, newGuardCache, Refusal } from "./preview-guard.js";
import { isShowable, type Actor, type ConvexService, type DeletionBudget } from "./service.js";

export const reportKey = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "reaper", stateKey: "last-report" });
/** Expiries the reaper set itself, by deployment name. Only these follow a redeploy; an expiry a person set is never moved later. */
const managedKey = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "reaper", stateKey: "managed-expiry" });
const EXPIRY_TOLERANCE_MS = 5 * 60_000;
/** An expiry sooner than this would make Convex delete a guarded preview before the next hourly pass could see a redeploy, so it is never scheduled. */
const MIN_PLANNED_LEAD_MS = 2 * HOUR_MS;

const safe = (error: unknown) => isShowable(error) ? error.message : "The Convex action failed.";

export interface ReaperOptions {
  trigger: ReaperReport["trigger"];
  /** Overrides the company setting; `true` always plans only. A real run still needs `reaper.enabled`. */
  dryRun?: boolean;
  /** The caller for the audit trail. Defaults to the plugin's own reaper. */
  actor?: Actor;
}

/**
 * Lists previews per mapped project, deletes those whose pull request is closed or merged (or whose branch is gone and idle),
 * shortens the expiry of the rest to lastDeployTime + TTL, and reports the team's deployment count against the quota.
 * It is a dry run until the company sets `reaper.enabled`. Every deletion goes through the same guards as the tool.
 */
export function runReaper(service: ConvexService, companyId: string, options: ReaperOptions): Promise<ReaperReport> {
  // One pass per company at a time: the hourly job, a board run and an agent's tool call must not interleave their reads and writes of the managed-expiry record.
  return service.serialize(`reaper:${companyId}`, () => reaperPass(service, companyId, options));
}

async function reaperPass(service: ConvexService, companyId: string, options: ReaperOptions): Promise<ReaperReport> {
  const { ctx } = service.d;
  const { config, reserved } = await service.requireConnected(companyId);
  const dryRun = options.dryRun === true || !config.reaper.enabled || config.guards.dryRunOnly;
  const actor: Actor = options.actor ?? { kind: "reaper", companyId };
  const now = service.d.now();
  const budget: DeletionBudget = { left: config.guards.maxDeletesPerRun, max: config.guards.maxDeletesPerRun };
  const cache = newGuardCache();
  const seen = new Set<string>();
  let listedAll = true;
  const stored = await ctx.state.get(managedKey(companyId));
  const managed: Record<string, number> = stored && typeof stored === "object" && !Array.isArray(stored) ? { ...(stored as Record<string, number>) } : {};
  const report: ReaperReport = { at: new Date(now).toISOString(), trigger: options.trigger, dryRun, projects: [], quota: null, errors: [] };

  for (const [index, project] of config.projects.entries()) {
    if (!reserved.has(project.convexProjectId)) continue;
    const entry: ReaperProjectReport = { convexProjectId: project.convexProjectId, name: project.name, previews: 0, delete: [], setExpiry: [], kept: 0, deleted: [], expirySet: [], failed: [], skipped: [] };
    report.projects.push(entry);
    try {
      listedAll = false;
      const token = await service.listToken(config, companyId, project, index);
      const previews = await service.d.convex.listProjectDeployments(token, project.convexProjectId, "preview");
      listedAll = true;
      entry.previews = previews.length;
      for (const preview of previews) seen.add(preview.name);
      for (const deployment of previews) {
        const { environment, reason } = classifyDeployment(deployment, project);
        if (deployment.projectId !== project.convexProjectId || environment !== "preview") {
          entry.skipped.push({ name: deployment.name, previewIdentifier: deployment.previewIdentifier, reason: `classified ${environment}: ${reason}` });
          continue;
        }
        const target = { config, project, projectIndex: index, deployment, environment, reason };
        const assessment = await service.assess(companyId, target, cache);
        if (!assessment.checked) {
          // Without GitHub nothing is known about this project's previews: stop, and neither delete nor shorten any of them.
          if (assessment.blocked === GITHUB_UNREADABLE) throw new Refusal(assessment.blocked);
          entry.skipped.push({ name: deployment.name, previewIdentifier: deployment.previewIdentifier, reason: assessment.blocked ?? "not checked" });
          continue;
        }
        if (assessment.reapReason) {
          entry.delete.push({ name: deployment.name, previewIdentifier: deployment.previewIdentifier, reason: assessment.reapReason });
          continue;
        }
        entry.kept += 1;
        const lastDeploy = deployment.lastDeployTime ?? deployment.createTime ?? now;
        const target36 = lastDeploy + config.reaper.ttlHours * HOUR_MS;
        const current = deployment.expiresAt;
        // Shorten to lastDeployTime + TTL. Follow a later deploy only for an expiry this reaper set, never one a person chose.
        const ours = managed[deployment.name] !== undefined && current !== null && Math.abs(managed[deployment.name] - current) <= EXPIRY_TOLERANCE_MS;
        if (target36 - now >= MIN_PLANNED_LEAD_MS) {
          if (current === null || current > target36 + EXPIRY_TOLERANCE_MS || (ours && current < target36 - EXPIRY_TOLERANCE_MS)) entry.setExpiry.push({ name: deployment.name, from: current, to: target36 });
        } else if (current === null) {
          entry.setExpiry.push({ name: deployment.name, from: null, to: now + config.reaper.ttlHours * HOUR_MS });
        }
      }
      if (dryRun) continue;
      for (const item of entry.delete) {
        if (budget.left <= 0) { entry.skipped.push({ ...item, reason: `Deletion limit of ${budget.max} reached for this run.` }); continue; }
        try {
          await service.deletePreview(actor, config, reserved, item.name, { dryRun: false, budget, cache, requireReapEvidence: true });
          entry.deleted.push(item.name);
        } catch (error) {
          if (error instanceof Refusal) entry.skipped.push({ ...item, reason: error.message });
          else entry.failed.push({ name: item.name, error: safe(error) });
        }
      }
      for (const item of entry.setExpiry) {
        try {
          await service.setPreviewExpiry(actor, config, reserved, item.name, 0, false, { expiryAt: item.to, viaReaper: true });
          managed[item.name] = item.to;
          entry.expirySet.push(item.name);
        } catch (error) {
          if (error instanceof Refusal) entry.skipped.push({ name: item.name, previewIdentifier: null, reason: error.message });
          else entry.failed.push({ name: item.name, error: safe(error) });
        }
      }
    } catch (error) {
      entry.error = safe(error);
      entry.delete = []; entry.setExpiry = [];
    }
  }

  if (!dryRun) {
    // Forget deployments that no longer exist, so the record stays as small as the preview list. Skipped when a project failed to list; a later problem, such as an unreadable GitHub repository, does not matter because the list is complete.
    if (listedAll) for (const name of Object.keys(managed)) if (!seen.has(name)) delete managed[name];
    await ctx.state.set(managedKey(companyId), managed);
  }

  try {
    const quota = await service.quota(config, companyId, reserved);
    report.quota = { ...quota };
    if (quota.alert) report.quota.issueId = await raiseQuotaAlert(service, config, companyId, quota, now);
  } catch (error) {
    report.errors.push(`Quota check failed: ${safe(error)}`);
  }

  await ctx.state.set(reportKey(companyId), report);
  await service.audit(actor, "Convex reaper run", {
    dryRun, trigger: options.trigger,
    deleted: report.projects.reduce((sum, item) => sum + item.deleted.length, 0), planned: report.projects.reduce((sum, item) => sum + item.delete.length, 0),
    expirySet: report.projects.reduce((sum, item) => sum + item.expirySet.length, 0),
    quota: report.quota ? { count: report.quota.count, quota: report.quota.quota, percent: report.quota.percent } : null,
  });
  return report;
}

async function raiseQuotaAlert(service: ConvexService, config: ConnectionConfig, companyId: string, quota: { count: number; quota: number; percent: number; partial: boolean }, now: number): Promise<string | null> {
  const percent = Math.round(quota.percent);
  await service.d.ctx.activity.log({ companyId, message: `Convex deployment quota at ${percent}%`, metadata: { count: quota.count, quota: quota.quota, percent: quota.percent, partial: quota.partial } });
  try {
    const projectId = config.projects.find(project => project.paperclipProjectId)?.paperclipProjectId;
    const issue = await service.d.ctx.issues.create({
      companyId, ...(projectId ? { projectId } : {}), priority: "high",
      title: `Convex deployment quota at ${percent}% (${quota.count}/${quota.quota})`,
      description: `The Convex team has ${quota.count} deployments against a quota of ${quota.quota} (${quota.percent}%${quota.partial ? ", counted over mapped projects only" : ""}). At the limit every backend CI job fails with DeploymentQuotaReached.\n\nThe Convex reaper deletes previews of closed pull requests and shortens preview expiry. Review the last reaper report, enable the reaper if it is still a dry run, and delete unused dev or custom deployments from the Convex dashboard.`,
      idempotencyKey: `convex-quota-alert:${companyId}:${new Date(now).toISOString().slice(0, 10)}`,
    });
    return issue.id;
  } catch (error) {
    service.d.ctx.logger.warn("Convex quota alert issue could not be created", { companyId, error: safe(error) });
    return null;
  }
}
