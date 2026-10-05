import { GitHubReadCache } from "./read-cache.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { GitHubClient, repoName } from "./github.js";
import { boardScope } from "./setup.js";
import type { LinkedProject, TaskRepositories } from "./contracts.js";

type Credentials = (companyId: string) => Promise<{ id: string; pem: string }>;

/** Linked sources stay in Paperclip; issue content stays on GitHub. */
export function registerTaskIssues(ctx: PluginContext, github: GitHubClient, credentials: Credentials, cache = new GitHubReadCache()) {
  async function links(companyId: string, projectId: unknown) {
    if (projectId !== undefined && (typeof projectId !== "string" || !projectId)) throw new Error("Invalid project.");
    const linked = new Map<string, { name: string; projects: LinkedProject[] }>();
    for (let offset = 0; ; offset += 100) {
      const projects = typeof projectId === "string"
        ? [await ctx.projects.get(projectId, companyId)]
        : await ctx.projects.list({ companyId, limit: 100, offset });
      for (const project of projects) {
        if (!project || project.companyId !== companyId) throw new Error("This project is not available in this company.");
        for (const workspace of await ctx.projects.listWorkspaces(project.id, companyId)) {
          const name = workspace.repoUrl ? repoName(workspace.repoUrl) : null;
          if (!name) continue;
          const key = name.toLowerCase();
          const entry = linked.get(key) ?? { name, projects: [] };
          if (!entry.projects.some(p => p.id === project.id)) entry.projects.push({ id: project.id, name: project.name });
          linked.set(key, entry);
        }
      }
      if (projectId || projects.length < 100) break;
    }
    return linked;
  }
  async function repositories(companyId: string, projectId?: unknown, refresh = false): Promise<TaskRepositories> {
    const linked = await links(companyId, projectId);
    const config = await ctx.config.get(companyId);
    const configured = !!config.appId && !!config.privateKey;
    if (!configured || !linked.size) return { configured, repositories: [], linkedCount: linked.size, warnings: [] };
    const auth = await credentials(companyId);
    const data = await cache.catalog(companyId, auth, github, refresh);
    const repositories = data.repositories.flatMap(repo => {
      const link = linked.get(repo.fullName.toLowerCase());
      return link ? [{ ...repo, projects: link.projects }] : [];
    });
    const unavailable = [...linked.values()].filter(link => !repositories.some(repo => repo.fullName.toLowerCase() === link.name.toLowerCase()));
    return { configured, repositories, linkedCount: linked.size, warnings: [
      ...data.warnings,
      ...(data.truncated ? ["Repository discovery was limited. Some linked repositories may be missing."] : []),
      ...unavailable.map(link => `${link.name} is not available to this App. Check repository access or unlink it in Projects (${link.projects.map(p => p.name).join(", ")}).`),
    ] };
  }
  ctx.actions.register("task-repositories", async (params, actor) => repositories(boardScope(params, actor).companyId, params.projectId, params.refresh === true));
  ctx.actions.register("task-issues", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    const page = params.page ?? 1;
    if (!Number.isSafeInteger(page) || Number(page) < 1 || Number(page) > 10000) throw new Error("Invalid issue page.");
    if (!Number.isSafeInteger(params.repositoryId) || Number(params.repositoryId) < 1) throw new Error("Invalid repository.");
    const linked = await links(companyId, params.projectId);
    if (!linked.size) throw new Error("This repository is no longer linked to a project.");
    const auth = await credentials(companyId);
    const data = await cache.catalog(companyId, auth, github);
    const repo = data.repositories.find(repo => repo.id === params.repositoryId && linked.has(repo.fullName.toLowerCase()));
    if (!repo) throw new Error("This repository is not linked to the project or is no longer accessible. Refresh repository access.");
    // A new repository-scoped token checks current installation access on every page.
    return github.issues(auth.id, auth.pem, repo, Number(page), "all");
  });
  async function repository(companyId: string, repositoryId: number) {
    const auth = await credentials(companyId), data = await cache.catalog(companyId, auth, github);
    const repo = data.repositories.find(r => r.id === repositoryId);
    if (!repo) return null;
    const linked = await links(companyId, undefined);
    return { ...repo, projects: linked.get(repo.fullName.toLowerCase())?.projects ?? [] };
  }
  return { repositories, repository };
}
