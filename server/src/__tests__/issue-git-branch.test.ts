import { describe, expect, it } from "vitest";
import { buildIssueBranchName } from "../services/issue-git-branch.js";

const issue = { id: "11111111-1111-4111-8111-111111111111", identifier: "PAP-123", title: "Fix login redirect" };

describe("buildIssueBranchName", () => {
  it("proposes the same name agents get from the default workspace template", () => {
    expect(buildIssueBranchName({ issue })).toEqual({
      name: "PAP-123-fix-login-redirect",
      template: "{{issue.identifier}}-{{slug}}",
      source: "default",
    });
  });

  it("slugs punctuation and symbols the way the workspace runtime does", () => {
    expect(buildIssueBranchName({ issue: { ...issue, identifier: "PAP-5", title: "Fix: auth/login (v2)!" } }).name).toBe(
      "PAP-5-fix-auth-login-v2",
    );
    expect(buildIssueBranchName({ issue: { ...issue, identifier: "PAP-9", title: "???" } }).name).toBe("PAP-9-pap-9");
  });

  it("caps the name at 120 characters and never ends on a separator", () => {
    const name = buildIssueBranchName({ issue: { ...issue, title: "word ".repeat(80) } }).name;
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name.startsWith("PAP-123-word-word")).toBe(true);
    expect(name).not.toMatch(/[-/.]$/);
  });

  it("uses the project's branch template when one is set", () => {
    const result = buildIssueBranchName({
      issue,
      projectPolicy: { workspaceStrategy: { type: "git_worktree", branchTemplate: "paperclip/{{issue.identifier}}-{{slug}}" } },
    });
    expect(result).toEqual({
      name: "paperclip/PAP-123-fix-login-redirect",
      template: "paperclip/{{issue.identifier}}-{{slug}}",
      source: "project_template",
    });
  });

  it("lets the issue's own template beat the project's", () => {
    const result = buildIssueBranchName({
      issue: {
        ...issue,
        executionWorkspaceSettings: { workspaceStrategy: { type: "git_worktree", branchTemplate: "wip/{{slug}}" } },
      },
      projectPolicy: { workspaceStrategy: { type: "git_worktree", branchTemplate: "paperclip/{{slug}}" } },
    });
    expect(result.name).toBe("wip/fix-login-redirect");
    expect(result.source).toBe("issue_template");
  });

  it("returns a pinned existing branch exactly as configured", () => {
    const result = buildIssueBranchName({
      issue: {
        ...issue,
        executionWorkspaceSettings: { workspaceStrategy: { type: "git_worktree", existingBranch: "release/2026.10" } },
      },
    });
    expect(result).toEqual({ name: "release/2026.10", template: null, source: "existing_branch" });
  });

  it("falls back to the default when a template is blank", () => {
    const result = buildIssueBranchName({
      issue,
      projectPolicy: { workspaceStrategy: { type: "git_worktree", branchTemplate: "   " } },
    });
    expect(result.source).toBe("default");
  });

  it("renders agent and project variables without throwing when there is no agent", () => {
    const result = buildIssueBranchName({
      issue,
      projectPolicy: { workspaceStrategy: { type: "git_worktree", branchTemplate: "{{agent.name}}/{{issue.identifier}}" } },
    });
    expect(result.name).toBe("PAP-123");
  });
});
