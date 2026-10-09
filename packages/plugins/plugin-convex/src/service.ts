import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { classifyDeployment } from "./classify.js";
import { ConfigError, parseConfig } from "./config.js";
import {
  HOUR_MS, MAX_PREVIEW_TTL_HOURS, MIN_EXPIRY_LEAD_MS,
  type Capability, type ConnectionConfig, type ConnectionState, type ConvexDeployment, type EnvironmentClass, type ProjectMapping, type SecretRef,
} from "./contracts.js";
import { ConvexApiError, ConvexClient } from "./convex-client.js";
import { isGranted, hasAnyGrant, type AgentIdentity } from "./grants.js";
import { GitHubReader } from "./github-reader.js";
import { parseCiPreview, supersedes, type CiEntry } from "./ci-previews.js";
import { decideDev } from "./dev-policy.js";
import { hardDeleteBlock } from "./hard-guard.js";
import { reaperDeadline } from "./policy.js";
import { assessPreview, recheckCache, Refusal, type GuardCache, type PreviewAssessment } from "./preview-guard.js";

const SECRET_TTL_MS = 60_000;
/** Expiries the plugin set itself, by deployment name. Only these follow a redeploy; an expiry a person set is never moved later. */
const managedKey = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "reaper", stateKey: "managed-expiry" });
const registryKey = { scopeKind: "instance" as const, namespace: "connection", stateKey: "projects" };
const disconnectedKey = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "connection", stateKey: "disconnected" });
const deletionKey = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "deletions", stateKey: "runs" });
type Registry = Record<string, string>;

export const MAX_LIST = 200;

/** The caller of an operation. Agents need grants; the board and the reaper are trusted by the operator's own config. */
export type Actor =
  | { kind: "agent"; companyId: string; agent: AgentIdentity; runId: string }
  | { kind: "board"; companyId: string; userId: string | null }
  | { kind: "reaper"; companyId: string };

export interface Target { config: ConnectionConfig; project: ProjectMapping; projectIndex: number; deployment: ConvexDeployment; environment: EnvironmentClass; reason: string }
export interface DeletionBudget { left: number; max: number }

export interface ServiceDeps { ctx: PluginContext; convex: ConvexClient; github: GitHubReader; now: () => number }

/** Errors with a message that is safe to show to an agent or a board user. */
export const isShowable = (error: unknown): error is Error => error instanceof Refusal || error instanceof ConvexApiError || error instanceof ConfigError;

export class ConvexService {
  private queue = new Map<string, Promise<unknown>>();
  private calls = new Map<string, number[]>();
  constructor(readonly d: ServiceDeps) {
    d.convex.onUnauthorized = token => this.forgetCredential(token);
    d.github.onUnauthorized = token => this.forgetCredential(token);
  }

  /** Runs operations on one key one at a time, so counters and registry changes cannot race. */
  serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.queue.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.queue.set(key, next);
    void next.finally(() => { if (this.queue.get(key) === next) this.queue.delete(key); }).catch(() => {});
    return next;
  }

  // --- configuration, registry and connection ---

  async loadConfig(companyId: string): Promise<ConnectionConfig> {
    return parseConfig(await this.d.ctx.config.get(companyId));
  }
  async registry(): Promise<Registry> {
    const stored = await this.d.ctx.state.get(registryKey);
    return stored && typeof stored === "object" && !Array.isArray(stored) ? { ...(stored as Registry) } : {};
  }
  async connectedCompanies(): Promise<string[]> {
    return [...new Set(Object.values(await this.registry()))];
  }
  async connectionState(companyId: string): Promise<{ state: ConnectionState; config: ConnectionConfig | null; reserved: Set<string> }> {
    const config = await this.loadConfig(companyId);
    const registry = await this.registry();
    const reserved = new Set(config.projects.filter(project => registry[project.convexProjectId] === companyId).map(project => project.convexProjectId));
    if (await this.d.ctx.state.get(disconnectedKey(companyId)) === true) return { state: "disconnected", config, reserved: new Set() };
    if (!config.projects.length || !(config.teamToken || config.projects.every(project => project.token || project.previewDeployKey))) return { state: "not-configured", config, reserved: new Set() };
    return { state: reserved.size ? "connected" : "not-connected", config, reserved };
  }
  async requireConnected(companyId: string): Promise<{ config: ConnectionConfig; reserved: Set<string> }> {
    const { state, config, reserved } = await this.connectionState(companyId);
    if (state === "connected" && config) return { config, reserved };
    throw new Refusal(state === "not-configured" ? "Convex is not configured for this company." : "Convex is not connected for this company. A Paperclip instance administrator must run connection.connect.");
  }

  /** Verifies each mapped project's credential with Convex, then reserves the project ids for this company. */
  connect(companyId: string): Promise<{ projects: string[] }> {
    return this.serialize("registry", async () => {
      const config = await this.loadConfig(companyId);
      if (!config.projects.length) throw new Refusal("Map at least one Convex project in this company's plugin config first.");
      const registry = await this.registry();
      for (const project of config.projects) {
        const owner = registry[project.convexProjectId];
        if (owner && owner !== companyId) throw new Refusal(`Convex project ${project.convexProjectId} is already connected to another company.`);
      }
      for (const [index, project] of config.projects.entries()) {
        const token = await this.listToken(config, companyId, project, index);
        await this.d.convex.listProjectDeployments(token, project.convexProjectId, "preview");
      }
      const wanted = new Set(config.projects.map(project => project.convexProjectId));
      for (const [id, owner] of Object.entries(registry)) if (owner === companyId && !wanted.has(id)) delete registry[id];
      for (const id of wanted) registry[id] = companyId;
      await this.d.ctx.state.set(registryKey, registry);
      await this.d.ctx.state.delete(disconnectedKey(companyId));
      await this.d.ctx.activity.log({ companyId, message: "Convex connected", metadata: { projects: [...wanted] } });
      return { projects: [...wanted] };
    });
  }
  disconnect(companyId: string): Promise<void> {
    return this.serialize("registry", async () => {
      // The flag alone refuses the company, even if releasing the project ids below is interrupted.
      await this.d.ctx.state.set(disconnectedKey(companyId), true);
      const registry = await this.registry();
      for (const [id, owner] of Object.entries(registry)) if (owner === companyId) delete registry[id];
      await this.d.ctx.state.set(registryKey, registry);
      for (const key of [...this.secrets.keys()]) if (key.startsWith(`${companyId}:`)) this.secrets.delete(key);
      await this.d.ctx.activity.log({ companyId, message: "Convex disconnected" });
    });
  }

  // --- credentials: resolved per operation, never stored, logged or returned ---

  /**
   * Resolved secrets are kept in worker memory for a minute, per company and secret, because the host limits secret resolution per minute and a
   * reaper pass or a few tool calls would otherwise exhaust it. Expired entries are dropped on every lookup, and a credential that Convex or GitHub
   * rejects with 401 is dropped at once (see `forgetCredential`). Values are never returned, logged or persisted.
   */
  private secrets = new Map<string, { value: Promise<string>; expires: number }>();
  private resolveSecret(_config: ConnectionConfig, ref: SecretRef, companyId: string, configPath: string): Promise<string> {
    const key = `${companyId}:${ref.secretId}`;
    const now = this.d.now();
    for (const [entryKey, entry] of this.secrets) if (entry.expires <= now) this.secrets.delete(entryKey);
    const known = this.secrets.get(key);
    if (known) return known.value;
    const value = this.d.ctx.secrets.resolve(ref, { companyId, configPath });
    this.secrets.set(key, { value, expires: now + SECRET_TTL_MS });
    value.catch(() => { if (this.secrets.get(key)?.value === value) this.secrets.delete(key); });
    return value;
  }
  /** A 401 means the cached value is stale (rotated or wrong): forget whichever cached secret holds exactly that value. */
  private forgetCredential(token: string) {
    for (const [key, entry] of this.secrets) void entry.value.then(value => { if (value === token && this.secrets.get(key) === entry) this.secrets.delete(key); }, () => {});
  }
  private forgetSecret(companyId: string, ref: SecretRef) { this.secrets.delete(`${companyId}:${ref.secretId}`); }
  /** Listing needs a project token or the team token; a preview deploy key cannot list. */
  async listToken(config: ConnectionConfig, companyId: string, project: ProjectMapping, index: number): Promise<string> {
    if (project.token) return this.resolveSecret(config, project.token, companyId, `projects.${index}.token`);
    if (config.teamToken) return this.resolveSecret(config, config.teamToken, companyId, "teamToken");
    throw new Refusal("No credential is configured to list this Convex project.");
  }
  /** Credentials that may act on a deployment by name, cheapest first. They are resolved lazily, so the common case resolves one. */
  private credentialCandidates(config: ConnectionConfig, companyId: string, scope: { project: ProjectMapping; index: number } | null, previewKey: boolean): Array<{ ref: SecretRef; load: () => Promise<string> }> {
    const out: Array<{ ref: SecretRef; load: () => Promise<string> }> = [];
    const add = (ref: SecretRef | null, path: string) => { if (ref) out.push({ ref, load: () => this.resolveSecret(config, ref, companyId, path) }); };
    const projects = scope ? [scope] : config.projects.map((project, index) => ({ project, index }));
    for (const { project, index } of projects) {
      if (previewKey) add(project.previewDeployKey, `projects.${index}.previewDeployKey`);
      add(project.token, `projects.${index}.token`);
    }
    add(config.teamToken, "teamToken");
    return out;
  }
  /** Tries each candidate credential in turn. A credential scoped to another project (401/403) or a missing deployment (404) moves on to the next one. */
  async withCredential<T>(config: ConnectionConfig, companyId: string, scope: { project: ProjectMapping; index: number } | null, use: (token: string) => Promise<T>, options: { previewKey?: boolean } = {}): Promise<T> {
    let failure: unknown = null;
    for (const candidate of this.credentialCandidates(config, companyId, scope, options.previewKey !== false)) {
      try { return await use(await candidate.load()); }
      catch (error) {
        if (error instanceof ConvexApiError && [401, 403, 404].includes(error.status)) {
          if (error.status === 401) this.forgetSecret(companyId, candidate.ref);
          failure = error;
          continue;
        }
        throw error;
      }
    }
    throw failure ?? new Refusal("No credential is configured for this Convex project.");
  }
  async teamToken(config: ConnectionConfig, companyId: string): Promise<string> {
    if (!config.teamToken) throw new Refusal("No team token is configured for this company.");
    return this.resolveSecret(config, config.teamToken, companyId, "teamToken");
  }
  async githubToken(config: ConnectionConfig, companyId: string): Promise<string | null> {
    if (!config.githubToken) return null;
    try { return await this.resolveSecret(config, config.githubToken, companyId, "github.token"); }
    catch { throw new Refusal("The GitHub token could not be read from Paperclip secrets, so the preview was kept."); }
  }

  // --- caller checks ---

  private rateLimit(companyId: string, subject: string, perMinute: number) {
    const key = `${companyId}:${subject}`;
    const now = this.d.now();
    const recent = (this.calls.get(key) ?? []).filter(at => now - at < 60_000);
    if (recent.length >= perMinute) throw new Refusal(`Convex rate limit reached (${perMinute} calls per minute). Try again shortly.`);
    recent.push(now);
    this.calls.set(key, recent);
  }

  /** Validates the host-supplied run context, then loads the company's connection and the agent's identity. */
  async agentActor(params: unknown, runCtx: ToolRunContext, capability: Capability): Promise<{ actor: Actor & { kind: "agent" }; config: ConnectionConfig; reserved: Set<string> }> {
    if (!runCtx?.companyId || !runCtx.agentId || !runCtx.runId) throw new Refusal("Convex tools need a company, agent and run context.");
    const given = params && typeof params === "object" ? (params as Record<string, unknown>).companyId : undefined;
    if (given !== undefined && given !== runCtx.companyId) throw new Refusal("This Convex tool call belongs to another company.");
    const { config, reserved } = await this.requireConnected(runCtx.companyId);
    this.rateLimit(runCtx.companyId, runCtx.agentId, config.guards.callsPerMinute);
    const agent = await this.d.ctx.agents.get(runCtx.agentId, runCtx.companyId);
    if (!agent || agent.companyId !== runCtx.companyId) throw new Refusal("This agent does not belong to this company.");
    const identity: AgentIdentity = { id: agent.id, role: typeof agent.role === "string" ? agent.role : null };
    if (!hasAnyGrant(config, identity, capability)) throw new Refusal(`Agent has no grant for ${capability} on any Convex environment.`);
    return { actor: { kind: "agent", companyId: runCtx.companyId, agent: identity, runId: runCtx.runId }, config, reserved };
  }

  /** Throws unless the actor may use the capability on the environment. Board users and the reaper are not subject to grants. */
  requireGrant(actor: Actor, config: ConnectionConfig, environment: EnvironmentClass, capability: Capability): void {
    if (actor.kind !== "agent") return;
    if (!isGranted(config, actor.agent, environment, capability)) throw new Refusal(`Agent has no grant for ${capability} on ${environment} deployments.`);
  }

  // --- deployments ---

  /** Re-fetches a deployment from Convex at call time and decides everything from that fresh record. */
  async resolveTarget(actor: Actor, config: ConnectionConfig, reserved: Set<string>, name: string, options: { previewKey?: boolean } = {}): Promise<Target> {
    if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) throw new Refusal("Provide a Convex deployment name.");
    // One message for "does not exist", "not reachable" and "belongs to someone else", so names of other companies cannot be probed.
    const unavailable = () => new Refusal("This Convex deployment is not available for this company.");
    let deployment: ConvexDeployment | null;
    try {
      deployment = await this.withCredential(config, actor.companyId, null, token => this.d.convex.getDeployment(token, name), options);
    } catch (error) {
      if (error instanceof ConvexApiError && [401, 403, 404].includes(error.status)) throw unavailable();
      throw error;
    }
    // Everything that follows is decided from the record Convex returned, and it must be the deployment that was asked for.
    if (!deployment || deployment.name !== name) throw unavailable();
    const projectIndex = config.projects.findIndex(project => project.convexProjectId === deployment!.projectId);
    if (projectIndex < 0 || !reserved.has(config.projects[projectIndex].convexProjectId)) throw unavailable();
    const project = config.projects[projectIndex];
    const { environment, reason } = classifyDeployment(deployment, project);
    return { config, project, projectIndex, deployment, environment, reason };
  }

  summary(deployment: ConvexDeployment, environment: EnvironmentClass, reason?: string) {
    return {
      name: deployment.name, environment, ...(reason ? { environmentReason: reason } : {}), deploymentType: deployment.deploymentType, reference: deployment.reference,
      previewIdentifier: deployment.previewIdentifier, isDefault: deployment.isDefault, createTime: deployment.createTime, lastDeployTime: deployment.lastDeployTime,
      expiresAt: deployment.expiresAt, region: deployment.region, deploymentClass: deployment.deploymentClass, creator: deployment.creator, project: deployment.projectId,
    };
  }
  /** What is recorded about a deployment before a change. Never a credential. */
  before(deployment: ConvexDeployment) {
    const { deploymentUrl: _url, ...rest } = deployment;
    return rest;
  }

  async audit(actor: Actor, message: string, metadata: Record<string, unknown>, entityId?: string): Promise<void> {
    const who = actor.kind === "agent" ? { agentId: actor.agent.id, runId: actor.runId } : actor.kind === "board" ? { userId: actor.userId } : { reaper: true };
    await this.d.ctx.activity.log({ companyId: actor.companyId, message, entityType: "convex_deployment", ...(entityId ? { entityId } : {}), metadata: { ...who, ...metadata } });
  }

  // --- lifecycle ---

  /** Previews only. Production, staging, dev and custom environments are never touched by this path. */
  private requirePreview(target: Target): void {
    if (target.environment === "dev") throw new Refusal("Dev deployments are personal. Agents may list them but never change or delete them; deleting one is a board action or a Decision.");
    if (target.environment !== "preview") throw new Refusal(`Agents cannot change ${target.environment} deployments; only previews. This deployment is classified ${target.environment} (${target.reason}).`);
  }

  /**
   * Sets a preview's expiry. Convex deletes a preview when its expiry passes, so an expiry sooner than the activity window is a
   * deletion: it follows the deletion guards and counts against the agent's per-run deletion cap. The reaper applies its own
   * policy and passes `viaReaper`.
   */
  async setPreviewExpiry(actor: Actor, config: ConnectionConfig, reserved: Set<string>, name: string, hours: number, dryRun: boolean, options: { expiryAt?: number; viaReaper?: boolean } = {}) {
    const target = await this.resolveTarget(actor, config, reserved, name);
    this.requirePreview(target);
    this.requireGrant(actor, config, target.environment, "lifecycle");
    const now = this.d.now();
    const expiresAt = options.expiryAt ?? now + hours * HOUR_MS;
    // The hard guard stops an expiry from being scheduled or shortened. Moving an existing deadline later postpones a deletion, so it stays allowed.
    const hardBlock = hardDeleteBlock(target.deployment);
    if (hardBlock && !(target.deployment.expiresAt !== null && expiresAt > target.deployment.expiresAt)) throw new Refusal(hardBlock);
    if (expiresAt - now > MAX_PREVIEW_TTL_HOURS * HOUR_MS) throw new Refusal(`A preview expiry can be at most ${MAX_PREVIEW_TTL_HOURS} hours (7 days) from now.`);
    if (expiresAt - now < MIN_EXPIRY_LEAD_MS) throw new Refusal("A preview expiry must be at least 30 minutes from now.");
    // An expiry is a scheduled deletion. Setting one sooner than the preview already has, sooner than the reaper's own deadline for it, or
    // sooner than the activity window is a deletion and follows the deletion guards. Extending an expiry (up to 7 days) is not.
    const { deployment } = target;
    const lastActivity = deployment.lastDeployTime ?? deployment.createTime ?? now;
    const floor = Math.max(deployment.expiresAt ?? 0, reaperDeadline(now, lastActivity, config.reaper.ttlHours), now + config.guards.activityHours * HOUR_MS);
    const deletesSoon = !options.viaReaper && expiresAt < floor;
    if (deletesSoon) {
      if (!dryRun && !config.guards.dryRunOnly) await this.requireRunAllowance(actor, config.guards.maxDeletesPerRun);
      const assessment = await this.assess(actor.companyId, target);
      if (assessment.blocked) throw new Refusal(`${assessment.blocked} An expiry sooner than this preview's current deadline deletes it earlier, so it follows the deletion guards.`);
    }
    const record = { deployment: name, environment: target.environment, capability: "lifecycle", before: { expiresAt: target.deployment.expiresAt }, after: { expiresAt }, countsAsDeletion: deletesSoon };
    if (dryRun || config.guards.dryRunOnly) {
      await this.audit(actor, "Convex preview expiry dry run", { ...record, outcome: "dry-run" }, name);
      return { dryRun: true, name, expiresAt, previousExpiresAt: target.deployment.expiresAt };
    }
    if (deletesSoon && actor.kind === "agent") await this.reserveRunDeletion(actor, config.guards.maxDeletesPerRun);
    await this.withCredential(config, actor.companyId, { project: target.project, index: target.projectIndex }, token => this.d.convex.setExpiry(token, name, expiresAt));
    await this.audit(actor, "Convex preview expiry set", { ...record, outcome: "expiry-set" }, name);
    // The expiry is set at Convex; failing to remember it only means a later redeploy will not move it, so it must not report the change as failed.
    try { await this.markManaged(actor.companyId, { [name]: expiresAt }); }
    catch { this.d.ctx.logger.warn("Convex managed expiry could not be recorded", { companyId: actor.companyId, deployment: name }); }
    return { dryRun: false, name, expiresAt, previousExpiresAt: target.deployment.expiresAt };
  }

  /** Expiries this plugin set, by deployment name. Whoever sets an expiry (the reaper or an agent) records it here, so a later redeploy can move it. */
  async managedExpiries(companyId: string): Promise<Record<string, number>> {
    const stored = await this.d.ctx.state.get(managedKey(companyId));
    return stored && typeof stored === "object" && !Array.isArray(stored) ? { ...(stored as Record<string, number>) } : {};
  }
  markManaged(companyId: string, changes: Record<string, number>): Promise<void> {
    return this.serialize(`managed:${companyId}`, async () => {
      await this.d.ctx.state.set(managedKey(companyId), { ...(await this.managedExpiries(companyId)), ...changes });
    });
  }
  /**
   * Forgets deployments that no longer exist, so the record stays as small as the preview list. Only names that were tracked when the pass began are
   * considered, so an expiry set during the pass for a preview created after it was listed is kept.
   */
  pruneManaged(companyId: string, live: ReadonlySet<string>, trackedAtStart: Iterable<string>): Promise<void> {
    return this.serialize(`managed:${companyId}`, async () => {
      const managed = await this.managedExpiries(companyId);
      for (const name of trackedAtStart) if (!live.has(name)) delete managed[name];
      await this.d.ctx.state.set(managedKey(companyId), managed);
    });
  }

  /** Per-run deletion counts for a company, in one record. Entries older than three days are dropped whenever the record is written. */
  private async deletionRuns(companyId: string): Promise<Record<string, { count: number; at: string }>> {
    const stored = await this.d.ctx.state.get(deletionKey(companyId));
    return stored && typeof stored === "object" && !Array.isArray(stored) ? { ...(stored as Record<string, { count: number; at: string }>) } : {};
  }
  /** Fails fast, before any network call, when the run has no deletions left. The reservation below is the authoritative check. */
  private async requireRunAllowance(actor: Actor, max: number): Promise<void> {
    if (actor.kind !== "agent") return;
    if (Number((await this.deletionRuns(actor.companyId))[actor.runId]?.count ?? 0) >= max) throw new Refusal(`This run reached its limit of ${max} deletions.`);
  }
  /** Reserves one deletion for a tool run. The count survives a worker restart, so a run cannot exceed its cap by crashing. */
  private reserveRunDeletion(actor: Actor & { kind: "agent" }, max: number): Promise<void> {
    return this.serialize(`deletions:${actor.companyId}`, async () => {
      const runs = await this.deletionRuns(actor.companyId);
      const used = Number(runs[actor.runId]?.count ?? 0);
      if (used >= max) throw new Refusal(`This run reached its limit of ${max} deletions.`);
      const now = this.d.now();
      for (const [runId, entry] of Object.entries(runs)) if (now - Date.parse(entry.at) > 3 * 24 * HOUR_MS) delete runs[runId];
      runs[actor.runId] = { count: used + 1, at: new Date(now).toISOString() };
      await this.d.ctx.state.set(deletionKey(actor.companyId), runs);
    });
  }

  async assess(companyId: string, target: Target, cache?: GuardCache): Promise<PreviewAssessment> {
    return assessPreview({
      github: this.d.github, token: await this.githubToken(target.config, companyId), project: target.project,
      deployment: target.deployment, activityHours: target.config.guards.activityHours, now: this.d.now(), cache,
      prNumber: parseCiPreview(target.config.reaper.ciPreviewTemplate, target.deployment.previewIdentifier)?.pr ?? null,
    });
  }

  /** After a failed or unanswered delete: did the deployment go away anyway? */
  private async isGone(config: ConnectionConfig, companyId: string, target: Target, name: string, previewKey: boolean): Promise<boolean> {
    try { await this.withCredential(config, companyId, { project: target.project, index: target.projectIndex }, token => this.d.convex.getDeployment(token, name), { previewKey }); return false; }
    catch (error) { return error instanceof ConvexApiError && error.status === 404; }
  }
  /** After a delete Convex accepted: is the deployment still there? Only a 404 proves it is gone and only a deployment proves it is not. */
  private async existence(config: ConnectionConfig, companyId: string, target: Target, name: string, previewKey: boolean): Promise<"exists" | "gone" | "unknown"> {
    try { return (await this.withCredential(config, companyId, { project: target.project, index: target.projectIndex }, token => this.d.convex.getDeployment(token, name), { previewKey })) ? "exists" : "unknown"; }
    catch (error) { return error instanceof ConvexApiError && error.status === 404 ? "gone" : "unknown"; }
  }

  /**
   * The one place a deployment is deleted at Convex, for previews and dev deployments alike. It audits the intent, deletes with a credential the
   * deployment kind allows (a preview deploy key can only touch previews), checks the answer, then checks that the deployment is really gone.
   */
  private async executeDelete(actor: Actor, config: ConnectionConfig, target: Target, kind: "preview" | "dev", record: Record<string, unknown>, finish: (deleted: boolean) => unknown): Promise<unknown> {
    const { deployment } = target;
    const name = deployment.name;
    const previewKey = kind === "preview";
    const scope = { project: target.project, index: target.projectIndex };
    const noun = kind === "preview" ? "preview" : "dev deployment";
    await this.audit(actor, `Convex ${noun} deletion requested`, { ...record, outcome: "requested" }, name);
    try {
      await this.withCredential(config, actor.companyId, scope, token => this.d.convex.deleteDeployment(token, name), { previewKey });
    } catch (error) {
      // A transport failure can follow a delete that succeeded. Look before reporting a failure.
      const unanswered = error instanceof ConvexApiError && (error.status === 0 || error.status >= 500);
      if (unanswered && await this.isGone(config, actor.companyId, target, name, previewKey)) {
        await this.audit(actor, `Convex ${noun} deleted`, { ...record, outcome: "deleted-verified", after: null }, name);
        return finish(true);
      }
      await this.audit(actor, unanswered ? `Convex ${noun} delete outcome unknown` : `Convex ${noun} delete failed`,
        { ...record, outcome: unanswered ? "unknown" : "failed", error: error instanceof ConvexApiError ? error.message : "Convex could not delete the deployment." }, name);
      if (unanswered) throw new ConvexApiError((error as ConvexApiError).status, "Convex did not confirm the deletion. Check the deployment before retrying.");
      throw error;
    }
    const existence = await this.existence(config, actor.companyId, target, name, previewKey);
    if (existence === "exists") {
      await this.audit(actor, `Convex ${noun} delete failed`, { ...record, outcome: "still-exists" }, name);
      throw new ConvexApiError(0, "Convex accepted the delete but the deployment still exists. Check it before retrying.");
    }
    // Convex accepted the delete. When the follow-up read could not say either way, that is recorded instead of claiming a confirmation.
    await this.audit(actor, `Convex ${noun} deleted`, { ...record, outcome: existence === "gone" ? "deleted" : "deleted-unverified", after: null }, name);
    return finish(true);
  }

  /**
   * A preview of an open pull request is deleted as superseded only if, on the records fetched now, a newer preview of the same pull request exists
   * and this one has been idle for the minimum age. A run that redeployed into it since the plan was made keeps it.
   */
  private async requireNewerPreview(actor: Actor, config: ConnectionConfig, reserved: Set<string>, target: Target, newer: { name: string; pr: number }): Promise<void> {
    const gone = () => new Refusal("The newer preview of this pull request is not available any more, so the older one was kept.");
    if (newer.name === target.deployment.name) throw gone();
    let sibling: Target;
    try { sibling = await this.resolveTarget(actor, config, reserved, newer.name); } catch { throw gone(); }
    if (sibling.environment !== "preview" || sibling.project.convexProjectId !== target.project.convexProjectId) throw gone();
    const now = this.d.now();
    const minAge = config.reaper.supersededMinAgeMinutes * 60_000;
    const entry = (deployment: ConvexDeployment): CiEntry | null => {
      const parsed = parseCiPreview(config.reaper.ciPreviewTemplate, deployment.previewIdentifier);
      return parsed ? { ...parsed, at: deployment.lastDeployTime ?? deployment.createTime ?? now } : null;
    };
    const mine = entry(target.deployment);
    const theirs = entry(sibling.deployment);
    if (!mine || !theirs || mine.pr !== newer.pr || !supersedes(theirs, mine)) throw gone();
    if (now - mine.at < minAge) throw new Refusal("This preview was deployed recently and may be in use, so it was kept.");
  }

  async deletePreview(actor: Actor, config: ConnectionConfig, reserved: Set<string>, name: string, options: {
    dryRun: boolean; budget?: DeletionBudget; cache?: GuardCache; requireReapEvidence?: boolean;
    /** Delete a preview of an open pull request because this newer preview of the same pull request exists. Only the reaper passes it. */
    supersededBy?: { name: string; pr: number };
  }) {
    if (!options.dryRun && !config.guards.dryRunOnly) {
      if (options.budget && options.budget.left <= 0) throw new Refusal(`Deletion limit of ${options.budget.max} reached for this run.`);
      await this.requireRunAllowance(actor, config.guards.maxDeletesPerRun);
    }
    const target = await this.resolveTarget(actor, config, reserved, name);
    this.requirePreview(target);
    this.requireGrant(actor, config, target.environment, "lifecycle");
    const hardBlock = hardDeleteBlock(target.deployment);
    if (hardBlock) throw new Refusal(hardBlock);
    // The decision re-reads open pull requests and branches; only the closed-PR evidence list may be shared with the planning pass.
    const assessment = await this.assess(actor.companyId, target, recheckCache(options.cache));
    let reason = assessment.reapReason;
    if (assessment.blocked) {
      const newer = options.supersededBy;
      if (!newer || assessment.openPullRequest === null || assessment.openPullRequest !== newer.pr) throw new Refusal(assessment.blocked);
      await this.requireNewerPreview(actor, config, reserved, target, newer);
      reason = `superseded by ${newer.name}`;
    }
    if (options.requireReapEvidence && !reason) throw new Refusal("No closed pull request and no idle gone branch was found for this preview, so it was kept.");
    const record = { deployment: name, environment: target.environment, capability: "lifecycle", before: this.before(target.deployment), evidence: assessment.evidence, reason };
    const result = (deleted: boolean, dryRun: boolean) => ({ dryRun, wouldDelete: true, deleted, environment: target.environment, deployment: this.summary(target.deployment, target.environment), evidence: assessment.evidence, reason });
    if (options.dryRun || config.guards.dryRunOnly) {
      await this.audit(actor, "Convex preview delete dry run", { ...record, outcome: "dry-run" }, name);
      return result(false, true);
    }
    // An agent's allowance is per run across every tool call (persisted); the reaper's budget caps one pass on top of that.
    if (actor.kind === "agent") await this.reserveRunDeletion(actor, config.guards.maxDeletesPerRun);
    if (options.budget) {
      if (options.budget.left <= 0) throw new Refusal(`Deletion limit of ${options.budget.max} reached for this run.`);
      options.budget.left -= 1;
    }
    return this.executeDelete(actor, config, target, "preview", record, deleted => result(deleted, false));
  }

  /**
   * Deletes one dev deployment under the company's dev policy (age, protect list, allow list). Only the scheduled reaper and a board user may
   * do this: dev deployments are personal, and an agent can list them but never delete them. The deployment is re-fetched first, so every
   * decision is made on its current state.
   */
  async deleteDev(actor: Actor, config: ConnectionConfig, reserved: Set<string>, name: string, options: { dryRun: boolean; budget?: DeletionBudget }) {
    if (actor.kind === "agent") throw new Refusal("Agents cannot delete dev deployments. Dev deployments are personal; deleting one is a board action or a Decision.");
    const target = await this.resolveTarget(actor, config, reserved, name, { previewKey: false });
    if (target.environment !== "dev") throw new Refusal(`Only dev deployments are deleted by the dev policy; this one is classified ${target.environment}.`);
    const hardBlock = hardDeleteBlock(target.deployment);
    if (hardBlock) throw new Refusal(hardBlock);
    const decision = decideDev(target.deployment, config.reaper.dev, this.d.now());
    if (!decision.delete) throw new Refusal(decision.reason);
    const record = { deployment: name, environment: target.environment, capability: "lifecycle", before: this.before(target.deployment), reason: decision.reason };
    const result = (deleted: boolean, dryRun: boolean) => ({ dryRun, wouldDelete: true, deleted, environment: target.environment, deployment: this.summary(target.deployment, target.environment), reason: decision.reason });
    if (options.dryRun || config.guards.dryRunOnly) {
      await this.audit(actor, "Convex dev deployment delete dry run", { ...record, outcome: "dry-run" }, name);
      return result(false, true);
    }
    if (options.budget) {
      if (options.budget.left <= 0) throw new Refusal(`Dev deletion limit of ${options.budget.max} reached for this run.`);
      options.budget.left -= 1;
    }
    return this.executeDelete(actor, config, target, "dev", record, deleted => result(deleted, false));
  }

  // --- inventory ---

  async listDeployments(actor: Actor, config: ConnectionConfig, reserved: Set<string>, options: { convexProjectId?: string; deploymentType?: string }, capability: Capability = "meta-read") {
    const out: ReturnType<ConvexService["summary"]>[] = [];
    let truncated = false;
    for (const [index, project] of config.projects.entries()) {
      if (!reserved.has(project.convexProjectId) || (options.convexProjectId && options.convexProjectId !== project.convexProjectId)) continue;
      const token = await this.listToken(config, actor.companyId, project, index);
      for (const deployment of await this.d.convex.listProjectDeployments(token, project.convexProjectId, options.deploymentType)) {
        if (deployment.projectId !== project.convexProjectId) continue;
        const { environment, reason } = classifyDeployment(deployment, project);
        if (actor.kind === "agent" && !isGranted(config, actor.agent, environment, capability)) continue;
        if (out.length >= MAX_LIST) { truncated = true; continue; }
        out.push(this.summary(deployment, environment, reason));
      }
    }
    return { deployments: out, truncated };
  }

  /** Total deployments of the team against the quota. Project-scoped credentials can only count the mapped projects (partial). */
  async quota(config: ConnectionConfig, companyId: string, reserved: Set<string>) {
    let count = 0;
    let partial = false;
    if (config.teamToken && config.teamId) {
      const token = await this.resolveSecret(config, config.teamToken, companyId, "teamToken");
      let cursor: string | undefined;
      for (let page = 0; page < 100; page++) {
        const result = await this.d.convex.listTeamDeploymentsPage(token, config.teamId, cursor);
        count += result.items.length;
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
    } else {
      partial = true;
      for (const [index, project] of config.projects.entries()) {
        if (!reserved.has(project.convexProjectId)) continue;
        count += (await this.d.convex.listProjectDeployments(await this.listToken(config, companyId, project, index), project.convexProjectId)).length;
      }
    }
    const quota = config.reaper.quota;
    const percent = Math.round((count / quota) * 1000) / 10;
    return { count, quota, percent, partial, alert: percent >= config.reaper.alertPercent };
  }
}
