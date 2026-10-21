import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID } from "./contracts.js";
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID, apiVersion: 1, version: "0.13.0", displayName: "GitHub",
  description: "Manage GitHub repositories, Projects and synced tasks with Paperclip’s native GitHub channel and review connector.",
  author: "VLLNT", categories: ["connector"],
  capabilities: ["companies.read", "agents.read", "chat.endpoints.read", "issues.create", "issues.update", "issues.wakeup", "jobs.schedule", "events.subscribe", "webhooks.receive", "projects.read", "project.workspaces.read", "issues.read", "issue.comments.read", "plugin.state.read", "plugin.state.write",
    "secrets.read-ref", "secrets.write-own", "skills.managed", "http.outbound", "activity.log.write", "ui.page.register", "ui.sidebar.register",
    "ui.detailTab.register", "ui.action.register", "instance.settings.register", "agent.tools.register"],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  jobs: [{ jobKey: "github-sync", displayName: "Sync GitHub tasks", schedule: "* * * * *" }],
  webhooks: [{ endpointKey: "github", displayName: "GitHub events", description: "Receive issue and pull request events from your GitHub App." }],
  taskCreation: { label: "GitHub", listAction: "task-destinations", publishAction: "publish-task", linksAction: "task-links" },
  projectRepositories: { listAction: "project-repositories", setupPath: "/github-projects", writeIdentityAction: "repository-write-identity", signCommitAction: "repository-sign-commit" },
  skills: [{
    skillKey: "github-review-workflow",
    displayName: "GitHub review workflow",
    slug: "github-review-workflow",
    description: "Editable instructions for agent assignment, review, request-changes, approval, merge and post-merge monitoring.",
    markdown: `# GitHub review workflow

Use the linked Paperclip task as the source of execution state and the GitHub record panel as the source of repository state.

## Before working
- Read the repository and organization policy configured by the operator.
- Work only on tasks assigned to you and keep at most the configured number of active runs.
- Inspect the pull request head SHA and checks before commenting or reviewing.

## Review
- Explain findings with file and line references.
- Use **REQUEST_CHANGES** only for actionable blocking defects.
- Use **APPROVE** only when the current SHA satisfies the repository policy.
- If the PR changes after your review, reassess the new SHA.

## Merge
- Never merge because a task is assigned.
- Merge only when all required bot reviews, human reviews, checks, approvals and branch protections pass.
- Prefer enabling GitHub auto-merge when the repository policy requires queueing.
- After merge, verify the merge event and update the linked Paperclip task with the result.

The operator can edit this skill for each company, repository or organization policy. The GitHub plugin supplies the tools and receipts; this skill supplies the decision policy.`,
  }],
  instanceConfigSchema: {
    type: "object", additionalProperties: false,
    properties: {
      personalToken: { type: "object", format: "secret-ref", properties: { type: { const: "secret_ref" }, secretId: { type: "string" }, version: { const: "latest" } }, required: ["type", "secretId"], additionalProperties: false },
      personalLogin: { type: "string" },
      appId: { type: "string", pattern: "^[1-9][0-9]*$" },
      appSlug: { type: "string" }, appName: { type: "string" },
      webhookSecret: { type: "object", format: "secret-ref", properties: { type: { const: "secret_ref" }, secretId: { type: "string" }, version: { const: "latest" } }, required: ["type", "secretId"], additionalProperties: false },
      privateKey: { type: "object", format: "secret-ref", properties: {
        type: { const: "secret_ref" }, secretId: { type: "string" }, version: { const: "latest" }
      }, required: ["type", "secretId"], additionalProperties: false },
      // App user identity: the App's client ID and secret, the rotating refresh
      // token the plugin stores back (bind a placeholder secret), and the SSH key
      // agent commits are signed with.
      userClientId: { type: "string", pattern: "^[A-Za-z0-9.]{8,100}$" },
      userClientSecret: { type: "object", format: "secret-ref", properties: { type: { const: "secret_ref" }, secretId: { type: "string" }, version: { const: "latest" } }, required: ["type", "secretId"], additionalProperties: false },
      userRefreshToken: { type: "object", format: "secret-ref", properties: { type: { const: "secret_ref" }, secretId: { type: "string" }, version: { const: "latest" } }, required: ["type", "secretId"], additionalProperties: false },
      signingKey: { type: "object", format: "secret-ref", properties: { type: { const: "secret_ref" }, secretId: { type: "string" }, version: { const: "latest" } }, required: ["type", "secretId"], additionalProperties: false },
      // Agents never merge a pull request that touches a protected path. An instance administrator may release some of them for
      // one repository. The host validates this shape when the config is saved; the worker reads it again (and validates it
      // again) at every merge. CODEOWNERS paths, the paths of a repository's protectedPathPolicy rules and tiers paths are never released here, and a repository with a tiers file cannot opt in, whatever it says.
      agentMergeablePaths: {
        type: "array", maxItems: 50,
        description: "Lets agents merge pull requests that touch protected paths under .github/ (such as workflows) in the repositories listed here, with no review. Each entry names one repository (owner/name), the paths to release (allow, under .github/, for example .github/**) and paths to keep refused (exclude). One refused file refuses the whole pull request. CODEOWNERS files, the paths of the repository's protectedPathPolicy rules and the paths of a paperclip/tiers.yaml are never released here, and a repository with a paperclip/tiers.yaml on its base branch cannot opt in. Only an instance administrator can change this. A file-name exclusion is a speed bump, not a boundary: a new workflow file or a local action can still reach production. The real boundary is GitHub's environment protection (required reviewers) on the deployment.",
        items: {
          type: "object", additionalProperties: false, required: ["repository", "allow"],
          properties: {
            repository: { type: "string", pattern: "^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$", description: "owner/name. Matched exactly and without regard to case." },
            allow: {
              type: "array", minItems: 1, maxItems: 50,
              description: "Protected paths to release, all under .github/ (for example .github/** or .github/workflows/**). A CODEOWNERS path cannot be listed.",
              items: { type: "string", maxLength: 200, pattern: "^\\.github/[A-Za-z0-9._\\-/*?]+$", not: { anyOf: [{ pattern: "\\.\\." }, { pattern: "//" }, { pattern: "[Cc][Oo][Dd][Ee][Oo][Ww][Nn][Ee][Rr][Ss]" }] } }
            },
            exclude: {
              type: "array", maxItems: 100,
              description: "Paths or globs that stay refused even when allow covers them, for example .github/workflows/release.yml.",
              items: { type: "string", maxLength: 200, pattern: "^[A-Za-z0-9._\\-/*?]+$", not: { anyOf: [{ pattern: "^/" }, { pattern: "\\.\\." }, { pattern: "//" }] } }
            }
          }
        }
      },
      // Which paths agents may not merge, and which they may merge once reviewers approved the exact head commit. Read at every
      // merge, from here only: never from a pull request or a file of the repository. Without an entry for a repository, the
      // minimum list (.github/** and CODEOWNERS files) and the paths of its paperclip/tiers.yaml refuse, as they always did.
      protectedPathPolicy: {
        type: "array", maxItems: 50,
        description: "Per repository, ordered rules for protected paths. A refuse rule (the default for a rule with no action) protects its paths and keeps agents from merging a pull request that changes them. A require rule lets an agent merge a pull request that changes its paths when each named lens has an approval at the pull request's exact head commit from an agent you listed for that lens. The first rule that covers a path decides. A CODEOWNERS file is governed only by a rule with codeowners set to true. An approval is the first line of a comment on an issue assigned to the merging agent: VERDICT <lens> APPROVE <full head sha>; the agent that merges never approves its own merge, and a later push makes an approval stale. allowAdmin lets an --admin merge go ahead for a rule's paths (the plugin's admin merge checks still apply). Only an instance administrator can change this. A setting that cannot be read refuses every merge in its repository.",
        items: {
          type: "object", additionalProperties: false, required: ["repository", "rules"],
          properties: {
            repository: { type: "string", pattern: "^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$", description: "owner/name. Matched exactly and without regard to case; list a repository once." },
            rules: {
              type: "array", minItems: 1, maxItems: 50,
              description: "Rules in order; the first one that covers a path decides.",
              items: {
                type: "object", additionalProperties: false, required: ["paths"],
                properties: {
                  paths: { type: "array", minItems: 1, maxItems: 50, description: "Paths or globs the rule covers, for example scripts/** or paperclip/tiers.yaml.", items: { type: "string", maxLength: 200, pattern: "^[A-Za-z0-9._\\-/*?]+$", not: { anyOf: [{ pattern: "^/" }, { pattern: "\\.\\." }, { pattern: "//" }] } } },
                  action: { type: "string", enum: ["refuse", "require"], description: "refuse (the default): agents cannot merge a change to these paths. require: they can, with every named lens approved at the head." },
                  lenses: { type: "array", minItems: 1, maxItems: 10, description: "For require: the lenses that must approve, by the names defined in this entry's lenses.", items: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9 &._-]{0,39}$" } },
                  allowAdmin: { type: "boolean", description: "For require: whether an --admin merge may go ahead for these paths. Default false." },
                  codeowners: { type: "boolean", description: "For require: whether the rule also covers CODEOWNERS files. Default false: a CODEOWNERS file stays refused." }
                },
                allOf: [
                  { if: { properties: { action: { const: "require" } }, required: ["action"] }, then: { required: ["lenses"] }, else: { not: { anyOf: [{ required: ["lenses"] }, { required: ["allowAdmin"] }, { required: ["codeowners"] }] } } }
                ]
              }
            },
            lenses: {
              type: "array", maxItems: 10,
              description: "The reviewer lenses the rules may require, each with the Paperclip agents whose verdicts count for it.",
              items: {
                type: "object", additionalProperties: false, required: ["name", "agents"],
                properties: {
                  name: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9 &._-]{0,39}$", description: "The lens name a rule uses, and the scope a reviewer writes in a verdict. Compared without regard to case." },
                  aliases: { type: "array", maxItems: 5, description: "Other spellings of the scope that count for this lens.", items: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9 &._-]{0,39}$" } },
                  agents: { type: "array", minItems: 1, maxItems: 20, description: "Paperclip agent IDs whose verdicts count for this lens.", items: { type: "string", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" } }
                }
              }
            }
          }
        }
      },
    }
  },
  tools: [
    { name: "github_read_issue", displayName: "Read GitHub issue", description: "Read a GitHub issue by repository and number.", parametersSchema: { type: "object" } },
    { name: "github_read_pull_request", displayName: "Read GitHub pull request", description: "Read a GitHub pull request by repository and number.", parametersSchema: { type: "object" } },
    { name: "github_create_issue", displayName: "Create GitHub issue", description: "Create an issue in a GitHub repository.", parametersSchema: { type: "object" } },
    { name: "github_update_issue", displayName: "Update GitHub issue", description: "Edit or close a GitHub issue.", parametersSchema: { type: "object" } },
    { name: "github_comment", displayName: "Comment on GitHub", description: "Comment on a GitHub issue or pull request.", parametersSchema: { type: "object" } },
    { name: "github_create_pull_request", displayName: "Create GitHub pull request", description: "Create a GitHub pull request.", parametersSchema: { type: "object" } },
    { name: "github_update_pull_request", displayName: "Update GitHub pull request", description: "Edit or close a GitHub pull request.", parametersSchema: { type: "object" } },
    { name: "github_inline_comment", displayName: "Comment on PR diff", description: "Add an inline pull request diff comment.", parametersSchema: { type: "object" } },
    { name: "github_reply_review_comment", displayName: "Reply to PR review comment", description: "Reply to a pull request review comment.", parametersSchema: { type: "object" } },
    { name: "github_resolve_review_thread", displayName: "Resolve PR review thread", description: "Resolve a pull request review thread.", parametersSchema: { type: "object" } },
    { name: "github_reopen_review_thread", displayName: "Reopen PR review thread", description: "Reopen a pull request review thread.", parametersSchema: { type: "object" } },
    { name: "github_update_pull_request_branch", displayName: "Update PR branch", description: "Update a pull request branch.", parametersSchema: { type: "object" } },
    { name: "github_convert_pull_request_draft", displayName: "Convert PR to draft", description: "Convert a pull request to draft.", parametersSchema: { type: "object" } },
    { name: "github_mark_pull_request_ready", displayName: "Mark PR ready", description: "Mark a pull request ready for review.", parametersSchema: { type: "object" } },
    { name: "github_request_reviewers", displayName: "Request GitHub reviewers", description: "Request GitHub users or teams; Paperclip native GitHub channels own agent reviewer identity.", parametersSchema: { type: "object" } },
    { name: "github_remove_reviewers", displayName: "Remove GitHub reviewers", description: "Remove requested GitHub users or teams; Paperclip native GitHub channels own agent identity.", parametersSchema: { type: "object" } },
    { name: "github_submit_review", displayName: "Submit GitHub review", description: "Read and sync review state. Formal agent reviews and change requests belong to Paperclip’s native GitHub connector.", parametersSchema: { type: "object" } },
    { name: "github_rerun_checks", displayName: "Rerun GitHub checks", description: "Rerun a GitHub check run for a pull request.", parametersSchema: { type: "object" } },
    { name: "github_merge_pull_request", displayName: "Merge GitHub pull request", description: "Merge an open pull request after checking its current SHA.", parametersSchema: { type: "object" } },
    { name: "github_enable_auto_merge", displayName: "Enable GitHub auto-merge", description: "Enable auto-merge after checking a pull request's current SHA.", parametersSchema: { type: "object" } }
  ],
  ui: { slots: [
    { type: "taskListToolbar", id: "github-task-list", displayName: "GitHub issues", exportName: "GitHubTaskList", entityTypes: ["company", "project"] },
    { type: "page", id: "github", routePath: "github-projects", displayName: "GitHub", exportName: "GitHubPage" },
    { type: "globalToolbarButton", id: "github-task-button", displayName: "GitHub issues", exportName: "GitHubTaskButton" },
    { type: "sidebar", id: "github-link", displayName: "GitHub", exportName: "GitHubLink" },
    { type: "settingsPage", id: "github-settings", displayName: "GitHub connection", exportName: "GitHubPage" },
    { type: "detailTab", id: "github-issues", displayName: "GitHub", exportName: "GitHubIssues", entityTypes: ["project"] },
    { type: "detailTab", id: "github-record", displayName: "GitHub", exportName: "GitHubRecordPanel", entityTypes: ["issue"] },

  ] }
};
export default manifest;
