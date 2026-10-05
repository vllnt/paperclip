import { createHash } from "node:crypto";
import type { EnvSecretRefBinding, PluginContext } from "@paperclipai/plugin-sdk";
import { GitHubClient, GitHubError, repoName } from "./github.js";
import { GitHubReadCache } from "./read-cache.js";
import type { registerSync } from "./sync.js";
import { boardScope } from "./setup.js";
import { nativeConnectorRequiredError, nativeGitHubEndpoints, requireNativeGitHubAgents } from "./native-github.js";
import { ProjectManager, projectReads, projectWrites } from "./management-projects.js";
import { permission, RepositoryManager, repoReads, repoWrites, integer, text, type Params } from "./management-repository.js";

type Auth = { id: string; pem: string };
export function registerManagement(ctx: PluginContext, github: GitHubClient, credentials: (companyId: string) => Promise<Auth>, synced: (companyId: string) => Promise<unknown>, cache = new GitHubReadCache(), ensureTasks?: ReturnType<typeof registerSync>["ensureTasks"]) {
  const queues = new Map<string, Promise<unknown>>();
  async function personal(companyId: string) {
    const config = await ctx.config.get(companyId);
    if (!config.personalToken) return null;
    const token = await ctx.secrets.resolve(config.personalToken as EnvSecretRefBinding, { companyId, configPath: "personalToken" });
    const { data } = await github.request<{ login: string }>("/user", token);
    return { token, login: data.login };
  }
  async function scope(companyId: string, p: Params, fresh = false) {
    const auth = await credentials(companyId), catalog = await cache.catalog(companyId, auth, github, fresh || p.refresh === true);
    const repository = catalog.repositories.find(r => r.id === p.repositoryId);
    return { auth, catalog, repository };
  }
  // Persist before a side effect. A lost response can be inspected, but is never replayed blindly.
  async function write(companyId: string, family: string, op: string, params: Params, run: (beforeWrite: () => Promise<void>) => Promise<unknown>) {
    const requestId = text(params.requestId, "request identifier", 100);
    if (!/^[a-zA-Z0-9-]{8,100}$/.test(requestId)) throw new Error("Invalid request identifier.");
    const key = { scopeKind: "company" as const, scopeId: companyId, namespace: "management", stateKey: `request:${requestId}` };
    const fingerprint = createHash("sha256").update(JSON.stringify({ family, op, params })).digest("hex");
    const previous = queues.get(companyId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      const prior = await ctx.state.get(key) as { fingerprint: string; status: string; result?: unknown } | null;
      if (prior && prior.fingerprint !== fingerprint) throw new Error("This request identifier was used for different values. Refresh before trying again.");
      if (prior?.status === "done") return prior.result;
      if (prior?.status === "pending") throw new Error("The previous result is unconfirmed. Refresh GitHub data and check whether it succeeded before starting a new action.");
      let result: unknown, sent = false;
      const beforeWrite = async () => {
        await ctx.activity.log({ companyId, message: `GitHub ${family}: ${op} requested`, metadata: { repositoryId: params.repositoryId, number: params.number, projectNumber: params.projectNumber, owner: params.owner, requestId } });
        await ctx.state.set(key, { fingerprint, status: "pending", at: new Date().toISOString() });
        sent = true;
        cache.invalidate(companyId);
      };
      try { result = await run(beforeWrite); }
      catch (error) {
        if (sent) cache.invalidate(companyId);
        // HTTP client rejections establish no applied write. Network/GraphQL/storage uncertainty stays pending.
        if (error instanceof GitHubError && [400, 401, 403, 404, 405, 409, 410, 422, 429].includes(error.status)) {
          await ctx.state.set(key, { fingerprint, status: "rejected" });
          throw error;
        }
        if (sent) throw new Error("GitHub may have applied this change, but its result is unconfirmed. Refresh the item and inspect it before starting a new action.");
        throw error;
      }
      cache.invalidate(companyId);
      const saved = result ?? { ok: true };
      try { await ctx.state.set(key, { fingerprint, status: "done", result: saved, at: new Date().toISOString() }); }
      catch { throw new Error("GitHub applied this change, but Paperclip could not save its confirmation. Refresh the item before starting a new action."); }
      void synced(companyId).catch(() => {});
      return saved;
    });
    queues.set(companyId, current);
    void current.finally(() => { if (queues.get(companyId) === current) queues.delete(companyId); }).catch(() => {});
    return current;
  }
  ctx.actions.register("verify-personal", async (params, actor) => {
    boardScope(params, actor);
    const token = text(params.token, "personal access token", 1000);
    const { data } = await github.request<{ login: string }>("/user", token);
    await github.graphql(token, "query{viewer{projectsV2(first:1){totalCount}}}");
    return { login: data.login };
  });
  ctx.actions.register("management-options", async (params, actor) => {
    const { companyId } = boardScope(params, actor), { catalog } = await scope(companyId, params);
    let user: { login: string } | null = null;
    try { const access = await personal(companyId); if (access) user = { login: access.login }; }
    catch { catalog.warnings.push("Personal Projects access needs attention. Update its token in connection settings."); }
    return { ...catalog, personal: user };
  });
  async function reviewProjects(companyId: string, fullName: string) {
    const projects = [];
    for (let offset = 0; ; offset += 100) {
      const page = await ctx.projects.list({ companyId, limit: 100, offset });
      for (const project of page) {
        const workspaces = await ctx.projects.listWorkspaces(project.id, companyId);
        if (workspaces.some(w => w.repoUrl && repoName(w.repoUrl)?.toLowerCase() === fullName.toLowerCase())) projects.push({ id: project.id, name: project.name });
      }
      if (page.length < 100) break;
    }
    return projects;
  }
  async function providerPeople(companyId: string, repository: NonNullable<Awaited<ReturnType<typeof scope>>["repository"]>, auth: Auth) {
    // GitHub's assignees endpoint is the provider-owned candidate list for both
    // issue assignees and requested reviewers. Keep only well-formed logins so
    // stale/malformed provider rows can never become mutation inputs.
    const raw = await new RepositoryManager(github, auth, repository).run("assignees", {});
    const loginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
    const humans = (Array.isArray(raw?.rows) ? raw.rows : raw as any[])
      .map((row: any) => ({ login: typeof row?.login === "string" ? row.login : "", name: typeof row?.name === "string" ? row.name : null, avatarUrl: typeof row?.avatar_url === "string" ? row.avatar_url : null }))
      .filter((row: { login: string }) => loginPattern.test(row.login));
    const uniqueHumans = [...new Map(humans.map((row: { login: string }) => [row.login.toLowerCase(), row])).values()] as { login: string; name: string | null; avatarUrl: string | null }[];
    const endpoints = await nativeGitHubEndpoints(ctx, companyId);
    const bots = [] as { id: string; agentId: string; name: string; login: string; kind: "agent"; source: "paperclip-native-github"; enabled: true }[];
    for (const endpoint of endpoints) {
      if (!endpoint.assignedAgentId || !endpoint.botUsername || !loginPattern.test(endpoint.botUsername)) continue;
      const agent = await ctx.agents.get(endpoint.assignedAgentId, companyId);
      if (!agent || agent.status === "terminated") continue;
      if (bots.some(bot => bot.login.toLowerCase() === endpoint.botUsername!.toLowerCase())) continue;
      bots.push({ id: agent.id, agentId: agent.id, name: agent.name, login: endpoint.botUsername, kind: "agent", source: "paperclip-native-github", enabled: true });
    }
    const people = [
      ...uniqueHumans.map(row => ({ id: row.login, login: row.login, name: row.name, avatarUrl: row.avatarUrl, kind: "human" as const, source: "github" as const, enabled: true })),
      ...bots,
    ];
    return { assignees: uniqueHumans, reviewers: uniqueHumans, bots, people, nativeGitHub: { required: true, ready: bots.length > 0, setupPath: "/apps/chat/connect?provider=github&purpose=chat", owner: "paperclip-native-connector" as const } };
  }
  const peopleOptions = async (params: Params, actor: any) => {
    const { companyId } = boardScope(params, actor), { auth, repository } = await scope(companyId, params);
    if (!repository) throw new Error("This repository is not accessible.");
    return { repository: { id: repository.id, fullName: repository.fullName }, ...(await providerPeople(companyId, repository, auth)) };
  };
  ctx.actions.register("github-people-options", peopleOptions);

  ctx.actions.register("pr-task-options", async (params, actor) => {
    const { companyId } = boardScope(params, actor), { auth, repository } = await scope(companyId, params);
    if (!repository) throw new Error("This repository is not accessible.");
    const agents = [];
    for (let offset = 0; ; offset += 100) {
      const page = await ctx.agents.list({ companyId, limit: 100, offset });
      for (const agent of page.filter(a => a.status !== "terminated")) {
        const endpoint = (await nativeGitHubEndpoints(ctx, companyId, agent.id)).find(item => item.assignedAgentId === agent.id);
        agents.push({ id: agent.id, name: agent.name, status: agent.status, githubEnabled: Boolean(endpoint?.botUsername), githubLogin: endpoint?.botUsername ?? null, nativeGitHubRequired: true });
      }
      if (page.length < 100) break;
    }
    const people = await providerPeople(companyId, repository, auth);
    return {
      projects: await reviewProjects(companyId, repository.fullName),
      agents,
      ...people,
    };
  });
  ctx.actions.register("manage-agent-reviewers", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    const op = params.op === "remove" ? "remove-reviewers" : params.op === "request" ? "request-reviewers" : null;
    if (!op) throw new Error("Choose whether to request or remove reviewers.");
    const { auth, repository } = await scope(companyId, params, true);
    if (!repository) throw new Error("This repository is not accessible.");
    const number = integer(params.number, "pull request number");
    const rawAgentIds = params.agentIds ?? params.reviewerBotIds ?? [];
    const agentIds = Array.isArray(rawAgentIds) ? rawAgentIds : [];
    const loginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
    const humanReviewers = Array.isArray(params.reviewers) ? params.reviewers.map(login => text(login, "reviewer login", 39)) : [];
    if (humanReviewers.some(login => !loginPattern.test(login))) throw new Error("Choose valid GitHub reviewer logins.");
    const endpoints = agentIds.length ? await requireNativeGitHubAgents(ctx, companyId, agentIds as string[]) : [];
    const explicitBotLogins = Array.isArray(params.reviewerBotLogins) ? params.reviewerBotLogins.map(login => text(login, "reviewer bot login", 39)) : [];
    const availableBotLogins = new Set(endpoints.map(endpoint => endpoint.botUsername).filter((login): login is string => Boolean(login)).map(login => login.toLowerCase()));
    if (explicitBotLogins.some(login => !availableBotLogins.has(login.toLowerCase()))) throw nativeConnectorRequiredError();
    const logins = [...new Set([...endpoints.map(endpoint => endpoint.botUsername).filter((login): login is string => Boolean(login)), ...explicitBotLogins])];
    if (agentIds.length && logins.length !== agentIds.length) throw nativeConnectorRequiredError();
    const reviewers = [...new Set([...humanReviewers, ...logins])];
    const result = await write(companyId, "reviewers", op, params, beforeWrite => new RepositoryManager(github, auth, repository, beforeWrite).run(op, { ...params, number, reviewers }));
    await ctx.activity.log({ companyId, message: `GitHub PR reviewers ${params.op === "request" ? "requested" : "removed"}`, metadata: { repositoryId: repository.id, number, agentIds, reviewers } });
    return { ...result as Record<string, unknown>, operation: params.op, authoringIdentity: { kind: "company-app", appId: auth.id }, reviewers, nativeGitHub: { requiredForAgents: true, setupPath: "/apps/chat/connect?provider=github&purpose=chat", mode: "routing-compatibility" } };
  });

  ctx.actions.register("review-pr-task", async (params, actor) => {
    const { companyId } = boardScope(params, actor), { auth, repository } = await scope(companyId, params, true);
    if (!repository) throw new Error("This repository is not accessible.");
    const projects = await reviewProjects(companyId, repository.fullName);
    if (!projects.some(p => p.id === params.projectId)) throw new Error("Choose a Paperclip project linked to this repository.");

    // `agentIds` is the multi-reviewer form. Keep `agentId` as a compatibility
    // alias for callers that create one review task at a time.
    const rawReviewerAgentIds = params.reviewerAgentIds === undefined ? [] : params.reviewerAgentIds;
    if (!Array.isArray(rawReviewerAgentIds)) throw new Error("Choose one or more reviewer agents.");
    const reviewerAgentIds = [...new Set(rawReviewerAgentIds.map(id => text(id, "review agent", 100)))];
    const reviewerEndpoints = reviewerAgentIds.length ? await requireNativeGitHubAgents(ctx, companyId, reviewerAgentIds) : [];
    const reviewerLogins = reviewerEndpoints.map(endpoint => endpoint.botUsername).filter((login): login is string => Boolean(login));
    if (reviewerAgentIds.length && reviewerLogins.length !== reviewerAgentIds.length) throw nativeConnectorRequiredError();
    const reviewerBots = { agents: reviewerAgentIds.map((agentId, index) => ({ agentId, login: reviewerLogins[index]!, identity: "github-app" as const, targetType: "reviewer-login" as const })), logins: reviewerLogins };

    const rawAgentIds = params.agentIds !== undefined
      ? params.agentIds
      : params.agentId !== undefined
        ? [params.agentId]
        : reviewerAgentIds;
    if (!Array.isArray(rawAgentIds)) throw new Error("Choose one or more review agents.");
    const agentIds = [...new Set(rawAgentIds.map(id => text(id, "agent", 100)))];
    if (agentIds.length > 15) throw new Error("Choose between 1 and 15 review agents.");
    if (agentIds.length) await requireNativeGitHubAgents(ctx, companyId, agentIds);
    const agents = [] as { id: string; name: string }[];
    for (const id of agentIds) {
      const agent = await ctx.agents.get(id, companyId);
      if (!agent || agent.status === "terminated") throw new Error("Choose available agents in this company.");
      agents.push({ id: agent.id, name: agent.name });
    }
    if (params.wake && !agentIds.length) throw new Error("Choose an agent to wake.");

    const pr = await new RepositoryManager(github, auth, repository).run("pull", params);
    if (pr.state !== "open" || pr.merged) throw new Error("Choose an open PR for review.");
    if (pr.head.sha !== params.sha) throw new Error("The PR changed. Refresh before delegating this revision.");

    // No assignee still means one shared, unassigned review task. Once agents
    // are selected, each perspective gets an independent task and wake receipt.
    const assignments: (string | null)[] = agentIds.length ? agentIds : [null];
    const baseKey = `github-review:${repository.id}:${pr.number}:${pr.head.sha}`;
    const reviewerText = reviewerBots.agents.length
      ? `\n\nGitHub reviewer routing targets: ${reviewerBots.agents.map(agent => `@${agent.login}`).join(", ")}. Paperclip’s native GitHub connector owns channel identity and formal review submission.`
      : "\n\nGitHub reviewer identity and formal review submission are handled by Paperclip’s native GitHub connector.";
    const tasks = [] as { id: string; identifier?: string | null; assigneeAgentId?: string | null; agentId?: string | null; agentName?: string | null }[];
    for (const assignedAgentId of assignments) {
      const assignedAgent = agents.find(agent => agent.id === assignedAgentId);
      // Preserve the original single-agent request key for existing clients;
      // multi-agent requests add the assignee to keep every task idempotent.
      const taskKey = assignments.length === 1 ? baseKey : `${baseKey}:${assignedAgentId}`;
      const perspective = assignedAgent ? `\n\nReviewer perspective: ${assignedAgent.name}.` : "";
      const task = await ctx.issues.create({ companyId, projectId: String(params.projectId), title: `Review ${repository.fullName} #${pr.number}: ${pr.title}${assignedAgent ? ` · ${assignedAgent.name}` : ""}`,
        description: `Review https://github.com/${repository.fullName}/pull/${pr.number} at commit ${pr.head.sha}.\n\nInspect the diff and checks, and report findings in this task. A board user submits the GitHub review from Paperclip.${perspective}${reviewerText}`,
        status: "todo", ...(assignedAgentId ? { assigneeAgentId: assignedAgentId } : {}), originKind: "plugin:vllnt.paperclip-github:pull", originId: String(pr.id), idempotencyKey: taskKey, allowDuplicate: true });
      await ctx.state.set({ scopeKind: "company", scopeId: companyId, namespace: "sync", stateKey: `review:${task.id}` }, { issueId: task.id, repositoryId: repository.id, number: pr.number, reviewerAgentId: assignedAgentId, reviewerAgents: reviewerBots.agents.map(agent => ({ agentId: agent.agentId, login: agent.login, identity: agent.identity })) });
      if (params.wake === true) {
        if (task.status === "done" || task.status === "cancelled") throw new Error(`The review task (${task.identifier ?? task.id}) is already closed. Open it to request another review.`);
        if (assignedAgentId && task.assigneeAgentId !== assignedAgentId) throw new Error(`A review task already exists (${task.identifier ?? task.id}) with a different assignee. Open that task to reassign it.`);
        await ctx.issues.requestWakeup(task.id, companyId, { reason: "GitHub pull request review", contextSource: "github.pr", idempotencyKey: taskKey });
      }
      tasks.push({ id: task.id, identifier: task.identifier, assigneeAgentId: task.assigneeAgentId, agentId: assignedAgentId, agentName: assignedAgent?.name ?? null });
    }
    await ctx.activity.log({ companyId, message: "GitHub PR review task requested", metadata: { taskIds: tasks.map(task => task.id), repositoryId: repository.id, number: pr.number, sha: pr.head.sha, agentIds, wake: params.wake === true } });
    const first = tasks[0];
    return { id: first.id, identifier: first.identifier, assigneeAgentId: first.assigneeAgentId, agentId: first.agentId, agentName: first.agentName, tasks, authoringIdentity: { kind: "company-app", appId: auth.id }, reviewers: reviewerBots.agents.map(agent => ({ agentId: agent.agentId, login: agent.login, identity: agent.identity, targetType: agent.targetType })), nativeGitHub: { requiredForAgentIdentity: true, setupPath: "/apps/chat/connect?provider=github&purpose=chat", mode: "routing-compatibility" } };
  });
  ctx.actions.register("manage-repository", async (params, actor) => {
    const { companyId } = boardScope(params, actor), op = text(params.op, "action", 50);
    if (!repoReads.has(op) && !repoWrites.has(op)) throw new Error("Unknown repository action.");
    const { auth, catalog, repository } = await scope(companyId, params, repoWrites.has(op));
    if (!repository) throw new Error("This repository is not accessible through this company’s App.");
    const clean = { ...params };
    // Human board actions may select Paperclip agents as GitHub assignees or
    // reviewers. The native channel resolves each bot login; plugin mappings
    // are never used.
    if (["request-reviewers", "remove-reviewers"].includes(op) && (Array.isArray(params.reviewerAgentIds) || Array.isArray(params.reviewerBotIds))) {
      const rawReviewerIds = params.reviewerAgentIds ?? params.reviewerBotIds;
      const agentIds = [...new Set((Array.isArray(rawReviewerIds) ? rawReviewerIds : []).map(id => text(id, "reviewer agent", 100)))];
      const humanReviewers = Array.isArray(params.reviewers) ? params.reviewers.map(login => text(login, "reviewer login", 39)) : [];
      const endpoints = agentIds.length ? await requireNativeGitHubAgents(ctx, companyId, agentIds) : [];
      const explicitBotLogins = Array.isArray(params.reviewerBotLogins) ? params.reviewerBotLogins.map(login => text(login, "reviewer bot login", 39)) : [];
      const availableBotLogins = new Set(endpoints.map(endpoint => endpoint.botUsername).filter((login): login is string => Boolean(login)).map(login => login.toLowerCase()));
      if (explicitBotLogins.some(login => !availableBotLogins.has(login.toLowerCase()))) throw nativeConnectorRequiredError();
      const logins = [...new Set([...endpoints.map(endpoint => endpoint.botUsername).filter((login): login is string => Boolean(login)), ...explicitBotLogins])];
      if (agentIds.length && logins.length !== agentIds.length) throw nativeConnectorRequiredError();
      clean.reviewers = [...new Set([...humanReviewers, ...logins])];
    }
    if (["create-issue", "edit-issue"].includes(op) && (Array.isArray(params.assigneeAgentIds) || Array.isArray(params.assigneeBotIds))) {
      const rawAgentIds = params.assigneeAgentIds ?? params.assigneeBotIds;
      const agentIds = [...new Set((Array.isArray(rawAgentIds) ? rawAgentIds : []).map(id => text(id, "assignee agent", 100)))];
      const loginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
      const humanAssignees = Array.isArray(params.assignees) ? params.assignees.map(login => text(login, "assignee login", 39)) : [];
      if (humanAssignees.some(login => !loginPattern.test(login))) throw new Error("Choose valid GitHub assignee logins.");
      const endpoints = await requireNativeGitHubAgents(ctx, companyId, agentIds);
      const logins = endpoints.map(endpoint => endpoint.botUsername).filter((login): login is string => Boolean(login));
      if (logins.length !== agentIds.length) throw nativeConnectorRequiredError();
      clean.assignees = [...new Set([...humanAssignees, ...logins])];
    }
    delete clean.assigneeAgentIds;
    delete clean.assigneeBotIds;
    delete clean.assigneeBotLogins;
    delete clean.reviewerAgentIds;
    delete clean.reviewerBotIds;
    delete clean.reviewerBotLogins;
    delete clean.reviewerAgentIds;
    // Never accept a browser-supplied GraphQL repository node ID.
    delete clean.destinationNodeId;
    if (op === "transfer-issue") {
      const destinationRepositoryId = integer(params.destinationRepositoryId, "destination repository");
      const destination = catalog.repositories.find(r => r.id === destinationRepositoryId);
      if (!destination) throw new Error("Choose an accessible destination repository.");
      if (destination.installationId !== repository.installationId) throw new Error("Transfer requires both repositories in the same App installation.");
      permission(destination, "issues", true);
      clean.destinationRepositoryId = destinationRepositoryId;
      clean.destinationNodeId = (await new RepositoryManager(github, auth, destination).run("metadata", {})).node_id;
    }
    const operation = (beforeWrite?: () => Promise<void>) => new RepositoryManager(github, auth, repository, beforeWrite).run(op, clean);
    const { requestId: _requestId, refresh: _refresh, ...readParams } = clean;
    const result = repoWrites.has(op)
      ? await write(companyId, "repository", op, params, operation)
      : await cache.read(companyId, auth, ["repository", readParams], () => operation(), params.refresh === true).then(r => ({ ...r.data, cache: r.cache }));
    if (ensureTasks && ["issues", "issue", "create-issue", "edit-issue"].includes(op)) {
      const rows = (op === "issues" ? result.rows : [result]).filter((row: any) => !row.pull_request);
      const refs = await ensureTasks(companyId, repository, rows.map((row: any) => github.issue(row, repository)));
      if (op === "issues") return { ...result, rows: result.rows.map((row: any) => ({ ...row, ...refs.get(row.id) })) };
      return { ...result, ...refs.get(result.id) };
    }
    return result;
  });
  ctx.actions.register("manage-project", async (params, actor) => {
    const { companyId } = boardScope(params, actor), op = text(params.op, "action", 50);
    if (!projectReads.has(op) && !projectWrites.has(op)) throw new Error("Unknown project action.");
    const { auth, catalog } = await scope(companyId, params, projectWrites.has(op)), ownerLogin = text(params.owner, "account", 100);
    let token: string, type: "Organization" | "User", personalIdentity: string | undefined;
    if (params.ownerType === "User") {
      const access = await personal(companyId);
      if (!access || access.login.toLowerCase() !== ownerLogin.toLowerCase()) throw new Error("Connect this personal account in GitHub connection settings first.");
      token = access.token; personalIdentity = token; type = "User";
    } else {
      const installation = catalog.installations.find(i => !i.suspended && i.accountType === "Organization" && i.login.toLowerCase() === ownerLogin.toLowerCase());
      if (!installation) throw new Error("Choose an organization connected to this company’s App.");
      const level = installation.permissions?.organization_projects;
      if (!level || (projectWrites.has(op) && level !== "write" && level !== "admin")) throw new Error("Enable Organization Projects read/write on the GitHub App and approve the installation update.");
      const permissions: Record<string, string> = { organization_projects: projectWrites.has(op) ? "write" : "read", metadata: "read" };
      for (const key of ["issues", "pull_requests", "contents"]) if (installation.permissions?.[key]) permissions[key] = projectWrites.has(op) && ["convert-draft", "link-repository", "unlink-repository"].includes(op) ? installation.permissions[key] : "read";
      token = await github.scopedToken(auth.id, auth.pem, installation.id, permissions); type = "Organization";
    }
    const repoNode = async (repositoryId: unknown, number?: unknown) => {
      const repo = catalog.repositories.find(r => r.id === repositoryId);
      if (!repo) throw new Error("Choose a repository accessible to this company’s App.");
      const manager = new RepositoryManager(github, auth, repo);
      const metadata = await manager.run("metadata", {});
      const row = number === undefined ? null : await manager.run("issue", { number: integer(number) });
      return { id: metadata.node_id as string, contentId: row?.node_id as string | undefined };
    };
    const operation = (beforeWrite?: () => Promise<void>) => new ProjectManager(github, token, { login: ownerLogin, type }, repoNode, beforeWrite).run(op, params);
    const { requestId: _requestId, refresh: _refresh, ...readParams } = params;
    const result = projectWrites.has(op)
      ? await write(companyId, "project", op, params, operation)
      : await cache.read(companyId, { auth, personalIdentity }, ["project", readParams], () => operation(), params.refresh === true).then(r => ({ ...r.data, cache: r.cache }));
    // Project items reference repository issues; drafts and PRs have their own lifecycle.
    if (ensureTasks && ["items", "add-item", "convert-draft"].includes(op)) {
      const items = op === "items" ? result.rows : [result.addProjectV2ItemById?.item ?? result.convertProjectV2DraftIssueItemToIssue?.item].filter(Boolean);
      for (const item of items) {
        if (item.content?.__typename !== "Issue") continue;
        const repo = catalog.repositories.find(r => r.fullName.toLowerCase() === item.content.repository?.nameWithOwner?.toLowerCase());
        if (!repo) { item.paperclipTaskError = "Grant this App repository access to associate a task."; continue; }
        try {
          const remote = github.issue({ ...item.content, id: Number(item.content.fullDatabaseId), state: item.content.issueState?.toLowerCase(), state_reason: item.content.stateReason?.toLowerCase(), updated_at: item.content.updatedAt, html_url: item.content.url, assignees: item.content.assignees?.nodes, labels: item.content.labels?.nodes }, repo);
          Object.assign(item, (await ensureTasks(companyId, repo, [remote])).get(remote.id));
        } catch (error) { item.paperclipTaskError = error instanceof Error ? error.message : "Task association failed. Refresh to retry."; }
      }
    }
    return result;
  });
}
