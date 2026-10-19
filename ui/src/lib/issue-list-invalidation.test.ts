// @vitest-environment node

import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  isIssueListQueryAffected,
  mergeIssueListScopes,
  resolveIssueListScope,
} from "./issue-list-invalidation";
import { queryKeys } from "./queryKeys";

function columnKey(companyId: string, status: string, search = "") {
  return [
    ...queryKeys.issues.boardColumns(companyId),
    status,
    search,
    "__all-projects__",
    {},
    "compact",
    200,
    "without-routine-executions",
  ];
}

function boardWith(columns: Record<string, string[]>, companyId = "company-1", search = "") {
  const client = new QueryClient();
  for (const [status, ids] of Object.entries(columns)) {
    client.setQueryData(columnKey(companyId, status, search), ids.map((id) => ({ id })));
  }
  return client;
}

const scopeOf = (value: ReturnType<typeof resolveIssueListScope>) =>
  value === "all" ? "all" : [...value].sort();

describe("resolveIssueListScope", () => {
  it("narrows a comment to the column that holds the issue", () => {
    const client = boardWith({ todo: ["a", "b"], done: ["c"] });
    expect(
      scopeOf(resolveIssueListScope(client, "company-1", { entityId: "a", action: "issue.comment_added", details: null })),
    ).toEqual(["todo"]);
  });

  it.each([
    ["a priority edit", { changes: { priority: { from: "low", to: "high" } }, priority: "high" }],
    ["a title and assignee edit", { changes: { title: { from: "a", to: "b" }, assigneeAgentId: { from: null, to: "x" } } }],
    ["a comment-only update", { changes: {}, source: "comment" }],
  ])("narrows %s to the column that holds the issue", (_name, details) => {
    const client = boardWith({ todo: ["a"], done: ["c"] });
    expect(
      scopeOf(resolveIssueListScope(client, "company-1", { entityId: "a", action: "issue.updated", details })),
    ).toEqual(["todo"]);
  });

  it.each([
    ["a status change in the diff", "issue.updated", { changes: { status: { from: "todo", to: "done" } }, status: "done" }],
    ["a status key without a diff entry", "issue.updated", { changes: { priority: { from: "low", to: "high" } }, status: "todo" }],
    ["a reopen", "issue.updated", { changes: { priority: { from: "low", to: "high" } }, reopened: true }],
    ["a reparent", "issue.updated", { changes: { parentId: { from: null, to: "p" } } }],
    ["a project move", "issue.updated", { changes: { projectId: { from: null, to: "p" } } }],
    ["a blocker change", "issue.updated", { changes: { blockedByIssueIds: { from: [], to: ["z"] } } }],
    ["a label change", "issue.updated", { changes: { labelIds: { from: [], to: ["l"] } } }],
    ["an unknown field", "issue.updated", { changes: { somethingNew: { from: 1, to: 2 } } }],
    ["an update with no diff (system emitters)", "issue.updated", { status: "todo", source: "deferred_comment_wake" }],
    ["an update with null details", "issue.updated", null],
    ["a created issue", "issue.created", { title: "t", identifier: "PAP-1" }],
    ["an unrelated issue action", "issue.checked_out", { changes: {} }],
  ])("refreshes every list for %s", (_name, action, details) => {
    const client = boardWith({ todo: ["a"], done: ["c"] });
    expect(resolveIssueListScope(client, "company-1", { entityId: "a", action, details })).toBe("all");
  });

  it("refreshes every list when no cached column holds the issue", () => {
    const client = boardWith({ todo: ["a"] });
    expect(
      scopeOf(resolveIssueListScope(client, "company-1", { entityId: "zzz", action: "issue.comment_added", details: null })),
    ).toBe("all");
  });

  it("refreshes every list when there is no entity id", () => {
    const client = boardWith({ todo: ["a"] });
    expect(resolveIssueListScope(client, "company-1", { entityId: null, action: "issue.comment_added", details: null })).toBe("all");
  });

  it("unions the columns of every cached board that holds the issue", () => {
    const client = boardWith({ todo: ["a"] });
    client.setQueryData(columnKey("company-1", "in_progress", "search"), [{ id: "a" }]);
    expect(
      scopeOf(resolveIssueListScope(client, "company-1", { entityId: "a", action: "issue.comment_added", details: null })),
    ).toEqual(["in_progress", "todo"]);
  });

  it("ignores another company's board", () => {
    const client = boardWith({ todo: ["a"] }, "company-2");
    expect(resolveIssueListScope(client, "company-1", { entityId: "a", action: "issue.comment_added", details: null })).toBe("all");
  });
});

describe("isIssueListQueryAffected", () => {
  const scope = new Set(["todo"] as const);

  it("keeps only the scoped board columns", () => {
    expect(isIssueListQueryAffected(columnKey("company-1", "todo"), "company-1", scope)).toBe(true);
    expect(isIssueListQueryAffected(columnKey("company-1", "done", "x"), "company-1", scope)).toBe(false);
  });

  it("skips the label catalog and keeps every other issue list", () => {
    expect(isIssueListQueryAffected(queryKeys.issues.labels("company-1"), "company-1", scope)).toBe(false);
    expect(isIssueListQueryAffected(queryKeys.issues.listByProject("company-1", "p1"), "company-1", scope)).toBe(true);
    expect(isIssueListQueryAffected(queryKeys.issues.listMineByMe("company-1"), "company-1", scope)).toBe(true);
    expect(isIssueListQueryAffected(["issues", "company-1", { status: "todo" }], "company-1", scope)).toBe(true);
  });
});

describe("mergeIssueListScopes", () => {
  it("unions column scopes and lets all win", () => {
    expect(mergeIssueListScopes(null, "all")).toBe("all");
    expect(scopeOf(mergeIssueListScopes(null, new Set(["todo"] as const)))).toEqual(["todo"]);
    expect(scopeOf(mergeIssueListScopes(new Set(["todo"] as const), new Set(["done"] as const)))).toEqual(["done", "todo"]);
    expect(mergeIssueListScopes(new Set(["todo"] as const), "all")).toBe("all");
    expect(mergeIssueListScopes("all", new Set(["todo"] as const))).toBe("all");
  });
});
