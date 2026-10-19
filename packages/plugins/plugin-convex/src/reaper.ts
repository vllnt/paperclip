import { HOUR_MS, type ConnectionConfig, type ConvexDeployment, type EnvironmentClass, type ProjectMapping, type ReaperItem, type ReaperDevReport, type ReaperProjectReport, type ReaperReport } from "./contracts.js";
import { classifyDeployment } from "./classify.js";
import { parseCiPreview, supersedes, type CiEntry } from "./ci-previews.js";
import { ConvexApiError } from "./convex-client.js";
import { decideDev } from "./dev-policy.js";
import { hardDeleteBlock } from "./hard-guard.js";
import { EXPIRY_TOLERANCE_MS, MIN_PLANNED_LEAD_MS } from "./policy.js";
import { mapLimit } from "./pool.js";
import { clean } from "./projection.js";
import { GITHUB_UNREADABLE, newGuardCache, Refusal, type GuardCache } from "./preview-guard.js";
import { isDefinitive, isShowable, isTransport, type Actor, type ConvexService, type DeletionBudget, type Scope } from "./service.js";

export const reportKey = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "reaper", stateKey: "last-report" });
const alertKey = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "reaper", stateKey: "quota-alert" });

/** One pass stops starting new work after this long; the hourly job comes back for the rest, oldest previews first. The host kills a job at 5 minutes. */
export const PASS_BUDGET_MS = 4 * 60_000;
/** GitHub reads in flight at once while planning. */
const PLAN_CONCURRENCY = 6;
/** Expiry changes made in one pass, per project. A first run over a large backlog finishes over a few passes instead of one long one. */
export const MAX_EXPIRY_CHANGES = 100;
/** This many transport failures in a row stop a project's writes for the pass: Convex is down or throttling, and more calls would only add load. */
const BREAKER = 3;
const ALERT_BUCKET = 5;

/** Said to anyone who asks for a real run while the company has not enabled the reaper. */
export const REAPER_OFF_MESSAGE = "Enable the reaper (reaper.enabled) in this company's Convex config before a real run.";

const safe = (error: unknown) => isShowable(error) ? error.message : "The Convex action failed.";

export interface ReaperOptions {
  trigger: ReaperReport["trigger"];
  /** Overrides the company setting; `true` always plans only. A real run still needs `reaper.enabled`. */
  dryRun?: boolean;
  /** The caller for the audit trail. Defaults to the plugin's own reaper. */
  actor?: Actor;
  /** A time the pass must not run past, when the caller has a shorter limit than one pass (the scheduled job shares it between companies). */
  endsAt?: number;
}

/**
 * Lists previews per mapped project, deletes those whose pull request is closed or merged (or whose branch is gone and idle),
 * shortens the expiry of the rest to lastDeployTime + TTL, and reports the team's deployment count against the quota.
 * It is a dry run until the company sets `reaper.enabled`. Every deletion goes through the same guards as the tool.
 */
export function runReaper(service: ConvexService, companyId: string, options: ReaperOptions): Promise<ReaperReport> {
  // One pass per company at a time: the hourly job, a board run and an agent's tool call must not interleave their reads and writes.
  // At most one more pass waits behind a running one, and every request that arrives meanwhile joins it (the caller's trigger is not kept).
  const key = `${companyId}:${options.dryRun === true ? "plan" : "live"}`;
  const waiting = service.passes.get(key);
  if (waiting && !waiting.started) return waiting.promise;
  const slot = { started: false, promise: undefined as unknown as Promise<ReaperReport> };
  slot.promise = service.serialize(`reaper:${companyId}`, () => { slot.started = true; return reaperPass(service, companyId, options); });
  service.passes.set(key, slot);
  void slot.promise.finally(() => { if (service.passes.get(key) === slot) service.passes.delete(key); }).catch(() => {});
  return slot.promise;
}

interface Pass {
  service: ConvexService;
  companyId: string;
  config: ConnectionConfig;
  reserved: Set<string>;
  actor: Actor;
  dryRun: boolean;
  now: number;
  endsAt: number;
  budget: DeletionBudget;
  cache: GuardCache;
  managed: Record<string, number>;
  /** Why the pass stopped early; set once and read by every loop. */
  stopped: string | null;
  incomplete: string[];
  superseded: Map<string, { name: string; pr: number }>;
}

/** True once the pass must start no new work: out of time, or told to stop. */
function halted(pass: Pass): boolean {
  if (pass.stopped) return true;
  if (pass.service.d.now() >= pass.endsAt) pass.stopped = `The time budget of ${PASS_BUDGET_MS / 60_000} minutes was reached; the next pass continues with the oldest previews.`;
  return pass.stopped !== null;
}

/** The branch-derived identifier is chosen by whoever pushed the branch, so it is cleaned before it enters a report an agent reads. */
const identifier = (deployment: ConvexDeployment): string | null => deployment.previewIdentifier === null ? null : clean(deployment.previewIdentifier);

interface Candidate { deployment: ConvexDeployment; environment: EnvironmentClass; reason: string }

/** What planning decided about one preview. */
interface Decision {
  skipped?: ReaperItem;
  delete?: ReaperItem;
  setExpiry?: { name: string; from: number | null; to: number };
  kept?: boolean;
  githubProblem?: string;
}

async function reaperPass(service: ConvexService, companyId: string, options: ReaperOptions): Promise<ReaperReport> {
  const { ctx } = service.d;
  const { config, reserved } = await service.requireConnected(companyId);
  const dryRun = options.dryRun === true || !config.reaper.enabled || config.guards.dryRunOnly;
  const actor: Actor = options.actor ?? { kind: "reaper", companyId };
  const now = service.d.now();
  const report: ReaperReport = { at: new Date(now).toISOString(), trigger: options.trigger, dryRun, projects: [], quota: null, errors: [] };
  const pass: Pass = {
    service, companyId, config, reserved, actor, dryRun, now, endsAt: Math.min(now + PASS_BUDGET_MS, options.endsAt ?? Infinity),
    budget: { left: config.guards.maxDeletesPerRun, max: config.guards.maxDeletesPerRun },
    cache: newGuardCache(), managed: await service.managedExpiries(companyId), stopped: null, incomplete: [], superseded: new Map(),
  };
  // Separate dev allowance for the whole pass, across every project.
  const devBudget: DeletionBudget = { left: config.reaper.dev.maxDeletes, max: config.reaper.dev.maxDeletes };
  const seen = new Set<string>();
  let listedAll = true;

  for (const [index, project] of config.projects.entries()) {
    if (!reserved.has(project.convexProjectId)) continue;
    if (halted(pass)) { listedAll = false; break; }
    const entry: ReaperProjectReport = { convexProjectId: project.convexProjectId, name: project.name, previews: 0, delete: [], setExpiry: [], kept: 0, deleted: [], expirySet: [], failed: [], skipped: [] };
    report.projects.push(entry);
    // Dev deployments are handled on their own: a problem there (for example a token that cannot list them) never stops the preview pass.
    entry.dev = await reapDev(pass, project, index, devBudget);
    if (halted(pass)) { listedAll = false; break; }
    let listed = false;
    try {
      const token = await service.listToken(config, companyId, project, index);
      const previews = await service.d.convex.listProjectDeployments(token, project.convexProjectId, "preview");
      listed = true;
      entry.previews = previews.length;
      if (config.reaper.ciPreviewTemplate) entry.ciMatched = previews.filter(deployment => parseCiPreview(config.reaper.ciPreviewTemplate, deployment.previewIdentifier)).length;
      for (const preview of previews) seen.add(preview.name);
      await planProject(pass, project, index, previews, entry);
      if (!dryRun) await applyPlan(pass, project, index, entry);
    } catch (error) {
      // A project that cannot be listed must keep its tracked expiries: pruning is skipped for the whole pass.
      if (!listed) listedAll = false;
      entry.error = safe(error);
      entry.delete = []; entry.setExpiry = [];
    }
  }

  // Plugin bookkeeping only: nothing at Convex changes, so it also runs in a dry run.
  if (listedAll) await service.pruneManaged(companyId, seen, Object.keys(pass.managed));

  try {
    const quota = await service.quota(config, companyId, reserved);
    report.quota = { ...quota };
    if (quota.alert) report.quota.issueId = await raiseQuotaAlert(service, config, companyId, quota, now);
  } catch (error) {
    report.errors.push(`Quota check failed: ${safe(error)}`);
  }
  const reasons = [pass.stopped, ...pass.incomplete].filter((reason): reason is string => !!reason);
  if (reasons.length) report.incomplete = reasons.join(" ");

  await ctx.state.set(reportKey(companyId), report);
  await service.audit(actor, "Convex reaper run", {
    dryRun, trigger: options.trigger,
    deleted: report.projects.reduce((sum, item) => sum + item.deleted.length, 0), planned: report.projects.reduce((sum, item) => sum + item.delete.length, 0),
    expirySet: report.projects.reduce((sum, item) => sum + item.expirySet.length, 0), incomplete: report.incomplete ?? null,
    devDeleted: report.projects.reduce((sum, item) => sum + (item.dev?.deleted.length ?? 0), 0), devPlanned: report.projects.reduce((sum, item) => sum + (item.dev?.delete.length ?? 0), 0),
    quota: report.quota ? { count: report.quota.count, quota: report.quota.quota, percent: report.quota.percent } : null,
  });
  return report;
}

/**
 * Older runs of a pull request that a newer run's preview has replaced, by preview name. CI makes one preview per run, shard and attempt, so
 * every shard of the newest run stays (equal shards do not replace each other). A preview must also have been idle for the minimum age, so a
 * run that is still using it is not cut off. The ordering rule is shared with the delete-time check (`supersedes`).
 */
function planSuperseded(previews: ConvexDeployment[], project: ProjectMapping, config: ConnectionConfig, now: number): Map<string, { name: string; pr: number }> {
  const out = new Map<string, { name: string; pr: number }>();
  const template = config.reaper.ciPreviewTemplate;
  if (!template) return out;
  const minAge = config.reaper.supersededMinAgeMinutes * 60_000;
  const entries: Array<CiEntry & { name: string }> = [];
  for (const deployment of previews) {
    if (deployment.projectId !== project.convexProjectId || classifyDeployment(deployment, project).environment !== "preview" || hardDeleteBlock(deployment)) continue;
    const parsed = parseCiPreview(template, deployment.previewIdentifier);
    if (parsed) entries.push({ name: deployment.name, ...parsed, at: deployment.lastDeployTime ?? deployment.createTime ?? now });
  }
  const latest = (a: CiEntry & { name: string }, b: CiEntry & { name: string }) => ((a.run ?? -1) - (b.run ?? -1) || (a.attempt ?? -1) - (b.attempt ?? -1) || a.name.localeCompare(b.name)) > 0 ? a : b;
  for (const mine of entries) {
    if (now - mine.at < minAge) continue;
    const replacements = entries.filter(other => other.name !== mine.name && supersedes(other, mine));
    if (replacements.length) out.set(mine.name, { name: replacements.reduce(latest).name, pr: mine.pr });
  }
  return out;
}

const DEV_CREDENTIAL = "Listing dev deployments needs a Team Access Token (or a project token that can list them); a preview deploy key cannot.";

/**
 * Plans, and when allowed carries out, the dev policy for one project. Deletion needs the reaper enabled, the dev policy enabled, no dry run and a
 * pass started by the schedule or a board user: an agent that starts a pass only sees the plan.
 */
async function reapDev(pass: Pass, project: ProjectMapping, index: number, budget: DeletionBudget): Promise<ReaperDevReport> {
  const { service, config, reserved, companyId, actor, dryRun, now } = pass;
  const out: ReaperDevReport = { listed: 0, delete: [], deleted: [], kept: 0, failed: [], skipped: [], executed: false };
  try {
    const token = await service.listToken(config, companyId, project, index);
    const devs = await service.d.convex.listProjectDeployments(token, project.convexProjectId, "dev");
    out.listed = devs.length;
    for (const deployment of devs) {
      const { environment, reason } = classifyDeployment(deployment, project);
      const hardBlock = hardDeleteBlock(deployment);
      if (deployment.projectId !== project.convexProjectId || environment !== "dev") out.skipped.push({ name: deployment.name, previewIdentifier: deployment.reference === null ? null : clean(deployment.reference), reason: `classified ${environment}: ${reason}` });
      else if (hardBlock) out.skipped.push({ name: deployment.name, previewIdentifier: deployment.reference === null ? null : clean(deployment.reference), reason: hardBlock });
      else {
        const decision = decideDev(deployment, config.reaper.dev, now);
        if (decision.delete) out.delete.push({ name: deployment.name, previewIdentifier: deployment.reference === null ? null : clean(deployment.reference), reason: decision.reason });
        else if (decision.listed) out.skipped.push({ name: deployment.name, previewIdentifier: deployment.reference === null ? null : clean(deployment.reference), reason: decision.reason });
        else out.kept += 1;
      }
    }
  } catch (error) {
    out.error = error instanceof Refusal || (error instanceof ConvexApiError && [401, 403].includes(error.status)) ? DEV_CREDENTIAL : safe(error);
    return out;
  }
  if (dryRun || !config.reaper.dev.enabled || actor.kind === "agent") return out;
  out.executed = true;
  let failures = 0;
  for (const item of out.delete) {
    if (halted(pass)) break;
    const stopped = await service.passStopReason(companyId, true);
    if (stopped) { pass.stopped = stopped; break; }
    if (failures >= BREAKER) { out.error = `Convex failed ${BREAKER} times in a row, so the remaining dev deployments were kept for the next pass.`; break; }
    if (budget.left <= 0) { out.skipped.push({ ...item, reason: `Dev deletion limit of ${budget.max} reached for this run.` }); continue; }
    try {
      await service.deleteDev(actor, config, reserved, item.name, { dryRun: false, budget, scope: { project, index } });
      out.deleted.push(item.name);
      failures = 0;
    } catch (error) {
      if (error instanceof Refusal) out.skipped.push({ ...item, reason: error.message });
      else out.failed.push({ name: item.name, error: safe(error) });
      failures = isTransport(error) ? failures + 1 : 0;
    }
  }
  return out;
}

/** Decides, for every preview of a project, whether to delete it, move its expiry, or leave it. Nothing at Convex changes here. */
async function planProject(pass: Pass, project: ProjectMapping, index: number, previews: ConvexDeployment[], entry: ReaperProjectReport): Promise<void> {
  const { now } = pass;
  pass.superseded = planSuperseded(previews, project, pass.config, now);
  const candidates: Candidate[] = [];
  for (const deployment of previews) {
    const { environment, reason } = classifyDeployment(deployment, project);
    if (deployment.projectId !== project.convexProjectId || environment !== "preview") {
      entry.skipped.push({ name: deployment.name, previewIdentifier: identifier(deployment), reason: `classified ${environment}: ${reason}` });
      continue;
    }
    candidates.push({ deployment, environment, reason });
  }
  // Oldest activity first: the previews most likely to be finished are examined before the time budget can run out.
  const activity = (deployment: ConvexDeployment) => deployment.lastDeployTime ?? deployment.createTime ?? now;
  candidates.sort((a, b) => activity(a.deployment) - activity(b.deployment));

  const decisions = await mapLimit(candidates, PLAN_CONCURRENCY, () => halted(pass), candidate => planPreview(pass, project, index, candidate));
  let githubProblem: string | null = null;
  let deferred = 0;
  for (const decision of decisions) {
    if (!decision) { deferred += 1; continue; }
    if (decision.skipped) entry.skipped.push(decision.skipped);
    if (decision.delete) entry.delete.push(decision.delete);
    if (decision.setExpiry) entry.setExpiry.push(decision.setExpiry);
    if (decision.kept) entry.kept += 1;
    githubProblem ??= decision.githubProblem ?? null;
  }
  if (entry.setExpiry.length > MAX_EXPIRY_CHANGES) {
    deferred += entry.setExpiry.length - MAX_EXPIRY_CHANGES;
    entry.setExpiry.length = MAX_EXPIRY_CHANGES;
    pass.incomplete.push(`At most ${MAX_EXPIRY_CHANGES} expiry changes are made per project in one pass; the next pass continues.`);
  }
  if (deferred) entry.deferred = deferred;
  if (githubProblem) entry.error = githubProblem;
}

async function planPreview(pass: Pass, project: ProjectMapping, index: number, { deployment, environment, reason }: Candidate): Promise<Decision> {
  const { service, config, now } = pass;
  const item = (why: string): ReaperItem => ({ name: deployment.name, previewIdentifier: identifier(deployment), reason: why });
  const lastDeploy = deployment.lastDeployTime ?? deployment.createTime ?? now;
  const deadline = lastDeploy + config.reaper.ttlHours * HOUR_MS;
  const current = deployment.expiresAt;
  // An expiry the plugin set follows a later deploy; one a person chose never moves later. Moving a deadline later deletes nothing, so it needs no GitHub.
  const ours = current !== null && pass.managed[deployment.name] !== undefined && Math.abs(pass.managed[deployment.name] - current) <= EXPIRY_TOLERANCE_MS;
  const extend = ours && deadline - now >= MIN_PLANNED_LEAD_MS && current < deadline - EXPIRY_TOLERANCE_MS;
  /** The one change that is safe whatever GitHub says: moving a plugin-set expiry later. Otherwise `otherwise`. */
  const extendOr = (otherwise: Decision): Decision =>
    extend ? { kept: true, setExpiry: { name: deployment.name, from: current, to: deadline } } : otherwise;

  const hardBlock = hardDeleteBlock(deployment);
  // Never deleted, and never given or shortened an expiry (an expiry is a delayed delete), whatever the grants or config say.
  // An expiry the plugin already set may still move later: that postpones a deletion.
  if (hardBlock) return extendOr({ skipped: item(hardBlock) });

  let unreadable: string | null = null;
  let assessment: Awaited<ReturnType<ConvexService["assess"]>> | null = null;
  try { assessment = await service.assess(pass.companyId, { config, project, projectIndex: index, deployment, environment, reason }, pass.cache); }
  catch (error) { unreadable = safe(error); }
  if (assessment && !assessment.checked && assessment.blocked === GITHUB_UNREADABLE) unreadable = assessment.blocked;
  // Without GitHub nothing is known about this preview: it is neither deleted nor shortened. Only a move to a later deadline is safe.
  if (unreadable !== null) return { ...extendOr({}), githubProblem: unreadable };
  // Not checkable (no identifier, repository or token): leave it alone, except for a move to a later deadline, which deletes nothing.
  if (!assessment!.checked) return extendOr({ skipped: item(assessment!.blocked ?? "not checked") });
  if (assessment!.blocked && assessment!.openPullRequest !== null) {
    const newer = pass.superseded.get(deployment.name);
    if (newer && newer.pr === assessment!.openPullRequest) return { delete: item(`superseded by ${newer.name}`) };
  }
  if (assessment!.reapReason) return { delete: item(assessment!.reapReason) };

  const decision: Decision = { kept: true };
  // Shorten to lastDeployTime + TTL; when that is too close, only give a preview without any expiry now + TTL.
  if (deadline - now >= MIN_PLANNED_LEAD_MS) {
    if (current === null || current > deadline + EXPIRY_TOLERANCE_MS || extend) decision.setExpiry = { name: deployment.name, from: current, to: deadline };
  } else if (current === null) {
    decision.setExpiry = { name: deployment.name, from: null, to: now + config.reaper.ttlHours * HOUR_MS };
  }
  return decision;
}

/** Applies the plan of one project: deletions first, then expiry changes. Config flags and the connection are read again before every write. */
async function applyPlan(pass: Pass, project: ProjectMapping, index: number, entry: ReaperProjectReport): Promise<void> {
  const { service, companyId, config, reserved, actor } = pass;
  const scope: Scope = { project, index };
  let failures = 0;
  const defer = (count = 1) => { entry.deferred = (entry.deferred ?? 0) + count; };
  const tripped = () => failures >= BREAKER;
  const trip = () => { entry.error ??= `Convex failed ${BREAKER} times in a row, so the rest of this project was left for the next pass.`; };
  const gate = async (): Promise<boolean> => {
    if (halted(pass)) return false;
    const reason = await service.passStopReason(companyId, true);
    if (reason) pass.stopped = reason;
    return reason === null;
  };
  const outcome = (error: unknown) => { failures = isTransport(error) ? failures + 1 : 0; };

  for (const [position, item] of entry.delete.entries()) {
    if (tripped()) { trip(); defer(entry.delete.length - position); break; }
    if (pass.budget.left <= 0) { entry.skipped.push({ ...item, reason: `Deletion limit of ${pass.budget.max} reached for this run.` }); continue; }
    if (!await gate()) { defer(entry.delete.length - position); break; }
    try {
      await service.deletePreview(actor, config, reserved, item.name, { dryRun: false, budget: pass.budget, cache: pass.cache, requireReapEvidence: true, scope, supersededBy: pass.superseded.get(item.name) });
      entry.deleted.push(item.name);
      failures = 0;
    } catch (error) {
      if (error instanceof Refusal) entry.skipped.push({ ...item, reason: error.message });
      else entry.failed.push({ name: item.name, error: safe(error) });
      outcome(error);
    }
  }

  if (!entry.setExpiry.length) return;
  // Write-ahead: the whole batch is recorded as ours before Convex changes. Whatever is not applied is taken back out below.
  const names = entry.setExpiry.map(item => item.name);
  let previous: Record<string, number | null>;
  try { previous = await service.markManaged(companyId, Object.fromEntries(entry.setExpiry.map(item => [item.name, item.to]))); }
  catch {
    entry.error ??= "Paperclip could not record the planned expiries, so no expiry was changed for this project.";
    defer(names.length);
    return;
  }
  const undo: string[] = [];
  for (const [position, item] of entry.setExpiry.entries()) {
    if (tripped() || !await gate()) {
      if (tripped()) trip();
      defer(names.length - position);
      undo.push(...names.slice(position));
      break;
    }
    try {
      await service.setPreviewExpiry(actor, config, reserved, item.name, 0, false, { expiryAt: item.to, viaReaper: true, recorded: true, scope });
      entry.expirySet.push(item.name);
      failures = 0;
    } catch (error) {
      // A refusal or a definitive 4xx proves nothing changed; after a timeout the expiry may be set, so its record stays.
      if (error instanceof Refusal || isDefinitive(error)) undo.push(item.name);
      if (error instanceof Refusal) entry.skipped.push({ name: item.name, previewIdentifier: null, reason: error.message });
      else entry.failed.push({ name: item.name, error: safe(error) });
      outcome(error);
    }
  }
  if (undo.length) await service.markManaged(companyId, Object.fromEntries(undo.map(name => [name, previous[name] ?? null]))).catch(() => {});
}

/**
 * Raises one issue per alert level (5% steps) rather than one per day: a quota that stays at 90% is one issue, and a climb to 95% is a new one.
 * The activity log line is written when the level changes or once a day.
 */
async function raiseQuotaAlert(service: ConvexService, config: ConnectionConfig, companyId: string, quota: { count: number; quota: number; percent: number; partial: boolean }, now: number): Promise<string | null> {
  const { ctx } = service.d;
  const percent = Math.round(quota.percent);
  const bucket = Math.floor(quota.percent / ALERT_BUCKET) * ALERT_BUCKET;
  const last = await ctx.state.get(alertKey(companyId)).catch(() => null) as { bucket?: number; at?: number; issueId?: string | null } | null;
  if (last && last.bucket === bucket && typeof last.at === "number" && now - last.at < 24 * HOUR_MS) return last.issueId ?? null;
  await ctx.activity.log({ companyId, message: `Convex deployment quota at ${percent}%`, metadata: { count: quota.count, quota: quota.quota, percent: quota.percent, partial: quota.partial } });
  let issueId: string | null = null;
  try {
    const projectId = config.projects.find(project => project.paperclipProjectId)?.paperclipProjectId;
    const issue = await ctx.issues.create({
      companyId, ...(projectId ? { projectId } : {}), priority: "high",
      title: `Convex deployment quota at ${percent}% (${quota.count}/${quota.quota})`,
      description: `The Convex team has ${quota.count} deployments against a quota of ${quota.quota} (${quota.percent}%${quota.partial ? ", counted over mapped projects only" : ""}). At the limit every backend CI job fails with DeploymentQuotaReached.\n\nThe Convex reaper deletes previews of closed pull requests and shortens preview expiry. Review the last reaper report, enable the reaper if it is still a dry run, and delete unused dev or custom deployments from the Convex dashboard.`,
      idempotencyKey: `convex-quota-alert:${companyId}:${bucket}`,
    });
    issueId = issue.id;
  } catch (error) {
    ctx.logger.warn("Convex quota alert issue could not be created", { companyId, error: safe(error) });
  }
  try { await ctx.state.set(alertKey(companyId), { bucket, at: now, issueId }); }
  catch { ctx.logger.warn("Convex quota alert state could not be saved", { companyId }); }
  return issueId;
}
