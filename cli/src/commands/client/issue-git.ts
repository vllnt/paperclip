import { Command } from "commander";
import type { IssueGitPullRequest, IssueGitView, LinkIssuePullRequest } from "@paperclipai/shared";
import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

const PULL_REQUEST_URL = /^https:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)(?:[/?#].*)?$/;
const PULL_REQUEST_SHORT = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/;

/** Turns a URL or `owner/repo#number` into the body the link endpoint takes. */
export function parsePullRequestReference(value: string): Pick<LinkIssuePullRequest, "url" | "repository" | "number"> {
  const text = value.trim();
  if (PULL_REQUEST_URL.test(text)) return { url: text };
  const short = PULL_REQUEST_SHORT.exec(text);
  if (short) return { repository: `${short[1]}/${short[2]}`, number: Number(short[3]) };
  throw new Error("Use a github.com pull request URL, or owner/repo#number.");
}

function describePullRequest(pr: IssueGitPullRequest): string {
  const flags = [pr.state, pr.closes ? "closes" : "refs only", pr.verified ? "verified" : "unverified", `via ${pr.linkedBy}`];
  if (pr.automation.applied) flags.push(`status ${pr.automation.applied.from} -> ${pr.automation.applied.to}`);
  else if (pr.automation.deferred) flags.push(`automation held: ${pr.automation.deferred}`);
  return `  ${pr.repository}#${pr.number}  ${pr.title}\n    ${flags.join(" · ")}\n    ${pr.url ?? ""}`.trimEnd();
}

function printView(view: IssueGitView): void {
  console.log(`Branch   ${view.branch.name}`);
  console.log(`Start    ${view.branch.command}`);
  console.log(`Status automation: ${view.statusAutomation.enabled ? "on" : "off"}`);
  if (view.pullRequests.length === 0) {
    console.log("Pull requests: none linked");
    return;
  }
  console.log("Pull requests:");
  for (const pr of view.pullRequests) console.log(describePullRequest(pr));
}

/**
 * `issue git`, `issue git:link` and `issue git:unlink`. Registered after the main issue
 * commands so it can add to the same `issue` group without editing that file.
 */
export function registerIssueGitCommands(program: Command): void {
  const issue = program.commands.find((command) => command.name() === "issue");
  if (!issue) throw new Error("registerIssueCommands must run before registerIssueGitCommands");

  addCommonClientOptions(
    issue
      .command("git")
      .description("Show the branch name to copy and the pull requests linked to an issue")
      .argument("<issueId>", "Issue ID or identifier such as PAP-123")
      .option("--branch", "Print only the branch name")
      .action(async (issueId: string, opts: BaseClientOptions & { branch?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts);
          const view = await ctx.api.get<IssueGitView>(apiPath`/api/issues/${issueId}/git`);
          if (!view) throw new Error("Issue not found");
          if (opts.branch) {
            console.log(view.branch.name);
            return;
          }
          if (ctx.json) printOutput(view, { json: true });
          else printView(view);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("git:link")
      .description("Link a GitHub pull request to an issue")
      .argument("<issueId>", "Issue ID or identifier such as PAP-123")
      .argument("<pullRequest>", "Pull request URL, or owner/repo#number")
      .option("--refs-only", "Link it without letting a merge complete the issue")
      .action(async (issueId: string, pullRequest: string, opts: BaseClientOptions & { refsOnly?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts);
          const body: LinkIssuePullRequest = { ...parsePullRequestReference(pullRequest), ...(opts.refsOnly ? { closes: false } : {}) };
          const view = await ctx.api.post<IssueGitView>(apiPath`/api/issues/${issueId}/git/pull-requests`, body);
          if (ctx.json || !view) printOutput(view, { json: ctx.json });
          else printView(view);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("git:unlink")
      .description("Unlink a pull request from an issue; it will not be linked again automatically")
      .argument("<issueId>", "Issue ID or identifier such as PAP-123")
      .argument("<workProductId>", "The pull request's workProductId from `issue git --json`")
      .action(async (issueId: string, workProductId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          await ctx.api.delete(apiPath`/api/issues/${issueId}/git/pull-requests/${workProductId}`);
          printOutput({ unlinked: true, issueId, workProductId }, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}
