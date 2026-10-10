import type { RankableCommandAction } from "./command-action-rank.js";

/**
 * The board's launcher actions as data: one list for the command palette,
 * the keyboard chords and the shortcut cheatsheet. It holds no UI code, so
 * the server and the CLI can read it too.
 */

export const COMMAND_ACTION_GROUPS = ["navigate", "create", "general", "contextual"] as const;
export type CommandActionGroup = (typeof COMMAND_ACTION_GROUPS)[number];

/**
 * What an action does. `navigate` paths are company-relative (the UI router
 * adds the company prefix). `ui` actions run a client handler, for example
 * opening a dialog.
 */
export type CommandActionOperation =
  | { kind: "navigate"; path: string }
  | { kind: "ui" };

export interface CommandActionDefinition extends RankableCommandAction {
  group: CommandActionGroup;
  /**
   * Keys pressed one after another, e.g. `["g", "d"]`. Contextual actions run
   * their shortcut only on the page that registers them.
   */
  shortcut?: readonly string[];
  operation: CommandActionOperation;
}

function navigate(
  id: string,
  title: string,
  path: string,
  chordKey: string | null,
  keywords: readonly string[] = [],
): CommandActionDefinition {
  return {
    id,
    title,
    keywords,
    group: "navigate",
    ...(chordKey ? { shortcut: ["g", chordKey] } : {}),
    operation: { kind: "navigate", path },
  };
}

function uiAction(
  id: string,
  title: string,
  group: CommandActionGroup,
  shortcut: readonly string[] | null,
  keywords: readonly string[] = [],
): CommandActionDefinition {
  return {
    id,
    title,
    keywords,
    group,
    ...(shortcut ? { shortcut } : {}),
    operation: { kind: "ui" },
  };
}

/** Every launcher action, in the order the palette lists ties. */
export const COMMAND_ACTIONS: readonly CommandActionDefinition[] = [
  navigate("nav.dashboard", "Dashboard", "/dashboard", "d", ["home", "overview", "live runs"]),
  navigate("nav.inbox", "Inbox", "/inbox", "i", ["my work", "notifications", "unread"]),
  navigate("nav.tasks", "Tasks", "/issues", "t", ["issues", "tickets", "board", "kanban"]),
  navigate("nav.projects", "Projects", "/projects", "p"),
  navigate("nav.goals", "Goals", "/goals", "o", ["objectives", "okr"]),
  navigate("nav.agents", "Agents", "/agents", "a", ["team", "employees", "org", "bots"]),
  navigate("nav.routines", "Routines", "/routines", "r", ["schedules", "recurring", "automations"]),
  navigate("nav.approvals", "Approvals", "/approvals", "v", ["review", "pending", "governance"]),
  navigate("nav.activity", "Activity", "/activity", "e", ["audit", "log", "history", "events"]),
  navigate("nav.costs", "Costs", "/costs", "m", ["spend", "budget", "money", "usage", "billing"]),
  navigate("nav.skills", "Skills", "/skills", "k", ["capabilities", "tools"]),
  navigate("nav.settings", "Company settings", "/company/settings", "s", ["preferences", "configuration", "members"]),
  navigate("nav.apps", "Connectors", "/apps", null, ["apps", "integrations", "connections"]),
  navigate("nav.companies", "Companies", "/companies", null, ["switch company", "organizations"]),
  uiAction("create.task", "Create new task", "create", ["c"], ["create", "issue", "ticket", "add"]),
  uiAction("create.project", "Create new project", "create", null, ["create", "add"]),
  uiAction("create.goal", "Create new goal", "create", null, ["create", "objective", "add"]),
  uiAction("create.agent", "Create new agent", "create", null, ["create", "hire", "add"]),
  uiAction("ui.toggle-sidebar", "Toggle sidebar", "general", ["["], ["hide", "show", "navigation"]),
  uiAction("ui.toggle-panel", "Toggle properties panel", "general", ["]"], ["hide", "show", "details"]),
  uiAction("ui.shortcuts", "Keyboard shortcuts", "general", ["?"], ["help", "keys", "cheatsheet", "hotkeys"]),
  uiAction("issue.focus-comment", "Comment on this task", "contextual", ["g", "c"], ["reply", "write", "composer"]),
  uiAction("issue.open-file", "Open file in this issue", "contextual", ["g", "f"], ["file viewer", "workspace"]),
  uiAction("issue.archive-from-inbox", "Archive from inbox", "contextual", ["y"], ["done", "dismiss"]),
];

/** Looks up an action by id. */
export function findCommandAction(id: string): CommandActionDefinition | undefined {
  return COMMAND_ACTIONS.find((action) => action.id === id);
}

/**
 * Maps the second key of each `g` chord to its action id, e.g. `d` to
 * `nav.dashboard`.
 */
export function commandActionGoChords(
  actions: readonly CommandActionDefinition[] = COMMAND_ACTIONS,
): ReadonlyMap<string, string> {
  const chords = new Map<string, string>();
  for (const action of actions) {
    const [first, second, ...rest] = action.shortcut ?? [];
    if (first === "g" && second && rest.length === 0) chords.set(second, action.id);
  }
  return chords;
}
