// Text rendering of GET /api/issues/:id/diagnostics/subtree for `issue tree`.

interface TreeRun {
  status: string;
  errorCode?: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface TreeNode {
  issue: {
    id: string;
    identifier: string | null;
    title: string;
    status: string;
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
  };
  parentId: string | null;
  depth: number;
  lastRun?: TreeRun | null;
}

export interface IssueTreeResponse {
  nodes: TreeNode[];
  omittedUnauthorizedNodeCount?: number | null;
  truncated?: boolean;
}

/** Age of a run, from its most recent timestamp: `30s ago`, `5m ago`, `3h ago`, `2d ago`. */
export function formatRunAge(
  run: Pick<TreeRun, "createdAt" | "startedAt" | "finishedAt">,
  now: Date = new Date(),
): string {
  const latest = Math.max(
    ...[run.createdAt, run.startedAt, run.finishedAt]
      .filter((value): value is string => Boolean(value))
      .map((value) => new Date(value).getTime())
      .filter((time) => Number.isFinite(time)),
  );
  if (!Number.isFinite(latest)) return "unknown age";
  const seconds = Math.max(0, Math.floor((now.getTime() - latest) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function formatAssignee(node: TreeNode, agentNames: ReadonlyMap<string, string>): string {
  if (node.issue.assigneeAgentId) {
    return agentNames.get(node.issue.assigneeAgentId) ?? node.issue.assigneeAgentId;
  }
  if (node.issue.assigneeUserId) return `user:${node.issue.assigneeUserId}`;
  return "-";
}

function formatLastRun(run: TreeRun | null | undefined, now: Date): string {
  if (!run) return "-";
  const status = run.errorCode ? `${run.status}(${run.errorCode})` : run.status;
  return `${status} ${formatRunAge(run, now)}`;
}

/**
 * One line per node, indented two spaces per level, parents before children
 * (children keep the order the server returned them in). Nodes whose parent is
 * not in the response are printed as roots.
 */
export function formatIssueTree(
  tree: IssueTreeResponse,
  agentNames: ReadonlyMap<string, string>,
  now: Date = new Date(),
): string[] {
  const byId = new Map(tree.nodes.map((node) => [node.issue.id, node]));
  const children = new Map<string, TreeNode[]>();
  const roots: TreeNode[] = [];
  for (const node of tree.nodes) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (!parent) {
      roots.push(node);
      continue;
    }
    const siblings = children.get(parent.issue.id) ?? [];
    siblings.push(node);
    children.set(parent.issue.id, siblings);
  }

  const lines: string[] = [];
  const visit = (node: TreeNode, level: number) => {
    const label = node.issue.identifier ?? node.issue.id;
    lines.push(
      `${"  ".repeat(level)}${label} [${node.issue.status}] assignee=${formatAssignee(node, agentNames)} ` +
        `lastRun=${formatLastRun(node.lastRun, now)}  ${node.issue.title}`,
    );
    for (const child of children.get(node.issue.id) ?? []) visit(child, level + 1);
  };
  for (const root of roots) visit(root, 0);

  const omitted = tree.omittedUnauthorizedNodeCount ?? 0;
  if (omitted > 0) lines.push(`(${omitted} node${omitted === 1 ? "" : "s"} outside your access omitted)`);
  if (tree.truncated) lines.push("(tree truncated by depth or node caps; use --json for details)");
  return lines;
}
