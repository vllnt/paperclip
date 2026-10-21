import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { Agent, AttentionItem } from "@paperclipai/shared";
import { useLocation } from "@/lib/router";
import { agentsApi } from "../../api/agents";
import { attentionApi } from "../../api/attention";
import { authApi } from "../../api/auth";
import { decisionsApi } from "../../api/decisions";
import { issuesApi } from "../../api/issues";
import { useCompany } from "../../context/CompanyContext";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useToastActions } from "../../context/ToastContext";
import { useInboxDismissals } from "../../hooks/useInboxBadge";
import { useScrollRowBudget } from "../../hooks/useScrollRowBudget";
import { planAttentionRenderRows } from "../../lib/attention";
import { getArchivedInboxIssues } from "../../lib/inbox";
import { invalidateInboxIssueQueries } from "../../lib/inboxArchiveCache";
import { inboxMineIssuesQuery, inboxTouchedIssuesQuery } from "../../lib/inboxIssueQueries";
import { createIssueDetailLocationState } from "../../lib/issueDetailBreadcrumb";
import { queryKeys } from "../../lib/queryKeys";
import { AttentionQueueRow } from "../../components/AttentionQueueRow";
import { Curtain } from "../../components/DecisionShelf";
import { DecisionResolver } from "../../components/DecisionResolver";
import { issueActivityTimestamp } from "../../components/IssueColumns";
import { IssueRow } from "../../components/IssueRow";
import { PageSkeleton } from "../../components/PageSkeleton";
import { StatusIcon } from "../../components/StatusIcon";
import { Button } from "../../components/ui/button";

const DECISION_HISTORY_VISIBLE_LIMIT = 50;
const DECISION_HISTORY_QUERY_LIMIT = DECISION_HISTORY_VISIBLE_LIMIT + 1;
const NO_GROUPS: never[] = [];
const NO_COLLAPSED_GROUPS: ReadonlySet<string> = new Set();

/** Curtain rows never expand; module-level so memoized rows see one identity. */
const noopToggleExpand = () => {};

/** Decided and expired decisions load only once their curtain is opened. */
export function decisionHistoryQueryEnabled(companyId: string | null | undefined, open: boolean) {
  return Boolean(companyId && open);
}

/** A history curtain's count; "50+" once the list is longer than the curtain shows. */
export function decisionHistoryCount(count: number | undefined) {
  if (count == null) return undefined;
  return count > DECISION_HISTORY_VISIBLE_LIMIT ? `${DECISION_HISTORY_VISIBLE_LIMIT}+` : count;
}

/**
 * The Inbox's Archived tab: everything that left the needs-me tabs, each in
 * its own curtain.
 *   - Tasks: tasks I archived (with Move to inbox) and done tasks that
 *     auto-archived from Mine.
 *   - Snoozed / Dismissed: attention items I hid, with Restore.
 *   - Decided / Expired: decision history, read-only.
 * The attention curtains need the Decisions setting, like the Decide and
 * Alerts tabs.
 */
export function InboxArchivedTab({
  tabBar,
  decisionsEnabled,
}: {
  tabBar: ReactNode;
  decisionsEnabled: boolean;
}) {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const { dismiss, restore } = useInboxDismissals(selectedCompanyId);
  const [tasksOpen, setTasksOpen] = useState(true);
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  const [dismissedOpen, setDismissedOpen] = useState(false);
  const [decidedOpen, setDecidedOpen] = useState(false);
  const [expiredOpen, setExpiredOpen] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setBreadcrumbs([{ label: "Inbox" }]);
  }, [setBreadcrumbs]);

  const mineQuery = inboxMineIssuesQuery(selectedCompanyId ?? "");
  const touchedQuery = inboxTouchedIssuesQuery(selectedCompanyId ?? "");
  const { data: mineIssues, isLoading: mineLoading, error: mineError } = useQuery({
    ...mineQuery,
    enabled: !!selectedCompanyId,
  });
  const { data: touchedIssues, isLoading: touchedLoading, error: touchedError } = useQuery({
    ...touchedQuery,
    enabled: !!selectedCompanyId,
  });

  const { data: feed, error: feedError } = useQuery({
    // Same key as the former Decisions page's curtain feed: dismissed rows ride
    // along, so the badge's one-row query never counts them.
    queryKey: [...queryKeys.attention(selectedCompanyId!), "with-dismissed"],
    queryFn: () => attentionApi.list(selectedCompanyId!, { includeDismissed: true, all: true }),
    enabled: !!selectedCompanyId && decisionsEnabled,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && decisionsEnabled,
  });

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;

  // Decided / expired decisions leave the open attention feed, so the curtains
  // read them from the decisions list.
  const { data: decidedDecisions, isLoading: decidedLoading } = useQuery({
    queryKey: queryKeys.decisions.list(selectedCompanyId!, "decided"),
    queryFn: () => decisionsApi.list(selectedCompanyId!, { status: "decided", limit: DECISION_HISTORY_QUERY_LIMIT }),
    enabled: decisionsEnabled && decisionHistoryQueryEnabled(selectedCompanyId, decidedOpen),
  });
  const { data: expiredDecisions, isLoading: expiredLoading } = useQuery({
    queryKey: queryKeys.decisions.list(selectedCompanyId!, "expired"),
    queryFn: () => decisionsApi.list(selectedCompanyId!, { status: "expired", limit: DECISION_HISTORY_QUERY_LIMIT }),
    enabled: decisionsEnabled && decisionHistoryQueryEnabled(selectedCompanyId, expiredOpen),
  });

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agents ?? []) map.set(agent.id, agent);
    return map;
  }, [agents]);

  const archivedIssues = useMemo(
    () => getArchivedInboxIssues({ touchedIssues: touchedIssues ?? [], mineIssues: mineIssues ?? [] }),
    [mineIssues, touchedIssues],
  );

  // Reset optimistic restores once the server sends a fresh snapshot.
  useEffect(() => {
    setPendingRestore(new Set());
  }, [feed?.generatedAt]);

  const hiddenItems = useCallback(
    (kind: "snooze" | "dismiss") =>
      (feed?.items ?? []).filter(
        (item) => item.dismissal?.kind === kind && item.dismissal.isActive && !pendingRestore.has(item.id),
      ),
    [feed, pendingRestore],
  );
  const snoozedItems = useMemo(() => hiddenItems("snooze"), [hiddenItems]);
  const dismissedItems = useMemo(() => hiddenItems("dismiss"), [hiddenItems]);

  // One render budget across the open curtains, in document order.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const openRowCount =
    (tasksOpen ? archivedIssues.length : 0)
    + (snoozedOpen ? snoozedItems.length : 0)
    + (dismissedOpen ? dismissedItems.length : 0);
  const rowLimit = useScrollRowBudget(rootRef, openRowCount, selectedCompanyId);
  const taskRows = tasksOpen ? archivedIssues.slice(0, rowLimit) : [];
  const hiddenPlan = planAttentionRenderRows({
    groups: NO_GROUPS,
    collapsedGroupKeys: NO_COLLAPSED_GROUPS,
    snoozedItems,
    snoozedOpen,
    dismissedItems,
    dismissedOpen,
    limit: rowLimit - taskRows.length,
  });

  const issueLinkState = useMemo(
    () => createIssueDetailLocationState("Inbox", `${location.pathname}${location.search}${location.hash}`, "inbox"),
    [location.hash, location.pathname, location.search],
  );

  const moveToInbox = useMutation({
    mutationFn: (issueId: string) => issuesApi.unarchiveFromInbox(issueId),
    onSuccess: () => {
      if (selectedCompanyId) void invalidateInboxIssueQueries(queryClient, selectedCompanyId);
    },
    onError: (error) =>
      pushToast({
        title: "Could not move to inbox",
        body: error instanceof Error ? error.message : "Please try again.",
        tone: "error",
      }),
  });

  const handleRestore = useCallback(
    (item: AttentionItem) => {
      setPendingRestore((prev) => new Set(prev).add(item.id));
      restore(item.dismissalKey);
    },
    [restore],
  );
  const handleDismiss = useCallback((item: AttentionItem) => dismiss(item.dismissalKey), [dismiss]);

  if (!selectedCompanyId) {
    return <p className="text-sm text-muted-foreground">Select an organization first.</p>;
  }

  const header = <div className="flex flex-wrap items-center justify-between gap-2">{tabBar}</div>;

  if (mineLoading || touchedLoading) {
    return (
      <div className="space-y-4">
        {header}
        <PageSkeleton variant="inbox" />
      </div>
    );
  }

  const error = mineError ?? touchedError ?? feedError;

  return (
    <div ref={rootRef} className="max-w-3xl space-y-4">
      {header}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}

      <Curtain label="Tasks" count={archivedIssues.length} open={tasksOpen} onToggle={() => setTasksOpen((prev) => !prev)}>
        {archivedIssues.length === 0 ? (
          <p className="text-xs text-muted-foreground">No archived tasks. Done tasks and tasks you archive land here.</p>
        ) : (
          <div>
            {taskRows.map(({ issue, archivedByMe }) => (
              <IssueRow
                key={issue.id}
                issue={issue}
                presentation="task"
                issueLinkState={issueLinkState}
                statusSlot={<StatusIcon status={issue.status} externalConversationState={issue.externalConversationState} size="md" />}
                mobileTitleMeta={issueActivityTimestamp(issue)}
                trailingMeta={issueActivityTimestamp(issue)}
                actions={archivedByMe ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="h-7"
                    disabled={moveToInbox.isPending && moveToInbox.variables === issue.id}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      moveToInbox.mutate(issue.id);
                    }}
                  >
                    {moveToInbox.isPending && moveToInbox.variables === issue.id && <Loader2 className="h-3 w-3 animate-spin" />}
                    Move to inbox
                  </Button>
                ) : undefined}
              />
            ))}
          </div>
        )}
      </Curtain>

      {decisionsEnabled && (
        <>
          {snoozedItems.length > 0 && (
            <Curtain label="Snoozed" count={snoozedItems.length} open={snoozedOpen} onToggle={() => setSnoozedOpen((prev) => !prev)}>
              {hiddenPlan.snoozedRows.map((item) => (
                <AttentionQueueRow
                  key={item.id}
                  item={item}
                  companyId={selectedCompanyId}
                  variant="hidden"
                  expanded={false}
                  onToggleExpand={noopToggleExpand}
                  onDismiss={handleDismiss}
                  onRestore={handleRestore}
                  agentMap={agentMap}
                  currentUserId={currentUserId}
                />
              ))}
            </Curtain>
          )}

          {dismissedItems.length > 0 && (
            <Curtain label="Dismissed" count={dismissedItems.length} open={dismissedOpen} onToggle={() => setDismissedOpen((prev) => !prev)}>
              {hiddenPlan.dismissedRows.map((item) => (
                <AttentionQueueRow
                  key={item.id}
                  item={item}
                  companyId={selectedCompanyId}
                  variant="hidden"
                  expanded={false}
                  onToggleExpand={noopToggleExpand}
                  onDismiss={handleDismiss}
                  onRestore={handleRestore}
                  agentMap={agentMap}
                  currentUserId={currentUserId}
                />
              ))}
            </Curtain>
          )}

          <Curtain
            label="Decided"
            count={decisionHistoryCount(decidedDecisions?.length)}
            open={decidedOpen}
            onToggle={() => setDecidedOpen((prev) => !prev)}
          >
            {decidedLoading ? (
              <p className="text-xs text-muted-foreground">Loading decided decisions…</p>
            ) : (decidedDecisions?.length ?? 0) > 0 ? (
              decidedDecisions!.slice(0, DECISION_HISTORY_VISIBLE_LIMIT).map((decision) => (
                <DecisionResolver
                  key={decision.id}
                  companyId={selectedCompanyId}
                  decisionId={decision.id}
                  agentMap={agentMap}
                  initialDecision={{ ...decision, executions: decision.executions ?? [] }}
                />
              ))
            ) : (
              <p className="text-xs text-muted-foreground">No decided decisions.</p>
            )}
          </Curtain>

          <Curtain
            label="Expired"
            count={decisionHistoryCount(expiredDecisions?.length)}
            open={expiredOpen}
            onToggle={() => setExpiredOpen((prev) => !prev)}
          >
            {expiredLoading ? (
              <p className="text-xs text-muted-foreground">Loading expired decisions…</p>
            ) : (expiredDecisions?.length ?? 0) > 0 ? (
              expiredDecisions!.slice(0, DECISION_HISTORY_VISIBLE_LIMIT).map((decision) => (
                <DecisionResolver
                  key={decision.id}
                  companyId={selectedCompanyId}
                  decisionId={decision.id}
                  agentMap={agentMap}
                  initialDecision={{ ...decision, executions: decision.executions ?? [] }}
                />
              ))
            ) : (
              <p className="text-xs text-muted-foreground">No expired decisions.</p>
            )}
          </Curtain>
        </>
      )}
    </div>
  );
}
