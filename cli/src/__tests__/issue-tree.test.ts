import { describe, expect, it } from "vitest";
import { formatIssueTree, formatRunAge } from "../commands/client/issue-tree.js";

const NOW = new Date("2026-10-09T12:00:00.000Z");

function node(input: {
  id: string;
  identifier?: string | null;
  title?: string;
  status?: string;
  parentId?: string | null;
  depth: number;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  lastRun?: Record<string, unknown> | null;
}) {
  return {
    issue: {
      id: input.id,
      identifier: input.identifier ?? null,
      title: input.title ?? `Title ${input.id}`,
      status: input.status ?? "todo",
      priority: "medium",
      assigneeAgentId: input.assigneeAgentId ?? null,
      assigneeUserId: input.assigneeUserId ?? null,
    },
    parentId: input.parentId ?? null,
    depth: input.depth,
    lastRun: input.lastRun ?? null,
  };
}

describe("formatRunAge", () => {
  it("uses the most recent timestamp and compact units", () => {
    expect(formatRunAge({ createdAt: "2026-10-09T11:59:30.000Z", startedAt: null, finishedAt: null }, NOW)).toBe("30s ago");
    expect(formatRunAge({ createdAt: "2026-10-09T10:00:00.000Z", startedAt: "2026-10-09T11:00:00.000Z", finishedAt: "2026-10-09T11:55:00.000Z" }, NOW)).toBe("5m ago");
    expect(formatRunAge({ createdAt: "2026-10-09T09:00:00.000Z", startedAt: null, finishedAt: null }, NOW)).toBe("3h ago");
    expect(formatRunAge({ createdAt: "2026-10-07T12:00:00.000Z", startedAt: null, finishedAt: null }, NOW)).toBe("2d ago");
  });
});

describe("formatIssueTree", () => {
  it("prints an indented tree with assignee names and last runs", () => {
    const lines = formatIssueTree(
      {
        nodes: [
          node({ id: "root", identifier: "PC-1", title: "Ship it", status: "in_progress", depth: 0, assigneeAgentId: "agent-1",
            lastRun: { status: "running", createdAt: "2026-10-09T11:58:00.000Z", startedAt: "2026-10-09T11:58:00.000Z", finishedAt: null, errorCode: null } }),
          node({ id: "a", identifier: "PC-2", status: "blocked", parentId: "root", depth: 1, assigneeUserId: "user-9" }),
          node({ id: "b", identifier: "PC-3", status: "todo", parentId: "root", depth: 1, assigneeAgentId: "agent-2",
            lastRun: { status: "failed", createdAt: "2026-10-09T10:00:00.000Z", startedAt: null, finishedAt: "2026-10-09T10:00:00.000Z", errorCode: "process_exit" } }),
          node({ id: "a1", identifier: null, status: "done", parentId: "a", depth: 2 }),
        ],
        omittedUnauthorizedNodeCount: 0,
        truncated: false,
      },
      new Map([["agent-1", "Builder"]]),
      NOW,
    );

    expect(lines).toEqual([
      "PC-1 [in_progress] assignee=Builder lastRun=running 2m ago  Ship it",
      "  PC-2 [blocked] assignee=user:user-9 lastRun=-  Title a",
      "    a1 [done] assignee=- lastRun=-  Title a1",
      "  PC-3 [todo] assignee=agent-2 lastRun=failed(process_exit) 2h ago  Title b",
    ]);
  });

  it("notes omitted and truncated nodes", () => {
    const lines = formatIssueTree(
      {
        nodes: [node({ id: "root", identifier: "PC-1", depth: 0 })],
        omittedUnauthorizedNodeCount: 2,
        truncated: true,
      },
      new Map(),
      NOW,
    );
    expect(lines.slice(1)).toEqual([
      "(2 nodes outside your access omitted)",
      "(tree truncated by depth or node caps; use --json for details)",
    ]);
  });
});
