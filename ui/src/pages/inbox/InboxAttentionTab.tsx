import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Inbox } from "lucide-react";
import { ATTENTION_INBOX_TAB_BY_KIND, type Agent, type AttentionItem, type AttentionSubject } from "@paperclipai/shared";
import { useNavigate, useSearchParams } from "@/lib/router";
import { attentionApi } from "../../api/attention";
import { agentsApi } from "../../api/agents";
import { authApi } from "../../api/auth";
import { decisionQueuesApi } from "../../api/decisionQueues";
import { useCompany } from "../../context/CompanyContext";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useToastActions } from "../../context/ToastContext";
import { useInboxDismissals } from "../../hooks/useInboxBadge";
import { useScrollRowBudget } from "../../hooks/useScrollRowBudget";
import { queryKeys } from "../../lib/queryKeys";
import {
  ATTENTION_AGING_DAYS,
  attentionIsAging,
  attentionKind,
  buildAttentionFilterOptions,
  buildDeskShelves,
  defaultAttentionFilterState,
  filterAttentionItems,
  groupAttentionItems,
  isInlineResolvable,
  loadAttentionFilters,
  loadAttentionGroupBy,
  loadAttentionSortOrder,
  loadCollapsedAttentionGroupKeys,
  planAttentionRenderRows,
  resolveAttentionDateRange,
  saveAttentionFilters,
  saveAttentionGroupBy,
  saveAttentionSortOrder,
  saveCollapsedAttentionGroupKeys,
  sortAttentionItems,
  type AttentionDateRangeId,
  type AttentionFilterState,
  type AttentionGroup,
  type AttentionGroupBy,
  type AttentionSortOrder,
} from "../../lib/attention";
import type { InboxAttentionTab as InboxAttentionTabKey } from "../../lib/inbox";
import { hasBlockingShortcutDialog, resolveAttentionQueueKeyAction } from "../../lib/keyboardShortcuts";
import { PageSkeleton } from "../../components/PageSkeleton";
import { AttentionQueueRow } from "../../components/AttentionQueueRow";
import { DecisionsToolbar } from "../../components/DecisionsToolbar";
import { Curtain, AgingItemRow } from "../../components/DecisionShelf";
import { DecisionQueueRail, decideTabHref } from "../../components/DecisionQueueRail";
import { DecisionDateChips, type AttentionCustomRange } from "../../components/DecisionDateChips";
import { QueueExcludeButton, SeedRulesCard } from "../../components/DecisionQueueControls";
import { IssueGroupHeader } from "../../components/IssueGroupHeader";

const NO_ITEMS: AttentionItem[] = [];

/** Which attention items a tab lists: one queue's items, or every open item of the tab's kind. */
export function belongsOnAttentionTab(
  item: AttentionItem,
  tab: InboxAttentionTabKey,
  queueKey: string | null,
): boolean {
  if (queueKey) return true;
  return ATTENTION_INBOX_TAB_BY_KIND[attentionKind(item)] === tab;
}

/**
 * The Inbox's Decide and Alerts tabs: the open attention feed (the former
 * Decisions page), split by attention kind. Decide lists items waiting on a
 * verdict and carries the decision-queue rail; `?queue=<key>` scopes it to one
 * queue with that queue's seed rules and per-item Exclude. Alerts lists items
 * reporting something stuck. Dismissed, snoozed, decided and expired items live
 * on the Archived tab.
 */
export function InboxAttentionTab({ tab, tabBar }: { tab: InboxAttentionTabKey; tabBar: ReactNode }) {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const queueKey = tab === "decide" ? searchParams.get("queue")?.trim() || null : null;
  const deepLinkDecisionId = searchParams.get("decisionId");
  const [deepLinkConsumed, setDeepLinkConsumed] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedAttentionId, setSelectedAttentionId] = useState<string | null>(null);
  // How the current selection was made. The selection ring is the keyboard
  // cursor — it marks the row that j/k, e, x and s will act on — so it is drawn
  // only for a keyboard-driven selection. The selection itself still follows a
  // click, so keyboard actions target the row you just used.
  const [selectionFromKeyboard, setSelectionFromKeyboard] = useState(false);
  const [autoExpandDone, setAutoExpandDone] = useState(false);
  // Toolbar preferences (persisted to localStorage, shared by both tabs and every queue).
  const [groupBy, setGroupBy] = useState<AttentionGroupBy>(() => loadAttentionGroupBy());
  const [sortOrder, setSortOrder] = useState<AttentionSortOrder>(() => loadAttentionSortOrder());
  const [filters, setFilters] = useState<AttentionFilterState>(() => defaultAttentionFilterState);
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<Set<string>>(() => new Set());
  const [agingOpen, setAgingOpen] = useState(false);
  const [dateRange, setDateRange] = useState<AttentionDateRangeId>("all");
  const [customRange, setCustomRange] = useState<AttentionCustomRange>({ from: null, to: null });
  // Optimistic hide after dismiss/snooze. Reset whenever a fresh feed lands (server truth).
  const [pendingHide, setPendingHide] = useState<Set<string>>(() => new Set());

  const { dismiss, snooze, restore } = useInboxDismissals(selectedCompanyId);
  const { pushToast } = useToastActions();
  const navigate = useNavigate();

  // Date chips resolve to server-side activity bounds anchored to start-of-day,
  // so the ISO strings are stable within a day — safe to key the feed query on.
  const activityBounds = useMemo(
    () => resolveAttentionDateRange(dateRange, Date.now(), customRange),
    [dateRange, customRange],
  );

  const { data: queues } = useQuery({
    queryKey: queryKeys.decisionQueues.list(selectedCompanyId!),
    queryFn: () => decisionQueuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && queueKey !== null,
  });
  const queue = useMemo(() => queues?.find((entry) => entry.key === queueKey) ?? null, [queues, queueKey]);

  useEffect(() => {
    setBreadcrumbs(
      queueKey
        ? [{ label: "Inbox", href: decideTabHref(null) }, { label: queue?.title ?? queueKey }]
        : [{ label: "Inbox" }],
    );
  }, [queue?.title, queueKey, setBreadcrumbs]);

  // Re-hydrate per-company preferences when the company changes.
  useEffect(() => {
    setFilters(loadAttentionFilters(selectedCompanyId));
    setCollapsedGroupKeys(loadCollapsedAttentionGroupKeys(selectedCompanyId));
  }, [selectedCompanyId]);

  const {
    data: feed,
    isLoading,
    error,
  } = useQuery({
    // Under the `["attention", companyId]` prefix, so every resolver's
    // invalidation refreshes both tabs and the badge together.
    queryKey: [
      ...queryKeys.attention(selectedCompanyId!),
      "inbox-tab",
      queueKey,
      activityBounds.activitySince ?? null,
      activityBounds.activityUntil ?? null,
    ],
    queryFn: () => attentionApi.list(selectedCompanyId!, {
      all: true,
      queue: queueKey ?? undefined,
      ...activityBounds,
    }),
    enabled: !!selectedCompanyId,
    refetchOnWindowFocus: true,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agents ?? []) map.set(agent.id, agent);
    return map;
  }, [agents]);

  useEffect(() => {
    setPendingHide(new Set());
  }, [feed?.generatedAt]);

  const tabItems = useMemo(
    () => (feed?.items ?? NO_ITEMS).filter((item) => belongsOnAttentionTab(item, tab, queueKey)),
    [feed, queueKey, tab],
  );
  const activeItems = useMemo(
    () => tabItems.filter((item) => !(item.dismissal?.isActive ?? false) && !pendingHide.has(item.id)),
    [pendingHide, tabItems],
  );

  // The server's clock at feed time — used for the arrival/decide-by shelves and
  // the aging idle labels so they stay stable across renders.
  const now = useMemo(
    () => (feed?.generatedAt ? new Date(feed.generatedAt).getTime() : Date.now()),
    [feed?.generatedAt],
  );

  // Aging shelf (§4.4): items the server flags as idle past retention leave the
  // live list for their own curtain, so the tab leads with fresh items.
  const agingItems = useMemo(() => activeItems.filter(attentionIsAging), [activeItems]);
  const deskItems = useMemo(() => activeItems.filter((item) => !attentionIsAging(item)), [activeItems]);

  const filterOptions = useMemo(() => buildAttentionFilterOptions(deskItems), [deskItems]);

  // Filter → sort → group, all client-side so switching re-buckets without a
  // refetch. Ungrouped, the desk groups by arrival ("Decide now" when a
  // decide-by is due, then "New today", then "Earlier"); an explicit group-by
  // keeps the activity grouping.
  const groups = useMemo<AttentionGroup[]>(() => {
    const filtered = filterAttentionItems(deskItems, filters);
    if (groupBy === "none") {
      return buildDeskShelves(filtered, now);
    }
    const sorted = sortAttentionItems(filtered, sortOrder);
    return groupAttentionItems(sorted, groupBy);
  }, [deskItems, filters, sortOrder, groupBy, now]);

  const visibleCount = useMemo(() => groups.reduce((sum, group) => sum + group.items.length, 0), [groups]);
  const keyboardItems = useMemo(
    () => groups.filter((group) => group.label === null || !collapsedGroupKeys.has(group.key)).flatMap((group) => group.items),
    [collapsedGroupKeys, groups],
  );

  const rootRef = useRef<HTMLDivElement | null>(null);
  const renderedRowLimit = useScrollRowBudget(rootRef, keyboardItems.length, `${selectedCompanyId}:${tab}:${queueKey}`);

  // Keyboard selection may point past the budget (e.g. wrapping to the last
  // row), so the effective limit always covers it.
  const renderPlan = useMemo(() => {
    const selectedIndex = selectedAttentionId
      ? keyboardItems.findIndex((item) => item.id === selectedAttentionId)
      : -1;
    return planAttentionRenderRows({
      groups,
      collapsedGroupKeys,
      snoozedItems: NO_ITEMS,
      snoozedOpen: false,
      dismissedItems: NO_ITEMS,
      dismissedOpen: false,
      limit: Math.max(renderedRowLimit, selectedIndex + 1),
    });
  }, [collapsedGroupKeys, groups, keyboardItems, renderedRowLimit, selectedAttentionId]);

  useEffect(() => {
    if (selectedAttentionId && !keyboardItems.some((item) => item.id === selectedAttentionId)) {
      setSelectedAttentionId(null);
      setSelectionFromKeyboard(false);
    }
  }, [keyboardItems, selectedAttentionId]);

  useEffect(() => {
    if (!selectedAttentionId) return;
    document.getElementById(`attention-row-${selectedAttentionId}`)?.scrollIntoView({ block: "nearest" });
  }, [selectedAttentionId]);

  // `?decisionId=` deep link (§4.7): focus and expand the referenced decision
  // once the feed lands, then drop the param so a later manual collapse is not
  // re-forced on the next refetch. Wins over the generic auto-expand below.
  useEffect(() => {
    if (deepLinkConsumed || !deepLinkDecisionId || activeItems.length === 0) return;
    const target = activeItems.find(
      (item) => item.sourceKind === "decision" && item.subject.id === deepLinkDecisionId,
    );
    setDeepLinkConsumed(true);
    setAutoExpandDone(true);
    if (target) {
      setExpandedId(target.id);
      setSelectedAttentionId(target.id);
      setSelectionFromKeyboard(true);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("decisionId");
          return next;
        },
        { replace: true },
      );
    }
  }, [activeItems, deepLinkConsumed, deepLinkDecisionId, setSearchParams]);

  // Auto-expand the topmost inline-capable item, once.
  useEffect(() => {
    if (autoExpandDone || deskItems.length === 0) return;
    const sorted = sortAttentionItems(deskItems, sortOrder);
    const topInline = sorted.find((item) => isInlineResolvable(item));
    if (topInline) setExpandedId(topInline.id);
    setAutoExpandDone(true);
  }, [deskItems, autoExpandDone, sortOrder]);

  const updateGroupBy = (next: AttentionGroupBy) => {
    setGroupBy(next);
    saveAttentionGroupBy(next);
  };
  const updateSortOrder = (next: AttentionSortOrder) => {
    setSortOrder(next);
    saveAttentionSortOrder(next);
  };
  const updateFilters = (next: AttentionFilterState) => {
    setFilters(next);
    saveAttentionFilters(selectedCompanyId, next);
  };
  const toggleGroupCollapse = (key: string) => {
    setCollapsedGroupKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveCollapsedAttentionGroupKeys(selectedCompanyId, next);
      return next;
    });
  };

  // Every row callback is stable (deps are setState functions, stable hook
  // callbacks and the stable `pushToast`), so memoized rows re-render only when
  // their own props change (PAP-13784).
  const handleUndoDismiss = useCallback(
    (item: AttentionItem) => {
      setPendingHide((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
      restore(item.dismissalKey);
    },
    [restore],
  );
  const handleDismiss = useCallback(
    (item: AttentionItem) => {
      setPendingHide((prev) => new Set(prev).add(item.id));
      dismiss(item.dismissalKey);
      setExpandedId((previous) => (previous === item.id ? null : previous));
      // ~8s undo window; restores the row in place.
      pushToast({
        id: `attention-dismiss-${item.id}`,
        dedupeKey: `attention-dismiss-${item.dismissalKey}`,
        title: "Dismissed",
        body: item.subject.title ?? undefined,
        tone: "info",
        ttlMs: 8000,
        action: { label: "Undo", onClick: () => handleUndoDismiss(item) },
      });
    },
    [dismiss, handleUndoDismiss, pushToast],
  );
  const handleSnooze = useCallback(
    (item: AttentionItem, snoozedUntil: string) => {
      setPendingHide((prev) => new Set(prev).add(item.id));
      snooze(item.dismissalKey, snoozedUntil);
      setExpandedId((previous) => (previous === item.id ? null : previous));
    },
    [snooze],
  );
  const handleToggleExpand = useCallback((item: AttentionItem) => {
    setSelectedAttentionId(item.id);
    setSelectionFromKeyboard(false);
    setExpandedId((prev) => (prev === item.id ? null : item.id));
  }, []);
  const invalidateQueue = useCallback(() => {
    if (!selectedCompanyId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.attention(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.decisionQueues.list(selectedCompanyId) });
  }, [queryClient, selectedCompanyId]);

  const toggleSeedRules = useMutation({
    mutationFn: (enabled: boolean) =>
      decisionQueuesApi.update(selectedCompanyId!, queueKey!, { seedRulesEnabled: enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.decisionQueues.list(selectedCompanyId!) }),
    onError: (err) =>
      pushToast({
        title: "Could not update seeding",
        body: err instanceof Error ? err.message : "Please try again.",
        tone: "error",
      }),
  });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const action = resolveAttentionQueueKeyAction({
        defaultPrevented: event.defaultPrevented,
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        target: event.target,
        hasOpenDialog: hasBlockingShortcutDialog(document),
        hasSelection: selectedAttentionId !== null,
      });
      if (action === "ignore" || keyboardItems.length === 0) return;

      if (action === "next" || action === "previous") {
        event.preventDefault();
        const currentIndex = selectedAttentionId ? keyboardItems.findIndex((item) => item.id === selectedAttentionId) : -1;
        const offset = action === "next" ? 1 : -1;
        const nextIndex = currentIndex < 0
          ? action === "next"
            ? 0
            : keyboardItems.length - 1
          : (currentIndex + offset + keyboardItems.length) % keyboardItems.length;
        setSelectedAttentionId(keyboardItems[nextIndex]?.id ?? null);
        setSelectionFromKeyboard(true);
        return;
      }

      const selectedItem = keyboardItems.find((item) => item.id === selectedAttentionId);
      if (!selectedItem) return;
      event.preventDefault();

      if (action === "dismiss") {
        handleDismiss(selectedItem);
      } else if (isInlineResolvable(selectedItem)) {
        setExpandedId((previous) => (previous === selectedItem.id ? null : selectedItem.id));
      } else if (selectedItem.subject.href) {
        navigate(selectedItem.subject.href);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleDismiss, keyboardItems, navigate, selectedAttentionId]);

  if (!selectedCompanyId) {
    return <p className="text-sm text-muted-foreground">Select an organization first.</p>;
  }

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      {tabBar}
      <DecisionsToolbar
        visibleCount={visibleCount}
        filterOptions={filterOptions}
        filters={filters}
        onFiltersChange={updateFilters}
        groupBy={groupBy}
        onGroupByChange={updateGroupBy}
        sortOrder={sortOrder}
        onSortOrderChange={updateSortOrder}
      />
    </div>
  );

  if (isLoading) {
    return (
      <div className="space-y-4">
        {header}
        <PageSkeleton variant="approvals" />
      </div>
    );
  }

  return (
    <div ref={rootRef} className="max-w-3xl space-y-4">
      {header}

      {/* Queue quicklinks + date-range chips (§4.1–§4.2). The rail self-hides
          when the company has no queues; the chips filter server-side. */}
      <div className="space-y-2">
        {tab === "decide" ? <DecisionQueueRail companyId={selectedCompanyId} activeQueueKey={queueKey} /> : null}
        <DecisionDateChips
          value={dateRange}
          custom={customRange}
          onChange={(value, custom) => {
            setDateRange(value);
            setCustomRange(custom);
          }}
        />
      </div>

      {queueKey ? (
        <div className="space-y-2">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{queue?.title ?? queueKey}</h2>
            {queue?.description && <p className="mt-0.5 text-sm text-muted-foreground">{queue.description}</p>}
          </div>
          {queue && queue.seedRules.length > 0 && (
            <SeedRulesCard
              enabled={queue.seedRulesEnabled}
              rules={queue.seedRules.map((rule) => rule.description)}
              pending={toggleSeedRules.isPending}
              onToggle={() => toggleSeedRules.mutate(!queue.seedRulesEnabled)}
            />
          )}
        </div>
      ) : null}

      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}

      {activeItems.length === 0 ? (
        <ZeroState tab={tab} queued={queueKey !== null} />
      ) : (
        <div className="space-y-4">
          {visibleCount === 0 ? (
            <CaughtUpNote filtered={deskItems.length > 0} />
          ) : (
            groups.map((group) => {
              const groupLabel = group.label;
              const collapsed = groupLabel !== null && collapsedGroupKeys.has(group.key);
              return (
                <section key={group.key} className="space-y-2">
                  {groupLabel !== null && (
                    <IssueGroupHeader
                      label={groupLabel}
                      collapsible
                      collapsed={collapsed}
                      onToggle={() => toggleGroupCollapse(group.key)}
                      trailing={
                        <span className="text-xs tabular-nums text-muted-foreground">{group.items.length}</span>
                      }
                    />
                  )}
                  {!collapsed && (
                    <div className="space-y-4">
                      {(() => {
                        const rows = renderPlan.groupRows.get(group.key) ?? [];
                        const seenBundles = new Set<string>();
                        return rows.map((item) => {
                          const bundleId =
                            item.sourceKind === "decision"
                              ? ((item.subject.metadata?.bundleId as string | null | undefined) ?? null)
                              : null;
                          let bundleHeader: ReactNode = null;
                          if (bundleId && !seenBundles.has(bundleId)) {
                            seenBundles.add(bundleId);
                            const bundleRows = rows.filter(
                              (row) =>
                                row.sourceKind === "decision" &&
                                ((row.subject.metadata?.bundleId as string | null | undefined) ?? null) === bundleId,
                            );
                            const first = bundleRows[0];
                            bundleHeader = (
                              <DecisionBundleHeader
                                agentName={agentMap.get(first?.subject.metadata?.originAgentId as string)?.name ?? null}
                                title={(first?.subject.metadata?.bundleTitle as string | null | undefined) ?? null}
                                originIssue={first?.relatedIssue ?? null}
                                count={bundleRows.length}
                              />
                            );
                          }
                          return (
                            <Fragment key={item.id}>
                              {bundleHeader}
                              <div className={bundleId ? "space-y-1.5 border-l-2 border-violet-500/40 pl-3" : "space-y-1.5"}>
                                {queueKey ? (
                                  <QueueExcludeButton
                                    item={item}
                                    companyId={selectedCompanyId}
                                    queueKey={queueKey}
                                    onExcluded={invalidateQueue}
                                  />
                                ) : null}
                                <AttentionQueueRow
                                  item={item}
                                  companyId={selectedCompanyId}
                                  expanded={expandedId === item.id}
                                  onToggleExpand={handleToggleExpand}
                                  onDismiss={handleDismiss}
                                  onSnooze={handleSnooze}
                                  agentMap={agentMap}
                                  agents={agents}
                                  showTriage
                                  currentUserId={currentUserId}
                                  selected={selectionFromKeyboard && selectedAttentionId === item.id}
                                />
                              </div>
                            </Fragment>
                          );
                        });
                      })()}
                    </div>
                  )}
                </section>
              );
            })
          )}

          {agingItems.length > 0 && (
            <Curtain
              label="Aging"
              count={agingItems.length}
              open={agingOpen}
              onToggle={() => setAgingOpen((prev) => !prev)}
            >
              <p className="text-xs text-muted-foreground">
                Idle past {ATTENTION_AGING_DAYS} days — kept off the list. Keep any you still want surfaced.
              </p>
              {agingItems.map((item) => (
                <AgingItemRow
                  key={item.id}
                  item={item}
                  companyId={selectedCompanyId}
                  now={now}
                  agentMap={agentMap}
                  agents={agents}
                  currentUserId={currentUserId}
                  expanded={expandedId === item.id}
                  onToggleExpand={handleToggleExpand}
                  onDismiss={handleDismiss}
                  onSnooze={handleSnooze}
                />
              ))}
            </Curtain>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Violet left-rule strip over a run of decisions that share a bundle, e.g.
 * "Planner proposed 6 decisions · from PAP-123 · routing review · 6 pending".
 * Grouping is a surface only — each decision is still decided independently.
 */
export function DecisionBundleHeader({
  agentName,
  title,
  originIssue,
  count,
}: {
  agentName: string | null;
  title: string | null;
  originIssue: AttentionSubject | null;
  count: number;
}) {
  const noun = count === 1 ? "decision" : "decisions";
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-sm border-l-2 border-violet-500/60 bg-violet-500/5 px-3 py-1.5 text-xs">
      <span className="font-semibold text-violet-800 dark:text-violet-200">
        {agentName ?? "An agent"} proposed {count} {noun}
      </span>
      {originIssue && (originIssue.identifier || originIssue.title) && (
        <span className="text-muted-foreground">
          {"· from "}
          {originIssue.href ? (
            <a href={originIssue.href} className="hover:underline">
              {originIssue.identifier ?? originIssue.title}
            </a>
          ) : (
            originIssue.identifier ?? originIssue.title
          )}
        </span>
      )}
      {title && <span className="text-muted-foreground">· {title}</span>}
      <span className="text-muted-foreground">· {count} pending</span>
    </div>
  );
}

function CaughtUpNote({ filtered }: { filtered: boolean }) {
  return (
    <div className="rounded-xl border border-dashed border-border py-10 text-center">
      <p className="text-sm font-medium text-foreground">
        {filtered ? "Nothing matches your filters." : "You're all caught up."}
      </p>
      {filtered && (
        <p className="mt-1 text-xs text-muted-foreground">Adjust or clear the filters to see the rest.</p>
      )}
    </div>
  );
}

function ZeroState({ tab, queued }: { tab: InboxAttentionTabKey; queued: boolean }) {
  const message = queued
    ? "This queue is empty. Decisions land here when they match the queue's rules or an agent adds them."
    : tab === "decide"
      ? "Nothing needs a decision from you right now."
      : "No failures, errors, blockers or budget alerts right now.";
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-20 text-center">
      <div className="mb-4 rounded-full bg-green-500/10 p-4">
        <CheckCircle2 className="h-10 w-10 text-green-500" />
      </div>
      <p className="text-lg font-semibold text-foreground">You're all caught up</p>
      <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
        <Inbox className="h-4 w-4" />
        {message}
      </p>
    </div>
  );
}
