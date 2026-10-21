import { useEffect, useState } from "react";
import { useParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { goalsApi } from "../api/goals";
import { projectsApi } from "../api/projects";
import { assetsApi } from "../api/assets";
import { issuesApi } from "../api/issues";
import { routinesApi } from "../api/routines";
import { agentsApi } from "../api/agents";
import { usePanel } from "../context/PanelContext";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { GoalProperties } from "../components/GoalProperties";
import { GoalTree } from "../components/GoalTree";
import { StatusBadge } from "../components/StatusBadge";
import { InlineEditor } from "../components/InlineEditor";
import { EntityRow } from "../components/EntityRow";
import { PageSkeleton } from "../components/PageSkeleton";
import { routineDetailHref } from "../components/RoutineContextualSidebar";
import { RoutineComposerDialog } from "../components/RoutineComposerDialog";
import { agentUrl, cn, issueUrl, projectUrl } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus, SlidersHorizontal } from "lucide-react";
import {
  GOAL_TEXT_MAX_LENGTH,
  OPEN_ISSUE_STATUSES,
  goalAgentLinks,
  type Goal,
  type GoalAgentReason,
  type Project,
} from "@paperclipai/shared";

const goalAgentReasonLabels: Record<GoalAgentReason, string> = {
  owner: "Owner",
  task: "Open tasks",
  routine: "Routines",
};

interface GoalPropertiesToggleButtonProps {
  panelVisible: boolean;
  onShowProperties: () => void;
}

export function GoalPropertiesToggleButton({
  panelVisible,
  onShowProperties,
}: GoalPropertiesToggleButtonProps) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className={cn(
        "hidden md:inline-flex shrink-0 transition-opacity duration-200",
        panelVisible ? "opacity-0 pointer-events-none w-0 overflow-hidden" : "opacity-100",
      )}
      onClick={onShowProperties}
      title="Show properties"
    >
      <SlidersHorizontal className="h-4 w-4" />
    </Button>
  );
}

export function GoalDetail() {
  const { goalId } = useParams<{ goalId: string }>();
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { openNewGoal } = useDialogActions();
  const { openPanel, closePanel, panelVisible, setPanelVisible } = usePanel();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [composerOpen, setComposerOpen] = useState(false);

  const {
    data: goal,
    isLoading,
    error
  } = useQuery({
    queryKey: queryKeys.goals.detail(goalId!),
    queryFn: () => goalsApi.get(goalId!),
    enabled: !!goalId
  });
  const resolvedCompanyId = goal?.companyId ?? selectedCompanyId;

  const { data: allGoals } = useQuery({
    queryKey: queryKeys.goals.list(resolvedCompanyId!),
    queryFn: () => goalsApi.list(resolvedCompanyId!),
    enabled: !!resolvedCompanyId
  });

  const { data: allProjects } = useQuery({
    queryKey: queryKeys.projects.list(resolvedCompanyId!, { includeArchived: true }),
    queryFn: () => projectsApi.list(resolvedCompanyId!, { includeArchived: true }),
    enabled: !!resolvedCompanyId
  });

  // Linked work reads the goal's own tasks and routines; sub-goals keep theirs on their own page.
  const linkedWorkEnabled = !!resolvedCompanyId && !!goalId;
  const { data: openTasks } = useQuery({
    queryKey: queryKeys.issues.listOpenByGoal(resolvedCompanyId!, goalId!),
    queryFn: () => issuesApi.listAll(resolvedCompanyId!, { goalId: goalId!, status: OPEN_ISSUE_STATUSES.join(",") }),
    enabled: linkedWorkEnabled
  });

  const { data: goalRoutines } = useQuery({
    queryKey: queryKeys.routines.list(resolvedCompanyId!, { goalId }),
    queryFn: () => routinesApi.list(resolvedCompanyId!, { goalId }),
    enabled: linkedWorkEnabled
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(resolvedCompanyId!),
    queryFn: () => agentsApi.list(resolvedCompanyId!),
    enabled: !!resolvedCompanyId
  });

  useEffect(() => {
    if (!goal?.companyId || goal.companyId === selectedCompanyId) return;
    setSelectedCompanyId(goal.companyId, { source: "route_sync" });
  }, [goal?.companyId, selectedCompanyId, setSelectedCompanyId]);

  const updateGoal = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      goalsApi.update(goalId!, data),
    onError: (error: Error) => {
      pushToast({ title: "Goal not saved", body: error.message, tone: "error" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.goals.detail(goalId!)
      });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.goals.list(resolvedCompanyId)
        });
      }
    }
  });

  const uploadImage = useMutation({
    mutationFn: async (file: File) => {
      if (!resolvedCompanyId) throw new Error("No organization selected");
      return assetsApi.uploadImage(
        resolvedCompanyId,
        file,
        `goals/${goalId ?? "draft"}`
      );
    }
  });

  const childGoals = (allGoals ?? []).filter((g) => g.parentId === goalId);
  const linkedProjects = (allProjects ?? []).filter((p) => {
    if (!goalId) return false;
    if (p.goalIds.includes(goalId)) return true;
    if (p.goals.some((goalRef) => goalRef.id === goalId)) return true;
    return p.goalId === goalId;
  });
  const agentById = new Map((agents ?? []).map((agent) => [agent.id, agent]));
  const linkedAgents = goalAgentLinks({
    ownerAgentId: goal?.ownerAgentId ?? null,
    tasks: openTasks ?? [],
    routines: goalRoutines ?? [],
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Goals", href: "/goals" },
      { label: goal?.title ?? goalId ?? "Goal" }
    ]);
  }, [setBreadcrumbs, goal, goalId]);

  useEffect(() => {
    if (goal) {
      openPanel(
        <GoalProperties
          goal={goal}
          onUpdate={(data) => updateGoal.mutateAsync(data)}
        />
      );
    }
    return () => closePanel();
  }, [goal]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!goal) return null;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase text-muted-foreground">
            {goal.level}
          </span>
          <StatusBadge status={goal.status} />
          <div className="ml-auto">
            <GoalPropertiesToggleButton
              panelVisible={panelVisible}
              onShowProperties={() => setPanelVisible(true)}
            />
          </div>
        </div>

        <InlineEditor
          value={goal.title}
          onSave={(title) => updateGoal.mutate({ title })}
          maxLength={GOAL_TEXT_MAX_LENGTH}
          as="h2"
          className="text-xl font-bold"
        />

        <InlineEditor
          value={goal.description ?? ""}
          onSave={(description) => updateGoal.mutate({ description })}
          as="p"
          className="text-sm text-muted-foreground"
          placeholder="Add a description..."
          multiline
          imageUploadHandler={async (file) => {
            const asset = await uploadImage.mutateAsync(file);
            return asset.contentPath;
          }}
        />
      </div>

      <Tabs defaultValue="children">
        <TabsList>
          <TabsTrigger value="children">
            Sub-Goals ({childGoals.length})
          </TabsTrigger>
          <TabsTrigger value="projects">
            Projects ({linkedProjects.length})
          </TabsTrigger>
          <TabsTrigger value="tasks">
            Open tasks ({openTasks?.length ?? 0})
          </TabsTrigger>
          <TabsTrigger value="routines">
            Routines ({goalRoutines?.length ?? 0})
          </TabsTrigger>
          <TabsTrigger value="agents">
            Agents ({linkedAgents.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="children" className="mt-4 space-y-3">
          <div className="flex items-center justify-start">
            <Button
              size="sm"
              variant="outline"
              onClick={() => openNewGoal({ parentId: goalId })}
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              Sub Goal
            </Button>
          </div>
          {childGoals.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sub-goals.</p>
          ) : (
            <GoalTree goals={childGoals} goalLink={(g) => `/goals/${g.id}`} />
          )}
        </TabsContent>

        <TabsContent value="projects" className="mt-4">
          {linkedProjects.length === 0 ? (
            <p className="text-sm text-muted-foreground">No linked projects.</p>
          ) : (
            <div className="border border-border">
              {linkedProjects.map((project) => (
                <EntityRow
                  key={project.id}
                  title={project.name}
                  subtitle={project.description ?? undefined}
                  to={projectUrl(project)}
                  trailing={<StatusBadge status={project.status} />}
                />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="tasks" className="mt-4">
          {(openTasks ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No open tasks for this goal.</p>
          ) : (
            <div className="border border-border">
              {(openTasks ?? []).map((task) => (
                <EntityRow
                  key={task.id}
                  identifier={task.identifier ?? undefined}
                  title={task.title}
                  subtitle={task.assigneeAgentId ? agentById.get(task.assigneeAgentId)?.name : undefined}
                  to={issueUrl(task)}
                  trailing={<StatusBadge status={task.status} />}
                />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="routines" className="mt-4 space-y-3">
          <div className="flex items-center justify-start">
            <Button size="sm" variant="outline" onClick={() => setComposerOpen(true)}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              Routine
            </Button>
          </div>
          {(goalRoutines ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No routines for this goal.</p>
          ) : (
            <div className="border border-border">
              {(goalRoutines ?? []).map((routine) => (
                <EntityRow
                  key={routine.id}
                  title={routine.title}
                  subtitle={routine.assigneeAgentId ? agentById.get(routine.assigneeAgentId)?.name : undefined}
                  to={routineDetailHref(routine.id)}
                  trailing={<StatusBadge status={routine.status} />}
                />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="agents" className="mt-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            The goal's owner, and the agents of its open tasks and routines.
          </p>
          {linkedAgents.length === 0 ? (
            <p className="text-sm text-muted-foreground">No agents work on this goal yet.</p>
          ) : (
            <div className="border border-border">
              {linkedAgents.map((link) => {
                const agent = agentById.get(link.agentId);
                return (
                  <EntityRow
                    key={link.agentId}
                    title={agent?.name ?? link.agentId}
                    subtitle={link.reasons.map((reason) => goalAgentReasonLabels[reason]).join(" · ")}
                    to={agent ? agentUrl(agent) : undefined}
                    trailing={agent ? <StatusBadge status={agent.status} /> : undefined}
                  />
                );
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>

      <RoutineComposerDialog
        companyId={goal.companyId}
        open={composerOpen}
        onOpenChange={setComposerOpen}
        initialDraft={{ goalId: goal.id }}
        afterCreate="stay"
      />
    </div>
  );
}
