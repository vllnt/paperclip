import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RoutineListItem } from "@paperclipai/shared";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { routinesApi } from "../api/routines";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { RoutineComposerDialog } from "./RoutineComposerDialog";
import { RoutineListRow, nextRoutineStatus, type RoutineListAgentSummary, type RoutineListProjectSummary } from "./RoutineList";
import { routineDetailHref } from "./RoutineContextualSidebar";
import { RoutineRunVariablesDialog, type RoutineRunDialogSubmitData } from "./RoutineRunVariablesDialog";

export interface ProjectRoutinesSectionProps {
  companyId: string;
  projectId: string;
  /** Off for an archived project: the New routine composer cannot choose it. */
  canCreate?: boolean;
}

/**
 * The project Configuration tab's routines: list, create, edit, pause and run the routines that
 * belong to this project without leaving the page. Archived routines stay hidden until the viewer
 * asks for them.
 */
export function ProjectRoutinesSection({ companyId, projectId, canCreate = true }: ProjectRoutinesSectionProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [showArchived, setShowArchived] = useState(false);
  const [runDialogRoutine, setRunDialogRoutine] = useState<RoutineListItem | null>(null);
  const [runningRoutineId, setRunningRoutineId] = useState<string | null>(null);
  const [statusMutationRoutineId, setStatusMutationRoutineId] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  // Kept after close so the dialog keeps its content while it animates out.
  const [editingRoutine, setEditingRoutine] = useState<RoutineListItem | null>(null);

  const routinesQuery = useQuery({
    queryKey: queryKeys.routines.list(companyId, { projectId }),
    queryFn: () => routinesApi.list(companyId, { projectId }),
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(companyId, { includeArchived: true }),
    queryFn: () => projectsApi.list(companyId, { includeArchived: true }),
  });

  const routines = routinesQuery.data ?? [];
  const archivedCount = routines.filter((routine) => routine.status === "archived").length;
  const visibleRoutines = showArchived ? routines : routines.filter((routine) => routine.status !== "archived");
  const agentById = useMemo(
    () => new Map<string, RoutineListAgentSummary>((agents ?? []).map((agent) => [agent.id, agent])),
    [agents],
  );
  const projectById = useMemo(
    () => new Map<string, RoutineListProjectSummary>((projects ?? []).map((project) => [project.id, project])),
    [projects],
  );

  const invalidateRoutine = (routineId: string) =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.routines.all(companyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routineId) }),
    ]);

  const updateRoutineStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => routinesApi.update(id, { status }),
    onMutate: ({ id }) => setStatusMutationRoutineId(id),
    onSuccess: (_, { id }) => invalidateRoutine(id),
    onSettled: () => setStatusMutationRoutineId(null),
    onError: (mutationError) => {
      pushToast({
        title: "Failed to update routine",
        body: mutationError instanceof Error ? mutationError.message : "Paperclip could not update the routine.",
        tone: "error",
      });
    },
  });

  const runRoutine = useMutation({
    mutationFn: ({ id, data }: { id: string; data: RoutineRunDialogSubmitData }) => routinesApi.run(id, {
      ...(data.variables && Object.keys(data.variables).length > 0 ? { variables: data.variables } : {}),
      ...(data.assigneeAgentId !== undefined ? { assigneeAgentId: data.assigneeAgentId } : {}),
      ...(data.projectId !== undefined ? { projectId: data.projectId } : {}),
      ...(data.executionWorkspaceId !== undefined ? { executionWorkspaceId: data.executionWorkspaceId } : {}),
      ...(data.executionWorkspacePreference !== undefined
        ? { executionWorkspacePreference: data.executionWorkspacePreference }
        : {}),
      ...(data.executionWorkspaceSettings !== undefined
        ? { executionWorkspaceSettings: data.executionWorkspaceSettings }
        : {}),
    }),
    onMutate: ({ id }) => setRunningRoutineId(id),
    onSuccess: (_, { id }) => {
      setRunDialogRoutine(null);
      return invalidateRoutine(id);
    },
    onSettled: () => setRunningRoutineId(null),
    onError: (mutationError) => {
      pushToast({
        title: "Routine run failed",
        body: mutationError instanceof Error ? mutationError.message : "Paperclip could not start the routine run.",
        tone: "error",
      });
    },
  });

  function handleToggleEnabled(routine: RoutineListItem, enabled: boolean) {
    if (!enabled && !routine.assigneeAgentId) {
      pushToast({
        title: "Default agent required",
        body: "Set a default agent before enabling routine automation.",
        tone: "warn",
      });
      return;
    }
    updateRoutineStatus.mutate({ id: routine.id, status: nextRoutineStatus(routine.status, !enabled) });
  }

  const newRoutineButton = canCreate ? (
    <Button size="sm" variant="outline" onClick={() => setComposerOpen(true)}>
      <Plus className="h-3.5 w-3.5" />
      New routine
    </Button>
  ) : null;

  function openEditor(routine: RoutineListItem) {
    setEditingRoutine(routine);
    setEditorOpen(true);
  }

  return (
    <section className="space-y-3" aria-labelledby="project-routines-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="project-routines-heading" className="text-xs text-muted-foreground">Routines</h3>
        <div className="flex items-center gap-2">
          {archivedCount > 0 ? (
            <Button size="sm" variant="ghost" onClick={() => setShowArchived((current) => !current)}>
              {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
            </Button>
          ) : null}
          {visibleRoutines.length > 0 ? newRoutineButton : null}
        </div>
      </div>

      {routinesQuery.error ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
          <span>Failed to load routines: {routinesQuery.error.message}</span>
          <Button size="sm" variant="outline" onClick={() => void routinesQuery.refetch()}>
            Retry
          </Button>
        </div>
      ) : null}

      {routinesQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading routines...</p>
      ) : !routinesQuery.data ? null : visibleRoutines.length === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-border px-3 py-4 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>{archivedCount > 0 ? "Only archived routines in this project." : "No routines in this project yet."}</span>
          {newRoutineButton}
        </div>
      ) : (
        <div className="rounded-lg border border-border">
          {visibleRoutines.map((routine) => (
            <RoutineListRow
              key={routine.id}
              routine={routine}
              projectById={projectById}
              agentById={agentById}
              runningRoutineId={runningRoutineId}
              statusMutationRoutineId={statusMutationRoutineId}
              href={routineDetailHref(routine.id)}
              onRunNow={setRunDialogRoutine}
              onToggleEnabled={handleToggleEnabled}
              onEdit={openEditor}
            />
          ))}
        </div>
      )}

      <RoutineComposerDialog
        companyId={companyId}
        open={composerOpen}
        onOpenChange={setComposerOpen}
        initialDraft={{ projectId }}
        afterCreate="stay"
      />
      <RoutineComposerDialog
        companyId={companyId}
        open={editorOpen}
        onOpenChange={setEditorOpen}
        routine={editingRoutine}
      />

      <RoutineRunVariablesDialog
        open={runDialogRoutine !== null}
        onOpenChange={(next) => {
          if (!next) setRunDialogRoutine(null);
        }}
        companyId={companyId}
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
    </section>
  );
}
