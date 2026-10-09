import { useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { GOAL_STATUSES, GOAL_LEVELS, GOAL_HORIZONS, GOAL_TEXT_MAX_LENGTH, type GoalHorizon } from "@paperclipai/shared";
import { GOAL_HORIZON_LABELS } from "../lib/goal-dates";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { goalsApi } from "../api/goals";
import { assetsApi } from "../api/assets";
import { queryKeys } from "../lib/queryKeys";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Maximize2,
  Minimize2,
  Target,
  Layers,
  Flag,
  Clock,
} from "lucide-react";
import { cn } from "../lib/utils";
import { MarkdownEditor, type MarkdownEditorRef } from "./MarkdownEditor";
import { StatusBadge } from "./StatusBadge";

const levelLabels: Record<string, string> = {
  company: "Organization",
  team: "Team",
  agent: "Agent",
  task: "Task",
};

export function NewGoalDialog() {
  const { newGoalOpen, newGoalDefaults, closeNewGoal } = useDialog();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState("planned");
  const [level, setLevel] = useState("task");
  const [parentId, setParentId] = useState("");
  const [isMilestone, setIsMilestone] = useState(false);
  const [horizon, setHorizon] = useState<GoalHorizon | null>(null);
  const [targetDate, setTargetDate] = useState("");
  const [horizonOpen, setHorizonOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const [statusOpen, setStatusOpen] = useState(false);
  const [levelOpen, setLevelOpen] = useState(false);
  const [parentOpen, setParentOpen] = useState(false);
  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);

  // Apply defaults when dialog opens
  const appliedParentId = parentId || newGoalDefaults.parentId || "";

  const { data: goals } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && newGoalOpen,
  });

  const createGoal = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      goalsApi.create(selectedCompanyId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.goals.list(selectedCompanyId!) });
      reset();
      closeNewGoal();
    },
    onError: (error: Error) => {
      pushToast({ title: "Goal not created", body: error.message, tone: "error" });
    },
  });

  const uploadDescriptionImage = useMutation({
    mutationFn: async (file: File) => {
      if (!selectedCompanyId) throw new Error("No organization selected");
      return assetsApi.uploadImage(selectedCompanyId, file, "goals/drafts");
    },
  });

  function reset() {
    setTitle("");
    setDescription("");
    setStatus("planned");
    setLevel("task");
    setParentId("");
    setIsMilestone(false);
    setHorizon(null);
    setTargetDate("");
    setExpanded(false);
  }

  function handleSubmit() {
    if (!selectedCompanyId || !title.trim()) return;
    createGoal.mutate({
      title: title.trim(),
      description: description.trim() || undefined,
      status,
      level,
      ...(appliedParentId ? { parentId: appliedParentId } : {}),
      kind: isMilestone ? "milestone" : "goal",
      ...(horizon ? { horizon } : {}),
      ...(targetDate ? { targetDate } : {}),
    });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }

  const currentParent = (goals ?? []).find((g) => g.id === appliedParentId);

  return (
    <Dialog
      open={newGoalOpen}
      onOpenChange={(open) => {
        if (!open) {
          reset();
          closeNewGoal();
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className={cn("p-0 gap-0", expanded ? "sm:max-w-2xl" : "sm:max-w-lg")}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {selectedCompany && (
              <span className="bg-muted px-1.5 py-0.5 rounded text-xs font-medium">
                {selectedCompany.issuePrefix}
              </span>
            )}
            <span className="text-muted-foreground/60">&rsaquo;</span>
            <span>{newGoalDefaults.parentId ? "New sub-goal" : "New goal"}</span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              onClick={() => { reset(); closeNewGoal(); }}
            >
              <span className="text-lg leading-none">&times;</span>
            </Button>
          </div>
        </div>

        {/* Title */}
        <div className="px-4 pt-4 pb-2 shrink-0">
          <input
            className="w-full text-lg font-semibold bg-transparent outline-none placeholder:text-muted-foreground/50"
            placeholder="Goal title"
            maxLength={GOAL_TEXT_MAX_LENGTH}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Tab" && !e.shiftKey) {
                e.preventDefault();
                descriptionEditorRef.current?.focus();
              }
            }}
            autoFocus
          />
        </div>

        {/* Description */}
        <div className="px-4 pb-2 overflow-y-auto max-h-(--sz-50vh)">
          <MarkdownEditor
            ref={descriptionEditorRef}
            value={description}
            onChange={setDescription}
            placeholder="Add description..."
            bordered={false}
            contentClassName={cn("text-sm text-muted-foreground", expanded ? "min-h-(--sz-220px)" : "min-h-(--sz-120px)")}
            imageUploadHandler={async (file) => {
              const asset = await uploadDescriptionImage.mutateAsync(file);
              return asset.contentPath;
            }}
          />
        </div>

        {/* Property chips */}
        <div className="flex items-center gap-1.5 px-4 py-2 border-t border-border flex-wrap">
          {/* Status */}
          <Popover open={statusOpen} onOpenChange={setStatusOpen}>
            <PopoverTrigger asChild>
              <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors">
                <StatusBadge status={status} />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-40 p-1" align="start">
              {GOAL_STATUSES.map((s) => (
                <button
                  key={s}
                  className={cn(
                    "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 capitalize",
                    s === status && "bg-accent"
                  )}
                  onClick={() => { setStatus(s); setStatusOpen(false); }}
                >
                  {s}
                </button>
              ))}
            </PopoverContent>
          </Popover>

          {/* Level */}
          <Popover open={levelOpen} onOpenChange={setLevelOpen}>
            <PopoverTrigger asChild>
              <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors">
                <Layers className="h-3 w-3 text-muted-foreground" />
                {levelLabels[level] ?? level}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-40 p-1" align="start">
              {GOAL_LEVELS.map((l) => (
                <button
                  key={l}
                  className={cn(
                    "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                    l === level && "bg-accent"
                  )}
                  onClick={() => { setLevel(l); setLevelOpen(false); }}
                >
                  {levelLabels[l] ?? l}
                </button>
              ))}
            </PopoverContent>
          </Popover>

          {/* Milestone */}
          <button
            type="button"
            aria-pressed={isMilestone}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors",
              isMilestone && "bg-accent",
            )}
            onClick={() => setIsMilestone(!isMilestone)}
          >
            <Flag className="h-3 w-3 text-muted-foreground" />
            Milestone
          </button>

          {/* Horizon */}
          <Popover open={horizonOpen} onOpenChange={setHorizonOpen}>
            <PopoverTrigger asChild>
              <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors">
                <Clock className="h-3 w-3 text-muted-foreground" />
                {horizon ? GOAL_HORIZON_LABELS[horizon] : "Horizon"}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-40 p-1" align="start">
              {[...GOAL_HORIZONS, null].map((h) => (
                <button
                  key={h ?? "none"}
                  className={cn(
                    "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                    h === horizon && "bg-accent"
                  )}
                  onClick={() => { setHorizon(h); setHorizonOpen(false); }}
                >
                  {h ? GOAL_HORIZON_LABELS[h] : "No horizon"}
                </button>
              ))}
            </PopoverContent>
          </Popover>

          {/* Target date */}
          <input
            type="date"
            aria-label="Target date"
            className="h-7 rounded-md border border-border bg-background px-2 text-xs"
            value={targetDate}
            onChange={(e) => setTargetDate(e.target.value)}
          />

          {/* Parent goal */}
          <Popover open={parentOpen} onOpenChange={setParentOpen}>
            <PopoverTrigger asChild>
              <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors">
                <Target className="h-3 w-3 text-muted-foreground" />
                {currentParent ? currentParent.title : "Parent goal"}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-48 p-1" align="start">
              <button
                className={cn(
                  "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                  !appliedParentId && "bg-accent"
                )}
                onClick={() => { setParentId(""); setParentOpen(false); }}
              >
                No parent
              </button>
              {(goals ?? []).map((g) => (
                <button
                  key={g.id}
                  className={cn(
                    "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 truncate",
                    g.id === appliedParentId && "bg-accent"
                  )}
                  onClick={() => { setParentId(g.id); setParentOpen(false); }}
                >
                  {g.title}
                </button>
              ))}
            </PopoverContent>
          </Popover>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end px-4 py-2.5 border-t border-border">
          <Button
            size="sm"
            disabled={!title.trim() || createGoal.isPending}
            onClick={handleSubmit}
          >
            {createGoal.isPending ? "Creating…" : newGoalDefaults.parentId ? "Create sub-goal" : "Create goal"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
