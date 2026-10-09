# Goals, milestones and the company focus

Goals tell agents and people what the company is working toward, and in what order.
This guide covers the planning fields, milestones, and the company focus that agents read
first.

## The model

A goal is an outcome. A milestone is a dated checkpoint toward its parent goal. Both live in
one tree, so a task linked to a milestone also counts toward every goal above it.

```
Become the best AI control plane        long term
└─ Land all open pull requests          short term, target 2026-10-16, "open PRs = 0"
   ├─ ⚑ Review every open PR            milestone, 2026-10-12
   └─ ⚑ Merge or close every PR         milestone, 2026-10-16
      └─ task PAP-123 Merge PR #45      goalId = this milestone
```

| Field | Values | Meaning |
|---|---|---|
| `kind` | `goal`, `milestone` | A milestone is a checkpoint toward its parent |
| `horizon` | `short`, `medium`, `long`, none | When the goal matters |
| `targetDate` | `YYYY-MM-DD` | When it should be reached |
| `successCriteria` | text | How to tell it is reached |

Link a task to a goal or milestone with the task's `goalId`. Link a project to goals with the
project's `goalIds`, and its new tasks inherit the project's goal.

## The company focus

**Active goals with the short horizon are the company focus.** Make a goal the focus by
setting its horizon to short term and its status to active. Remove it by changing either.

Agents see the focus in two places:

- `companyFocus` in `GET /api/issues/{issueId}/heartbeat-context`: the focus goals with their
  progress, days left, success criteria and open milestones, a short `guidance` text, and
  `issueFocusGoalId`, which says whether the current task serves the focus.
- `GET /api/agents/me/inbox-lite` lists tasks that serve a focus goal first, each with
  `focusGoalId`. The order inside each group does not change.

The guidance tells agents to work the focus first, finish and land work in review before
starting new work, and ask the board through an approval if the focus needs more agents, runs
or budget. Agents never change their own limits.

The focus is advice. If it cannot be read, agents get their normal context and order.

## Progress

Progress counts the tasks linked to a goal or any goal below it. Cancelled, hidden and
conversation tasks do not count. `GET /api/companies/{companyId}/goals/progress` returns it for
every goal; the focus includes it for focus goals and their milestones.

## Example: land all open pull requests this week

```sh
paperclipai goal create -C <company> --title "Land all open pull requests" --level company \
  --status active --horizon short --target-date 2026-10-16 --success-criteria "Open PRs = 0"
paperclipai goal create -C <company> --title "Review every open PR" --kind milestone \
  --status active --parent-id <goal> --target-date 2026-10-12
paperclipai issue update <task> --goal-id <milestone>
paperclipai goal focus -C <company>
```

In the web app: Goals → New Goal, with the Milestone, Horizon and date chips. The Goals page
shows the current focus at the top.

## Surfaces

| | |
|---|---|
| REST | `GET/POST /api/companies/{id}/goals`, `PATCH /api/goals/{id}`, `GET /api/companies/{id}/goals/focus`, `GET /api/companies/{id}/goals/progress` |
| CLI | `goal create/update --kind --horizon --target-date --success-criteria`, `goal focus` |
| Agents | `companyFocus` in the heartbeat context, focus-first inbox |
| Web | Current focus panel and planning details on the Goals page, planning fields in goal properties and the New Goal dialog |

## Not yet

- A time-boxed "focus push" that reallocates agents, runs and routines with one board
  approval and undoes it at the deadline.
- A success metric that Paperclip measures itself, such as open pull requests from linked PRs.
- Limiting who may set the short horizon. Today anyone who may edit goals can, as with other
  goal fields, and each change is in the activity log.
