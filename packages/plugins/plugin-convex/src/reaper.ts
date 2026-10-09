import { HOUR_MS, type ConnectionConfig, type ReaperProjectReport, type ReaperReport } from "./contracts.js";
import { classifyDeployment } from "./classify.js";
import { EXPIRY_TOLERANCE_MS, MIN_PLANNED_LEAD_MS } from "./policy.js";
import { GITHUB_UNREADABLE, newGuardCache, Refusal, type PreviewAssessment } from "./preview-guard.js";
import { isShowable, type Actor, type ConvexService, type DeletionBudget } from "./service.js";

export const reportKey = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "reaper", stateKey: "last-report" });

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
  // One pass per company at a time: the hourly job, a board run and an agent's tool call must not interleave their reads and writes.
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
  const managed = await service.managedExpiries(companyId);
  const report: ReaperReport = { at: new Date(now).toISOString(), trigger: options.trigger, dryRun, projects: [], quota: null, errors: [] };

  for (const [index, project] of config.projects.entries()) {
    if (!reserved.has(project.convexProjectId)) continue;
    const entry: ReaperProjectReport = { convexProjectId: project.convexProjectId, name: project.name, previews: 0, delete: [], setExpiry: [], kept: 0, deleted: [], expirySet: [], failed: [], skipped: [] };
    report.projects.push(entry);
    let listed = false;
    try {
      const token = await service.listToken(config, companyId, project, index);
      const previews = await service.d.convex.listProjectDeployments(token, project.convexProjectId, "preview");
      listed = true;
      entry.previews = previews.length;
      for (const preview of previews) seen.add(preview.name);
      let githubProblem: string | null = null;
      for (const deployment of previews) {
        const { environment, reason } = classifyDeployment(deployment, project);
        if (deployment.projectId !== project.convexProjectId || environment !== "preview") {
          entry.skipped.push({ name: deployment.name, previewIdentifier: deployment.previewIdentifier, reason: `classified ${environment}: ${reason}` });
          continue;
        }
        const lastDeploy = deployment.lastDeployTime ?? deployment.createTime ?? now;
        const deadline = lastDeploy + config.reaper.ttlHours * HOUR_MS;
        const current = deployment.expiresAt;
        // An expiry the plugin set follows a later deploy; one a person chose never moves later. Moving a deadline later deletes nothing, so it needs no GitHub.
        const ours = current !== null && managed[deployment.name] !== undefined && Math.abs(managed[deployment.name] - current) <= EXPIRY_TOLERANCE_MS;
        const extend = ours && deadline - now >= MIN_PLANNED_LEAD_MS && current < deadline - EXPIRY_TOLERANCE_MS;

        let assessment: PreviewAssessment | null = null;
        let unreadable: string | null = null;
        try { assessment = await service.assess(companyId, { config, project, projectIndex: index, deployment, environment, reason }, cache); }
        catch (error) { unreadable = safe(error); }
        if (assessment && !assessment.checked && assessment.blocked === GITHUB_UNREADABLE) unreadable = assessment.blocked;
        if (unreadable !== null) {
          // Without GitHub nothing is known about this preview: it is neither deleted nor shortened. Only a move to a later deadline is safe.
          githubProblem ??= unreadable;
          if (extend) { entry.kept += 1; entry.setExpiry.push({ name: deployment.name, from: current, to: deadline }); }
          continue;
        }
        if (!assessment!.checked) {
          // Not checkable (no identifier, repository or token): leave it alone, except for a move to a later deadline, which deletes nothing.
          if (extend) { entry.kept += 1; entry.setExpiry.push({ name: deployment.name, from: current, to: deadline }); }
          else entry.skipped.push({ name: deployment.name, previewIdentifier: deployment.previewIdentifier, reason: assessment!.blocked ?? "not checked" });
          continue;
        }
        if (assessment!.reapReason) {
          entry.delete.push({ name: deployment.name, previewIdentifier: deployment.previewIdentifier, reason: assessment!.reapReason });
          continue;
        }
        entry.kept += 1;
        // Shorten to lastDeployTime + TTL; when that is too close, only give a preview without any expiry now + TTL.
        if (deadline - now >= MIN_PLANNED_LEAD_MS) {
          if (current === null || current > deadline + EXPIRY_TOLERANCE_MS || extend) entry.setExpiry.push({ name: deployment.name, from: current, to: deadline });
        } else if (current === null) {
          entry.setExpiry.push({ name: deployment.name, from: null, to: now + config.reaper.ttlHours * HOUR_MS });
        }
      }
      if (githubProblem) entry.error = githubProblem;
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
          entry.expirySet.push(item.name);
        } catch (error) {
          if (error instanceof Refusal) entry.skipped.push({ name: item.name, previewIdentifier: null, reason: error.message });
          else entry.failed.push({ name: item.name, error: safe(error) });
        }
      }
    } catch (error) {
      // A project that cannot be listed must keep its tracked expiries: pruning is skipped for the whole pass.
      if (!listed) listedAll = false;
      entry.error = safe(error);
      entry.delete = []; entry.setExpiry = [];
    }
  }

  // Plugin bookkeeping only: nothing at Convex changes, so it also runs in a dry run.
  if (listedAll) await service.pruneManaged(companyId, seen, Object.keys(managed));

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
