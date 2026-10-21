import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import type { Routine, RoutineVariable } from "@paperclipai/shared";
import { Link, useNavigate } from "@/lib/router";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { accessApi } from "../api/access";
import { agentsApi } from "../api/agents";
import { ApiError } from "../api/client";
import { foldersApi } from "../api/folders";
import { goalsApi } from "../api/goals";
import { projectsApi } from "../api/projects";
import { routinesApi } from "../api/routines";
import { useToastActions } from "../context/ToastContext";
import { buildMarkdownMentionOptions } from "../lib/company-members";
import { queryKeys } from "../lib/queryKeys";
import { getRecentAssigneeIds, sortAgentsByRecency, trackRecentAssignee } from "../lib/recent-assignees";
import { getRecentProjectIds, trackRecentProject } from "../lib/recent-projects";
import { agentNameMap, stepWarningsToast } from "../lib/routine-step-warnings";
import { InlineEntitySelector, type InlineEntityOption } from "./InlineEntitySelector";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "./MarkdownEditor";
import { routineDetailHref } from "./RoutineContextualSidebar";

const concurrencyPolicies = ["coalesce_if_active", "always_enqueue", "skip_if_active"];
const catchUpPolicies = ["skip_missed", "enqueue_missed_with_cap"];
const concurrencyPolicyDescriptions: Record<string, string> = {
  coalesce_if_active: "If a run is already active, keep just one follow-up run queued.",
  always_enqueue: "Queue every trigger occurrence, even if the routine is already running.",
  skip_if_active: "Drop new trigger occurrences while a run is still active.",
};
const catchUpPolicyDescriptions: Record<string, string> = {
  skip_missed: "Ignore windows that were missed while the scheduler or routine was paused.",
  enqueue_missed_with_cap: "Catch up missed schedule windows after recovery; sub-hourly schedules are combined into one catch-up run, slower schedules replay each missed window up to a cap.",
};

/** The fields the composer edits. Empty strings mean "none" for the project, the goal and the agent. */
export interface RoutineComposerDraft {
  title: string;
  description: string;
  projectId: string;
  goalId: string;
  folderId: string | null;
  assigneeAgentId: string;
  priority: string;
  concurrencyPolicy: string;
  catchUpPolicy: string;
  variables: RoutineVariable[];
}

const emptyRoutineDraft: RoutineComposerDraft = {
  title: "",
  description: "",
  projectId: "",
  goalId: "",
  folderId: null,
  assigneeAgentId: "",
  priority: "medium",
  concurrencyPolicy: "coalesce_if_active",
  catchUpPolicy: "skip_missed",
  variables: [],
};

/**
 * Fields the edit mode sends; triggers, steps, secrets and variable settings stay in the full editor.
 * The server still derives the variable list from the title and instructions, so removing a
 * `{{name}}` from the text removes that variable, as it does in the full editor.
 */
const editableRoutineFields = [
  "title",
  "description",
  "projectId",
  "goalId",
  "folderId",
  "assigneeAgentId",
  "concurrencyPolicy",
  "catchUpPolicy",
] as const;

function autoResizeTextarea(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight}px`;
}

function routineMutationPayload(draft: RoutineComposerDraft) {
  return {
    ...draft,
    description: draft.description.trim() || null,
    projectId: draft.projectId || null,
    goalId: draft.goalId || null,
    folderId: draft.folderId || null,
    assigneeAgentId: draft.assigneeAgentId || null,
  };
}

/**
 * The composer draft of a saved routine.
 * @param routine The routine to edit.
 * @returns Its editable fields, with null project, goal and agent as empty strings.
 */
export function routineComposerDraftFrom(routine: Routine): RoutineComposerDraft {
  return {
    title: routine.title,
    description: routine.description ?? "",
    projectId: routine.projectId ?? "",
    goalId: routine.goalId ?? "",
    folderId: routine.folderId ?? null,
    assigneeAgentId: routine.assigneeAgentId ?? "",
    priority: routine.priority,
    concurrencyPolicy: routine.concurrencyPolicy,
    catchUpPolicy: routine.catchUpPolicy,
    variables: routine.variables ?? [],
  };
}

/**
 * The `PATCH /routines/:id` body for an edit: only the fields that differ from the saved routine, plus
 * the revision the edit started from so a concurrent save answers 409.
 * @param routine The saved routine the dialog opened with.
 * @param draft The edited draft.
 * @returns The patch, or null when nothing changed.
 */
export function routineEditPatch(routine: Routine, draft: RoutineComposerDraft): Record<string, unknown> | null {
  const saved = routineMutationPayload(routineComposerDraftFrom(routine));
  const next = routineMutationPayload(draft);
  const patch: Record<string, unknown> = {};
  for (const field of editableRoutineFields) {
    if (next[field] !== saved[field]) patch[field] = next[field];
  }
  if (Object.keys(patch).length === 0) return null;
  return { ...patch, baseRevisionId: routine.latestRevisionId };
}

export interface RoutineComposerDialogProps {
  companyId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fields a new routine starts with, applied over the unsaved draft each time the dialog opens. */
  initialDraft?: Partial<RoutineComposerDraft>;
  /** Edits this routine instead of creating one; the draft starts from its saved fields on open. */
  routine?: Routine | null;
  /**
   * After a create: `triggers` opens the new routine's trigger setup; `stay` keeps the current page
   * and offers trigger setup in the toast.
   */
  afterCreate?: "triggers" | "stay";
}

/**
 * The routine composer: creates a routine, or edits the work definition of one (title, instructions,
 * default agent, project, folder, goal and delivery policies). The full routine editor keeps triggers,
 * steps, variables and secrets.
 */
export function RoutineComposerDialog({
  companyId,
  open,
  onOpenChange,
  initialDraft,
  routine = null,
  afterCreate = "triggers",
}: RoutineComposerDialogProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToastActions();
  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);
  const titleInputRef = useRef<HTMLTextAreaElement | null>(null);
  const assigneeSelectorRef = useRef<HTMLButtonElement | null>(null);
  const projectSelectorRef = useRef<HTMLButtonElement | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [draft, setDraft] = useState<RoutineComposerDraft>(() => ({ ...emptyRoutineDraft, ...initialDraft }));
  const [seededForOpen, setSeededForOpen] = useState(false);
  if (open !== seededForOpen) {
    setSeededForOpen(open);
    if (open) setDraft((current) => (routine ? routineComposerDraftFrom(routine) : { ...current, ...initialDraft }));
  }

  // A closed composer fetches nothing; the host page usually has these lists cached already.
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: open,
  });
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(companyId, { includeArchived: true }),
    queryFn: () => projectsApi.list(companyId, { includeArchived: true }),
    enabled: open,
  });
  const { data: goals } = useQuery({
    queryKey: queryKeys.goals.list(companyId),
    queryFn: () => goalsApi.list(companyId),
    enabled: open,
  });
  const { data: routineFolders } = useQuery({
    queryKey: queryKeys.folders.list(companyId, "routine"),
    queryFn: () => foldersApi.list(companyId, "routine"),
    enabled: open,
  });
  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId),
    queryFn: () => accessApi.listUserDirectory(companyId),
    enabled: open,
  });

  useEffect(() => {
    autoResizeTextarea(titleInputRef.current);
  }, [draft.title, open]);

  const mentionOptions = useMemo<MentionOption[]>(() => {
    return buildMarkdownMentionOptions({
      agents,
      projects: (projects ?? []).filter((project) => !project.archivedAt),
      members: companyMembers?.users,
    });
  }, [agents, companyMembers?.users, projects]);

  const editPatch = routine ? routineEditPatch(routine, draft) : null;
  const saveRoutine = useMutation({
    mutationFn: () => {
      if (!routine) return routinesApi.create(companyId, routineMutationPayload(draft));
      return routinesApi.update(routine.id, editPatch ?? {});
    },
    onSuccess: async (saved) => {
      // An edit keeps its draft so the closing dialog does not blank out; the next open seeds it again.
      if (!routine) setDraft(emptyRoutineDraft);
      onOpenChange(false);
      setAdvancedOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.all(companyId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(saved.id) }),
      ]);
      if (routine) {
        pushToast({ title: "Routine saved", tone: "success" });
      } else {
        const stay = afterCreate === "stay";
        pushToast({
          title: "Routine created",
          body: saved.assigneeAgentId
            ? "Add the first trigger to turn it into a live workflow."
            : "Draft saved. Add a default agent before enabling automation.",
          tone: "success",
          ...(stay ? { action: { label: "Add a trigger", href: routineDetailHref(saved.id, "triggers") } } : {}),
        });
        if (!stay) navigate(routineDetailHref(saved.id, "triggers"));
      }
      const warningToast = stepWarningsToast(saved.warnings, agentNameMap(agents));
      if (warningToast) pushToast(warningToast);
    },
    onError: (error) => {
      // A 409 means someone saved a newer revision: refresh so reopening the dialog edits that one.
      if (error instanceof ApiError && error.status === 409) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.routines.all(companyId) });
      }
    },
  });
  const resetSave = saveRoutine.reset;
  // The dialog stays mounted between opens, so a closed dialog drops its last save error.
  useEffect(() => {
    if (!open) resetSave();
  }, [open, resetSave]);

  const recentAssigneeIds = useMemo(() => getRecentAssigneeIds(), [open]);
  const recentProjectIds = useMemo(() => getRecentProjectIds(), [open]);
  // An edited routine keeps showing its saved agent, project and goal even when terminated, archived or cancelled.
  const savedAssigneeId = routine?.assigneeAgentId ?? null;
  const savedProjectId = routine?.projectId ?? null;
  const savedGoalId = routine?.goalId ?? null;
  const assigneeOptions = useMemo<InlineEntityOption[]>(
    () =>
      sortAgentsByRecency(
        (agents ?? []).filter((agent) => agent.status !== "terminated" || agent.id === savedAssigneeId),
        recentAssigneeIds,
      ).map((agent) => ({
        id: agent.id,
        label: agent.status === "terminated" ? `${agent.name} (terminated)` : agent.name,
        searchText: `${agent.name} ${agent.role} ${agent.title ?? ""}`,
      })),
    [agents, recentAssigneeIds, savedAssigneeId],
  );
  const projectOptions = useMemo<InlineEntityOption[]>(
    () =>
      (projects ?? []).filter((project) => !project.archivedAt || project.id === savedProjectId).map((project) => ({
        id: project.id,
        label: project.archivedAt ? `${project.name} (archived)` : project.name,
        searchText: project.description ?? "",
      })),
    [projects, savedProjectId],
  );
  const goalOptions = useMemo<InlineEntityOption[]>(
    () =>
      (goals ?? []).filter((goal) => goal.status !== "cancelled" || goal.id === savedGoalId).map((goal) => ({
        id: goal.id,
        label: goal.status === "cancelled" ? `${goal.title} (cancelled)` : goal.title,
        searchText: goal.description ?? "",
      })),
    [goals, savedGoalId],
  );
  const agentById = useMemo(() => new Map((agents ?? []).map((agent) => [agent.id, agent])), [agents]);
  const projectById = useMemo(() => new Map((projects ?? []).map((project) => [project.id, project])), [projects]);
  const currentAssignee = draft.assigneeAgentId ? agentById.get(draft.assigneeAgentId) ?? null : null;
  const currentProject = draft.projectId ? projectById.get(draft.projectId) ?? null : null;
  // A closing dialog cannot save: after an edit its draft still differs from the routine it opened with.
  const canSave = open && !saveRoutine.isPending && Boolean(draft.title.trim()) && (!routine || editPatch !== null);

  function close() {
    onOpenChange(false);
    setAdvancedOpen(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!saveRoutine.isPending) {
          onOpenChange(next);
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex max-h-(--sz-calc-18) max-w-3xl flex-col gap-0 overflow-hidden p-0"
      >
        <div className="shrink-0 flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-5 py-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-(--tracking-caps) text-muted-foreground">
              {routine ? "Edit routine" : "New routine"}
            </p>
            <p className="text-sm text-muted-foreground">
              {routine
                ? "Change the recurring work. Triggers, steps, variables and secrets are in the full editor."
                : "Define the recurring work first. Default project and agent are optional for draft routines."}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={close} disabled={saveRoutine.isPending}>
            Cancel
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="px-5 pt-5 pb-3">
            <textarea
              ref={titleInputRef}
              className="w-full resize-none overflow-hidden bg-transparent text-xl font-semibold outline-none placeholder:text-muted-foreground/50"
              placeholder="Routine title"
              aria-label="Routine title"
              rows={1}
              value={draft.title}
              onChange={(event) => {
                setDraft((current) => ({ ...current, title: event.target.value }));
                autoResizeTextarea(event.target);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  descriptionEditorRef.current?.focus();
                  return;
                }
                if (event.key === "Tab" && !event.shiftKey) {
                  event.preventDefault();
                  if (draft.assigneeAgentId) {
                    if (draft.projectId) {
                      descriptionEditorRef.current?.focus();
                    } else {
                      projectSelectorRef.current?.focus();
                    }
                  } else {
                    assigneeSelectorRef.current?.focus();
                  }
                }
              }}
              autoFocus
            />
          </div>

          <div className="px-5 pb-3">
            <div className="overflow-x-auto overscroll-x-contain">
              <div className="inline-flex min-w-full flex-wrap items-center gap-2 text-sm text-muted-foreground sm:min-w-max sm:flex-nowrap">
                <span>For</span>
                <InlineEntitySelector
                  ref={assigneeSelectorRef}
                  value={draft.assigneeAgentId}
                  options={assigneeOptions}
                  recentOptionIds={recentAssigneeIds}
                  placeholder="Responsible"
                  noneLabel="No responsible"
                  searchPlaceholder="Search responsible..."
                  emptyMessage="No responsible found."
                  onChange={(assigneeAgentId) => {
                    if (assigneeAgentId) trackRecentAssignee(assigneeAgentId);
                    setDraft((current) => ({ ...current, assigneeAgentId }));
                  }}
                  onConfirm={() => {
                    if (draft.projectId) {
                      descriptionEditorRef.current?.focus();
                    } else {
                      projectSelectorRef.current?.focus();
                    }
                  }}
                  renderTriggerValue={(option) =>
                    option ? (
                      currentAssignee ? (
                        <>
                          <AgentAvatar agent={currentAssignee} size={16} className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/>
                          <span className="truncate">{option.label}</span>
                        </>
                      ) : (
                        <span className="truncate">{option.label}</span>
                      )
                    ) : (
                      <span className="text-muted-foreground">Responsible</span>
                    )
                  }
                  renderOption={(option) => {
                    if (!option.id) return <span className="truncate">{option.label}</span>;
                    const assignee = agentById.get(option.id);
                    return (
                      <>
                        {assignee ? <AgentAvatar agent={assignee} size={16} className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/> : null}
                        <span className="truncate">{option.label}</span>
                      </>
                    );
                  }}
                />
                <span>in</span>
                <InlineEntitySelector
                  ref={projectSelectorRef}
                  value={draft.projectId}
                  options={projectOptions}
                  recentOptionIds={recentProjectIds}
                  placeholder="Project"
                  noneLabel="No project"
                  searchPlaceholder="Search projects..."
                  emptyMessage="No projects found."
                  onChange={(projectId) => {
                    if (projectId) trackRecentProject(projectId);
                    setDraft((current) => ({ ...current, projectId }));
                  }}
                  onConfirm={() => descriptionEditorRef.current?.focus()}
                  renderTriggerValue={(option) =>
                    option && currentProject ? (
                      <>
                        <span
                          className="h-3.5 w-3.5 shrink-0 rounded-sm"
                          style={{ backgroundColor: currentProject.color ?? "var(--project-none)" }}
                        />
                        <span className="truncate">{option.label}</span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">Project</span>
                    )
                  }
                  renderOption={(option) => {
                    if (!option.id) return <span className="truncate">{option.label}</span>;
                    const project = projectById.get(option.id);
                    return (
                      <>
                        <span
                          className="h-3.5 w-3.5 shrink-0 rounded-sm"
                          style={{ backgroundColor: project?.color ?? "var(--project-none)" }}
                        />
                        <span className="truncate">{option.label}</span>
                      </>
                    );
                  }}
                />
                <span>filed in</span>
                <Select
                  value={draft.folderId ?? "__unfiled"}
                  onValueChange={(value) => setDraft((current) => ({
                    ...current,
                    folderId: value === "__unfiled" ? null : value,
                  }))}
                >
                  <SelectTrigger className="h-8 w-auto min-w-32 border-0 bg-muted/50 px-2 shadow-none">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__unfiled">Unfiled</SelectItem>
                    {(routineFolders?.folders ?? []).map((folder) => (
                      <SelectItem key={folder.id} value={folder.id}>
                        {folder.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span>toward</span>
                <InlineEntitySelector
                  value={draft.goalId}
                  options={goalOptions}
                  placeholder="Goal"
                  noneLabel="No goal"
                  searchPlaceholder="Search goals..."
                  emptyMessage="No goals found."
                  onChange={(goalId) => setDraft((current) => ({ ...current, goalId }))}
                  onConfirm={() => descriptionEditorRef.current?.focus()}
                />
              </div>
            </div>
          </div>

          <div className="border-t border-border/60 px-5 py-4">
            <MarkdownEditor
              ref={descriptionEditorRef}
              value={draft.description}
              onChange={(description) => setDraft((current) => ({ ...current, description }))}
              placeholder="Add instructions..."
              bordered={false}
              contentClassName="min-h-(--sz-160px) text-sm text-muted-foreground"
              mentions={mentionOptions}
              onSubmit={() => {
                if (canSave && draft.projectId && draft.assigneeAgentId) {
                  saveRoutine.mutate();
                }
              }}
            />
          </div>

          <div className="border-t border-border/60 px-5 py-3">
            <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
              <CollapsibleTrigger className="flex w-full items-center justify-between text-left">
                <div>
                  <p className="text-sm font-medium">Advanced delivery settings</p>
                  <p className="text-sm text-muted-foreground">Keep policy controls secondary to the work definition.</p>
                </div>
                {advancedOpen ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-3">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <p className="text-xs font-medium uppercase tracking-(--tracking-caps) text-muted-foreground">Concurrency</p>
                    <Select
                      value={draft.concurrencyPolicy}
                      onValueChange={(concurrencyPolicy) => setDraft((current) => ({ ...current, concurrencyPolicy }))}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {concurrencyPolicies.map((value) => (
                          <SelectItem key={value} value={value}>{value.replaceAll("_", " ")}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">{concurrencyPolicyDescriptions[draft.concurrencyPolicy]}</p>
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs font-medium uppercase tracking-(--tracking-caps) text-muted-foreground">Catch-up</p>
                    <Select
                      value={draft.catchUpPolicy}
                      onValueChange={(catchUpPolicy) => setDraft((current) => ({ ...current, catchUpPolicy }))}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {catchUpPolicies.map((value) => (
                          <SelectItem key={value} value={value}>{value.replaceAll("_", " ")}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">{catchUpPolicyDescriptions[draft.catchUpPolicy]}</p>
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        </div>

        <div className="shrink-0 flex flex-col gap-3 border-t border-border/60 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm text-muted-foreground">
            {routine ? (
              <Link to={routineDetailHref(routine.id)} className="underline underline-offset-2 hover:text-foreground">
                Open the full editor
              </Link>
            ) : afterCreate === "stay" ? (
              "Add triggers after creation. Draft routines stay paused until you add a default agent."
            ) : (
              "After creation, Paperclip takes you straight to trigger setup. Draft routines stay paused until you add a default agent."
            )}
          </div>
          <div className="flex flex-col gap-2 sm:items-end">
            <Button onClick={() => saveRoutine.mutate()} disabled={!canSave}>
              {routine ? null : <Plus className="mr-2 h-4 w-4" />}
              {saveRoutine.isPending
                ? routine ? "Saving..." : "Creating..."
                : routine ? "Save changes" : "Create routine"}
            </Button>
            {saveRoutine.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {saveRoutine.error instanceof ApiError && saveRoutine.error.status === 409 && routine
                  ? "Someone else saved this routine. Cancel and reopen it to edit the latest version."
                  : saveRoutine.error instanceof Error
                    ? saveRoutine.error.message
                    : routine ? "Failed to save routine" : "Failed to create routine"}
              </p>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
