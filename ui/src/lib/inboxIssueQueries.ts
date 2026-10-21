import { INBOX_MINE_ISSUE_STATUS_FILTER, type Issue } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { queryKeys } from "./queryKeys";

export const INBOX_ISSUE_LIST_LIMIT = 500;

/**
 * Tasks I touched that I have not archived: the Mine tab's list. The Inbox
 * and its Archived tab share this key, so switching tabs reuses one fetch.
 */
export function inboxMineIssuesQuery(companyId: string) {
  return {
    queryKey: [
      ...queryKeys.issues.listMineByMe(companyId),
      "compact",
      "with-routine-executions",
      "live-descendant-summary",
      INBOX_ISSUE_LIST_LIMIT,
    ] as const,
    queryFn: () =>
      issuesApi.listCompact(companyId, {
        touchedByUserId: "me",
        inboxArchivedByUserId: "me",
        status: INBOX_MINE_ISSUE_STATUS_FILTER,
        includeRoutineExecutions: true,
        includeLiveDescendantSummary: true,
        limit: INBOX_ISSUE_LIST_LIMIT,
      }).then((rows) => rows as Issue[]),
  };
}

/** Every task I touched, archived or not: the Recent, Unread and All tabs' list. */
export function inboxTouchedIssuesQuery(companyId: string) {
  return {
    queryKey: [
      ...queryKeys.issues.listTouchedByMe(companyId),
      "compact",
      "with-routine-executions",
      "live-descendant-summary",
      INBOX_ISSUE_LIST_LIMIT,
    ] as const,
    queryFn: () =>
      issuesApi.listCompact(companyId, {
        touchedByUserId: "me",
        status: INBOX_MINE_ISSUE_STATUS_FILTER,
        includeRoutineExecutions: true,
        includeLiveDescendantSummary: true,
        limit: INBOX_ISSUE_LIST_LIMIT,
      }).then((rows) => rows as Issue[]),
  };
}
