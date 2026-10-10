import { AgentIdentity } from "@/components/AgentIdentity";
import { Fragment, useState, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { useNavigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { rankCommandActions, scoreTextMatch } from "@paperclipai/shared/command-action-rank";
import type { CommandActionGroup } from "@paperclipai/shared/command-actions";
import { useCompany } from "../context/CompanyContext";
import { useSidebar } from "../context/SidebarContext";
import { useCommandActions, type AvailableCommandAction } from "../context/CommandActionsContext";
import { issuesApi } from "../api/issues";
import { authApi } from "../api/auth";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
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
import { CircleDot, Bot, Hexagon, Search } from "lucide-react";
import { agentUrl, projectUrl } from "../lib/utils";
import {
  SEARCH_OPERATOR_QUICK_FILTERS,
  buildSearchPathFromQuery,
  parseSearchQuery,
  type SearchQueryParserContext,
} from "../lib/search-query-parser";

export function buildFullSearchPath(query: string, context: SearchQueryParserContext = {}) {
  return buildSearchPathFromQuery(query, context);
}

/** Max promoted project matches kept when typing in the palette. */
const MAX_MATCHED_PROJECTS = 5;
/** Task cap when projects are also promoted, so Tasks can't crowd them out. */
const TASK_LIMIT_WITH_PROJECTS = 6;
const TASK_LIMIT = 10;
const MAX_MATCHED_AGENTS = 5;
const MAX_MATCHED_ACTIONS = 8;
const MAX_RECENT_ACTIONS = 5;
/**
 * An action match at or above this score (a title prefix or better) is
 * listed before the entity groups; weaker matches are listed after them.
 */
const STRONG_ACTION_MATCH = 700;

const EMPTY_QUERY_GROUPS: ReadonlyArray<{ group: CommandActionGroup; heading: string }> = [
  { group: "navigate", heading: "Navigate" },
  { group: "create", heading: "Create" },
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

/** Focuses `element` if it can still take focus, otherwise the page's main content. */
function restoreFocus(element: HTMLElement | null) {
  const canFocus = element !== null
    && element.isConnected
    && !element.closest("[inert], [hidden], [aria-hidden='true']")
    && !("disabled" in element && element.disabled === true)
    && element.getClientRects().length > 0;
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
  } = useCommandActions();
  const [query, setQuery] = useState("");
  const [openedAt, setOpenedAt] = useState(() => Date.now());
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
      setQuery("");
      const pendingRun = pendingRunRef.current;
      pendingRunRef.current = null;
      pendingRun?.();
      return;
    }
    setOpenedAt(Date.now());
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

  const { data: searchedIssues = [] } = useQuery({
    queryKey: queryKeys.issues.search(selectedCompanyId!, quickSearchQuery, undefined, 10),
    queryFn: () => issuesApi.list(selectedCompanyId!, { q: quickSearchQuery, limit: 10, includeRoutineExecutions: true }),
    enabled: !!selectedCompanyId && open && quickSearchQuery.length > 0,
  });

  function runAfterClose(callback: () => void) {
    ranFromPaletteRef.current = true;
    pendingRunRef.current = callback;
    setOpen(false);
  }

  function go(path: string) {
    runAfterClose(() => navigate(path));
  }

  function goFullSearch() {
    go(buildFullSearchPath(searchQuery, parserContext));
  }

  function runAction(actionId: string) {
    runAfterClose(() => run(actionId));
  }

  const visibleIssues = useMemo(
    () => (quickSearchQuery.length > 0 ? searchedIssues : issues),
    [issues, searchedIssues, quickSearchQuery],
  );

  const rankedActions = useMemo(
    () => rankCommandActions({ query: searchQuery, actions, contextualIds, usage, now: openedAt }),
    [actions, contextualIds, openedAt, searchQuery, usage],
  );

  const matchedProjects = useMemo(() => {
    if (quickSearchQuery.length === 0) return [];
    return projects
      .map((project) => ({ project, score: scoreTextMatch(project.name, project.description ?? "", quickSearchQuery) }))
      .filter((entry): entry is { project: (typeof projects)[number]; score: number } => entry.score !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_MATCHED_PROJECTS)
      .map((entry) => entry.project);
  }, [projects, quickSearchQuery]);

  const matchedAgents = useMemo(() => {
    if (quickSearchQuery.length === 0) return agents.slice(0, TASK_LIMIT);
    return agents
      .map((agent) => ({ agent, score: scoreTextMatch(agent.name, `${agent.role ?? ""} ${agent.title ?? ""}`, quickSearchQuery) }))
      .filter((entry): entry is { agent: (typeof agents)[number]; score: number } => entry.score !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_MATCHED_AGENTS)
      .map((entry) => entry.agent);
  }, [agents, quickSearchQuery]);

  const hasQuery = searchQuery.length > 0;
  const actionMatches = hasQuery ? rankedActions.slice(0, MAX_MATCHED_ACTIONS) : [];
  const strongActionMatch = (actionMatches[0]?.score ?? 0) >= STRONG_ACTION_MATCH;
  const taskLimit = matchedProjects.length > 0 ? TASK_LIMIT_WITH_PROJECTS : TASK_LIMIT;
  const showEmptyHint =
    hasQuery
    && actionMatches.length === 0
    && visibleIssues.length === 0
    && matchedProjects.length === 0
    && matchedAgents.length === 0;

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
    (hasQuery ? matchedProjects : projects.slice(0, TASK_LIMIT)).map((project) => (
      <CommandItem
        key={project.id}
        value={`project:${project.id}`}
        onSelect={() => go(projectUrl(project))}
        data-testid={hasQuery ? "command-project-match" : undefined}
      >
        <Hexagon className="mr-2 h-4 w-4 shrink-0" />
        <span className="min-w-0 truncate">{project.name}</span>
        {hasQuery && project.description ? (
          <span className="ml-2 hidden min-w-0 flex-1 truncate text-xs text-muted-foreground sm:inline">
            {project.description}
          </span>
        ) : null}
      </CommandItem>
    )),
  );
  const taskSection = () => pushSection(
    "tasks",
    "Tasks",
    visibleIssues.slice(0, taskLimit).map((issue) => {
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
    matchedAgents.map((agent) => (
      <CommandItem key={agent.id} value={`agent:${agent.id}`} onSelect={() => go(agentUrl(agent))}>
        <Bot className="mr-2 h-4 w-4" />
        {agent.name}
        <span className="text-xs text-muted-foreground ml-2">{agent.role}</span>
      </CommandItem>
    )),
  );
  const quickFilterSection = () => pushSection(
    "quick-filters",
    "Quick filters",
    SEARCH_OPERATOR_QUICK_FILTERS.map((chip) => (
      <CommandItem
        key={chip}
        value={`quick-filter:${chip}`}
        onSelect={() => setQuery((current) => current.trim() ? `${current.trim()} ${chip}` : chip)}
        data-testid="command-filter-chip"
      >
        <Search className="mr-2 h-4 w-4" />
        <span className="font-mono text-xs">{chip}</span>
      </CommandItem>
    )),
  );

  if (hasQuery) {
    if (strongActionMatch) actionSection();
    projectSection();
    taskSection();
    agentSection();
    if (!strongActionMatch) actionSection();
    pushSection("search", "Search", [
      <CommandItem
        key="search-all"
        value="search-all"
        onSelect={goFullSearch}
        className="bg-accent/40 border border-accent data-[selected=true]:bg-accent/60"
        data-testid="command-search-all"
      >
        <Search className="mr-2 h-4 w-4" />
        <span className="flex-1 truncate">
          Search all for <span className="font-semibold">&ldquo;{searchQuery}&rdquo;</span>
        </span>
        <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
          <span>open full search</span>
          <kbd className="rounded border border-border bg-background px-1 py-0.5 text-(length:--text-nano)">↵</kbd>
        </span>
      </CommandItem>,
    ]);
    quickFilterSection();
  } else {
    const contextual = rankedActions.filter(({ action }) => action.contextual);
    const recent = rankedActions
      .filter(({ action }) => !action.contextual && (usage[action.id]?.count ?? 0) > 0)
      .slice(0, MAX_RECENT_ACTIONS);
    const shown = new Set([...contextual, ...recent].map(({ action }) => action.id));
    pushSection("this-view", "This view", contextual.map(({ action }) => renderAction(action)));
    pushSection("recent", "Recent", recent.map(({ action }) => renderAction(action)));
    for (const { group, heading } of EMPTY_QUERY_GROUPS) {
      pushSection(
        group,
        heading,
        actions.filter((action) => action.group === group && !shown.has(action.id)).map((action) => renderAction(action)),
      );
    }
    quickFilterSection();
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
      commandProps={{ shouldFilter: false, loop: true }}
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
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            goFullSearch();
            return;
          }
          if (event.key === "Enter" && showEmptyHint) {
            event.preventDefault();
            goFullSearch();
          }
        }}
      />
      <CommandList>
        <CommandEmpty>
          {hasQuery ? (
            <span>
              No quick matches. Press{" "}
              <kbd className="rounded border border-border bg-muted px-1 py-0.5 text-(length:--text-nano)">↵</kbd>{" "}
              to <span className="font-medium">search all</span> or keep typing to refine.
            </span>
          ) : (
            "No results found."
          )}
        </CommandEmpty>
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
