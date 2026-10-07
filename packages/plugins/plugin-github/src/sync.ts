import { createHash } from "node:crypto";
import type { Issue, PluginContext } from "@paperclipai/plugin-sdk";
import { GitHubClient, GitHubError } from "./github.js";
import { boardScope } from "./setup.js";
import { nativeGitHubReady } from "./native-github.js";
import { PLUGIN_ID, type AutomationRule, type ConnectionState, type GitHubIssue, type Repository, type SyncReport, type SyncSettings, type TaskRepository, type TaskRepositories } from "./contracts.js";

const ORIGIN = `plugin:${PLUGIN_ID}:issue` as const;
const defaults: SyncSettings = { enabled: true, rules: [] };
type Snapshot = { title: string; body: string; state: string };
type Link = { issueId: string; githubId: number; number: number; repositoryId: number; base: Snapshot; ruleMatch?: string; conflicts?: string[]; wakePending?: string; projectless?: boolean };
type Pending = { issueId: string; repositoryId: number; phase: "ready" | "posting"; title: string; body: string };
type Credentials = (companyId: string) => Promise<{ id: string; pem: string }>;
export interface GitHubWebhookPayload {
  action?: string;
  installation?: { id?: number; app_id?: number };
  repository?: { id?: number; full_name?: string; html_url?: string; name?: string; owner?: { login?: string }; private?: boolean };
  issue?: Record<string, unknown>;
  pull_request?: Record<string, unknown>;
  requested_reviewer?: { login?: string };
  check_run?: { check_suite?: { pull_requests?: Array<{ number?: number }> } };
  sender?: { login?: string };
}
export interface GitHubWebhookResult { companyId: string; action: string; kind: "issue" | "pull"; taskId?: string; duplicate?: boolean; ignored?: boolean }
const key = (companyId: string, stateKey: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "sync", stateKey });
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const cleanBody = (body: string) => body.replace(/\n?<!-- paperclip:[a-zA-Z0-9-]+:[a-zA-Z0-9-]+ -->/g, "");
const marker = (companyId: string, issueId: string) => `<!-- paperclip:${companyId}:${issueId} -->`;
const localSnapshot = (issue: Issue): Snapshot => ({ title: issue.title, body: issue.description ?? "", state: issue.status === "done" ? "completed" : issue.status === "cancelled" ? "not_planned" : "open" });
const remoteSnapshot = (issue: GitHubIssue): Snapshot => ({ title: issue.title, body: cleanBody(issue.body ?? ""), state: issue.state === "closed" ? issue.stateReason === "not_planned" ? "not_planned" : "completed" : "open" });
const statusFor = (state: string) => state === "open" ? "todo" as const : state === "not_planned" ? "cancelled" as const : "done" as const;
const errorText = (error: unknown) => error instanceof Error ? error.message : "Sync failed. Try again.";

/** Three-way comparison preserves edits on either side and exposes competing edits. */
export function mergeSnapshots(base: Snapshot, local: Snapshot, remote: Snapshot) {
  const toLocal: Partial<Snapshot> = {}, toRemote: Partial<Snapshot> = {}, conflicts: string[] = [];
  for (const field of ["title", "body", "state"] as const) {
    if (local[field] === remote[field]) continue;
    if (local[field] !== base[field] && remote[field] !== base[field]) conflicts.push(field);
    else if (local[field] !== base[field]) toRemote[field] = local[field];
    else toLocal[field] = remote[field];
  }
  return { toLocal, toRemote, conflicts };
}
export function matchingRule(rules: AutomationRule[], issue: GitHubIssue) {
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  return rules.find(rule => rule.enabled
    && (!rule.if.repository || eq(rule.if.repository, issue.repository))
    && (!rule.if.assignee || issue.assignees.some(value => eq(value, rule.if.assignee!)))
    && (!rule.if.label || issue.labels?.some(value => eq(value, rule.if.label!)))
    && (!rule.if.state || rule.if.state === issue.state));
}
export function validateSettings(input: unknown): SyncSettings {
  if (!input || typeof input !== "object") throw new Error("Invalid sync settings.");
  const value = input as SyncSettings;
  if (typeof value.enabled !== "boolean" || !Array.isArray(value.rules) || value.rules.length > 50) throw new Error("Use at most 50 automation rules.");
  const ids = new Set<string>();
  const rules = value.rules.map(rule => {
    if (!rule || typeof rule.id !== "string" || !/^[\w-]{1,80}$/.test(rule.id) || ids.has(rule.id) || typeof rule.enabled !== "boolean" || typeof rule.name !== "string" || !rule.name.trim() || rule.name.length > 100 || !rule.if || !rule.then) throw new Error("Each rule needs a unique ID and a name.");
    ids.add(rule.id);
    const condition: AutomationRule["if"] = {};
    for (const field of ["repository", "assignee", "label"] as const) {
      const text = rule.if[field];
      if (text !== undefined) {
        if (typeof text !== "string" || !text.trim() || text.length > 200) throw new Error("Enter a condition value.");
        condition[field] = text.trim();
      }
    }
    if (rule.if.state !== undefined) {
      if (!["open", "closed"].includes(rule.if.state)) throw new Error("Invalid GitHub state.");
      condition.state = rule.if.state;
    }
    if (!Object.keys(condition).length) throw new Error("Add at least one IF condition.");
    const action: AutomationRule["then"] = {};
    if (rule.then.agentId !== undefined) {
      if (typeof rule.then.agentId !== "string" || !rule.then.agentId) throw new Error("Choose an agent.");
      action.agentId = rule.then.agentId;
    }
    if (rule.then.status !== undefined) {
      if (!["todo", "backlog", "in_review", "blocked"].includes(rule.then.status)) throw new Error("Invalid task status.");
      action.status = rule.then.status;
    }
    if (rule.then.priority !== undefined) {
      if (!["low", "medium", "high", "critical"].includes(rule.then.priority)) throw new Error("Invalid priority.");
      action.priority = rule.then.priority;
    }
    if (rule.then.wake !== undefined && typeof rule.then.wake !== "boolean") throw new Error("Invalid wake setting.");
    if (rule.then.wake && !action.agentId) throw new Error("Choose an agent before enabling wake.");
    if (!Object.keys(action).length) throw new Error("Add at least one THEN action.");
    action.wake = !!rule.then.wake;
    return { id: rule.id, enabled: rule.enabled, name: rule.name.trim(), if: condition, then: action };
  });
  return { enabled: value.enabled, rules };
}

const DISCONNECTED_DURING_SYNC = "The GitHub App was disconnected during sync.";
export function registerSync(ctx: PluginContext, github: GitHubClient, credentials: Credentials,
  sources: { repositories(companyId: string, projectId?: unknown): Promise<TaskRepositories>; repository(companyId: string, repositoryId: number): Promise<TaskRepository | null> },
  invalidate: (companyId: string) => void,
  companies: { connected(): Promise<string[]>; state(companyId: string): Promise<ConnectionState> }) {
  // One worker owns the plugin. Serialize its jobs, UI writes and event handlers
  // per company; host idempotency also covers crashes between create and receipt.
  const queues = new Map<string, Promise<unknown>>();
  const running = new Map<string, Promise<SyncReport | null>>();
  function exclusive<T>(companyId: string, operation: () => Promise<T>): Promise<T> {
    const pending = (queues.get(companyId) ?? Promise.resolve()).catch(() => {}).then(operation);
    queues.set(companyId, pending);
    void pending.finally(() => { if (queues.get(companyId) === pending) queues.delete(companyId); }).catch(() => {});
    return pending;
  }
  async function settings(companyId: string) { return (await ctx.state.get(key(companyId, "settings")) as SyncSettings | null) ?? defaults; }
  const loadLink = async (companyId: string, id: number) => await ctx.state.get(key(companyId, `link:${id}`)) as Link | null;
  const saveLink = (companyId: string, link: Link) => ctx.state.set(key(companyId, `link:${link.githubId}`), link);
  const pendingFor = async (companyId: string) => (await ctx.state.get(key(companyId, "pending")) as Record<string, Pending> | null) ?? {};
  async function findNative(companyId: string, remote: GitHubIssue, link: Link | null) {
    if (link) return ctx.issues.get(link.issueId, companyId);
    return (await ctx.issues.list({ companyId, originKind: ORIGIN, originId: String(remote.id), limit: 1 }))[0] ?? null;
  }
  async function applyRule(companyId: string, native: Issue, remote: GitHubIssue, link: Link, config: SyncSettings) {
    const rule = matchingRule(config.rules, remote);
    const match = rule ? digest(rule) : "none";
    if (link.ruleMatch !== match) {
      delete link.wakePending;
      if (rule) {
        const open = remote.state === "open" && native.status !== "done" && native.status !== "cancelled";
        if (native.checkoutRunId || native.executionRunId) throw new Error("An agent is working on this task. Automation will retry after the run.");
        if (rule.then.agentId) {
          const agent = await ctx.agents.get(rule.then.agentId, companyId);
          if (!agent || agent.companyId !== companyId || agent.status === "terminated") throw new Error(`Automation “${rule.name}” needs an available agent.`);
        }
        native = await ctx.issues.update(native.id, {
          ...(rule.then.agentId ? { assigneeAgentId: rule.then.agentId, assigneeUserId: null } : {}),
          ...(open && rule.then.status ? { status: rule.then.status } : {}),
          ...(rule.then.priority ? { priority: rule.then.priority } : {}),
        }, companyId);
        if (open && rule.then.wake) link.wakePending = `github:${remote.id}:${remote.updatedAt}:${match}`;
      }
      link.ruleMatch = match;
      await saveLink(companyId, link);
    }
    if (link.wakePending && (!rule?.then.wake || native.assigneeAgentId !== rule.then.agentId
      || remote.state !== "open" || native.status === "done" || native.status === "cancelled")) {
      delete link.wakePending;
      await saveLink(companyId, link);
    }
    if (link.wakePending) {
      if (native.checkoutRunId || native.executionRunId) throw new Error("An agent is working on this task. Automation will retry after the run.");
      // Normal host wakeup enforces assignment, checkout, agent budget and runtime policy.
      await ctx.issues.requestWakeup(native.id, companyId, { reason: "GitHub automation", contextSource: "github.sync", idempotencyKey: link.wakePending });
      delete link.wakePending;
      await saveLink(companyId, link);
    }
  }
  async function ensureNative(companyId: string, repo: Repository, remote: GitHubIssue, projectIds: string[], report: SyncReport) {
    let link = await loadLink(companyId, remote.id);
    let native = await findNative(companyId, remote, link);
    // A deleted Paperclip task stays deleted; retain its mapping as a tombstone.
    if (link && !native) return null;
    if (!native) {
      native = await ctx.issues.create({ companyId, projectId: [...projectIds].sort()[0], title: remote.title, description: cleanBody(remote.body ?? ""),
        status: statusFor(remoteSnapshot(remote).state), originKind: ORIGIN, originId: String(remote.id),
        idempotencyKey: `github:${remote.id}`, allowDuplicate: true });
      report.imported++;
    }
    if (!link) {
      link = { issueId: native.id, githubId: remote.id, number: remote.number, repositoryId: repo.id, base: remoteSnapshot(remote), projectless: !projectIds.length };
      await saveLink(companyId, link);
    }
    return { native, link };
  }
  // UI discovery and the background job use the same queue and idempotent mapping.
  async function ensureTasks(companyId: string, repo: Repository, remotes: GitHubIssue[]) {
    return exclusive(companyId, async () => {
      const source = await sources.repository(companyId, repo.id);
      if (!source) throw new Error("This repository is no longer accessible.");
      const projectIds = source.projects.map(p => p.id);
      const refs = new Map<number, { paperclipTask?: { id: string; identifier: string | null; status: string }; paperclipTaskError?: string }>();
      const tracked = (await ctx.state.get(key(companyId, "standalone")) as Record<string, { repositoryId: number; number: number }> | null) ?? {};
      for (const remote of remotes) {
        try {
          // Recover a partially published task before considering a new import.
          const pending = Object.values(await pendingFor(companyId)).find(p => p.repositoryId === repo.id && remote.body?.includes(marker(companyId, p.issueId)));
          if (pending) await publishPending(companyId, pending, source, await credentials(companyId), [remote]);
          const pair = await ensureNative(companyId, source, remote, projectIds, { at: "", imported: 0, updated: 0, warnings: [] });
          if (!pair) { refs.set(remote.id, { paperclipTaskError: "Associated task was deleted." }); continue; }
          if (pair.link.projectless) tracked[String(remote.id)] = { repositoryId: source.id, number: remote.number };
          refs.set(remote.id, { paperclipTask: { id: pair.native.id, identifier: pair.native.identifier ?? null, status: pair.native.status } });
        } catch (error) { refs.set(remote.id, { paperclipTaskError: errorText(error) }); }
      }
      await ctx.state.set(key(companyId, "standalone"), tracked);
      return refs;
    });
  }
  function remoteFromWebhook(value: Record<string, unknown>, repo: Repository): GitHubIssue | null {
    const id = Number(value.id), number = Number(value.number);
    if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(number) || number < 1) return null;
    const assignees = Array.isArray(value.assignees) ? value.assignees.flatMap(item => item && typeof item === "object" && typeof (item as any).login === "string" ? [(item as any).login] : []) : [];
    const labels = Array.isArray(value.labels) ? value.labels.flatMap(item => item && typeof item === "object" && typeof (item as any).name === "string" ? [(item as any).name] : typeof item === "string" ? [item] : []) : [];
    const state = value.state === "closed" ? "closed" : "open";
    return { id, number, title: String(value.title ?? "GitHub task"), body: typeof value.body === "string" ? value.body : "", state,
      stateReason: typeof value.state_reason === "string" ? value.state_reason : null, labels, assignees,
      url: typeof value.html_url === "string" ? value.html_url : `https://github.com/${repo.fullName}/issues/${number}`,
      repository: repo.fullName, updatedAt: typeof value.updated_at === "string" ? value.updated_at : new Date().toISOString() };
  }
  async function ensurePullTask(companyId: string, repo: Repository, remote: GitHubIssue, projectIds: string[], config: SyncSettings) {
    const originKind = `plugin:${PLUGIN_ID}:pull`;
    const saved = await ctx.issues.list({ companyId, originKind, originId: String(remote.id), limit: 1 });
    let native = saved[0] ?? null;
    if (!native) {
      if (!projectIds.length) return null;
      native = await ctx.issues.create({ companyId, projectId: [...projectIds].sort()[0], title: remote.title,
        description: `${remote.body ?? ""}\n\n${remote.url}`, status: remote.state === "closed" ? "done" : "todo",
        originKind, originId: String(remote.id), idempotencyKey: `github-pull:${repo.id}:${remote.id}`, allowDuplicate: true });
      await ctx.activity.log({ companyId, message: "GitHub pull request created a Paperclip task", metadata: { taskId: native.id, repositoryId: repo.id, number: remote.number } });
    } else if (!native.checkoutRunId && !native.executionRunId) {
      const nextStatus = remote.state === "closed" ? "done" : native.status === "done" ? "todo" : native.status;
      const nextDescription = `${remote.body ?? ""}\n\n${remote.url}`;
      if (native.title !== remote.title || native.description !== nextDescription || native.status !== nextStatus) {
        native = await ctx.issues.update(native.id, { title: remote.title, description: nextDescription, status: nextStatus }, companyId);
      }
    }
    const link: Link = { issueId: native.id, githubId: remote.id, number: remote.number, repositoryId: repo.id, base: remoteSnapshot(remote) };
    await saveLink(companyId, { ...link, issueId: native.id });
    await applyRule(companyId, native, remote, link, config);
    return native;
  }

  async function reconcile(companyId: string, repo: Repository, remote: GitHubIssue, projectIds: string[],
    auth: { id: string; pem: string }, config: SyncSettings, report: SyncReport, force?: "paperclip" | "github") {
    const pair = await ensureNative(companyId, repo, remote, projectIds, report);
    if (!pair) return;
    let { native, link } = pair;
    if (link.projectless && !native.projectId && projectIds.length) {
      if (native.checkoutRunId || native.executionRunId) throw new Error("An agent is working on this task. Project linking will retry after the run.");
      native = await ctx.issues.update(native.id, { projectId: [...projectIds].sort()[0] }, companyId);
      link.projectless = false;
    }
    if (!(link.projectless && !native.projectId) && (!native.projectId || !projectIds.includes(native.projectId))) throw new Error("This task’s project is no longer linked to the repository. Sync is paused for this task.");
    link.repositoryId = repo.id; link.number = remote.number;
    const local = localSnapshot(native);
    // Listings can become stale while paginating. Re-read changed pairs before
    // conflict resolution or provider writes (GitHub has no conditional PATCH).
    if (digest(local) !== digest(remoteSnapshot(remote))) remote = await github.getIssue(auth.id, auth.pem, repo, remote.number);
    const incoming = remoteSnapshot(remote);
    const merged = mergeSnapshots(force === "paperclip" ? incoming : force === "github" ? local : link.base, local, incoming);
    link.conflicts = merged.conflicts;
    await saveLink(companyId, link);
    if (merged.conflicts.length) throw new Error(`Conflicting ${merged.conflicts.join(", ")} edits. Open the task’s GitHub panel to choose which version to keep.`);
    if (Object.keys(merged.toLocal).length) {
      if (native.checkoutRunId || native.executionRunId) throw new Error("An agent is working on this task. Incoming edits will retry after the run.");
      const current = await ctx.issues.get(native.id, companyId);
      if (!current || digest(localSnapshot(current)) !== digest(local)) throw new Error("Task changed during sync. Retrying on the next sync.");
      native = await ctx.issues.update(native.id, {
        ...(merged.toLocal.title !== undefined ? { title: merged.toLocal.title } : {}),
        ...(merged.toLocal.body !== undefined ? { description: merged.toLocal.body } : {}),
        ...(merged.toLocal.state !== undefined ? { status: statusFor(merged.toLocal.state) } : {}),
      }, companyId);
      report.updated++;
    }
    if (Object.keys(merged.toRemote).length) {
      if (!repo.issuesWrite) throw new Error("Enable Issues read/write on the GitHub App and approve the installation update to sync task edits.");
      const fields = merged.toRemote;
      // Preserve the creation receipt in the GitHub body when editing it.
      const receipt = (remote.body ?? "").match(/<!-- paperclip:[a-zA-Z0-9-]+:[a-zA-Z0-9-]+ -->/)?.[0];
      invalidate(companyId);
      try { remote = await github.updateIssue(auth.id, auth.pem, repo, remote.number, {
        ...(fields.title !== undefined ? { title: fields.title } : {}),
        ...(fields.body !== undefined ? { body: fields.body + (receipt ? `\n${receipt}` : "") } : {}),
        ...(fields.state !== undefined ? { state: fields.state === "open" ? "open" : "closed", state_reason: fields.state === "open" ? "reopened" : fields.state === "not_planned" ? "not_planned" : "completed" } : {}),
      }); } finally { invalidate(companyId); }
      report.updated++;
    }
    link.base = remoteSnapshot(remote);
    link.conflicts = [];
    await saveLink(companyId, link);
    await applyRule(companyId, native, remote, link, config);
  }
  async function attach(companyId: string, native: Issue, repo: Repository, remote: GitHubIssue, base?: Snapshot) {
    if (native.originKind?.startsWith("plugin:") && !native.originKind.startsWith(`plugin:${PLUGIN_ID}`)) throw new Error("This task is managed by another plugin. Create a separate GitHub task.");
    const existing = await loadLink(companyId, remote.id);
    const prior = await findNative(companyId, remote, existing);
    if (prior && prior.id !== native.id) throw new Error("This GitHub issue already has a Paperclip task. Open that task instead.");
    if (native.originKind === ORIGIN && native.originId && native.originId !== String(remote.id)) throw new Error("This task is already linked to a different GitHub issue.");
    await ctx.issues.update(native.id, { originKind: ORIGIN, originId: String(remote.id) }, companyId);
    await saveLink(companyId, { issueId: native.id, githubId: remote.id, number: remote.number, repositoryId: repo.id,
      base: base ?? remoteSnapshot(remote) });
  }
  async function publishPending(companyId: string, pending: Pending, repo: Repository, auth: { id: string; pem: string }, known?: GitHubIssue[]) {
    const native = await ctx.issues.get(pending.issueId, companyId);
    if (!native) throw new Error("The Paperclip task was deleted. Publication is paused.");
    if (!native.projectId || !(await sources.repositories(companyId, native.projectId)).repositories.some(r => r.id === repo.id)) throw new Error("The task’s repository is no longer linked. Publication is paused.");
    let remote = known?.find(issue => issue.body?.includes(marker(companyId, native.id)));
    if (!remote && pending.phase === "posting") throw new Error("GitHub creation is unconfirmed. Sync checks for its receipt before retrying; link the existing GitHub issue if you removed the receipt.");
    if (!remote) {
      if (!repo.issuesWrite) throw new Error("Enable Issues read/write and approve the installation update to publish this task.");
      pending.phase = "posting";
      const all = await pendingFor(companyId); all[native.id] = pending;
      await ctx.state.set(key(companyId, "pending"), all);
      invalidate(companyId);
      try { remote = await github.createIssue(auth.id, auth.pem, repo, { title: pending.title, body: pending.body + `\n${marker(companyId, native.id)}` }); }
      catch (error) {
        if (error instanceof GitHubError && [400, 401, 403, 404, 410, 422, 429].includes(error.status)) {
          pending.phase = "ready"; all[native.id] = pending;
          await ctx.state.set(key(companyId, "pending"), all);
        }
        throw error;
      } finally { invalidate(companyId); }
    }
    await attach(companyId, native, repo, remote, { title: pending.title, body: pending.body, state: "open" });
    const all = await pendingFor(companyId); delete all[native.id]; await ctx.state.set(key(companyId, "pending"), all);
    return remote;
  }
  async function run(companyId: string): Promise<SyncReport | null> {
    // Only a connected company syncs; disconnecting also stops an in-flight run
    // before its next repository.
    const connected = async () => await companies.state(companyId) === "connected";
    if (!await connected()) return null;
    const report: SyncReport = { at: new Date().toISOString(), imported: 0, updated: 0, warnings: [] };
    try {
      const config = await settings(companyId);
      if (!config.enabled) return null;
      const data = await sources.repositories(companyId);
      report.warnings.push(...data.warnings);
      const auth = await credentials(companyId);
      for (const repo of data.repositories) {
        if (!await connected()) { report.warnings.push(DISCONNECTED_DURING_SYNC); return report; }
        try {
          const remoteIssues: GitHubIssue[] = [];
          for (let page: number | null = 1; page !== null;) {
            const result = await github.issues(auth.id, auth.pem, repo, page, "all");
            remoteIssues.push(...result.issues);
            if (result.nextPage !== null && (result.nextPage <= page || result.nextPage > 10000)) throw new Error("GitHub returned an invalid issue page.");
            page = result.nextPage;
          }
          const pending = Object.values(await pendingFor(companyId)).filter(item => item.repositoryId === repo.id);
          const unresolved = new Set<string>();
          for (const item of pending) {
            try {
              const remote = await publishPending(companyId, item, repo, auth, remoteIssues);
              if (!remoteIssues.some(issue => issue.id === remote.id)) remoteIssues.push(remote);
            } catch (error) { unresolved.add(item.issueId); report.warnings.push(`${repo.fullName}: ${errorText(error)}`); }
          }
          for (const remote of new Map(remoteIssues.map(issue => [issue.id, issue])).values()) {
            // A partially attached publication is never imported as a second task.
            if ([...unresolved].some(id => remote.body?.includes(marker(companyId, id)))) continue;
            try { await reconcile(companyId, repo, remote, repo.projects.map(p => p.id), auth, config, report); }
            catch (error) { report.warnings.push(`${repo.fullName} #${remote.number}: ${errorText(error)}`); }
          }
        } catch (error) { report.warnings.push(`${repo.fullName}: ${errorText(error)}`); }
      }
      const tracked = (await ctx.state.get(key(companyId, "standalone")) as Record<string, { repositoryId: number; number: number }> | null) ?? {};
      for (const [githubId, item] of Object.entries(tracked)) {
        if (data.repositories.some(repo => repo.id === item.repositoryId)) continue;
        if (!await connected()) { report.warnings.push(DISCONNECTED_DURING_SYNC); return report; }
        try {
          const repo = await sources.repository(companyId, item.repositoryId);
          if (!repo) throw new Error("Repository access is unavailable.");
          const remote = await github.getIssue(auth.id, auth.pem, repo, item.number);
          if (String(remote.id) !== githubId) throw new Error("Issue moved. Open it in its destination repository to reconnect.");
          await reconcile(companyId, repo, remote, repo.projects.map(p => p.id), auth, config, report);
        } catch (error) { report.warnings.push(`GitHub issue #${item.number}: ${errorText(error)}`); }
      }
    } catch (error) { report.warnings.push(errorText(error)); }
    finally { if (report.updated) invalidate(companyId); await ctx.state.set(key(companyId, "report"), report); }
    return report;
  }
  function sync(companyId: string) {
    const existing = running.get(companyId); if (existing) return existing;
    const promise = exclusive(companyId, () => run(companyId));
    running.set(companyId, promise);
    void promise.finally(() => { if (running.get(companyId) === promise) running.delete(companyId); }).catch(() => {});
    return promise;
  }
  ctx.jobs.register("github-sync", async () => {
    // Scheduled plugin jobs are instance-scoped at the host boundary, and
    // ctx.companies.list() is a forbidden wildcard call from this context.
    // Iterate the companies connected in persisted state, so a worker restart
    // without a config replay keeps syncing.
    for (const companyId of await companies.connected()) {
      try { await sync(companyId); }
      catch (error) { ctx.logger.error("GitHub scheduled sync failed", { companyId, error: errorText(error) }); }
    }
  });
  for (const event of ["issue.updated", "project.created", "project.updated"] as const) {
    ctx.events.on(event, async event => {
      if (event.actorType === "plugin") return;
      // Event delivery is only an accelerator; scheduled reconciliation repairs missed events.
      void sync(event.companyId).catch(() => {});
    });
  }
  ctx.actions.register("sync-now", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    if (params.refresh === true) invalidate(companyId);
    else {
      const report = await ctx.state.get(key(companyId, "report")) as SyncReport | null;
      if (report && Date.now() - Date.parse(report.at) < 60_000) return { started: false };
    }
    void sync(companyId).catch(() => {});
    return { started: true };
  });
  ctx.actions.register("sync-status", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    // Reports the connection without loading the private key.
    const connection = await companies.state(companyId);
    return { configured: connection === "connected", connection, settings: await settings(companyId), busy: running.has(companyId),
      report: await ctx.state.get(key(companyId, "report")), pendingCount: Object.keys(await pendingFor(companyId)).length };
  });
  ctx.actions.register("automation-options", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    const agents = [];
    for (let offset = 0; ; offset += 100) {
      const page = await ctx.agents.list({ companyId, limit: 100, offset });
      agents.push(...page.filter(a => a.status !== "terminated").map(a => ({ id: a.id, name: a.name })));
      if (page.length < 100) break;
    }
    return { agents, repositories: (await sources.repositories(companyId)).repositories.map(r => r.fullName) };
  });
  ctx.actions.register("save-sync-settings", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    const value = validateSettings(params.settings);
    for (const rule of value.rules) {
      if (rule.then.agentId && !await ctx.agents.get(rule.then.agentId, companyId)) throw new Error("Choose an agent in this company.");
      if (rule.then.wake && !(await nativeGitHubReady(ctx, companyId))) throw new Error("Enable and assign Paperclip’s native GitHub chat connector before enabling agent wake for GitHub automations.");
    }
    await exclusive(companyId, async () => {
      await ctx.state.set(key(companyId, "settings"), value);
      await ctx.activity.log({ companyId, message: "GitHub sync and automation settings updated", metadata: { enabled: value.enabled, ruleCount: value.rules.length } });
    });
    void sync(companyId).catch(() => {});
    return value;
  });
  ctx.actions.register("task-destinations", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    if (typeof params.projectId !== "string" || !params.projectId) return { destinations: [] };
    const data = await sources.repositories(companyId, params.projectId);
    return { destinations: data.repositories.map(repo => ({ id: String(repo.id), label: repo.fullName,
      ...(!repo.issuesWrite ? { disabledReason: "Enable Issues read/write in GitHub connection settings." } : {}) })) };
  });
  ctx.actions.register("publish-task", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    return exclusive(companyId, async () => {
      const native = typeof params.issueId === "string" ? await ctx.issues.get(params.issueId, companyId) : null;
      if (!native?.projectId) throw new Error("Choose a project linked to GitHub.");
      const repo = (await sources.repositories(companyId, native.projectId)).repositories.find(r => String(r.id) === params.destinationId);
      if (!repo) throw new Error("This repository is not linked to the task’s project or is no longer accessible.");
      if (native.originKind === ORIGIN && native.originId) {
        const link = await loadLink(companyId, Number(native.originId));
        if (link && link.repositoryId !== repo.id) throw new Error("This task is already linked to a different repository.");
        if (link) return { url: `https://github.com/${repo.fullName}/issues/${link.number}` };
      }
      const all = await pendingFor(companyId);
      if (all[native.id] && all[native.id].repositoryId !== repo.id) throw new Error("Publication is already pending for another repository.");
      const item = all[native.id] ?? { issueId: native.id, repositoryId: repo.id, phase: "ready" as const, title: native.title, body: native.description ?? "" };
      all[native.id] = item; await ctx.state.set(key(companyId, "pending"), all);
      try {
        const remote = await publishPending(companyId, item, repo, await credentials(companyId));
        return { url: remote.url };
      } catch (error) { return { warning: errorText(error) }; }
    });
  });
  ctx.actions.register("task-sync-detail", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    const native = typeof params.issueId === "string" ? await ctx.issues.get(params.issueId, companyId) : null;
    if (!native) throw new Error("Task not found in this company.");
    const link = native.originKind === ORIGIN && native.originId ? await loadLink(companyId, Number(native.originId)) : null;
    const repos = native.projectId ? (await sources.repositories(companyId, native.projectId)).repositories : [];
    if (link?.projectless && !repos.some(r => r.id === link.repositoryId)) {
      const source = await sources.repository(companyId, link.repositoryId); if (source) repos.push(source);
    }
    const repo = repos.find(r => r.id === link?.repositoryId);
    return { link: link ? { ...link, base: undefined, url: repo ? `https://github.com/${repo.fullName}/issues/${link.number}` : null } : null,
      pending: !!(await pendingFor(companyId))[native.id], repositories: repos.map(r => ({ id: r.id, fullName: r.fullName, issuesWrite: r.issuesWrite })) };
  });
  ctx.actions.register("resolve-task-sync", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    if (params.keep !== "paperclip" && params.keep !== "github") throw new Error("Choose Paperclip or GitHub.");
    const keep = params.keep;
    return exclusive(companyId, async () => {
      const native = typeof params.issueId === "string" ? await ctx.issues.get(params.issueId, companyId) : null;
      if (!native || native.originKind !== ORIGIN || !native.originId) throw new Error("This task is not linked to a GitHub issue.");
      const link = await loadLink(companyId, Number(native.originId));
      const repo = link?.projectless ? await sources.repository(companyId, link.repositoryId) : native.projectId ? (await sources.repositories(companyId, native.projectId)).repositories.find(r => r.id === link?.repositoryId) : null;
      if (!link || !repo) throw new Error("The linked repository is no longer accessible.");
      const auth = await credentials(companyId);
      const remote = await github.getIssue(auth.id, auth.pem, repo, link.number);
      await reconcile(companyId, repo, remote, repo.projects.map(p => p.id), auth, await settings(companyId), { at: "", imported: 0, updated: 0, warnings: [] }, keep);
      return { ok: true };
    });
  });
  ctx.actions.register("link-task", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    if (!Number.isSafeInteger(params.number) || Number(params.number) < 1) throw new Error("Enter a GitHub issue number.");
    return exclusive(companyId, async () => {
      const native = typeof params.issueId === "string" ? await ctx.issues.get(params.issueId, companyId) : null;
      if (!native?.projectId) throw new Error("Choose a project linked to GitHub.");
      const repo = (await sources.repositories(companyId, native.projectId)).repositories.find(r => r.id === params.repositoryId);
      if (!repo) throw new Error("This repository is not linked to the task’s project.");
      const auth = await credentials(companyId), remote = await github.getIssue(auth.id, auth.pem, repo, Number(params.number));
      // Initial explicit linking adopts GitHub content on the next sync.
      await attach(companyId, native, repo, remote, localSnapshot(native));
      const pending = await pendingFor(companyId); delete pending[native.id]; await ctx.state.set(key(companyId, "pending"), pending);
      return { url: remote.url };
    });
  });
  async function handleWebhook(input: { companyId: string; headers: Record<string, string | string[]>; parsedBody?: unknown; requestId: string }): Promise<GitHubWebhookResult | null> {
    const body = input.parsedBody && typeof input.parsedBody === "object" ? input.parsedBody as GitHubWebhookPayload : null;
    if (!body?.repository) return null;
    const repositoryId = Number(body.repository.id);
    if (!Number.isSafeInteger(repositoryId) || repositoryId < 1) return null;
    const action = typeof body.action === "string" ? body.action : "unknown";
    // PR issue_comment deliveries carry the PR marker under `issue.pull_request`.
    // check_run deliveries carry only check_suite.pull_requests, so they are
    // resolved to the canonical issue/PR before task reconciliation.
    const pullFromIssue = body.issue && (body.issue as any).pull_request ? body.issue : undefined;
    const checkPullNumber = body.check_run?.check_suite?.pull_requests?.find(item => Number.isSafeInteger(item.number) && Number(item.number) > 0)?.number;
    const kind = body.pull_request || pullFromIssue || checkPullNumber ? "pull" as const : body.issue ? "issue" as const : null;
    if (!kind) return null;
    const receipt = String(input.headers["x-github-delivery"] ?? input.requestId);
    // Callers pass the company that authenticated the delivery. Errors propagate
    // so a failed delivery is never recorded as processed.
    const companyId = input.companyId;
    const repo = await sources.repository(companyId, repositoryId);
    if (!repo) return null;
    const receiptKey = key(companyId, `webhook:${receipt}`);
    const prior = await ctx.state.get(receiptKey) as GitHubWebhookResult | null;
    if (prior) return { ...prior, duplicate: true };
    let remote = kind === "pull" && checkPullNumber ? null : remoteFromWebhook((kind === "pull" ? (body.pull_request ?? pullFromIssue) : body.issue)!, repo);
    if (kind === "pull" && checkPullNumber) {
      // check_run payloads omit the PR body/title/head. Fetch the canonical
      // issue representation so the linked Paperclip PR task is refreshed.
      const auth = await credentials(companyId);
      remote = await github.getIssue(auth.id, auth.pem, repo, Number(checkPullNumber));
    }
    if (!remote) return null;
    if (body.requested_reviewer?.login && !remote.assignees.includes(body.requested_reviewer.login)) remote.assignees.push(body.requested_reviewer.login);
    const configSync = await settings(companyId);
    let taskId: string | undefined;
    if (kind === "issue") {
      const refs = await ensureTasks(companyId, repo, [remote]);
      taskId = refs.get(remote.id)?.paperclipTask?.id;
      const native = taskId ? await ctx.issues.get(taskId, companyId) : null;
      if (native) await applyRule(companyId, native, remote, (await loadLink(companyId, remote.id))!, configSync);
    } else {
      const native = await ensurePullTask(companyId, repo, remote, repo.projects.map(p => p.id), configSync);
      taskId = native?.id;
    }
    const result = { companyId, action, kind, ...(taskId ? { taskId } : {}), ignored: !taskId };
    await ctx.state.set(receiptKey, result);
    await ctx.activity.log({ companyId, message: `GitHub ${kind} webhook processed`, metadata: { action, repositoryId, number: remote.number, taskId, delivery: receipt } });
    return result;
  }

  return { sync, ensureTasks, handleWebhook, linkForTask: async (companyId: string, issue: Issue) => {
    if (issue.originKind !== ORIGIN || !issue.originId) return null;
    const link = await loadLink(companyId, Number(issue.originId));
    return link?.issueId === issue.id ? link : null;
  } };
}
