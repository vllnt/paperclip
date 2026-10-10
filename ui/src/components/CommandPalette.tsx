import { AgentIdentity } from "@/components/AgentIdentity";
import { Fragment, useState, useEffect, useLayoutEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useNavigate } from "@/lib/router";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { COMPANY_SEARCH_MAX_OFFSET, type CompanySearchResult, type CompanySearchResultType } from "@paperclipai/shared";
import { rankCommandActions } from "@paperclipai/shared/command-action-rank";
import type { CommandActionGroup } from "@paperclipai/shared/command-actions";
import { useCompany } from "../context/CompanyContext";
import { useSidebar } from "../context/SidebarContext";
import { useCommandActions, type AvailableCommandAction } from "../context/CommandActionsContext";
import { issuesApi } from "../api/issues";
import { authApi } from "../api/auth";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { searchApi, type CompanySearchParams } from "../api/search";
import { useDialogActions } from "../context/DialogContext";
import { HighlightedText } from "./search/HighlightedText";
import { loadRecentSearches, pushRecentSearch } from "../lib/recent-searches";
import { queryKeys } from "../lib/queryKeys";
import { commandActionIcon } from "../lib/command-action-bindings";
import { hasBlockingShortcutDialog, shouldOpenCommandLauncher } from "../lib/keyboardShortcuts";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { CircleDot, Bot, Hexagon, History, Paperclip, Plus, RotateCw, Search } from "lucide-react";
import { agentUrl, projectUrl } from "../lib/utils";
import {
  SEARCH_OPERATOR_QUICK_FILTERS,
  applySearchOperatorSuggestion,
  hasSearchFilters,
  parseSearchQuery,
  searchOperatorSuggestions,
  type SearchQueryParserContext,
} from "../lib/search-query-parser";

const TASK_LIMIT = 10;
const MAX_MATCHED_ACTIONS = 8;
/** Results per company-search page; "Show more results" loads the next page. */
const SEARCH_PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 150;

const RESULT_GROUPS: Record<CompanySearchResultType, { heading: string; countKey: CompanySearchResultType }> = {
  issue: { heading: "Tasks", countKey: "issue" },
  project: { heading: "Projects", countKey: "project" },
  agent: { heading: "Agents", countKey: "agent" },
  artifact: { heading: "Artifacts", countKey: "artifact" },
};

function resultIcon(type: CompanySearchResultType) {
  if (type === "agent") return Bot;
  if (type === "project") return Hexagon;
  if (type === "artifact") return Paperclip;
  return CircleDot;
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
const MAX_RECENT_ACTIONS = 5;
/**
 * An action match at or above this score (a title prefix or better) is
 * listed before the entity groups; weaker matches are listed after them.
 */
const STRONG_ACTION_MATCH = 700;

// Create comes first: the sidebar has no New Task button, so the launcher is
// where tasks start.
const EMPTY_QUERY_GROUPS: ReadonlyArray<{ group: CommandActionGroup; heading: string }> = [
  { group: "navigate", heading: "Navigate" },
  { group: "general", heading: "General" },
];

function ShortcutHint({ keys }: { keys: readonly string[] | undefined }) {
  if (!keys || keys.length === 0) return null;
  return (
    <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
      {keys.map((key, index) => (
        <Fragment key={`${key}-${index}`}>
          {index > 0 ? <span>then</span> : null}
          <kbd className="rounded border border-border bg-background px-1 py-0.5 font-mono text-(length:--text-nano) uppercase">{key}</kbd>
        </Fragment>
      ))}
    </span>
  );
}

/** True for the keys cmdk uses to move the selection (arrows, Home/End, Ctrl+N/P/J/K). */
function movesSelection(event: ReactKeyboardEvent): boolean {
  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return true;
  return event.ctrlKey && ["n", "p", "j", "k"].includes(event.key);
}

/** True when `element` sits outside the viewport sideways, like a closed off-canvas drawer. */
function isOffCanvas(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  return rect.right <= 0 || rect.left >= window.innerWidth;
}

/** Focuses `element` if it can still take focus, otherwise the page's main content. */
function restoreFocus(element: HTMLElement | null) {
  const canFocus = element !== null
    && element.isConnected
    && !element.closest("[inert], [hidden], [aria-hidden='true']")
    && !("disabled" in element && element.disabled === true)
    && element.getClientRects().length > 0
    // The phone sidebar closes when the launcher opens, sliding off-screen.
    && !isOffCanvas(element);
  const target = canFocus ? element : document.getElementById("main-content");
  target?.focus({ preventScroll: true });
}

export function CommandPalette() {
  const {
    paletteOpen: open,
    setPaletteOpen: setOpen,
    actions,
    contextualIds,
    usage,
    run,
    paletteQuery: query,
    setPaletteQuery: setQuery,
  } = useCommandActions();
  const { openNewIssue } = useDialogActions();
  const [openedAt, setOpenedAt] = useState(() => Date.now());
  // The query for which the user moved the selection with the keyboard.
  const [movedForQuery, setMovedForQuery] = useState<string | null>(null);
  // A selected row runs only after the close has committed: until then the
  // dialog's focus trap would pull focus back from whatever the row focuses
  // (e.g. the comment composer). The row then owns focus, so closing must not
  // restore focus to where it was before the palette opened.
  const pendingRunRef = useRef<(() => void) | null>(null);
  const ranFromPaletteRef = useRef(false);
  // Where focus was before the launcher opened. Recorded in a layout effect,
  // which runs before the dialog moves focus into itself.
  const returnFocusRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    returnFocusRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }, [open]);
  const navigate = useNavigate();
  const { selectedCompanyId } = useCompany();
  const { isMobile, setSidebarOpen } = useSidebar();
  const searchQuery = query.trim();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const shouldOpen = shouldOpenCommandLauncher({
        key: e.key,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        // keyCode 229 marks a key that an IME is still composing (Safari).
        isComposing: e.isComposing || e.keyCode === 229,
        defaultPrevented: e.defaultPrevented,
        target: e.target,
        hasOpenDialog: hasBlockingShortcutDialog(),
      });
      if (!shouldOpen) return;
      e.preventDefault();
      setOpen(true);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [setOpen]);

  useEffect(() => {
    if (!open) {
      const pendingRun = pendingRunRef.current;
      pendingRunRef.current = null;
      pendingRun?.();
      return;
    }
    setOpenedAt(Date.now());
    setMovedForQuery(null);
    ranFromPaletteRef.current = false;
    if (isMobile) setSidebarOpen(false);
  }, [open, isMobile, setSidebarOpen]);

  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && open,
  });

  const { data: projects = [] } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && open,
  });

  const { data: labels = [] } = useQuery({
    queryKey: queryKeys.issues.labels(selectedCompanyId!),
    queryFn: () => issuesApi.listLabels(selectedCompanyId!),
    enabled: !!selectedCompanyId && open,
  });

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: open,
  });

  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const parserContext = useMemo<SearchQueryParserContext>(() => ({
    currentUserId,
    agents,
    projects,
    labels,
  }), [agents, currentUserId, labels, projects]);
  const parsedQuery = useMemo(() => parseSearchQuery(query, parserContext), [parserContext, query]);
  const quickSearchQuery = parsedQuery.query.trim();

  const { data: issues = [] } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && open && searchQuery.length === 0,
  });

  // Company search: the same endpoint as `paperclipai search`. Typed
  // operators become its filters; scope: and sort: pick kind and order.
  // Debounced as a string: a fresh object every render would never settle.
  const liveRequestKey = JSON.stringify({
    q: parsedQuery.query,
    ...parsedQuery.filters,
    ...(parsedQuery.scope ? { scope: parsedQuery.scope } : {}),
    ...(parsedQuery.sort ? { sort: parsedQuery.sort } : {}),
  });
  const searchRequestKey = useDebouncedValue(liveRequestKey, SEARCH_DEBOUNCE_MS);
  const searchRequest = useMemo(() => JSON.parse(searchRequestKey) as CompanySearchParams, [searchRequestKey]);
  const searchEnabled = !!selectedCompanyId && open
    && (searchRequest.q.length > 0 || hasSearchFilters(searchRequest));
  const search = useInfiniteQuery({
    queryKey: [
      ...queryKeys.companySearch.search(selectedCompanyId ?? "", searchRequest.q, searchRequest.scope ?? "all", SEARCH_PAGE_SIZE, 0),
      searchRequestKey,
    ],
    queryFn: ({ pageParam }) => searchApi.search(selectedCompanyId!, { ...searchRequest, limit: SEARCH_PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last) => {
      const next = last.offset + last.limit;
      return last.hasMore && next <= COMPANY_SEARCH_MAX_OFFSET ? next : undefined;
    },
    enabled: searchEnabled,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const searchResults = useMemo(
    () => (searchEnabled ? search.data?.pages.flatMap((page) => page.results) ?? [] : []),
    [search.data, searchEnabled],
  );
  const searchCounts = searchEnabled ? search.data?.pages[0]?.countsByType : undefined;
  // While the next query is typed or loads, the previous query's rows stay on
  // screen (keepPreviousData) so the list does not jump. They are stale: shown
  // dimmed and disabled, so Enter never opens a result of an older query.
  const resultsAreStale = searchEnabled && (liveRequestKey !== searchRequestKey || search.isPlaceholderData);
  // scope: and sort: only shape a search. Without words or a filter the
  // server matches nothing (as `paperclipai search` needs words), so the
  // launcher asks for them instead of sending an empty search.
  const needsSearchTerms = parsedQuery.query.trim().length === 0
    && !hasSearchFilters(parsedQuery.filters)
    && Boolean(parsedQuery.scope || parsedQuery.sort);
  const recentSearches = useMemo(
    () => (open && selectedCompanyId ? loadRecentSearches(selectedCompanyId) : []),
    [open, selectedCompanyId],
  );

  function runAfterClose(callback: () => void) {
    ranFromPaletteRef.current = true;
    pendingRunRef.current = callback;
    setOpen(false);
  }

  function go(path: string) {
    runAfterClose(() => navigate(path));
  }

  function openResult(result: CompanySearchResult) {
    if (selectedCompanyId) pushRecentSearch(selectedCompanyId, searchQuery);
    go(result.href);
  }

  function runAction(actionId: string) {
    runAfterClose(() => run(actionId));
  }

  const rankedActions = useMemo(
    () => rankCommandActions({ query: searchQuery, actions, contextualIds, usage, now: openedAt }),
    [actions, contextualIds, openedAt, searchQuery, usage],
  );

  const hasQuery = searchQuery.length > 0;
  const actionMatches = hasQuery ? rankedActions.slice(0, MAX_MATCHED_ACTIONS) : [];
  const strongActionMatch = (actionMatches[0]?.score ?? 0) >= STRONG_ACTION_MATCH;

  // cmdk selects the first row when the text changes, but search results
  // arrive later and replace that row, which left Enter with no target. Keep
  // the selection controlled and move it to the best current row, until the
  // user moves it with the keyboard: then results that arrive late leave it
  // alone. A new query follows the best row again.
  const firstResult = resultsAreStale ? undefined : searchResults[0];
  const bestRowValue = !hasQuery
    ? undefined
    : strongActionMatch || !firstResult
      ? actionMatches[0] ? `action:${actionMatches[0].action.id}` : undefined
      : `result:${firstResult.type}:${firstResult.id}`;
  const [selectedValue, setSelectedValue] = useState("");
  const followsBestRow = movedForQuery !== query;
  useEffect(() => {
    if (followsBestRow && bestRowValue) setSelectedValue(bestRowValue);
  }, [bestRowValue, followsBestRow]);

  function renderAction(action: AvailableCommandAction, testId = "command-action") {
    const Icon = commandActionIcon(action.id);
    return (
      <CommandItem
        key={action.id}
        value={`action:${action.id}`}
        onSelect={() => runAction(action.id)}
        data-testid={testId}
      >
        <Icon className="mr-2 h-4 w-4" />
        <span className="flex-1 truncate">{action.title}</span>
        <ShortcutHint keys={action.shortcut} />
      </CommandItem>
    );
  }

  const sections: Array<{ key: string; node: ReactNode }> = [];
  const pushSection = (key: string, heading: string, children: ReactNode[]) => {
    if (children.length === 0) return;
    sections.push({ key, node: <CommandGroup heading={heading}>{children}</CommandGroup> });
  };

  const actionSection = () => pushSection("actions", "Actions", actionMatches.map(({ action }) => renderAction(action)));
  const projectSection = () => pushSection(
    "projects",
    "Projects",
    projects.slice(0, TASK_LIMIT).map((project) => (
      <CommandItem key={project.id} value={`project:${project.id}`} onSelect={() => go(projectUrl(project))}>
        <Hexagon className="mr-2 h-4 w-4 shrink-0" />
        <span className="min-w-0 truncate">{project.name}</span>
      </CommandItem>
    )),
  );
  const taskSection = () => pushSection(
    "tasks",
    "Tasks",
    issues.slice(0, TASK_LIMIT).map((issue) => {
      const assignee = issue.assigneeAgentId ? agents.find((agent) => agent.id === issue.assigneeAgentId) : undefined;
      return (
        <CommandItem
          key={issue.id}
          value={`issue:${issue.id}`}
          onSelect={() => go(`/issues/${issue.identifier ?? issue.id}`)}
        >
          <CircleDot className="mr-2 h-4 w-4" />
          <span className="text-muted-foreground mr-2 font-mono text-xs">
            {issue.identifier ?? issue.id.slice(0, 8)}
          </span>
          <span className="flex-1 truncate">{issue.title}</span>
          {assignee ? <AgentIdentity agent={assignee} size="sm" className="ml-2 hidden sm:inline-flex" /> : null}
        </CommandItem>
      );
    }),
  );
  const agentSection = () => pushSection(
    "agents",
    "Agents",
    agents.slice(0, TASK_LIMIT).map((agent) => (
      <CommandItem key={agent.id} value={`agent:${agent.id}`} onSelect={() => go(agentUrl(agent))}>
        <Bot className="mr-2 h-4 w-4" />
        {agent.name}
        <span className="text-xs text-muted-foreground ml-2">{agent.role}</span>
      </CommandItem>
    )),
  );
  const filterSection = (chips: readonly string[], apply: (chip: string) => string) => pushSection(
    "quick-filters",
    "Quick filters",
    chips.map((chip) => (
      <CommandItem
        key={chip}
        value={`quick-filter:${chip}`}
        onSelect={() => setQuery(apply(chip))}
        data-testid="command-filter-chip"
      >
        <Search className="mr-2 h-4 w-4" />
        <span className="font-mono text-xs">{chip}</span>
      </CommandItem>
    )),
  );
  const resultSections = () => {
    // Groups follow the rank of their best result, so the first row is the
    // best match overall.
    const order: CompanySearchResultType[] = [];
    const byType = new Map<CompanySearchResultType, CompanySearchResult[]>();
    for (const result of searchResults) {
      if (!byType.has(result.type)) {
        byType.set(result.type, []);
        order.push(result.type);
      }
      byType.get(result.type)!.push(result);
    }
    for (const type of order) {
      const { heading, countKey } = RESULT_GROUPS[type];
      const total = searchCounts?.[countKey];
      pushSection(
        `results-${type}`,
        total !== undefined ? `${heading} · ${total}` : heading,
        byType.get(type)!.map((result) => {
          const Icon = resultIcon(result.type);
          const snippet = result.snippets.find((entry) => entry.field !== "title") ?? null;
          const identifier = result.issue?.identifier ?? null;
          // Issue titles come back as "<identifier> <title>"; the identifier
          // has its own column, so show the plain title (its highlights would
          // be offset, so they are dropped).
          const prefixed = identifier !== null && result.title.startsWith(`${identifier} `);
          const title = prefixed ? result.title.slice(identifier.length + 1) : result.title;
          const titleHighlights = prefixed ? undefined : result.snippets.find((entry) => entry.field === "title")?.highlights;
          return (
            <CommandItem
              key={`${result.type}:${result.id}`}
              value={`result:${result.type}:${result.id}`}
              onSelect={() => openResult(result)}
              disabled={resultsAreStale}
              data-testid="command-search-result"
            >
              <Icon className="mr-2 h-4 w-4 shrink-0" />
              {identifier ? (
                <span className="mr-2 shrink-0 font-mono text-xs text-muted-foreground">{identifier}</span>
              ) : null}
              <span className="min-w-0 flex-1">
                <HighlightedText text={title} highlights={titleHighlights} className="block truncate" />
                {snippet ? (
                  <HighlightedText
                    text={snippet.text}
                    highlights={snippet.highlights}
                    className="block truncate text-xs text-muted-foreground"
                  />
                ) : null}
              </span>
            </CommandItem>
          );
        }),
      );
    }
  };
  const searchStatusSection = () => {
    if (needsSearchTerms) {
      sections.push({
        key: "search-hint",
        node: (
          <div role="status" className="px-4 py-3 text-sm text-muted-foreground" data-testid="command-search-hint">
            Add words or a filter to search. scope: and sort: only shape the results.
          </div>
        ),
      });
      return;
    }
    if (!searchEnabled) return;
    if (search.isError) {
      const message = search.error instanceof Error ? search.error.message : "Search failed";
      pushSection("search-status", "Search", [
        <CommandItem key="retry" value="search-retry" onSelect={() => void search.refetch()} data-testid="command-search-error">
          <RotateCw className="mr-2 h-4 w-4" />
          <span className="flex-1 truncate">Search failed: {message}</span>
          <span className="ml-auto text-xs text-muted-foreground">Retry</span>
        </CommandItem>,
      ]);
      return;
    }
    if (search.isPending || resultsAreStale) {
      sections.push({
        key: "search-loading",
        node: <div role="status" className="px-4 py-3 text-sm text-muted-foreground">Searching…</div>,
      });
      return;
    }
    if (searchResults.length === 0 && !search.isFetching) {
      const rows: ReactNode[] = [];
      if (parsedQuery.pills.length > 0 && parsedQuery.query) {
        rows.push(
          <CommandItem key="drop-filters" value="search-without-filters" onSelect={() => setQuery(parsedQuery.query)}>
            <Search className="mr-2 h-4 w-4" />
            <span className="flex-1 truncate">Search &ldquo;{parsedQuery.query}&rdquo; without filters</span>
          </CommandItem>,
        );
      }
      if (parsedQuery.query) {
        rows.push(
          <CommandItem
            key="create-from-query"
            value="create-task-from-query"
            onSelect={() => runAfterClose(() => openNewIssue({ title: parsedQuery.query }))}
          >
            <Plus className="mr-2 h-4 w-4" />
            <span className="flex-1 truncate">Create task &ldquo;{parsedQuery.query}&rdquo;</span>
          </CommandItem>,
        );
      }
      sections.push({
        key: "search-empty",
        node: (
          <CommandGroup heading="No results">
            <div role="status" className="px-2 py-2 text-sm text-muted-foreground" data-testid="command-search-empty">
              No results for &ldquo;{searchQuery}&rdquo;.
            </div>
            {rows}
          </CommandGroup>
        ),
      });
      return;
    }
    if (search.hasNextPage) {
      const total = searchCounts ? Object.values(searchCounts).reduce((sum, count) => sum + count, 0) : undefined;
      pushSection("search-more", "More", [
        <CommandItem
          key="more"
          value="search-show-more"
          onSelect={() => void search.fetchNextPage()}
          disabled={search.isFetchingNextPage}
          data-testid="command-search-more"
        >
          <Search className="mr-2 h-4 w-4" />
          <span className="flex-1 truncate">
            {search.isFetchingNextPage ? "Loading more…" : "Show more results"}
          </span>
          {total !== undefined ? (
            <span className="ml-auto text-xs text-muted-foreground">{searchResults.length} of {total}</span>
          ) : null}
        </CommandItem>,
      ]);
    }
  };

  if (hasQuery) {
    if (strongActionMatch) actionSection();
    resultSections();
    if (!strongActionMatch) actionSection();
    searchStatusSection();
    filterSection(
      searchOperatorSuggestions(query, 4).map((suggestion) => suggestion.token),
      (token) => applySearchOperatorSuggestion(query, token),
    );
  } else {
    const contextual = rankedActions.filter(({ action }) => action.contextual);
    const recent = rankedActions
      .filter(({ action }) => !action.contextual && (usage[action.id]?.count ?? 0) > 0)
      .slice(0, MAX_RECENT_ACTIONS);
    const shown = new Set([...contextual, ...recent].map(({ action }) => action.id));
    pushSection("create", "Create", actions.filter((action) => action.group === "create").map((action) => renderAction(action)));
    pushSection("this-view", "This view", contextual.map(({ action }) => renderAction(action)));
    pushSection("recent", "Recent", recent.filter(({ action }) => action.group !== "create").map(({ action }) => renderAction(action)));
    pushSection(
      "recent-searches",
      "Recent searches",
      recentSearches.map((recentQuery) => (
        <CommandItem key={recentQuery} value={`recent-search:${recentQuery}`} onSelect={() => setQuery(recentQuery)}>
          <History className="mr-2 h-4 w-4" />
          <span className="flex-1 truncate">{recentQuery}</span>
        </CommandItem>
      )),
    );
    for (const { group, heading } of EMPTY_QUERY_GROUPS) {
      pushSection(
        group,
        heading,
        actions.filter((action) => action.group === group && !shown.has(action.id)).map((action) => renderAction(action)),
      );
    }
    filterSection(SEARCH_OPERATOR_QUICK_FILTERS, (chip) => (query.trim() ? `${query.trim()} ${chip}` : chip));
    taskSection();
    agentSection();
    projectSection();
  }

  return (
    <CommandDialog
      title="Command launcher"
      description="Run a command, or search tasks, agents and projects."
      open={open}
      onOpenChange={setOpen}
      commandProps={{
        shouldFilter: false,
        loop: true,
        value: selectedValue,
        onValueChange: setSelectedValue,
        onKeyDown: (event) => {
          if (movesSelection(event)) setMovedForQuery(query);
        },
      }}
      onCloseAutoFocus={(event) => {
        // Radix would focus the dialog's trigger, and the launcher has none,
        // which left focus on <body>.
        event.preventDefault();
        if (ranFromPaletteRef.current) {
          ranFromPaletteRef.current = false;
          return;
        }
        restoreFocus(returnFocusRef.current);
      }}
    >
      <CommandInput
        placeholder="Type a command or search tasks, agents, projects..."
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        {sections.map((section, index) => (
          <Fragment key={section.key}>
            {index > 0 ? <CommandSeparator /> : null}
            {section.node}
          </Fragment>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
