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
import { assessPreview, Refusal, type OpenPullRequestCache, type PreviewAssessment } from "./preview-guard.js";

const registryKey = { scopeKind: "instance" as const, namespace: "connection", stateKey: "projects" };
const disconnectedKey = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "connection", stateKey: "disconnected" });
const deletionKey = (companyId: string, runId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "deletions", stateKey: runId });
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
  constructor(readonly d: ServiceDeps) {}

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
      await this.d.ctx.activity.log({ companyId, message: "Convex disconnected" });
    });
  }

  // --- credentials: resolved per call, never stored, logged or returned ---

  private resolveSecret(ref: SecretRef, companyId: string, configPath: string): Promise<string> {
    return this.d.ctx.secrets.resolve(ref, { companyId, configPath });
  }
  /** Listing needs a project token or the team token; a preview deploy key cannot list. */
  async listToken(config: ConnectionConfig, companyId: string, project: ProjectMapping, index: number): Promise<string> {
    if (project.token) return this.resolveSecret(project.token, companyId, `projects.${index}.token`);
    if (config.teamToken) return this.resolveSecret(config.teamToken, companyId, "teamToken");
    throw new Refusal("No credential is configured to list this Convex project.");
  }
  /** Credentials that may act on one deployment by name, cheapest first: preview deploy key, project token, team token. */
  private async nameCredentials(config: ConnectionConfig, companyId: string, project: ProjectMapping | null, index: number, previewOnly: boolean): Promise<string[]> {
    const out: string[] = [];
    const add = async (ref: SecretRef | null, path: string) => { if (ref) out.push(await this.resolveSecret(ref, companyId, path)); };
    if (project) {
      if (previewOnly) await add(project.previewDeployKey, `projects.${index}.previewDeployKey`);
      await add(project.token, `projects.${index}.token`);
    } else {
      for (const [i, candidate] of config.projects.entries()) {
        await add(candidate.previewDeployKey, `projects.${i}.previewDeployKey`);
        await add(candidate.token, `projects.${i}.token`);
      }
    }
    await add(config.teamToken, "teamToken");
    return [...new Set(out)];
  }
  async teamToken(config: ConnectionConfig, companyId: string): Promise<string> {
    if (!config.teamToken) throw new Refusal("No team token is configured for this company.");
    return this.resolveSecret(config.teamToken, companyId, "teamToken");
  }
  async githubToken(config: ConnectionConfig, companyId: string): Promise<string | null> {
    if (!config.githubToken) return null;
    try { return await this.resolveSecret(config.githubToken, companyId, "github.token"); } catch { return null; }
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
  async resolveTarget(actor: Actor, config: ConnectionConfig, reserved: Set<string>, name: string): Promise<Target> {
    if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) throw new Refusal("Provide a Convex deployment name.");
    const companyId = actor.companyId;
    let deployment: ConvexDeployment | null = null;
    let failure: unknown = null;
    for (const token of await this.nameCredentials(config, companyId, null, 0, true)) {
      try { deployment = await this.d.convex.getDeployment(token, name); break; }
      catch (error) {
        // A credential scoped to another project answers 401/403/404; try the next one. Anything else is a real failure.
        if (error instanceof ConvexApiError && [401, 403, 404].includes(error.status)) { failure = error; continue; }
        throw error;
      }
    }
    if (!deployment) throw failure instanceof ConvexApiError && failure.status === 404 ? new Refusal("Convex deployment not found.") : new Refusal("Convex deployment is not reachable with this company's credentials.");
    const projectIndex = config.projects.findIndex(project => project.convexProjectId === deployment!.projectId);
    if (projectIndex < 0 || !reserved.has(config.projects[projectIndex].convexProjectId)) throw new Refusal("This deployment is not mapped to this company.");
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

  async setPreviewExpiry(actor: Actor, config: ConnectionConfig, reserved: Set<string>, name: string, hours: number, dryRun: boolean, expiryAt?: number) {
    const target = await this.resolveTarget(actor, config, reserved, name);
    this.requirePreview(target);
    this.requireGrant(actor, config, target.environment, "lifecycle");
    const now = this.d.now();
    const expiresAt = expiryAt ?? now + hours * HOUR_MS;
    if (expiresAt - now > MAX_PREVIEW_TTL_HOURS * HOUR_MS) throw new Refusal(`A preview expiry can be at most ${MAX_PREVIEW_TTL_HOURS} hours (7 days) from now.`);
    if (expiresAt - now < MIN_EXPIRY_LEAD_MS) throw new Refusal("A preview expiry must be at least 30 minutes from now.");
    const effectiveDry = dryRun || config.guards.dryRunOnly;
    const record = { deployment: name, environment: target.environment, capability: "lifecycle", before: { expiresAt: target.deployment.expiresAt }, after: { expiresAt } };
    if (effectiveDry) {
      await this.audit(actor, "Convex preview expiry dry run", { ...record, outcome: "dry-run" }, name);
      return { dryRun: true, name, expiresAt, previousExpiresAt: target.deployment.expiresAt };
    }
    const [token] = await this.nameCredentials(config, actor.companyId, target.project, target.projectIndex, true);
    if (!token) throw new Refusal("No credential is configured for this Convex project.");
    await this.d.convex.setExpiry(token, name, expiresAt);
    await this.audit(actor, "Convex preview expiry set", { ...record, outcome: "expiry-set" }, name);
    return { dryRun: false, name, expiresAt, previousExpiresAt: target.deployment.expiresAt };
  }

  /** Reserves one deletion for a tool run. The count survives a worker restart, so a run cannot exceed its cap by crashing. */
  private reserveRunDeletion(actor: Actor & { kind: "agent" }, max: number): Promise<void> {
    return this.serialize(`deletions:${actor.companyId}`, async () => {
      const key = deletionKey(actor.companyId, actor.runId);
      const used = Number((await this.d.ctx.state.get(key) as { count?: number } | null)?.count ?? 0);
      if (used >= max) throw new Refusal(`This run reached its limit of ${max} deletions.`);
      await this.d.ctx.state.set(key, { count: used + 1, at: new Date(this.d.now()).toISOString() });
    });
  }

  async assess(companyId: string, target: Target, openCache?: OpenPullRequestCache): Promise<PreviewAssessment> {
    return assessPreview({
      github: this.d.github, token: await this.githubToken(target.config, companyId), project: target.project,
      deployment: target.deployment, activityHours: target.config.guards.activityHours, now: this.d.now(), openCache,
    });
  }

  async deletePreview(actor: Actor, config: ConnectionConfig, reserved: Set<string>, name: string, options: { dryRun: boolean; budget?: DeletionBudget; openCache?: OpenPullRequestCache; requireReapEvidence?: boolean }) {
    const target = await this.resolveTarget(actor, config, reserved, name);
    this.requirePreview(target);
    this.requireGrant(actor, config, target.environment, "lifecycle");
    const assessment = await this.assess(actor.companyId, target, options.openCache);
    if (assessment.blocked) throw new Refusal(assessment.blocked);
    if (options.requireReapEvidence && !assessment.reapReason) throw new Refusal("No closed pull request and no idle gone branch was found for this preview, so it was kept.");
    const record = {
      deployment: name, environment: target.environment, capability: "lifecycle", before: this.before(target.deployment),
      evidence: assessment.evidence, reason: assessment.reapReason,
    };
    const dryRun = options.dryRun || config.guards.dryRunOnly;
    if (dryRun) {
      await this.audit(actor, "Convex preview delete dry run", { ...record, outcome: "dry-run" }, name);
      return { dryRun: true, wouldDelete: true, deleted: false, environment: target.environment, deployment: this.summary(target.deployment, target.environment), evidence: assessment.evidence, reason: assessment.reapReason };
    }
    if (options.budget) {
      if (options.budget.left <= 0) throw new Refusal(`Deletion limit of ${options.budget.max} reached for this run.`);
      options.budget.left -= 1;
    } else if (actor.kind === "agent") await this.reserveRunDeletion(actor, config.guards.maxDeletesPerRun);
    const [token] = await this.nameCredentials(config, actor.companyId, target.project, target.projectIndex, true);
    if (!token) throw new Refusal("No credential is configured for this Convex project.");
    await this.audit(actor, "Convex preview deletion requested", { ...record, outcome: "requested" }, name);
    try {
      await this.d.convex.deleteDeployment(token, name);
    } catch (error) {
      await this.audit(actor, "Convex preview delete failed", { ...record, outcome: "failed", error: error instanceof ConvexApiError ? error.message : "Convex could not delete the deployment." }, name);
      throw error;
    }
    await this.audit(actor, "Convex preview deleted", { ...record, outcome: "deleted", after: null }, name);
    return { dryRun: false, wouldDelete: true, deleted: true, environment: target.environment, deployment: this.summary(target.deployment, target.environment), evidence: assessment.evidence, reason: assessment.reapReason };
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
      const token = await this.resolveSecret(config.teamToken, companyId, "teamToken");
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
