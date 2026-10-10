import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Archive,
  Bot,
  Boxes,
  Building2,
  CircleDot,
  Command,
  DollarSign,
  FileCode2,
  Hexagon,
  History,
  Inbox,
  Keyboard,
  LayoutDashboard,
  MessageSquare,
  PanelLeft,
  PanelRight,
  Plus,
  Repeat,
  Search,
  Settings,
  ShieldCheck,
  SquarePen,
  Target,
  Unplug,
  type LucideIcon,
} from "lucide-react";
import { COMMAND_ACTIONS } from "@paperclipai/shared/command-actions";
import type { CommandActionBinding, CommandActionBindings } from "../context/CommandActionsContext";
import { useDialogActions } from "../context/DialogContext";
import { useCombinedInboxTasksEnabled } from "../hooks/useCombinedInboxTasksEnabled";
import { useStreamlinedUiEnabled } from "../hooks/useStreamlinedUiEnabled";
import { instanceSettingsApi } from "../api/instanceSettings";
import { queryKeys } from "./queryKeys";
import { useNavigate } from "./router";

const COMMAND_ACTION_ICONS: Readonly<Record<string, LucideIcon>> = {
  "nav.dashboard": LayoutDashboard,
  "nav.inbox": Inbox,
  "nav.tasks": CircleDot,
  "nav.projects": Hexagon,
  "nav.goals": Target,
  "nav.agents": Bot,
  "nav.routines": Repeat,
  "nav.approvals": ShieldCheck,
  "nav.activity": History,
  "nav.costs": DollarSign,
  "nav.skills": Boxes,
  "nav.settings": Settings,
  "nav.search": Search,
  "nav.apps": Unplug,
  "nav.companies": Building2,
  "create.task": SquarePen,
  "create.project": Plus,
  "create.goal": Plus,
  "create.agent": Plus,
  "ui.toggle-sidebar": PanelLeft,
  "ui.toggle-panel": PanelRight,
  "ui.shortcuts": Keyboard,
  "issue.focus-comment": MessageSquare,
  "issue.open-file": FileCode2,
  "issue.archive-from-inbox": Archive,
};

export function commandActionIcon(actionId: string): LucideIcon {
  return COMMAND_ACTION_ICONS[actionId] ?? Command;
}

interface GlobalCommandActionHandlers {
  onToggleSidebar: () => void;
  onTogglePanel: () => void;
  onShowShortcuts: () => void;
}

/**
 * Handlers for the catalog's global actions: navigation, the create dialogs
 * and the layout toggles. Contextual actions are registered by their pages.
 *
 * Every navigation target is routed in both layout shells. The one gate is
 * Connectors, which the legacy shell's sidebar shows only with `enableApps`;
 * the launcher follows it. Goals stays listed whatever the sidebar-link flag
 * says, as in the previous palette, because the route always exists.
 */
export function useGlobalCommandActionBindings({
  onToggleSidebar,
  onTogglePanel,
  onShowShortcuts,
}: GlobalCommandActionHandlers): CommandActionBindings {
  const navigate = useNavigate();
  const { openNewIssue, openNewProject, openNewGoal, openNewAgent } = useDialogActions();
  const { enabled: combinedInboxTasksEnabled } = useCombinedInboxTasksEnabled();
  const { enabled: streamlinedUiEnabled } = useStreamlinedUiEnabled();
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    retry: false,
  });
  const showApps = streamlinedUiEnabled || experimentalSettings?.enableApps === true;

  return useMemo(() => {
    const bindings: Record<string, CommandActionBinding> = {};
    for (const action of COMMAND_ACTIONS) {
      if (action.operation.kind !== "navigate") continue;
      const path = action.operation.path;
      bindings[action.id] = { run: () => navigate(path) };
    }
    if (!showApps) delete bindings["nav.apps"];
    if (combinedInboxTasksEnabled) {
      bindings["nav.inbox"] = { run: () => navigate("/issues?view=mine"), title: "My work" };
    }
    bindings["create.task"] = { run: () => openNewIssue() };
    bindings["create.project"] = { run: () => openNewProject() };
    bindings["create.goal"] = { run: () => openNewGoal() };
    bindings["create.agent"] = { run: () => openNewAgent() };
    bindings["ui.toggle-sidebar"] = { run: onToggleSidebar };
    bindings["ui.toggle-panel"] = { run: onTogglePanel };
    bindings["ui.shortcuts"] = { run: onShowShortcuts };
    return bindings;
  }, [
    combinedInboxTasksEnabled,
    navigate,
    onShowShortcuts,
    onTogglePanel,
    onToggleSidebar,
    openNewAgent,
    openNewGoal,
    openNewIssue,
    openNewProject,
    showApps,
  ]);
}
