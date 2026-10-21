# Plan: Goals with their linked work, and routines per project

Status: slices 1 (#345) and 2 (#351) are merged. Slice 3 is in review.

## Context

Two requests share one plan:

1. A project's routines should be configured from the project page: list, create, edit, pause and run them there, with the same actions in the REST API and the `paperclipai` CLI.
2. A goal should show the work that serves it (tasks, routines, projects, agents), and agents, routines and skills should read goals through the REST API, the CLI, runtime tools and the paperclip skill.

In plain words: today a goal is a title in a tree, and a project's routines live on another page. After this plan, a goal page answers "what is being done for this goal, and by whom", and a project page answers "what runs here on a schedule".

### What exists today

| Need | Existing mechanism |
|---|---|
| A routine in a project | `routines.project_id` (indexed with `company_id`), `?projectId=` on `GET /companies/:companyId/routines`, `paperclipai routine list --project-id` |
| The project page list | `ProjectRoutinesSection` on the Configuration tab: lists, pauses or resumes, and runs routines |
| A goal on a task | `issues.goal_id`; a routine's run task gets `routines.goal_id`; a step is a child task and inherits its parent's goal |
| A goal on a routine | `routines.goal_id` (validated by the routine service), but no UI picker and no CLI flag |
| A goal on a project | the `project_goals` join table (many to many); `projects.goal_id` is deprecated |
| A goal's owner | `goals.owner_agent_id` |
| Agent read access | same-company agent keys can call the goal routes, with text capped for agents |

### Gaps

- The project page cannot create or edit a routine: "New routine" leaves for the Routines page, and the rows link to the routine editor.
- The CLI sets `projectId` and `goalId` on a routine only through `--payload-json`.
- The skill's routine reference marks `projectId` as required; the validator has it optional.
- Nothing lists a goal's tasks, routines or agents; there is no `goalId` filter on the task or routine lists and no links endpoint.
- The project page cannot link or unlink a goal: the project form redesign removed the goal field, while `PATCH /projects/:id` and the CLI still take `goalIds`.
- Remote runs reach only the goal list and goal detail through the sandbox callback bridge; runtime tools have no goal tools; the wake payload has no goal.

## Schema decisions

- **Project goals reuse `project_goals`.** A goal linked to a project through `project_goals` is that project's goal. No `goals.project_id` and no new goal level.
- **A goal's agents are derived, not stored.** "Agents linked to a goal" means the goal's owner plus the assignees of its open tasks and its routines. That answers "who works on this goal" without a table that can drift from the work. An explicit agent-to-goal link can come later if a request needs an agent tied to a goal without any work.
- **No skill-to-goal table.** Skills read goals through the API and the CLI; nothing in the request needs a stored link.
- **A step keeps inheriting its parent task's goal.** No `goalId` in the step JSON until a request needs a step to serve a different goal from its run.
- **No links endpoint.** A goal's linked work is composed from the `goalId` list filters and the project list, so it inherits the visibility rules of those lists for agent keys instead of copying them into a new route.
- **The task goal fallback needs no fix.** The projects service keeps the deprecated `projects.goal_id` equal to the first goal in `project_goals`, so the fallback already reads the project's goal.

Result: no migration in any slice. `issues.goal_id` and `routines.goal_id` have no index; the new goal filters always run inside one company, so an index waits until a measured query needs one.

## Slice 1: routines per project (merged in #345)

- **UI.** The New routine composer moves out of the Routines page into a shared `RoutineComposerDialog`. The project section opens it in place with the project chosen and stays on the page after the save. Each row gets an Edit action that opens the same dialog filled from the routine, for the title, instructions, default agent, project, folder and delivery policies, saved with `PATCH /routines/:id` and the routine's revision as `baseRevisionId` so a concurrent edit answers `409`. Triggers, steps, variables and secrets stay in the full routine editor, which the dialog links to.
- **REST.** No change: the list filter, create with `projectId` and the update route already exist and are in the OpenAPI document.
- **CLI.** `--project-id` on `routine create` and `routine update`, merged into the payload.
- **Skill.** `references/routines.md`: `projectId` is optional, and how to list and create a project's routines.
- **Tests.** Component tests for the dialog in both modes and for the project section; a CLI test for the flag; the project routines e2e test extended to create and edit in place.

## Slice 2: goal links and goal pages (merged in #351)

- **Shared.** `goalId` on the routine list query; `goalAgentLinks`, which derives a goal's agents from its owner, open tasks and routines.
- **Server.** `?goalId=` on the task and routine lists (a blank `goalId` counts as not set; a task list `goalId` that is not a UUID answers `400`, like the routine list). No links endpoint (see Schema decisions).
- **UI.** Open tasks, Routines and Agents tabs on the goal page next to Sub-Goals and Projects; the Routines tab creates a routine for the goal in place. A goal picker in the routine composer, for a new routine and an edit. A Goals section on the project's Configuration tab: each goal the project serves, with the project's open tasks and routines for it and their agents, and link and unlink in place.
- **CLI.** `goal links <id>`, `goal progress`, and `--goal-id` on `issue list`, `routine list`, `routine create` and `routine update` (`none` clears a routine's goal).
- **OpenAPI and docs.** The `goalId` filters in the OpenAPI document, `docs/api/` and `doc/CLI.md`; a new last section, "A goal's linked work", in the skill's API reference, with its row in the runner capability inventory.

## Slice 3: agents read goals

- **Sandbox callback bridge: reads only.** The bridge admits the goal focus and progress reads, next to the goal list and goal detail that it already admitted. The task and routine lists with `goalId` already pass. Goal writes (create and update) do not pass the bridge, even where the REST API lets the same agent write. Admitting them is a separate decision, because it widens what a remote run can change.
- **Runtime tools: none added.** Native runtime agents call the API through the OpenAPI document, which lists the goal reads and the `goalId` filters. MCP has the goal list and goal detail tools, `goalId` on the issue list tool, and the generic API request tool for the focus, the progress and a goal's routines.
- **Wake payload.** The task's own goal (id and title) in the wake issue summary, read inside the run's company and cut like every goal text an agent reads. The wake text shows it on one line, `- issue goal: <title> (goal id <id>)`, only when the task has a goal. A wake without a goal leaves out the key, so its text and its JSON copy do not change. A chat wake shows no goal.
- **Skill.** The "A goal's linked work" section of the API reference tells an agent how to read its task's goal, the focus and the progress, and how to link new work with `goalId` on task and routine writes, within its existing permissions. No CLI change: the CLI already reads goals, the focus and the progress.

## Coordination

Shared files (`server/src/routes/openapi.ts`, the project page, the paperclip skill, the heartbeat wake context) are announced to the sessions working on policies, datasets and routine steps before they are edited. Each slice is its own branch from current `origin/main`.
