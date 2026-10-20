# Project access control for users and agents

Status: phase 1 in progress. Contract: `doc/SPEC-implementation.md` §9.12.

## Goal

A company owner can restrict a project to chosen principals. Users and agents use the same rows and the same checks. Anyone who can read the project can see who can reach it and why, in the UI, the REST API and the CLI.

## Design

- One flag per project: `projects.access_mode` (`company` | `restricted`). The mode is a real column. It is never inferred from "has rows", because removing the last row would silently reopen the project.
- One table, `project_principal_access`, with one row per allowed user or agent. Rows carry no roles: the company role and grants still decide what a principal may do, so project access can only narrow.
- Implicit access, computed and never stored: the local operator, instance admins (not cloud tenants), company owners/admins, the lead agent, and the current issue assignee (that issue only).
- One gate inside `authorization.decide`, after `decideBase` and the responsible-user intersection. Every allow branch passes through it. It checks the acting principal directly (agent or user), so autonomous agent runs without a responsible user are covered too.
- Managing access is limited to company owner/admin board users. Agents never manage access.

## Phases

1. **Model and view (this change).** Schema, effective-access view (UI section, `GET /projects/:id/access`, `paperclipai project access list`), mode and list management, activity entries, and the gate in `shadow` behind `PAPERCLIP_PROJECT_ACCESS_MODE` (default `off`). The UI labels restricted mode "Not enforced yet".
2. **Enforce on single resources and the runtime together.** Projects, issues, routines, workspaces and documents; wake, heartbeat and routine dispatch skip or refuse work an agent cannot reach. Both ship in one change so an agent is never woken for work it cannot read. Assignment to a principal without access is refused in `assignmentPolicyEffect`. Decide 404 vs 403 for denied reads and align the existing `assertProjectReadAllowed` call sites.
3. **Enforce on aggregate paths.** One batched `accessibleProjectIds(actor, companyId)` per request, pushed into SQL `WHERE` clauses of issue lists, search, sidebar, dashboard, activity, costs, inbox and the context injected into agent prompts. Post-filtering would break pagination.

Only after phase 3 does `PAPERCLIP_PROJECT_ACCESS_MODE` accept `enforce`.

## Follow-ups

- Remove access-list rows when a member is removed or an agent is terminated. Stale rows grant nothing today, because company membership is checked first and the access view omits them. But a re-added member would regain the old entry.
- Review shadow logs on a real instance before enabling enforcement.
