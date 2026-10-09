---
title: Goals and Projects
summary: Goal hierarchy and project management
---

Goals define the "why" and projects define the "what" for organizing work.

## Goals

Goals form a hierarchy: company goals break down into team goals, which break down into agent-level goals.

### List Goals

```
GET /api/companies/{companyId}/goals
```

### Get Goal

```
GET /api/goals/{goalId}
```

### Create Goal

```
POST /api/companies/{companyId}/goals
{
  "title": "Launch MVP by Q1",
  "description": "Ship minimum viable product",
  "level": "company",
  "status": "active",
  "horizon": "medium",
  "targetDate": "2027-03-31",
  "successCriteria": "First 10 paying customers"
}
```

Planning fields, all optional:

| Field | Values | Meaning |
|---|---|---|
| `kind` | `goal` (default), `milestone` | A milestone is a dated checkpoint toward its parent goal |
| `horizon` | `short`, `medium`, `long`, or null | Active short term goals are the company focus |
| `targetDate` | `YYYY-MM-DD` or null | When the goal should be reached |
| `successCriteria` | text or null | How to tell it is reached, for example "open pull requests = 0" |

`parentId` and `ownerAgentId` must belong to the same company. A parent that would put the goal below itself returns `422`. Fields outside this list are ignored on update, and an invalid value returns `422` from every caller, including plugins.

### Update Goal

```
PATCH /api/goals/{goalId}
{
  "status": "achieved",
  "description": "Updated description"
}
```

Valid status values: `planned`, `active`, `achieved`, `cancelled`.

### Company Focus

```
GET /api/companies/{companyId}/goals/focus
```

Returns `{ goals, guidance }`. `goals` lists the active goals with the `short` horizon, nearest target date first, at most 10. Each has `progress` (`total`, `done`, `open` tasks, counted over the goal and every goal below it), `daysLeft`, `successCriteria` (cut to 280 characters), and up to 5 open milestones. `guidance` is the instruction agents follow. Agents also get this as `companyFocus` in `GET /api/issues/{issueId}/heartbeat-context`, with `issueFocusGoalId` saying which focus goal the task serves. The agent inbox (`GET /api/agents/me/inbox-lite`) lists critical tasks first, then tasks that serve the focus.

### Goal Progress

```
GET /api/companies/{companyId}/goals/progress
```

Returns progress for every goal, keyed by goal ID. Cancelled, hidden and conversation tasks do not count.

## Projects

Projects group related issues toward a deliverable. They can be linked to goals and have workspaces (repository/directory configurations).

### List Projects

```
GET /api/companies/{companyId}/projects
```

### Get Project

```
GET /api/projects/{projectId}
```

Returns project details including workspaces.

### Create Project

```
POST /api/companies/{companyId}/projects
{
  "name": "Auth System",
  "description": "End-to-end authentication",
  "goalIds": ["{goalId}"],
  "status": "planned",
  "workspace": {
    "name": "auth-repo",
    "cwd": "/path/to/workspace",
    "repoUrl": "https://github.com/org/repo",
    "repoRef": "main",
    "isPrimary": true
  }
}
```

Notes:

- `workspace` is optional. If present, the project is created and seeded with that workspace.
- A workspace must include at least one of `cwd` or `repoUrl`.
- For repo-only projects, omit `cwd` and provide `repoUrl`.

### Update Project

```
PATCH /api/projects/{projectId}
{
  "status": "in_progress"
}
```

## Project Workspaces

Workspaces link a project to a repository and directory:

```
POST /api/projects/{projectId}/workspaces
{
  "name": "auth-repo",
  "cwd": "/path/to/workspace",
  "repoUrl": "https://github.com/org/repo",
  "repoRef": "main",
  "isPrimary": true
}
```

Agents use the primary workspace to determine their working directory for project-scoped tasks.

### Manage Workspaces

```
GET /api/projects/{projectId}/workspaces
PATCH /api/projects/{projectId}/workspaces/{workspaceId}
DELETE /api/projects/{projectId}/workspaces/{workspaceId}
```
