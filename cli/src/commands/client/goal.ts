import { Command } from "commander";
import type { Agent, CompanyFocus, Goal, GoalAgentLink, GoalProgress, Issue, Project, RoutineListItem } from "@paperclipai/shared";
import { OPEN_ISSUE_STATUSES, createGoalSchema, goalAgentLinks, updateGoalSchema } from "@paperclipai/shared";
import type { PaperclipApiClient } from "../../client/http.js";
import {
  addCommonClientOptions,
  apiPath,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

/** The work linked to one goal, as `goal links` prints it. */
export interface GoalLinks {
  goal: Goal;
  progress: GoalProgress | null;
  projects: Array<Pick<Project, "id" | "name" | "status">>;
  tasks: Array<Pick<Issue, "id" | "identifier" | "title" | "status" | "assigneeAgentId">>;
  routines: Array<Pick<RoutineListItem, "id" | "title" | "status" | "assigneeAgentId" | "projectId">>;
  agents: Array<GoalAgentLink & { name: string | null }>;
}

const TASK_PAGE_SIZE = 500;

interface GoalListOptions extends BaseClientOptions {
  companyId?: string;
}

interface GoalPlanningOptions {
  kind?: string;
  horizon?: string;
  targetDate?: string;
  successCriteria?: string;
}

interface GoalCreateOptions extends BaseClientOptions, GoalPlanningOptions {
  companyId?: string;
  title: string;
  description?: string;
  level?: string;
  status?: string;
  parentId?: string;
  ownerAgentId?: string;
}

interface GoalUpdateOptions extends BaseClientOptions, GoalPlanningOptions {
  title?: string;
  description?: string;
  level?: string;
  status?: string;
  parentId?: string;
  ownerAgentId?: string;
}

interface GoalDeleteOptions extends BaseClientOptions {
  yes?: boolean;
}

export function registerGoalCommands(program: Command): void {
  const goal = program.command("goal").description("Goal operations");

  addCommonClientOptions(
    goal
      .command("list")
      .description("List goals for a company")
      .option("-C, --company-id <id>", "Company ID")
      .action(async (opts: GoalListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<Goal[]>(apiPath`/api/companies/${ctx.companyId}/goals`)) ?? [];
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          if (rows.length === 0) {
            printOutput([], { json: false });
            return;
          }
          for (const row of rows) {
            console.log(formatInlineRecord({
              id: row.id,
              status: row.status,
              title: row.title,
              level: row.level,
              parentId: row.parentId,
              ownerAgentId: row.ownerAgentId,
            }));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    goal
      .command("get")
      .description("Get one goal")
      .argument("<goalId>", "Goal ID")
      .action(async (goalId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<Goal>(apiPath`/api/goals/${goalId}`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    goal
      .command("create")
      .description("Create a goal")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--title <title>", "Goal title, at most 280 characters")
      .option("--description <text>", "Goal description")
      .option("--level <level>", "Goal level")
      .option("--status <status>", "Goal status")
      .option("--parent-id <id>", "Parent goal ID")
      .option("--owner-agent-id <id>", "Owner agent ID")
      .option("--kind <kind>", "goal or milestone; board only")
      .option("--horizon <horizon>", "short, medium or long; short term goals are the company focus; board only")
      .option("--target-date <YYYY-MM-DD>", "Target date; board only")
      .option("--success-criteria <text>", "How to tell the goal is reached, at most 280 characters; board only")
      .action(async (opts: GoalCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload = createGoalSchema.parse({
            title: opts.title,
            description: opts.description,
            level: opts.level,
            status: opts.status,
            parentId: parseNullableString(opts.parentId),
            ownerAgentId: parseNullableString(opts.ownerAgentId),
            kind: opts.kind,
            horizon: parseNullableString(opts.horizon),
            targetDate: parseNullableString(opts.targetDate),
            successCriteria: parseNullableString(opts.successCriteria),
          });
          const created = await ctx.api.post<Goal>(apiPath`/api/companies/${ctx.companyId}/goals`, payload);
          printOutput(created, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    goal
      .command("update")
      .description("Update a goal. Only the board can change a short term goal or a milestone")
      .argument("<goalId>", "Goal ID")
      .option("--title <title>", "Goal title, at most 280 characters")
      .option("--description <text|null>", "Goal description")
      .option("--level <level>", "Goal level")
      .option("--status <status>", "Goal status")
      .option("--parent-id <id|null>", "Parent goal ID")
      .option("--owner-agent-id <id|null>", "Owner agent ID")
      .option("--kind <kind>", "goal or milestone; board only")
      .option("--horizon <horizon|null>", "short, medium or long; short term goals are the company focus; board only")
      .option("--target-date <YYYY-MM-DD|null>", "Target date; board only")
      .option("--success-criteria <text|null>", "How to tell the goal is reached, at most 280 characters; board only")
      .action(async (goalId: string, opts: GoalUpdateOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = updateGoalSchema.parse({
            title: opts.title,
            description: parseNullableString(opts.description),
            level: opts.level,
            status: opts.status,
            parentId: parseNullableString(opts.parentId),
            ownerAgentId: parseNullableString(opts.ownerAgentId),
            kind: opts.kind,
            horizon: parseNullableString(opts.horizon),
            targetDate: parseNullableString(opts.targetDate),
            successCriteria: parseNullableString(opts.successCriteria),
          });
          const updated = await ctx.api.patch<Goal>(apiPath`/api/goals/${goalId}`, payload);
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    goal
      .command("focus")
      .description("Show the company focus: active short term goals, their progress and milestones")
      .option("-C, --company-id <id>", "Company ID")
      .action(async (opts: GoalListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const focus = await ctx.api.get<CompanyFocus>(apiPath`/api/companies/${ctx.companyId}/goals/focus`);
          if (ctx.json || !focus) printOutput(focus, { json: ctx.json });
          else printFocus(focus);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    goal
      .command("progress")
      .description("Show each goal's task progress: tasks linked to the goal or a goal below it")
      .option("-C, --company-id <id>", "Company ID")
      .action(async (opts: GoalListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const [progress, goals] = await Promise.all([
            ctx.api.get<Record<string, GoalProgress>>(apiPath`/api/companies/${ctx.companyId}/goals/progress`),
            ctx.api.get<Goal[]>(apiPath`/api/companies/${ctx.companyId}/goals`),
          ]);
          if (ctx.json) {
            printOutput(progress ?? {}, { json: true });
            return;
          }
          for (const row of goals ?? []) {
            const counts = progress?.[row.id];
            if (!counts) continue;
            console.log(formatInlineRecord({ id: row.id, title: row.title, done: counts.done, open: counts.open, total: counts.total }));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    goal
      .command("links")
      .description("Show the work linked to a goal: its projects, open tasks, routines and agents. Sub-goals are not included")
      .argument("<goalId>", "Goal ID")
      .action(async (goalId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const links = await readGoalLinks(ctx.api, goalId);
          if (ctx.json) printOutput(links, { json: true });
          else printLinks(links);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    goal
      .command("delete")
      .description("Delete a goal. Only the board can delete a short term goal or a milestone")
      .argument("<goalId>", "Goal ID")
      .option("--yes", "Confirm deletion")
      .action(async (goalId: string, opts: GoalDeleteOptions) => {
        try {
          if (!opts.yes) throw new Error("Deletion requires --yes.");
          const ctx = resolveCommandContext(opts);
          const deleted = await ctx.api.delete<Goal>(apiPath`/api/goals/${goalId}`);
          printOutput(deleted, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function describeDue(daysLeft: number | null): string {
  if (daysLeft === null) return "no date";
  if (daysLeft === 0) return "due today";
  const days = Math.abs(daysLeft);
  const unit = days === 1 ? "day" : "days";
  return daysLeft > 0 ? `${days} ${unit} left` : `${days} ${unit} overdue`;
}

function printFocus(focus: CompanyFocus): void {
  if (focus.goals.length === 0) {
    console.log("No company focus. Give an active goal the short horizon to set one.");
    return;
  }
  for (const item of focus.goals) {
    console.log(`${item.title}  (${item.progress.done}/${item.progress.total} done, ${describeDue(item.daysLeft)})  ${item.id}`);
    if (item.successCriteria) console.log(`  Target: ${item.successCriteria}`);
    for (const milestone of item.milestones) {
      console.log(`  - ${milestone.title}  (${milestone.progress.done}/${milestone.progress.total} done, ${describeDue(milestone.daysLeft)})`);
    }
  }
  console.log("");
  console.log(focus.guidance);
}

async function listOpenGoalTasks(api: PaperclipApiClient, companyId: string, goalId: string): Promise<Issue[]> {
  const tasks: Issue[] = [];
  let afterId: string | undefined;
  for (;;) {
    const params = new URLSearchParams({
      goalId,
      status: OPEN_ISSUE_STATUSES.join(","),
      limit: String(TASK_PAGE_SIZE),
      sortField: "id",
      sortDir: "asc",
    });
    if (afterId) params.set("afterId", afterId);
    const page = (await api.get<Issue[]>(`${apiPath`/api/companies/${companyId}/issues`}?${params}`)) ?? [];
    tasks.push(...page);
    const last = page.at(-1);
    // The server drops rows the caller may not see after it applies the page limit, so a short page
    // is not the last one. An empty page ends the read: a caller with narrow access can still miss
    // rows behind a full page of rows it may not see, until the list returns its raw cursor.
    if (!last) return tasks;
    afterId = last.id;
  }
}

/**
 * Reads the work linked to a goal from the list APIs, so the caller sees only what its own access
 * allows: projects that link the goal, open tasks and routines (not archived) whose own goal it is, and the agents
 * that `goalAgentLinks` derives from them.
 * @param api The API client.
 * @param goalId The goal.
 * @returns The goal, its task progress and its linked work.
 */
export async function readGoalLinks(api: PaperclipApiClient, goalId: string): Promise<GoalLinks> {
  const goal = await api.get<Goal>(apiPath`/api/goals/${goalId}`);
  if (!goal) throw new Error(`Goal ${goalId} not found.`);
  const companyId = goal.companyId;
  const [progress, projects, tasks, routines, agents] = await Promise.all([
    api.get<Record<string, GoalProgress>>(apiPath`/api/companies/${companyId}/goals/progress`),
    api.get<Project[]>(apiPath`/api/companies/${companyId}/projects`),
    listOpenGoalTasks(api, companyId, goalId),
    api.get<RoutineListItem[]>(`${apiPath`/api/companies/${companyId}/routines`}?${new URLSearchParams({ goalId })}`),
    api.get<Agent[]>(apiPath`/api/companies/${companyId}/agents`),
  ]);
  const agentNames = new Map((agents ?? []).map((agent) => [agent.id, agent.name]));
  const goalRoutines = (routines ?? []).filter((routine) => routine.status !== "archived");
  return {
    goal,
    progress: progress?.[goalId] ?? null,
    projects: (projects ?? [])
      .filter((project) => project.goalIds.includes(goalId))
      .map(({ id, name, status }) => ({ id, name, status })),
    tasks: tasks.map(({ id, identifier, title, status, assigneeAgentId }) => ({ id, identifier, title, status, assigneeAgentId })),
    routines: goalRoutines.map(({ id, title, status, assigneeAgentId, projectId }) => ({ id, title, status, assigneeAgentId, projectId })),
    agents: goalAgentLinks({ ownerAgentId: goal.ownerAgentId, tasks, routines: goalRoutines })
      .map((link) => ({ ...link, name: agentNames.get(link.agentId) ?? null })),
  };
}

function printLinks(links: GoalLinks): void {
  const { goal, progress } = links;
  const counts = progress ? `  (${progress.done}/${progress.total} done, ${progress.open} open)` : "";
  console.log(`${goal.title}${counts}  ${goal.id}`);
  const sections: Array<[string, string[]]> = [
    ["Projects", links.projects.map((project) => formatInlineRecord(project))],
    ["Open tasks", links.tasks.map((task) => formatInlineRecord(task))],
    ["Routines", links.routines.map((routine) => formatInlineRecord(routine))],
    ["Agents", links.agents.map((agent) => formatInlineRecord({ ...agent, reasons: agent.reasons.join(",") }))],
  ];
  for (const [title, lines] of sections) {
    console.log("");
    console.log(`${title} (${lines.length})`);
    for (const line of lines) console.log(`  ${line}`);
  }
}

function parseNullableString(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value.trim().toLowerCase() === "null" ? null : value;
}
