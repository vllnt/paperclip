import type { PluginContext } from "@paperclipai/plugin-sdk";
import { GitHubClient, repoName } from "./github.js";
import { GitHubReadCache, type AppAuth } from "./read-cache.js";
import { integer, permission, RepositoryManager } from "./management-repository.js";
import { boardScope } from "./setup.js";
import { PLUGIN_ID } from "./contracts.js";
import type { registerSync } from "./sync.js";

// Native tracking tasks are independent from review tasks tied to one revision.
export function registerRecordTasks(ctx: PluginContext, github: GitHubClient,
  credentials: (companyId: string) => Promise<AppAuth>, cache: GitHubReadCache,
  ensureTasks: ReturnType<typeof registerSync>["ensureTasks"]) {
  const queues = new Map<string, Promise<unknown>>();
  ctx.actions.register("open-record-task", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    const repositoryId = integer(params.repositoryId, "repository"), number = integer(params.number);
    const kind = params.kind;
    if (kind !== "issue" && kind !== "pull") throw new Error("Choose an issue or pull request.");
    if (params.projectId !== undefined && (typeof params.projectId !== "string" || !params.projectId)) throw new Error("Choose a valid project.");
    const auth = await credentials(companyId), catalog = await cache.catalog(companyId, auth, github, params.refresh === true);
    const repo = catalog.repositories.find(r => r.id === repositoryId);
    if (!repo) throw new Error("This repository is not accessible through this company’s App.");
    permission(repo, kind === "pull" ? "pull_requests" : "issues", false);
    const panel = { slotId: "github-record", recordId: `${repositoryId}:${kind}:${number}` };
    const { data: remote } = await cache.read(companyId, auth, ["record-task", repositoryId, kind, number],
      () => new RepositoryManager(github, auth, repo).run(kind, { number }), params.refresh === true);
    if (kind === "issue") {
      if (remote.pull_request) throw new Error("Choose an issue, or open this record as a pull request.");
      const reference = (await ensureTasks(companyId, repo, [github.issue(remote, repo)])).get(remote.id);
      if (!reference?.paperclipTask) throw new Error(reference?.paperclipTaskError ?? "The associated task is unavailable.");
      return { id: reference.paperclipTask.id, identifier: reference.paperclipTask.identifier, panel };
    }
    const projects: string[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await ctx.projects.list({ companyId, limit: 100, offset });
      for (const project of page) {
        const workspaces = await ctx.projects.listWorkspaces(project.id, companyId);
        if (workspaces.some(w => w.repoUrl && repoName(w.repoUrl)?.toLowerCase() === repo.fullName.toLowerCase())) projects.push(project.id);
      }
      if (page.length < 100) break;
    }
    const projectId = params.projectId === undefined ? projects.sort()[0] : String(params.projectId);
    if (!projectId || !projects.includes(projectId)) throw new Error("Choose a Paperclip project linked to this repository.");
    const prior = queues.get(companyId) ?? Promise.resolve();
    const current = prior.catch(() => {}).then(async () => {
      const key = { scopeKind: "company" as const, scopeId: companyId, namespace: "sync", stateKey: `pull:${repositoryId}:${remote.id}` };
      const saved = await ctx.state.get(key) as { issueId: string; repositoryId: number; number: number } | null;
      let task = saved ? await ctx.issues.get(saved.issueId, companyId) : null;
      if (saved && (!task || task.companyId !== companyId)) throw new Error("The associated task was deleted or is unavailable.");
      if (saved && (saved.repositoryId !== repositoryId || saved.number !== number || task?.originKind !== `plugin:${PLUGIN_ID}:pull` || task.originId !== String(remote.id))) throw new Error("The saved GitHub task association is invalid. Check this task’s connection.");
      if (!task) {
        task = await ctx.issues.create({ companyId, projectId, title: remote.title,
          description: `${remote.body ?? ""}\n\nhttps://github.com/${repo.fullName}/pull/${number}`,
          status: remote.merged || remote.state === "closed" ? "done" : "todo",
          originKind: `plugin:${PLUGIN_ID}:pull`, originId: String(remote.id),
          idempotencyKey: `github-pull:${repositoryId}:${remote.id}`, allowDuplicate: true });
        await ctx.state.set(key, { issueId: task.id, repositoryId, number });
        await ctx.activity.log({ companyId, message: "GitHub pull request linked to task", metadata: { taskId: task.id, repositoryId, number } });
      }
      await ctx.state.set({ scopeKind: "company", scopeId: companyId, namespace: "sync", stateKey: `review:${task.id}` }, { issueId: task.id, repositoryId, number, githubId: remote.id, tracking: true });
      return { id: task.id, identifier: task.identifier, panel };
    });
    queues.set(companyId, current);
    void current.finally(() => { if (queues.get(companyId) === current) queues.delete(companyId); }).catch(() => {});
    return current;
  });
}
