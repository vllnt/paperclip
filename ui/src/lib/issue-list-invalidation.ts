import { partialMatchKey, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { ISSUE_STATUSES, type Issue, type IssueStatus } from "@paperclipai/shared";
import { queryKeys } from "./queryKeys";

/**
 * Which board columns a live issue event can change. `"all"` is the safe
 * default: every issue list is refreshed, as before.
 */
export type IssueListScope = "all" | ReadonlySet<IssueStatus>;

/** Issue fields whose change leaves the card in its column and affects no other card. */
const COLUMN_LOCAL_CHANGE_KEYS: ReadonlySet<string> = new Set([
  "priority",
  "title",
  "description",
  "assigneeAgentId",
  "assigneeUserId",
]);

/**
 * Keys a status-changing `issue.updated` carries at the top of its details,
 * next to `changes`. Seeing one means the column may change, whatever `changes` says.
 */
const COLUMN_AFFECTING_DETAIL_KEYS: readonly string[] = [
  "status",
  "reopened",
  "parentId",
  "projectId",
  "blockedByIssueIds",
];

/** Position of the status in a board column key: `["issues", companyId, "board-column", status, ...]`. */
const BOARD_COLUMN_STATUS_INDEX = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toBoardStatus(value: unknown): IssueStatus | null {
  if (typeof value !== "string") return null;
  return ISSUE_STATUSES.find((status) => status === value) ?? null;
}

/**
 * True when the event cannot move the issue to another column or change another
 * card. A comment never does. An update does not when the server's own
 * before/after diff (`details.changes`) only names column-local fields. Any
 * other `issue.updated` shape (no diff, an unknown field) is not column-local.
 */
function isColumnLocalIssueActivity(action: string | null, details: unknown): boolean {
  if (action === "issue.comment_added") return true;
  if (action !== "issue.updated" || !isRecord(details)) return false;
  const { changes } = details;
  if (!isRecord(changes)) return false;
  if (COLUMN_AFFECTING_DETAIL_KEYS.some((key) => key in details)) return false;
  return Object.keys(changes).every((key) => COLUMN_LOCAL_CHANGE_KEYS.has(key));
}

function statusesHoldingIssue(
  queryClient: Pick<QueryClient, "getQueriesData">,
  companyId: string,
  issueId: string,
): Set<IssueStatus> {
  const statuses = new Set<IssueStatus>();
  const cached = queryClient.getQueriesData<Issue[]>({
    queryKey: queryKeys.issues.boardColumns(companyId),
  });
  for (const [queryKey, rows] of cached) {
    if (!Array.isArray(rows) || !rows.some((row) => row.id === issueId)) continue;
    const status = toBoardStatus(queryKey[BOARD_COLUMN_STATUS_INDEX]);
    if (status) statuses.add(status);
  }
  return statuses;
}

/**
 * Decides which board columns a live issue event needs refreshed. Narrows only
 * when the event is column-local and a cached column already holds the issue;
 * otherwise (new issue, status change, unknown shape, issue not on the board)
 * it returns `"all"`, so the board is never left showing a card that moved.
 */
export function resolveIssueListScope(
  queryClient: Pick<QueryClient, "getQueriesData">,
  companyId: string,
  event: { entityId: string | null; action: string | null; details: unknown },
): IssueListScope {
  if (!event.entityId || !isColumnLocalIssueActivity(event.action, event.details)) return "all";
  const statuses = statusesHoldingIssue(queryClient, companyId, event.entityId);
  return statuses.size > 0 ? statuses : "all";
}

/** Combines the scope of events that share one refresh window. */
export function mergeIssueListScopes(
  current: IssueListScope | null,
  next: IssueListScope,
): IssueListScope {
  if (current === null) return next;
  if (current === "all" || next === "all") return "all";
  return new Set([...current, ...next]);
}

/**
 * Whether a query under `["issues", companyId]` needs a refetch for a
 * column-local event: other columns and the label catalog cannot have
 * changed; every other issue list may show the edited issue.
 */
export function isIssueListQueryAffected(
  queryKey: QueryKey,
  companyId: string,
  scope: ReadonlySet<IssueStatus>,
): boolean {
  if (partialMatchKey(queryKey, queryKeys.issues.boardColumns(companyId))) {
    const status = toBoardStatus(queryKey[BOARD_COLUMN_STATUS_INDEX]);
    return status !== null && scope.has(status);
  }
  return !partialMatchKey(queryKey, queryKeys.issues.labels(companyId));
}
