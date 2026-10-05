import { GitHubClient } from "./github.js";
import type { Repository } from "./contracts.js";

export type Params = Record<string, unknown>;
export function text(value: unknown, label: string, max = 65536, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max) throw new Error(`Enter a valid ${label}.`);
  return value;
}
export function integer(value: unknown, label = "number"): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`Enter a valid ${label}.`);
  return Number(value);
}
export function choice<T extends string>(value: unknown, options: readonly T[], label = "option"): T {
  if (!options.includes(value as T)) throw new Error(`Choose a valid ${label}.`);
  return value as T;
}
export function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error(`Enter valid ${label}.`);
  return [...new Set(value.map(v => text(v, label, 200)))];
}
export function confirm(p: Params, expected: string) {
  if (p.confirm !== expected) throw new Error(`Confirm this action by entering ${expected}.`);
}
export function permission(repo: Repository, key: string, write: boolean) {
  const granted = repo.permissions?.[key] ?? (key === "issues" && repo.issuesWrite ? "write" : undefined);
  if (!granted || (write && granted !== "write" && granted !== "admin")) throw new Error(`Enable ${key.replaceAll("_", " ")} ${write ? "read/write" : "read"} on the GitHub App and approve the installation update.`);
}
export const repoWrites = new Set([
  "create-issue", "edit-issue", "lock", "unlock", "delete-issue", "transfer-issue", "create-pr", "edit-pr", "draft-pr", "ready-pr", "merge-pr", "update-branch", "enable-auto-merge", "disable-auto-merge",
  "request-reviewers", "remove-reviewers", "review", "dismiss-review", "inline-comment", "reply-review-comment", "edit-review-comment", "delete-review-comment", "resolve-thread", "unresolve-thread",
  "comment", "edit-comment", "delete-comment", "react-comment", "react-body", "pin-issue", "unpin-issue", "subscribe", "unsubscribe", "rerequest-check", "create-label", "edit-label", "delete-label", "create-milestone", "edit-milestone", "delete-milestone",
]);
export const repoReads = new Set(["issues", "pulls", "issue", "pull", "pin-status", "subscription", "comments", "reviews", "review-comments", "threads", "files", "commits", "checks", "labels", "milestones", "assignees", "branches", "metadata"]);

export class RepositoryManager {
  constructor(private github: GitHubClient, private auth: { id: string; pem: string }, private repo: Repository, private beforeWrite: () => Promise<void> = async () => {}) {}
  private async token(key: string, write = false) {
    permission(this.repo, key, write);
    return this.github.scopedToken(this.auth.id, this.auth.pem, this.repo.installationId,
      { metadata: "read", [key]: write ? "write" : "read" }, this.repo.id);
  }
  private async request(path: string, key: string, body?: unknown, method?: "POST" | "PATCH" | "PUT" | "DELETE") {
    const token = await this.token(key, !!method);
    if (method) await this.beforeWrite();
    return this.github.request<any>(`/repos/${this.repo.fullName}${path}`, token, body, method);
  }
  private async mutate(name: string, type: string, input: Params, key: string) {
    const token = await this.token(key, true);
    await this.beforeWrite();
    return this.github.graphql(token, `mutation($input:${type}!){${name}(input:$input){clientMutationId}}`, { input });
  }
  async run(op: string, p: Params) {
    const n = () => integer(p.number, "issue or pull request number");
    const page = p.page === undefined ? 1 : integer(p.page, "page");
    if (page > 10000) throw new Error("Page limit reached.");
    const list = async (path: string, key: string) => {
      const result = await this.request(`${path}${path.includes("?") ? "&" : "?"}per_page=50&page=${page}`, key);
      return { rows: result.data, nextPage: result.next ? page + 1 : null };
    };
    const pull = async () => (await this.request(`/pulls/${n()}`, "pull_requests")).data;
    const issue = async () => (await this.request(`/issues/${n()}`, "issues")).data;
    const issueKey = p.kind === "pull" ? "pull_requests" : "issues";
    const guardComment = async (review = false) => {
      const path = `/${review ? "pulls" : "issues"}/comments/${integer(p.commentId, "comment ID")}`;
      const row = (await this.request(path, review ? "pull_requests" : issueKey)).data;
      if (row[review ? "pull_request_url" : "issue_url"] !== `https://api.github.com/repos/${this.repo.fullName}/${review ? "pulls" : "issues"}/${n()}`) throw new Error("This comment belongs to another item.");
      return path;
    };
    switch (op) {
      case "issues": {
        const result = await list(`/issues?state=${choice(p.state ?? "open", ["open", "closed", "all"])}&sort=updated&direction=desc`, "issues");
        return { ...result, rows: result.rows.filter((r: any) => !r.pull_request) };
      }
      case "pulls": return list(`/pulls?state=${choice(p.state ?? "open", ["open", "closed", "all"])}&sort=updated&direction=desc`, "pull_requests");
      case "issue": return issue();
      case "pull": return pull();
      case "comments": return list(`/issues/${n()}/comments`, issueKey);
      case "reviews": return list(`/pulls/${n()}/reviews`, "pull_requests");
      case "review-comments": return list(`/pulls/${n()}/comments`, "pull_requests");
      case "files": return list(`/pulls/${n()}/files`, "pull_requests");
      case "commits": return list(`/pulls/${n()}/commits`, "pull_requests");
      case "labels": return list("/labels", "issues");
      case "milestones": return list("/milestones?state=all", "issues");
      case "assignees": return list("/assignees", "issues");
      case "branches": return list("/branches", "contents");
      case "metadata": return (await this.request("", "metadata")).data;
      case "subscription": return (await this.request(`/issues/${n()}/subscription`, issueKey)).data;
      case "subscribe": return (await this.request(`/issues/${n()}/subscription`, issueKey, { subscribed: true, ignored: false, reason: "manual" }, "PUT")).data;
      case "unsubscribe": return (await this.request(`/issues/${n()}/subscription`, issueKey, undefined, "DELETE")).data;
      case "pin-status": {
        const row = await issue();
        const data = await this.github.graphql<any>(await this.token("issues"), "query($id:ID!){node(id:$id){...on Issue{isPinned}}}", { id: row.node_id });
        return { isPinned: data.node?.isPinned === true };
      }
      case "rerequest-check": {
        const checkRunId = integer(p.checkRunId, "check run ID");
        return (await this.request(`/check-runs/${checkRunId}/rerequest`, "checks", undefined, "POST")).data;
      }
      case "checks": {
        const pr = await pull();
        const results = await Promise.allSettled([
          this.request(`/commits/${encodeURIComponent(pr.head.sha)}/check-runs?per_page=100&page=${page}`, "checks"),
          this.request(`/commits/${encodeURIComponent(pr.head.sha)}/status?per_page=100&page=${page}`, "statuses"),
        ]);
        return { sha: pr.head.sha, checks: results[0].status === "fulfilled" ? results[0].value.data.check_runs : [], statuses: results[1].status === "fulfilled" ? results[1].value.data.statuses : [],
          nextPage: results.some(r => r.status === "fulfilled" && r.value.next) ? page + 1 : null,
          warnings: results.flatMap(r => r.status === "rejected" ? [r.reason instanceof Error ? r.reason.message : "Checks unavailable."] : []) };
      }
      case "threads": {
        const pr = await pull();
        return this.github.graphql(await this.token("pull_requests"), `query($id:ID!,$cursor:String){node(id:$id){...on PullRequest{reviewThreads(first:50,after:$cursor){nodes{id isResolved comments(first:50){nodes{id body path line}}} pageInfo{hasNextPage endCursor}}}}}`, { id: pr.node_id, cursor: p.cursor ?? null });
      }
      case "create-issue": return (await this.request("/issues", "issues", { title: text(p.title, "title", 256), body: text(p.body ?? "", "description", 65536, true),
        ...(p.labels !== undefined ? { labels: strings(p.labels, "labels") } : {}), ...(p.assignees !== undefined ? { assignees: strings(p.assignees, "assignees") } : {}) }, "POST")).data;
      case "edit-issue": {
        const current = await issue();
        const input: Params = {};
        for (const field of ["title", "body"] as const) if (p[field] !== undefined) input[field] = text(p[field], field, field === "title" ? 256 : 65536, field === "body");
        // Keep sync's hidden creation receipt when editing a linked body.
        const receipt = String(current.body ?? "").match(/<!-- paperclip:[a-zA-Z0-9-]+:[a-zA-Z0-9-]+ -->/)?.[0];
        if (typeof input.body === "string" && receipt && !input.body.includes(receipt)) input.body += `\n${receipt}`;
        for (const field of ["labels", "assignees"] as const) if (p[field] !== undefined) input[field] = strings(p[field], field);
        if (p.milestone !== undefined) input.milestone = p.milestone === null ? null : integer(p.milestone, "milestone");
        if (p.state !== undefined) input.state = choice(p.state, ["open", "closed"]);
        if (p.stateReason !== undefined) input.state_reason = choice(p.stateReason, ["completed", "not_planned", "reopened"]);
        if (!Object.keys(input).length) throw new Error("Choose fields to update.");
        return (await this.request(`/issues/${n()}`, issueKey, input, "PATCH")).data;
      }
      case "lock": return (await this.request(`/issues/${n()}/lock`, issueKey, { lock_reason: choice(p.reason, ["off-topic", "too heated", "resolved", "spam"]) }, "PUT")).data;
      case "unlock": return (await this.request(`/issues/${n()}/lock`, issueKey, undefined, "DELETE")).data;
      case "delete-issue": {
        confirm(p, `${this.repo.fullName}#${n()}`); const row = await issue();
        if (row.pull_request) throw new Error("Pull requests cannot be deleted.");
        return this.mutate("deleteIssue", "DeleteIssueInput", { issueId: row.node_id }, "issues");
      }
      case "transfer-issue": {
        confirm(p, `${this.repo.fullName}#${n()}`); const row = await issue();
        const destinationRepositoryId = integer(p.destinationRepositoryId, "destination repository");
        if (row.pull_request || typeof p.destinationNodeId !== "string") throw new Error("Select a destination repository.");
        permission(this.repo, "issues", true);
        const token = await this.github.scopedToken(this.auth.id, this.auth.pem, this.repo.installationId, { metadata: "read", issues: "write" }, [this.repo.id, destinationRepositoryId]);
        await this.beforeWrite();
        return this.github.graphql(token, "mutation($input:TransferIssueInput!){transferIssue(input:$input){clientMutationId}}", { input: { issueId: row.node_id, repositoryId: p.destinationNodeId } });
      }
      case "comment": return (await this.request(`/issues/${n()}/comments`, issueKey, { body: text(p.body, "comment") }, "POST")).data;
      case "pin-issue": case "unpin-issue": {
        const row = await issue();
        if (row.pull_request) throw new Error("Pull requests cannot be pinned to the repository issue list.");
        const token = await this.token("issues", true);
        await this.beforeWrite();
        const mutation = op === "pin-issue" ? "pinIssue" : "unpinIssue";
        const input = op === "pin-issue" ? "PinIssueInput" : "UnpinIssueInput";
        return this.github.graphql(token, `mutation($input:${input}!){${mutation}(input:$input){clientMutationId}}`, { input: { issueId: row.node_id } });
      }
      case "edit-comment": return (await this.request(await guardComment(), issueKey, { body: text(p.body, "comment") }, "PATCH")).data;
      case "delete-comment": confirm(p, `${this.repo.fullName}#${n()}`); return (await this.request(await guardComment(), issueKey, undefined, "DELETE")).data;
      case "react-comment": {
        const content = choice(p.content, ["+1", "-1", "laugh", "hooray", "confused", "heart", "rocket", "eyes"] as const, "reaction");
        const review = p.review === true;
        await guardComment(review);
        const commentId = integer(p.commentId, "comment ID");
        return (await this.request(`/${review ? "pulls" : "issues"}/comments/${commentId}/reactions`, review ? "pull_requests" : issueKey, { content }, "POST")).data;
      }
      case "react-body": {
        const content = choice(p.content, ["+1", "-1", "laugh", "hooray", "confused", "heart", "rocket", "eyes"] as const, "reaction");
        return (await this.request(`/issues/${n()}/reactions`, issueKey, { content }, "POST")).data;
      }
      case "create-pr": return (await this.request("/pulls", "pull_requests", { title: text(p.title, "title", 256), body: text(p.body ?? "", "description", 65536, true), head: text(p.head, "head branch", 300), base: text(p.base, "base branch", 300), draft: p.draft === true }, "POST")).data;
      case "edit-pr": {
        const input: Params = {};
        for (const field of ["title", "body", "base"] as const) if (p[field] !== undefined) input[field] = text(p[field], field, field === "body" ? 65536 : 300, field === "body");
        if (p.state !== undefined) input.state = choice(p.state, ["open", "closed"]);
        return (await this.request(`/pulls/${n()}`, "pull_requests", input, "PATCH")).data;
      }
      case "draft-pr": case "ready-pr": {
        const pr = await pull();
        return this.mutate(op === "draft-pr" ? "convertPullRequestToDraft" : "markPullRequestReadyForReview", op === "draft-pr" ? "ConvertPullRequestToDraftInput" : "MarkPullRequestReadyForReviewInput", { pullRequestId: pr.node_id }, "pull_requests");
      }
      case "request-reviewers": case "remove-reviewers": return (await this.request(`/pulls/${n()}/requested_reviewers`, "pull_requests", { reviewers: strings(p.reviewers ?? [], "reviewers"), team_reviewers: strings(p.teams ?? [], "team slugs") }, op === "request-reviewers" ? "POST" : "DELETE")).data;
      case "review": {
        const pr = await pull(); if (pr.head.sha !== p.sha) throw new Error("The PR changed. Refresh the diff before reviewing.");
        const event = choice(p.event, ["COMMENT", "APPROVE", "REQUEST_CHANGES"]);
        return (await this.request(`/pulls/${n()}/reviews`, "pull_requests", { event, body: text(p.body ?? "", "review", 65536, event === "APPROVE"), commit_id: pr.head.sha }, "POST")).data;
      }
      case "dismiss-review": {
        confirm(p, `${this.repo.fullName}#${n()}`);
        return (await this.request(`/pulls/${n()}/reviews/${integer(p.reviewId, "review ID")}/dismissals`, "pull_requests", { message: text(p.body, "dismissal reason") }, "PUT")).data;
      }
      case "inline-comment": {
        const pr = await pull(); if (pr.head.sha !== p.sha) throw new Error("The PR changed. Refresh the diff before commenting.");
        return (await this.request(`/pulls/${n()}/comments`, "pull_requests", { body: text(p.body, "comment"), commit_id: pr.head.sha, path: text(p.path, "file path", 1000), line: integer(p.line, "line"), side: choice(p.side ?? "RIGHT", ["LEFT", "RIGHT"]) }, "POST")).data;
      }
      case "reply-review-comment": await guardComment(true); return (await this.request(`/pulls/${n()}/comments/${integer(p.commentId)}/replies`, "pull_requests", { body: text(p.body, "reply") }, "POST")).data;
      case "edit-review-comment": return (await this.request(await guardComment(true), "pull_requests", { body: text(p.body, "comment") }, "PATCH")).data;
      case "delete-review-comment": confirm(p, `${this.repo.fullName}#${n()}`); return (await this.request(await guardComment(true), "pull_requests", undefined, "DELETE")).data;
      case "resolve-thread": case "unresolve-thread": {
        const pr = await pull(), token = await this.token("pull_requests", true), threadId = text(p.threadId, "thread", 200);
        const data = await this.github.graphql<any>(token, "query($id:ID!){node(id:$id){...on PullRequestReviewThread{pullRequest{id}}}}", { id: threadId });
        if (data.node?.pullRequest?.id !== pr.node_id) throw new Error("This thread belongs to another PR.");
        const name = op === "resolve-thread" ? "resolveReviewThread" : "unresolveReviewThread";
        await this.beforeWrite();
        return this.github.graphql(token, `mutation($input:${op === "resolve-thread" ? "Resolve" : "Unresolve"}ReviewThreadInput!){${name}(input:$input){clientMutationId}}`, { input: { threadId } });
      }
      case "merge-pr": case "enable-auto-merge": case "update-branch": {
        const pr = await pull();
        if (pr.head.sha !== p.sha) throw new Error("The PR changed. Refresh and confirm the current commit.");
        if (pr.state !== "open" || pr.merged) throw new Error("This PR is no longer open.");
        if (op === "update-branch") return (await this.request(`/pulls/${n()}/update-branch`, "pull_requests", { expected_head_sha: pr.head.sha }, "PUT")).data;
        confirm(p, `${this.repo.fullName}#${n()}`);
        const method = choice(p.method, ["merge", "squash", "rebase"]);
        if (op === "enable-auto-merge") return this.mutate("enablePullRequestAutoMerge", "EnablePullRequestAutoMergeInput", { pullRequestId: pr.node_id, expectedHeadOid: pr.head.sha, mergeMethod: method.toUpperCase() }, "contents");
        const result = (await this.request(`/pulls/${n()}/merge`, "contents", { sha: pr.head.sha, merge_method: method }, "PUT")).data;
        if (!result.merged) throw new Error("GitHub did not merge this PR. Refresh and check repository rules.");
        return result;
      }
      case "disable-auto-merge": return this.mutate("disablePullRequestAutoMerge", "DisablePullRequestAutoMergeInput", { pullRequestId: (await pull()).node_id }, "contents");
      case "create-label": case "edit-label": {
        const color = text(p.color, "six-digit label color", 6); if (!/^[0-9a-f]{6}$/i.test(color)) throw new Error("Use six hexadecimal digits for the label color.");
        return (await this.request(op === "create-label" ? "/labels" : `/labels/${encodeURIComponent(text(p.currentName, "label", 200))}`, "issues", { [op === "create-label" ? "name" : "new_name"]: text(p.name, "label", 200), color, description: text(p.description ?? "", "description", 100, true) }, op === "create-label" ? "POST" : "PATCH")).data;
      }
      case "delete-label": confirm(p, text(p.name, "label", 200)); return (await this.request(`/labels/${encodeURIComponent(String(p.name))}`, "issues", undefined, "DELETE")).data;
      case "create-milestone": case "edit-milestone": return (await this.request(op === "create-milestone" ? "/milestones" : `/milestones/${integer(p.milestone, "milestone")}`, "issues", { title: text(p.title, "title", 256), description: text(p.body ?? "", "description", 65536, true), state: choice(p.state ?? "open", ["open", "closed"]), ...(p.dueOn !== undefined ? { due_on: p.dueOn === null ? null : new Date(text(p.dueOn, "due date", 50)).toISOString() } : {}) }, op === "create-milestone" ? "POST" : "PATCH")).data;
      case "delete-milestone": confirm(p, `${this.repo.fullName}/milestone/${integer(p.milestone)}`); return (await this.request(`/milestones/${integer(p.milestone)}`, "issues", undefined, "DELETE")).data;
      default: throw new Error("Unknown repository action.");
    }
  }
}
