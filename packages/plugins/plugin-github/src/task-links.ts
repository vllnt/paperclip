import type { Issue, PluginContext, PluginTaskLink, PluginTaskLinks } from "@paperclipai/plugin-sdk";
import { GitHubClient, repoName } from "./github.js";
import { GitHubReadCache, type AppAuth } from "./read-cache.js";
import { RepositoryManager } from "./management-repository.js";
import { boardScope } from "./setup.js";
import { PLUGIN_ID, PAGE_PATH } from "./contracts.js";

type Mapping = { issueId: string; number: number; repositoryId: number; conflicts?: string[]; tracking?: boolean; githubId?: number };
export const pullFields = "number title state isDraft repository { nameWithOwner }";
export function relatedPullsQuery(numbers: number[]) {
  if (!numbers.length || numbers.length > 20 || numbers.some(n => !Number.isSafeInteger(n) || n < 1)) throw new Error("Invalid issue numbers.");
  return `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${numbers.map(n => `i${n}:issue(number:${n}){closedByPullRequestsReferences(first:10,includeClosedPrs:true,orderByState:true){nodes{${pullFields}} pageInfo{hasNextPage}}}`).join(" ")}}}`;
}
export function registerTaskLinks(ctx: PluginContext, github: GitHubClient, credentials: (companyId: string) => Promise<AppAuth>, cache: GitHubReadCache,
  mapping: (companyId: string, issue: Issue) => Promise<Mapping | null>) {
  ctx.actions.register("task-links", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    if (!Array.isArray(params.issueIds) || params.issueIds.length > 100 || params.issueIds.some(id => typeof id !== "string" || !id || id.length > 100)) throw new Error("Choose at most 100 tasks.");
    const natives = await Promise.all([...new Set(params.issueIds as string[])].map(id => ctx.issues.get(id, companyId)));
    if (natives.some(task => !task || task.companyId !== companyId)) throw new Error("Task not found in this company.");
    const selected = natives.filter((task): task is Issue => !!task && task.originKind?.startsWith(`plugin:${PLUGIN_ID}:`) === true);
    if (!selected.length) return { tasks: [] };
    const auth = await credentials(companyId), catalog = await cache.catalog(companyId, auth, github, params.refresh === true);
    const view = (repositoryId: number, kind: string, number: number) => `${PAGE_PATH}?repository=${repositoryId}&kind=${kind}&number=${number}`;
    const tasks: PluginTaskLinks[] = [];
    const groups = new Map<number, { result: PluginTaskLinks; number: number }[]>();
    for (const native of selected) {
      const isPull = native.originKind === `plugin:${PLUGIN_ID}:pull`;
      const link = isPull ? await ctx.state.get({ scopeKind: "company", scopeId: companyId, namespace: "sync", stateKey: `review:${native.id}` }) as Mapping | null : await mapping(companyId, native);
      const result: PluginTaskLinks = { issueId: native.id, pullRequests: [], details: [] };
      tasks.push(result);
      const repo = catalog.repositories.find(r => r.id === link?.repositoryId);
      if (!link || !repo || link.issueId !== native.id || !Number.isSafeInteger(link.number) || link.number < 1 || (isPull && link.githubId !== undefined && String(link.githubId) !== native.originId)) { result.pullRequestsStatus = "error"; result.message = "Repository access is unavailable. Check this task’s project connection."; continue; }
      result.details!.push({ label: "Repository", value: repo.fullName });
      result.details!.push({ label: "Sync", value: isPull ? link.tracking ? "Connected" : "Review task" : link.conflicts?.length ? `Needs review: ${link.conflicts.join(", ")}` : "Connected" });
      const source: PluginTaskLink = { label: `#${link.number}`, url: `${repo.url}/${isPull ? "pull" : "issues"}/${link.number}`, title: `${repo.fullName} #${link.number}`, viewPath: view(repo.id, isPull ? "pull" : "issue", link.number), panel: { slotId: "github-record", recordId: `${repo.id}:${isPull ? "pull" : "issue"}:${link.number}` } };
      if (isPull) result.pullRequests = [source]; else result.issue = source;
      if (!repo.permissions?.pull_requests) {
        result.pullRequestsStatus = "access_required";
        result.message = "Allow Pull requests access in GitHub connection settings.";
      } else if (!isPull) {
        const group = groups.get(repo.id) ?? []; group.push({ result, number: link.number }); groups.set(repo.id, group);
      } else result.pullRequestsStatus = "ready";
      if (params.detail === true && selected.length === 1) {
        try {
          const { data } = await cache.read(companyId, auth, ["task-detail", repo.id, isPull, link.number], () => new RepositoryManager(github, auth, repo).run(isPull ? "pull" : "issue", { number: link.number }), params.refresh === true);
          source.state = data.merged ? "merged" : data.draft ? "draft" : data.state;
          source.title = data.title;
          result.details!.push({ label: "State", value: source.state ?? "Unknown" },
            { label: "Author", value: data.user?.login ?? "Unknown" },
            { label: "Assignees", value: data.assignees?.map((a: any) => a.login).join(", ") || "Unassigned" });
          if (data.labels?.length) result.details!.push({ label: "Labels", value: data.labels.map((l: any) => typeof l === "string" ? l : l.name).join(", ") });
          if (data.milestone?.title) result.details!.push({ label: "Milestone", value: data.milestone.title });
          if (isPull) {
            result.details!.push({ label: "Branches", value: `${data.head?.ref ?? "?"} → ${data.base?.ref ?? "?"}` });
            if (data.requested_reviewers?.length) result.details!.push({ label: "Reviewers", value: data.requested_reviewers.map((r: any) => r.login).join(", ") });
          }
          if (data.updated_at) result.details!.push({ label: "Updated", value: data.updated_at });
        } catch { result.message ??= "GitHub details could not be refreshed. Check access or retry."; }
      }
    }
    // One bounded GraphQL request per 20 issues, never a provider request per row.
    for (const [repositoryId, rows] of groups) {
      const repo = catalog.repositories.find(r => r.id === repositoryId)!;
      const numbers = [...new Set(rows.map(r => r.number))].sort((a,b) => a-b);
      for (let start = 0; start < numbers.length; start += 20) {
        const batch = numbers.slice(start, start + 20), affected = rows.filter(r => batch.includes(r.number));
        try {
          const { data } = await cache.read(companyId, auth, ["task-pulls", repositoryId, batch], async () => {
            const token = await github.scopedToken(auth.id, auth.pem, repo.installationId, { metadata: "read", issues: "read", pull_requests: "read" }, repo.id);
            const [owner, name] = repo.fullName.split("/");
            return github.graphql<any>(token, relatedPullsQuery(batch), { owner, name });
          }, params.refresh === true);
          for (const row of affected) {
            const connection = data.repository?.[`i${row.number}`]?.closedByPullRequestsReferences;
            if (!connection || !Array.isArray(connection.nodes)) throw new Error("GitHub did not return PR relationships.");
            row.result.pullRequests = connection.nodes.filter(Boolean).flatMap((pr: any): PluginTaskLink[] => {
              const fullName = repoName(`https://github.com/${pr.repository?.nameWithOwner}`);
              if (!fullName || !Number.isSafeInteger(pr.number) || pr.number < 1) return [];
              const target = catalog.repositories.find(r => r.fullName.toLowerCase() === fullName.toLowerCase());
              return [{ label: `#${pr.number}`, url: `https://github.com/${fullName}/pull/${pr.number}`, title: `${fullName} #${pr.number}: ${pr.title}`, state: pr.isDraft ? "draft" : String(pr.state).toLowerCase(), ...(target ? { viewPath: view(target.id, "pull", pr.number), panel: { slotId: "github-record", recordId: `${target.id}:pull:${pr.number}` } } : {}) }];
            });
            row.result.pullRequestsStatus = "ready";
            row.result.morePullRequests = !!connection.pageInfo?.hasNextPage;
          }
        } catch {
          for (const { result } of affected) { result.pullRequestsStatus = "error"; result.message = "Pull requests could not be refreshed. Check access or retry."; }
        }
      }
    }
    return { tasks };
  });
}
