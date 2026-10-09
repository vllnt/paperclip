import { useCallback, useEffect, useRef } from "react";
import { useQueries, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { ISSUE_STATUSES, type Issue, type IssueStatus } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";

export const ISSUE_BOARD_COLUMN_RESULT_LIMIT = 200;

type IssueListRequestFilters = NonNullable<Parameters<typeof issuesApi.listCompact>[1]>;

export interface BoardColumnIssues {
  /** Issues from every column that has loaded; null until the first column loads. */
  issues: Issue[] | null;
  /** Columns still waiting for their first response. */
  loadingStatuses: IssueStatus[];
  /** Columns whose request failed before returning any data. */
  failedStatuses: IssueStatus[];
  /** True when some column returned the full per-column cap. */
  limitReached: boolean;
}

interface CombinedBoardColumns extends BoardColumnIssues {
  /** Each column's latest server response, in `ISSUE_STATUSES` order; placeholders excluded. */
  serverData: (Issue[] | undefined)[];
}

/**
 * Merges the per-status column queries. Passed to `useQueries` as `combine`,
 * so the result is structurally shared: it keeps its identity until column
 * data or column state actually changes, instead of on every render.
 */
function combineBoardColumns(results: UseQueryResult<Issue[]>[]): CombinedBoardColumns {
  const merged = new Map<string, Issue>();
  const loadingStatuses: IssueStatus[] = [];
  const failedStatuses: IssueStatus[] = [];
  let hasData = false;
  let limitReached = false;
  results.forEach((result, index) => {
    const status = ISSUE_STATUSES[index];
    if (result.data) {
      hasData = true;
      if (result.data.length === ISSUE_BOARD_COLUMN_RESULT_LIMIT) limitReached = true;
      for (const issue of result.data) merged.set(issue.id, issue);
    } else if (result.isError) {
      failedStatuses.push(status);
    } else if (result.fetchStatus !== "idle") {
      loadingStatuses.push(status);
    }
  });
  return {
    issues: hasData ? [...merged.values()] : null,
    loadingStatuses,
    failedStatuses,
    limitReached,
    serverData: results.map((result) => (result.isPlaceholderData ? undefined : result.data)),
  };
}

/**
 * Loads the Kanban board one query per status column, each capped at
 * {@link ISSUE_BOARD_COLUMN_RESULT_LIMIT}, and reports per-column state so a
 * slow or failed column renders as loading/failed rather than as empty.
 */
export function useBoardColumnIssues({
  companyId,
  enabled,
  search,
  projectId,
  searchFilters,
  includeRoutineExecutions,
}: {
  companyId: string | null;
  enabled: boolean;
  search: string;
  projectId?: string;
  searchFilters?: Omit<IssueListRequestFilters, "q" | "projectId" | "limit" | "includeRoutineExecutions">;
  includeRoutineExecutions: boolean;
}): BoardColumnIssues & { retryFailedColumns: () => void } {
  const queryClient = useQueryClient();
  // `useQueries` starts a fresh observer whenever a column's key changes (a new
  // search, for instance), and a fresh observer has no previous data to hand
  // `placeholderData`. Keep each column's last response here instead, so the
  // board keeps its cards while the next search result loads. Only within the
  // same board scope: another company or project must never borrow them.
  const scopeKey = JSON.stringify([companyId, projectId ?? null, searchFilters ?? null, includeRoutineExecutions]);
  const lastServerDataRef = useRef<{ scopeKey: string; data: (Issue[] | undefined)[] }>({ scopeKey, data: [] });
  const lastServerDataFor = (index: number) =>
    lastServerDataRef.current.scopeKey === scopeKey ? lastServerDataRef.current.data[index] : undefined;
  const { serverData, ...columns } = useQueries({
    queries: ISSUE_STATUSES.map((status, index) => ({
      queryKey: [
        ...queryKeys.issues.list(companyId ?? "__no-company__"),
        "board-column",
        status,
        search,
        projectId ?? "__all-projects__",
        searchFilters ?? {},
        "compact",
        ISSUE_BOARD_COLUMN_RESULT_LIMIT,
        includeRoutineExecutions ? "with-routine-executions" : "without-routine-executions",
      ],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        issuesApi.listCompact(companyId!, {
          ...searchFilters,
          ...(search.length > 0 ? { q: search } : {}),
          projectId,
          status,
          limit: ISSUE_BOARD_COLUMN_RESULT_LIMIT,
          ...(includeRoutineExecutions ? { includeRoutineExecutions: true } : {}),
        }, { signal }).then((rows) => rows as Issue[]),
      enabled: !!companyId && enabled,
      placeholderData: (previousData: Issue[] | undefined) => previousData ?? lastServerDataFor(index),
    })),
    combine: combineBoardColumns,
  });

  useEffect(() => {
    const previous = lastServerDataRef.current.scopeKey === scopeKey ? lastServerDataRef.current.data : [];
    lastServerDataRef.current = {
      scopeKey,
      data: serverData.map((data, index) => data ?? previous[index]),
    };
  }, [scopeKey, serverData]);

  const retryFailedColumns = useCallback(() => {
    if (!companyId) return;
    void queryClient.refetchQueries({
      queryKey: [...queryKeys.issues.list(companyId), "board-column"],
      predicate: (query) => query.state.status === "error",
    });
  }, [companyId, queryClient]);

  return { ...columns, retryFailedColumns };
}
