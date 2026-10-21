import { startTransition, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, useNavigate, useSearchParams } from "@/lib/router";
import { ArrowUpDown, Check, ChevronRight, Layers, Plus, Repeat } from "lucide-react";
import { routinesApi } from "../api/routines";
import { foldersApi } from "../api/folders";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { issuesApi } from "../api/issues";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { cn } from "../lib/utils";
import { queryKeys } from "../lib/queryKeys";
import { agentNameMap, stepWarningsToast } from "../lib/routine-step-warnings";
import { groupBy } from "../lib/groupBy";
import { createIssueDetailLocationState } from "../lib/issueDetailBreadcrumb";
import { collectLiveIssueIds } from "../lib/liveIssueIds";
import { EmptyState } from "../components/EmptyState";
import { IssuesList } from "../components/IssuesList";
import { PageSkeleton } from "../components/PageSkeleton";
import { PageTabBar } from "../components/PageTabBar";
import { RoutineComposerDialog, type RoutineComposerDraft } from "../components/RoutineComposerDialog";
import { RoutineListRow, nextRoutineStatus } from "../components/RoutineList";
import {
  ROUTINE_FILTER_PARAM_KEYS,
  RoutineListFilterBar,
  changeSearchParams,
  hasActiveRoutineFilters,
  readRoutineUrlFilters,
  routineListQueryFromFilters,
  useRoutineSearchDraft,
} from "../components/RoutineListFilters";
import {
  RoutineRunVariablesDialog,
  type RoutineRunDialogSubmitData,
} from "../components/RoutineRunVariablesDialog";
import { RoutineVariablesEditor, RoutineVariablesHint } from "../components/RoutineVariablesEditor";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { auditSectionHref } from "./audit/audit-navigation";
import { routineDetailHref } from "../components/RoutineContextualSidebar";
import { usePublishSharedQueryData, useSharedPollingQuery } from "../hooks/useSharedPolling";
import { useNewRoutineLink } from "../hooks/useNewRoutineLink";
import { useStreamlinedUiEnabled } from "../hooks/useStreamlinedUiEnabled";
import type { RoutineListItem } from "@paperclipai/shared";
import type { FolderListItem } from "@paperclipai/shared";
import { Tabs } from "@/components/ui/tabs";
import {
  AllUnfiledBanner,
  BulkBar,
  DeleteFolderDialog,
  FolderChip,
  FolderFormDialog,
  FolderRail,
  FolderSwatch,
  MobileFolderSheet,
  MoveToMenu,
  folderSearchValue,
  normalizeFolderSelection,
  selectedFolderFromList,
  type FolderSelection,
} from "../components/folders/FolderControls";

type RoutineGroupBy = "folder" | "none" | "project" | "assignee";
type RoutinesTab = "routines" | "runs";
type RoutineSortField = "updated" | "created" | "title" | "lastRun";
type RoutineSortDir = "asc" | "desc";

type RoutineViewState = {
  sortField: RoutineSortField;
  sortDir: RoutineSortDir;
  groupBy: RoutineGroupBy;
  collapsedGroups: string[];
};

type RoutineGroup = {
  key: string;
  label: string | null;
  items: RoutineListItem[];
};

const builtInRoutineGroupKey = "__built_in_routines";

const defaultRoutineViewState: RoutineViewState = {
  sortField: "title",
  sortDir: "asc",
  groupBy: "folder",
  collapsedGroups: [],
};

const embeddedRoutineViewState: RoutineViewState = { ...defaultRoutineViewState, groupBy: "none" };

function getRoutineViewState(key: string, defaults: RoutineViewState = defaultRoutineViewState): RoutineViewState {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return { ...defaults, ...JSON.parse(raw) };
  } catch {
    // Ignore malformed local state and fall back to defaults.
  }
  return { ...defaults };
}

function saveRoutineViewState(key: string, state: RoutineViewState) {
  localStorage.setItem(key, JSON.stringify(state));
}

function timestampValue(value: Date | string | null | undefined) {
  if (!value) return Number.NEGATIVE_INFINITY;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function compareNullableText(left: string | null | undefined, right: string | null | undefined) {
  return (left ?? "").localeCompare(right ?? "", undefined, { sensitivity: "base" });
}

type RoutineFolderGroupMeta = { name: string; position?: number | null };

export function buildRoutineGroups(
  routines: RoutineListItem[],
  groupByValue: RoutineGroupBy,
  projectById: Map<string, { name: string }>,
  agentById: Map<string, { name: string }>,
  folderById: Map<string, RoutineFolderGroupMeta>,
): RoutineGroup[] {
  if (groupByValue === "none") {
    return [{ key: "__all", label: null, items: routines }];
  }

  if (groupByValue === "folder") {
    const groups = groupBy(routines, (routine) => routine.folderId ?? "__unfiled");
    return Object.keys(groups)
      .sort((left, right) => {
        if (left === "__unfiled" || right === "__unfiled") {
          if (left === right) return 0;
          return left === "__unfiled" ? 1 : -1;
        }

        const leftFolder = folderById.get(left);
        const rightFolder = folderById.get(right);
        const leftPosition = Number.isFinite(leftFolder?.position) ? leftFolder!.position! : Number.POSITIVE_INFINITY;
        const rightPosition = Number.isFinite(rightFolder?.position) ? rightFolder!.position! : Number.POSITIVE_INFINITY;
        const positionCompare = leftPosition - rightPosition;
        if (positionCompare !== 0) return positionCompare;

        const labelCompare = (leftFolder?.name ?? "Unknown folder").localeCompare(
          rightFolder?.name ?? "Unknown folder",
          undefined,
          { sensitivity: "base" },
        );
        return labelCompare || left.localeCompare(right);
      })
      .map((key) => ({
        key,
        label: key === "__unfiled" ? "Unfiled" : (folderById.get(key)?.name ?? "Unknown folder"),
        items: groups[key]!,
      }));
  }

  if (groupByValue === "project") {
    const groups = groupBy(routines, (routine) => routine.projectId ?? "__no_project");
    return Object.keys(groups)
      .sort((left, right) => {
        const leftLabel = left === "__no_project" ? "No project" : (projectById.get(left)?.name ?? "Unknown project");
        const rightLabel = right === "__no_project" ? "No project" : (projectById.get(right)?.name ?? "Unknown project");
        return leftLabel.localeCompare(rightLabel);
      })
      .map((key) => ({
        key,
        label: key === "__no_project" ? "No project" : (projectById.get(key)?.name ?? "Unknown project"),
        items: groups[key]!,
      }));
  }

  const groups = groupBy(routines, (routine) => routine.assigneeAgentId ?? "__unassigned");
  return Object.keys(groups)
    .sort((left, right) => {
      const leftLabel = left === "__unassigned" ? "Unassigned" : (agentById.get(left)?.name ?? "Unknown agent");
      const rightLabel = right === "__unassigned" ? "Unassigned" : (agentById.get(right)?.name ?? "Unknown agent");
      return leftLabel.localeCompare(rightLabel);
    })
    .map((key) => ({
      key,
      label: key === "__unassigned" ? "Unassigned" : (agentById.get(key)?.name ?? "Unknown agent"),
      items: groups[key]!,
    }));
}

export function isBuiltInRoutine(routine: Pick<RoutineListItem, "originKind">) {
  return routine.originKind === "built_in_agent_bundle";
}

export function buildRoutineSections(
  routines: RoutineListItem[],
  groupByValue: RoutineGroupBy,
  projectById: Map<string, { name: string }>,
  agentById: Map<string, { name: string }>,
  folderById: Map<string, { name: string }>,
): RoutineGroup[] {
  const builtInRoutines = routines.filter(isBuiltInRoutine);
  const customRoutines = routines.filter((routine) => !isBuiltInRoutine(routine));
  const customGroups = buildRoutineGroups(customRoutines, groupByValue, projectById, agentById, folderById)
    .filter((group) => group.items.length > 0)
    .map((group) => (
      builtInRoutines.length > 0 && groupByValue === "none" && group.key === "__all"
        ? { ...group, label: "Custom routines" }
        : group
    ));

  if (builtInRoutines.length === 0) return customGroups;

  return [
    ...customGroups,
    {
      key: builtInRoutineGroupKey,
      label: "Built-in routines",
      items: builtInRoutines,
    },
  ];
}

export function sortRoutines(
  routines: RoutineListItem[],
  sortField: RoutineSortField,
  sortDir: RoutineSortDir,
): RoutineListItem[] {
  const direction = sortDir === "asc" ? 1 : -1;
  return [...routines].sort((left, right) => {
    let result = 0;

    if (sortField === "title") {
      result = compareNullableText(left.title, right.title);
    } else if (sortField === "created") {
      result = timestampValue(left.createdAt) - timestampValue(right.createdAt);
    } else if (sortField === "lastRun") {
      result = timestampValue(left.lastRun?.triggeredAt ?? left.lastTriggeredAt) -
        timestampValue(right.lastRun?.triggeredAt ?? right.lastTriggeredAt);
    } else {
      result = timestampValue(left.updatedAt) - timestampValue(right.updatedAt);
    }

    if (result !== 0) return result * direction;
    return compareNullableText(left.title, right.title);
  });
}

function RoutineSectionHeader({
  label,
  count,
  isOpen: _isOpen,
}: {
  label: string;
  count: number;
  isOpen: boolean;
}) {
  return (
    <div className="flex items-center gap-2 px-2 py-1.5">
      <CollapsibleTrigger className="flex items-center gap-1.5">
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform [[data-state=open]>&]:rotate-90" />
        <span data-routine-section-label className="text-sm font-medium">
          {label}
        </span>
      </CollapsibleTrigger>
      <span className="text-xs text-muted-foreground">
        {count}
      </span>
    </div>
  );
}

/** Options for showing the routine list inside another page (the agent page's Routines tab). */
export interface RoutinesProps {
  /** Fixes the agent filter and pre-fills new routines with this agent. */
  fixedAssigneeAgentId?: string;
  /** Drops the page heading, breadcrumbs and legacy tabs. */
  embedded?: boolean;
  /** Routines shown elsewhere on the same page, such as a built-in agent's managed routine. */
  excludeRoutineIds?: readonly string[];
}

export function Routines({ fixedAssigneeAgentId, embedded = false, excludeRoutineIds }: RoutinesProps = {}) {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { pushToast } = useToastActions();
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [folderDialogTarget, setFolderDialogTarget] = useState<FolderListItem | null>(null);
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<FolderListItem | null>(null);
  const [mobileFoldersOpen, setMobileFoldersOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedRoutineIds, setSelectedRoutineIds] = useState<string[]>([]);
  const [moveAfterCreateIds, setMoveAfterCreateIds] = useState<string[]>([]);
  const [runningRoutineId, setRunningRoutineId] = useState<string | null>(null);
  const [statusMutationRoutineId, setStatusMutationRoutineId] = useState<string | null>(null);
  const [runDialogRoutine, setRunDialogRoutine] = useState<RoutineListItem | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerSeed, setComposerSeed] = useState<Partial<RoutineComposerDraft>>({});
  const { enabled: streamlinedUiEnabled } = useStreamlinedUiEnabled();
  const legacyRunsRequested = searchParams.get("tab") === "runs";
  const activeTab: RoutinesTab = !embedded && !streamlinedUiEnabled && legacyRunsRequested ? "runs" : "routines";
  const urlFilters = readRoutineUrlFilters(searchParams);
  const listFilters = routineListQueryFromFilters(urlFilters, fixedAssigneeAgentId);
  const filtersActive = hasActiveRoutineFilters(urlFilters, fixedAssigneeAgentId);
  const [searchDraft, setSearchDraft] = useRoutineSearchDraft();
  const routineViewStateKey = `paperclip:${embedded ? "agent-routines-view" : "routines-view"}${selectedCompanyId ? `:${selectedCompanyId}` : ""}`;
  const routineViewDefaults = embedded ? embeddedRoutineViewState : defaultRoutineViewState;
  const [routineViewState, setRoutineViewState] = useState<RoutineViewState>(() => getRoutineViewState(routineViewStateKey, routineViewDefaults));
  const folderSelection = normalizeFolderSelection(searchParams.get("folder"));

  useEffect(() => {
    if (embedded) return;
    setBreadcrumbs([{ label: "Routines" }]);
  }, [embedded, setBreadcrumbs]);

  useEffect(() => {
    setRoutineViewState(getRoutineViewState(routineViewStateKey, routineViewDefaults));
  }, [routineViewDefaults, routineViewStateKey]);

  const { data: routines, isLoading, error } = useQuery({
    queryKey: queryKeys.routines.list(selectedCompanyId!, listFilters),
    queryFn: () => routinesApi.list(selectedCompanyId!, listFilters),
    // Keep the last list on screen while a filter change loads, but never carry it into another company.
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === selectedCompanyId ? previous : undefined),
    enabled: !!selectedCompanyId,
  });
  const { data: routineFolders, isLoading: foldersLoading } = useQuery({
    queryKey: queryKeys.folders.list(selectedCompanyId!, "routine"),
    queryFn: () => foldersApi.list(selectedCompanyId!, "routine"),
    enabled: !!selectedCompanyId,
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!, { includeArchived: true }),
    queryFn: () => projectsApi.list(selectedCompanyId!, { includeArchived: true }),
    enabled: !!selectedCompanyId,
  });
  const { data: routineExecutionIssues, isLoading: recentRunsLoading, error: recentRunsError } = useQuery({
    queryKey: [...queryKeys.issues.list(selectedCompanyId!), "routine-executions"],
    queryFn: () => issuesApi.list(selectedCompanyId!, { originKind: "routine_execution" }),
    enabled: !!selectedCompanyId && !streamlinedUiEnabled && activeTab === "runs",
  });
  const liveRunsQueryKey = queryKeys.liveRuns(selectedCompanyId!);
  const sharedLiveRuns = useSharedPollingQuery({
    companyId: selectedCompanyId,
    resourceKey: "live-runs",
    queryKey: liveRunsQueryKey,
    enabled: !!selectedCompanyId && !streamlinedUiEnabled && activeTab === "runs",
    refetchInterval: false,
    leaderOnly: true,
  });
  const { data: liveRuns, dataUpdatedAt: liveRunsUpdatedAt } = useQuery({
    queryKey: liveRunsQueryKey,
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: sharedLiveRuns.enabled,
    refetchInterval: sharedLiveRuns.refetchInterval,
  });
  usePublishSharedQueryData(sharedLiveRuns, liveRuns, liveRunsUpdatedAt);

  const createFolder = useMutation({
    mutationFn: (payload: { name: string; color: string | null }) =>
      foldersApi.create(selectedCompanyId!, { kind: "routine", ...payload }),
    onSuccess: async (folder) => {
      setFolderDialogOpen(false);
      setFolderDialogTarget(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.folders.list(selectedCompanyId!, "routine") });
      if (moveAfterCreateIds.length > 0) {
        const ids = moveAfterCreateIds;
        setMoveAfterCreateIds([]);
        try {
          await Promise.all(ids.map((itemId) =>
            foldersApi.moveItem(selectedCompanyId!, { kind: "routine", itemId, folderId: folder.id })
          ));
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
            queryClient.invalidateQueries({ queryKey: queryKeys.folders.list(selectedCompanyId!, "routine") }),
          ]);
        } catch (moveError) {
          pushToast({
            title: "Folder created, move failed",
            body: moveError instanceof Error ? moveError.message : "Paperclip could not move the selected routines.",
            tone: "error",
          });
          return;
        }
      } else {
        setFolderSelection(folder.id);
      }
      pushToast({ title: "Folder created", body: folder.name, tone: "success" });
    },
    onError: (mutationError) => {
      pushToast({
        title: "Failed to save folder",
        body: mutationError instanceof Error ? mutationError.message : "Paperclip could not save the folder.",
        tone: "error",
      });
    },
  });
  const updateFolder = useMutation({
    mutationFn: ({ folderId, payload }: { folderId: string; payload: { name?: string; color?: string | null } }) =>
      foldersApi.update(selectedCompanyId!, folderId, payload),
    onSuccess: async () => {
      setFolderDialogOpen(false);
      setFolderDialogTarget(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.folders.list(selectedCompanyId!, "routine") });
    },
    onError: (mutationError) => {
      pushToast({
        title: "Folder save failed",
        body: mutationError instanceof Error ? mutationError.message : "Paperclip could not update the folder.",
        tone: "error",
      });
    },
  });
  const deleteFolder = useMutation({
    mutationFn: (folderId: string) => foldersApi.delete(selectedCompanyId!, folderId),
    onSuccess: async (_, folderId) => {
      if (folderSelection === folderId) setFolderSelection("all");
      setDeleteFolderTarget(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.folders.list(selectedCompanyId!, "routine") }),
      ]);
      pushToast({ title: "Folder deleted", body: "Items moved to Unfiled.", tone: "success" });
    },
    onError: (mutationError) => {
      pushToast({
        title: "Folder delete failed",
        body: mutationError instanceof Error ? mutationError.message : "Paperclip could not delete the folder.",
        tone: "error",
      });
    },
  });
  const moveRoutineToFolder = useMutation({
    mutationFn: ({ itemId, folderId }: { itemId: string; folderId: string | null }) =>
      foldersApi.moveItem(selectedCompanyId!, { kind: "routine", itemId, folderId }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.folders.list(selectedCompanyId!, "routine") }),
      ]);
    },
    onError: (mutationError) => {
      pushToast({
        title: "Move failed",
        body: mutationError instanceof Error ? mutationError.message : "Paperclip could not move the routine.",
        tone: "error",
      });
    },
  });
  const updateRoutineStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => routinesApi.update(id, { status }),
    onMutate: ({ id }) => {
      setStatusMutationRoutineId(id);
    },
    onSuccess: async (_, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(variables.id) }),
      ]);
    },
    onSettled: () => {
      setStatusMutationRoutineId(null);
    },
    onError: (mutationError) => {
      pushToast({
        title: "Failed to update routine",
        body: mutationError instanceof Error ? mutationError.message : "Paperclip could not update the routine.",
        tone: "error",
      });
    },
  });

  const runRoutine = useMutation({
    mutationFn: ({ id, data }: { id: string; data?: RoutineRunDialogSubmitData }) => routinesApi.run(id, {
      ...(data?.variables && Object.keys(data.variables).length > 0 ? { variables: data.variables } : {}),
      ...(data?.assigneeAgentId !== undefined ? { assigneeAgentId: data.assigneeAgentId } : {}),
      ...(data?.projectId !== undefined ? { projectId: data.projectId } : {}),
      ...(data?.executionWorkspaceId !== undefined ? { executionWorkspaceId: data.executionWorkspaceId } : {}),
      ...(data?.executionWorkspacePreference !== undefined
        ? { executionWorkspacePreference: data.executionWorkspacePreference }
        : {}),
      ...(data?.executionWorkspaceSettings !== undefined
        ? { executionWorkspaceSettings: data.executionWorkspaceSettings }
        : {}),
    }),
    onMutate: ({ id }) => {
      setRunningRoutineId(id);
    },
    onSuccess: async (run, { id }) => {
      setRunDialogRoutine(null);
      const warningToast = stepWarningsToast(run.warnings, agentNameMap(agents));
      if (warningToast) pushToast(warningToast);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(id) }),
      ]);
    },
    onSettled: () => {
      setRunningRoutineId(null);
    },
    onError: (mutationError) => {
      pushToast({
        title: "Routine run failed",
        body: mutationError instanceof Error ? mutationError.message : "Paperclip could not start the routine run.",
        tone: "error",
      });
    },
  });

  const agentById = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent])),
    [agents],
  );
  const projectById = useMemo(
    () => new Map((projects ?? []).map((project) => [project.id, project])),
    [projects],
  );
  const folderById = useMemo(
    () => new Map((routineFolders?.folders ?? []).map((folder) => [folder.id, folder])),
    [routineFolders],
  );
  const excludedRoutineIds = useMemo(() => new Set(excludeRoutineIds ?? []), [excludeRoutineIds]);
  const visibleRoutines = useMemo(
    () => (routines ?? []).filter((routine) =>
      (urlFilters.status === "archived" || routine.status !== "archived") && !excludedRoutineIds.has(routine.id)),
    [excludedRoutineIds, routines, urlFilters.status],
  );
  const liveIssueIds = useMemo(
    () => collectLiveIssueIds(liveRuns, routineExecutionIssues),
    [liveRuns, routineExecutionIssues],
  );
  const recentRunsIssueLinkState = useMemo(
    () => createIssueDetailLocationState("Recent Runs", "/routines?tab=runs", "issues"),
    [],
  );
  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) => issuesApi.update(id, data),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: [...queryKeys.issues.list(selectedCompanyId!), "routine-executions"],
      });
    },
  });

  function handleLegacyTabChange(tab: string) {
    const nextTab: RoutinesTab = tab === "runs" ? "runs" : "routines";
    startTransition(() => {
      navigate(nextTab === "runs" ? "/routines?tab=runs" : "/routines");
    });
  }
  const folderFilteredRoutines = useMemo(() => {
    if (routineViewState.groupBy !== "folder") return visibleRoutines;
    if (folderSelection === "all") return visibleRoutines;
    if (folderSelection === "unfiled") return visibleRoutines.filter((routine) => !routine.folderId);
    return visibleRoutines.filter((routine) => routine.folderId === folderSelection);
  }, [folderSelection, routineViewState.groupBy, visibleRoutines]);
  // Rail counts reflect the page's visible scope (archived hidden), not raw DB
  // counts (ux-spec §5.3).
  const railFolderResult = useMemo(() => {
    if (!routineFolders) return routineFolders;
    const counts = new Map<string, number>();
    let unfiled = 0;
    for (const routine of visibleRoutines) {
      if (routine.folderId) counts.set(routine.folderId, (counts.get(routine.folderId) ?? 0) + 1);
      else unfiled += 1;
    }
    return {
      ...routineFolders,
      allCount: visibleRoutines.length,
      unfiledCount: unfiled,
      folders: routineFolders.folders.map((folder) => ({
        ...folder,
        itemCount: counts.get(folder.id) ?? 0,
      })),
    };
  }, [routineFolders, visibleRoutines]);
  const sortedRoutines = useMemo(
    () => sortRoutines(folderFilteredRoutines, routineViewState.sortField, routineViewState.sortDir),
    [folderFilteredRoutines, routineViewState.sortDir, routineViewState.sortField],
  );
  const routineSections = useMemo(
    () => buildRoutineSections(sortedRoutines, routineViewState.groupBy, projectById, agentById, folderById),
    [agentById, folderById, projectById, routineViewState.groupBy, sortedRoutines],
  );
  const activeFolder = selectedFolderFromList(routineFolders?.folders ?? [], folderSelection);
  const hasRoutineFolders = (routineFolders?.folders.length ?? 0) > 0;
  const showFolderRail = routineViewState.groupBy === "folder" && hasRoutineFolders;

  function updateRoutineView(patch: Partial<RoutineViewState>) {
    setRoutineViewState((current) => {
      const next = { ...current, ...patch };
      saveRoutineViewState(routineViewStateKey, next);
      return next;
    });
  }

  function setRoutineFilterParam(key: (typeof ROUTINE_FILTER_PARAM_KEYS)[number], value: string | null) {
    changeSearchParams(setSearchParams, (params) => {
      if (value) params.set(key, value);
      else params.delete(key);
    });
  }

  function clearRoutineFilters() {
    setSearchDraft("");
    changeSearchParams(setSearchParams, (params) => {
      for (const key of ROUTINE_FILTER_PARAM_KEYS) params.delete(key);
    });
  }

  function setFolderSelection(selection: FolderSelection) {
    changeSearchParams(setSearchParams, (params) => {
      const value = folderSearchValue(selection);
      if (value) params.set("folder", value);
      else params.delete("folder");
    }, {});
  }

  function openCreateFolder(moveItemIds: string[] = []) {
    setMoveAfterCreateIds(moveItemIds);
    setFolderDialogTarget(null);
    setFolderDialogOpen(true);
  }

  function openComposer(projectId: string | null) {
    setComposerSeed({
      folderId: folderSelection === "all" || folderSelection === "unfiled" ? null : folderSelection,
      ...(fixedAssigneeAgentId ? { assigneeAgentId: fixedAssigneeAgentId } : {}),
      ...(projectId ? { projectId } : {}),
    });
    setComposerOpen(true);
  }

  function openCreateRoutine() {
    openComposer(null);
  }

  useNewRoutineLink(openComposer, !embedded);

  async function moveSelectedRoutines(folderId: string | null) {
    const ids = selectedRoutineIds;
    if (ids.length === 0) return;
    try {
      await Promise.all(ids.map((itemId) => foldersApi.moveItem(selectedCompanyId!, { kind: "routine", itemId, folderId })));
      setSelectedRoutineIds([]);
      setSelectMode(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.folders.list(selectedCompanyId!, "routine") }),
      ]);
      pushToast({ title: "Routines moved", body: `${ids.length} routine${ids.length === 1 ? "" : "s"} filed.`, tone: "success" });
    } catch (moveError) {
      pushToast({
        title: "Failed to move routines",
        body: moveError instanceof Error ? moveError.message : "Paperclip could not move the selected routines.",
        tone: "error",
      });
    }
  }

  function handleRunNow(routine: RoutineListItem) {
    setRunDialogRoutine(routine);
  }

  function handleToggleEnabled(routine: RoutineListItem, enabled: boolean) {
    if (!enabled && !routine.assigneeAgentId) {
      pushToast({
        title: "Default agent required",
        body: "Set a default agent before enabling routine automation.",
        tone: "warn",
      });
      return;
    }
    updateRoutineStatus.mutate({
      id: routine.id,
      status: nextRoutineStatus(routine.status, !enabled),
    });
  }

  function handleToggleArchived(routine: RoutineListItem) {
    updateRoutineStatus.mutate({
      id: routine.id,
      status: routine.status === "archived" ? "active" : "archived",
    });
  }

  if (!selectedCompanyId) {
    return <EmptyState icon={Repeat} message="Select an organization to view routines." />;
  }

  if (streamlinedUiEnabled && legacyRunsRequested) {
    return <Navigate to={auditSectionHref("runs", {})} replace />;
  }

  if (isLoading) {
    return <PageSkeleton variant="issues-list" />;
  }

  if (!streamlinedUiEnabled && activeTab === "runs") {
    return (
      <div className="space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Routines</h1>
            <p className="text-sm text-muted-foreground">
              Recurring work definitions that materialize into auditable execution tasks.
            </p>
          </div>
          <Button onClick={openCreateRoutine}>
            <Plus className="mr-2 h-4 w-4" />
            Create routine
          </Button>
        </div>
        <Tabs value={activeTab} onValueChange={handleLegacyTabChange}>
          <PageTabBar
            align="start"
            value={activeTab}
            onValueChange={handleLegacyTabChange}
            items={[
              { value: "routines", label: "Routines" },
              { value: "runs", label: "Recent Runs" },
            ]}
          />
        </Tabs>
        <IssuesList
          issues={routineExecutionIssues ?? []}
          isLoading={recentRunsLoading}
          error={recentRunsError as Error | null}
          agents={agents}
          projects={projects}
          liveIssueIds={liveIssueIds}
          viewStateKey="paperclip:routine-recent-runs-view"
          issueLinkState={recentRunsIssueLinkState}
          onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {embedded ? null : (
          <div className="space-y-1">
            <h1 className="text-xl font-bold">Routines</h1>
            <p className="text-sm text-muted-foreground">
              Recurring work definitions that materialize into auditable execution tasks.
            </p>
          </div>
        )}
        <div className="flex items-center gap-2">
          {streamlinedUiEnabled && !embedded ? (
            <Button variant="outline" asChild>
              <Link to={auditSectionHref("runs", {})}>View all runs</Link>
            </Button>
          ) : null}
          <Button onClick={openCreateRoutine}>
            <Plus className="mr-2 h-4 w-4" />
            {embedded ? "New routine" : "Create routine"}
          </Button>
        </div>
      </div>

      {!streamlinedUiEnabled && !embedded ? (
        <Tabs value={activeTab} onValueChange={handleLegacyTabChange}>
          <PageTabBar
            align="start"
            value={activeTab}
            onValueChange={handleLegacyTabChange}
            items={[
              { value: "routines", label: "Routines" },
              { value: "runs", label: "Recent Runs" },
            ]}
          />
        </Tabs>
      ) : null}

      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {visibleRoutines.length} routine{visibleRoutines.length === 1 ? "" : "s"}
          </p>
          <div className="flex items-center gap-1">
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="sm" className="text-xs" title="Sort">
                    <ArrowUpDown className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
                    <span className="hidden sm:inline">Sort</span>
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-44 p-0">
                  <div className="p-2 space-y-0.5">
                    {([
                      ["updated", "Updated"],
                      ["created", "Created"],
                      ["lastRun", "Last run"],
                      ["title", "Title"],
                    ] as const).map(([field, label]) => (
                      <button
                        key={field}
                        className={`flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm ${
                          routineViewState.sortField === field
                            ? "bg-accent/50 text-foreground"
                            : "text-muted-foreground hover:bg-accent/50"
                        }`}
                        onClick={() => {
                          updateRoutineView(
                            routineViewState.sortField === field
                              ? { sortDir: routineViewState.sortDir === "asc" ? "desc" : "asc" }
                              : { sortField: field, sortDir: field === "title" ? "asc" : "desc" },
                          );
                        }}
                      >
                        <span>{label}</span>
                        {routineViewState.sortField === field ? (
                          <span className="text-xs text-muted-foreground">
                            {routineViewState.sortDir === "asc" ? "Asc" : "Desc"}
                          </span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="sm" className="text-xs" title="Group">
                    <Layers className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
                    <span className="hidden sm:inline">Group</span>
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-44 p-0">
                  <div className="p-2 space-y-0.5">
                    {([
                      ["folder", "Folder"],
                      ["project", "Project"],
                      ["assignee", "Agent"],
                      ["none", "None"],
                    ] as const).map(([value, label]) => (
                      <button
                        key={value}
                        className={`flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm ${
                          routineViewState.groupBy === value
                            ? "bg-accent/50 text-foreground"
                            : "text-muted-foreground hover:bg-accent/50"
                        }`}
                        onClick={() => updateRoutineView({ groupBy: value, collapsedGroups: [] })}
                      >
                        <span>{label}</span>
                        {routineViewState.groupBy === value ? <Check className="h-3.5 w-3.5" /> : null}
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
              {routineViewState.groupBy === "folder" && !hasRoutineFolders ? (
                <Button variant="outline" size="sm" onClick={() => openCreateFolder()}>
                  <Plus className="mr-2 h-3.5 w-3.5" />
                  New folder
                </Button>
              ) : null}
              {showFolderRail ? (
                <Button variant="ghost" size="sm" className="text-xs" onClick={() => setSelectMode((current) => !current)}>
                  {selectMode ? "Done" : "Select"}
                </Button>
              ) : null}
          </div>
        </div>
        <RoutineListFilterBar
          searchDraft={searchDraft}
          onSearchDraftChange={setSearchDraft}
          filters={urlFilters}
          agents={fixedAssigneeAgentId ? undefined : (agents ?? []).map((agent) => ({ id: agent.id, name: agent.name }))}
          onFilterChange={setRoutineFilterParam}
          onClear={clearRoutineFilters}
          active={filtersActive}
        />
        {routineViewState.groupBy === "folder" ? (
          <div className="md:hidden">
            <FolderChip
              result={railFolderResult}
              selection={folderSelection}
              allLabel="All routines"
              onClick={() => setMobileFoldersOpen(true)}
            />
          </div>
        ) : null}
      </div>

      <RoutineComposerDialog
        companyId={selectedCompanyId!}
        open={composerOpen}
        onOpenChange={setComposerOpen}
        initialDraft={composerSeed}
      />

      {error ? (
        <Card>
          <CardContent className="pt-6 text-sm text-destructive">
            {error instanceof Error ? error.message : "Failed to load routines"}
          </CardContent>
        </Card>
      ) : null}

      <div className={cn(showFolderRail && "flex gap-4")}>
          {showFolderRail ? (
            <FolderRail
              result={railFolderResult}
              selection={folderSelection}
              allLabel="All routines"
              itemLabelPlural="routines"
              loading={foldersLoading}
              onSelect={setFolderSelection}
              onCreate={() => openCreateFolder()}
              onRename={(folder, name) => updateFolder.mutate({ folderId: folder.id, payload: { name } })}
              onEdit={(folder) => {
                setFolderDialogTarget(folder);
                setFolderDialogOpen(true);
              }}
              onDelete={setDeleteFolderTarget}
            />
          ) : null}
          <div className="min-w-0 flex-1">
          {routineViewState.groupBy === "folder" && hasRoutineFolders ? (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {folderSelection === "all" ? <FolderIconHeader label="All routines" count={sortedRoutines.length} /> : (
                <div className="flex min-w-0 items-center gap-2 text-sm">
                  <FolderSwatch color={activeFolder?.color} />
                  <span className="truncate font-medium">{folderSelection === "unfiled" ? "Unfiled" : activeFolder?.name ?? "Folder"}</span>
                  <span className="text-muted-foreground">{sortedRoutines.length} routine{sortedRoutines.length === 1 ? "" : "s"}</span>
                </div>
              )}
            </div>
          ) : null}
          {routineViewState.groupBy === "folder" && !hasRoutineFolders && !foldersLoading && visibleRoutines.length > 0 ? (
            <AllUnfiledBanner
              storageKey={`paperclip:routines-folder-nudge:${selectedCompanyId ?? "none"}`}
              itemLabelPlural="routines"
              onCreateFolder={() => openCreateFolder()}
            />
          ) : null}
          {selectMode ? (
            <BulkBar
              selectedCount={selectedRoutineIds.length}
              folders={routineFolders?.folders ?? []}
              onMove={(folderId) => void moveSelectedRoutines(folderId)}
              onCreateAndMove={() => openCreateFolder(selectedRoutineIds)}
              onClear={() => setSelectedRoutineIds([])}
              onDone={() => {
                setSelectMode(false);
                setSelectedRoutineIds([]);
              }}
            />
          ) : null}
          {visibleRoutines.length === 0 && filtersActive ? (
            <div className="py-12">
              <EmptyState icon={Repeat} message="No routines match these filters. Use Clear filters to see them all." />
            </div>
          ) : visibleRoutines.length === 0 ? (
            <div className="py-12">
              <EmptyState
                icon={Repeat}
                message={!embedded
                  ? "No active routines. Use Create routine to define the first recurring workflow."
                  : excludeRoutineIds?.length
                    ? "No other routines are assigned to this agent. Use New routine to add one."
                    : "No routines are assigned to this agent yet. Use New routine to create one."}
              />
            </div>
          ) : sortedRoutines.length === 0 ? (
            <div className="py-12">
              <EmptyState
                icon={Repeat}
                message={folderSelection === "all" ? "No routines match this view." : "This folder is empty."}
              />
              {folderSelection !== "all" ? (
                <div className="mt-3 flex justify-center">
                  <Button size="sm" onClick={openCreateRoutine}>
                    <Plus className="mr-2 h-3.5 w-3.5" />
                    New routine in this folder
                  </Button>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {routineSections.map((group) => {
                const isOpen = !routineViewState.collapsedGroups.includes(group.key);
                return (
                  <Collapsible
                    key={group.key}
                    open={isOpen}
                    onOpenChange={(open) => {
                      updateRoutineView({
                        collapsedGroups: open
                          ? routineViewState.collapsedGroups.filter((item) => item !== group.key)
                          : [...routineViewState.collapsedGroups, group.key],
                      });
                    }}
                  >
                    {group.label ? (
                      <RoutineSectionHeader
                        label={group.label}
                        count={group.items.length}
                        isOpen={isOpen}
                      />
                    ) : null}
                    <CollapsibleContent>
                      {group.items.map((routine) => (
                        <RoutineListRow
                          key={routine.id}
                          routine={routine}
                          projectById={projectById}
                          agentById={agentById}
                          runningRoutineId={runningRoutineId}
                          statusMutationRoutineId={statusMutationRoutineId}
                          href={`/routines/${routine.id}`}
                          runNowButton
                          divider={false}
                          onRunNow={handleRunNow}
                          onToggleEnabled={handleToggleEnabled}
                          onToggleArchived={handleToggleArchived}
                          selectMode={selectMode}
                          selected={selectedRoutineIds.includes(routine.id)}
                          onSelectChange={(selectedRoutine, selected) => {
                            setSelectedRoutineIds((current) =>
                              selected
                                ? Array.from(new Set([...current, selectedRoutine.id]))
                                : current.filter((id) => id !== selectedRoutine.id)
                            );
                          }}
                          extraMenuItems={
                            <MoveToMenu
                              folders={routineFolders?.folders ?? []}
                              currentFolderId={routine.folderId ?? null}
                              onMove={(folderId) => {
                                const previousFolderId = routine.folderId ?? null;
                                moveRoutineToFolder.mutate({ itemId: routine.id, folderId });
                                pushToast({
                                  title: "Routine moved",
                                  body: folderId
                                    ? `Moved "${routine.title}" to ${routineFolders?.folders.find((folder) => folder.id === folderId)?.name ?? "folder"}.`
                                    : `Moved "${routine.title}" to Unfiled.`,
                                  tone: "success",
                                  action: {
                                    label: "Undo",
                                    onClick: () => moveRoutineToFolder.mutate({ itemId: routine.id, folderId: previousFolderId }),
                                  },
                                });
                              }}
                              onCreateAndMove={() => openCreateFolder([routine.id])}
                            />
                          }
                        />
                      ))}
                    </CollapsibleContent>
                  </Collapsible>
                );
              })}
            </div>
          )}
          </div>
        </div>

      <FolderFormDialog
        open={folderDialogOpen}
        kind="routine"
        folder={folderDialogTarget}
        pending={createFolder.isPending || updateFolder.isPending}
        onOpenChange={setFolderDialogOpen}
        onSubmit={(payload) => {
          if (folderDialogTarget) updateFolder.mutate({ folderId: folderDialogTarget.id, payload });
          else createFolder.mutate(payload);
        }}
      />
      <DeleteFolderDialog
        open={deleteFolderTarget !== null}
        folder={deleteFolderTarget}
        itemLabelPlural="routines"
        pending={deleteFolder.isPending}
        onOpenChange={(open) => {
          if (!open) setDeleteFolderTarget(null);
        }}
        onConfirm={() => {
          if (deleteFolderTarget) deleteFolder.mutate(deleteFolderTarget.id);
        }}
      />
      <MobileFolderSheet
        open={mobileFoldersOpen}
        onOpenChange={setMobileFoldersOpen}
        result={railFolderResult}
        selection={folderSelection}
        allLabel="All routines"
        itemLabelPlural="Routines"
        onSelect={setFolderSelection}
        onCreate={() => openCreateFolder()}
      />

      <RoutineRunVariablesDialog
        open={runDialogRoutine !== null}
        onOpenChange={(next) => {
          if (!next) setRunDialogRoutine(null);
        }}
        companyId={selectedCompanyId}
        routineName={runDialogRoutine?.title ?? null}
        agents={agents ?? []}
        projects={projects ?? []}
        defaultProjectId={runDialogRoutine?.projectId ?? null}
        defaultAssigneeAgentId={runDialogRoutine?.assigneeAgentId ?? null}
        variables={runDialogRoutine?.variables ?? []}
        isPending={runRoutine.isPending}
        onSubmit={(data) => {
          if (!runDialogRoutine) return;
          runRoutine.mutate({ id: runDialogRoutine.id, data });
        }}
      />
    </div>
  );
}

function FolderIconHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm">
      <Repeat className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="truncate font-medium">{label}</span>
      <span className="text-muted-foreground">{count} routine{count === 1 ? "" : "s"}</span>
    </div>
  );
}
