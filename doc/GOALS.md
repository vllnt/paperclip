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

**Only the board writes the focus**, because every agent reads it on every run. Agents, plugins
and the onboarding seed pushed with an agent key get 403 when they:

- set `kind` to `milestone`, or set `horizon`, `targetDate` or `successCriteria`, on a new or
  existing goal;
- change or delete a goal with the short horizon, in any status, or a milestone.

They can still create, edit and delete other goals, and clear a planning field on a goal
outside the focus. A plugin's `ctx.goals.create` carries no planning fields at all. Paperclip
Cloud pushes the onboarding seed as the board.

Agents see the focus in two places:

- `companyFocus` in `GET /api/issues/{issueId}/heartbeat-context`: the focus goals with their
  progress, days left, success criteria and open milestones, a short `guidance` text, and
  `issueFocusGoalId`, which says whether the current task serves the focus.
- `GET /api/agents/me/inbox-lite` lists critical tasks first (an incident outranks the
  focus), then tasks that serve a focus goal, then the rest. Each task has `focusGoalId`. The
  order inside each group does not change.

**With no focus, nothing changes.** The heartbeat context has no `companyFocus` key, its `goal`
block has only the keys it had before planning fields, and the inbox keeps its order with no
`focusGoalId`. The task's `goal` block adds `kind` only for a milestone, and `horizon`,
`targetDate` and `successCriteria` only when set.

**The focus is small.** At most 10 focus goals and 5 milestones each are listed. Goal titles,
milestone titles and `successCriteria` are cut to 280 characters in what agents receive, so the
whole `companyFocus` holds at most about 30,000 characters of text. JSON escaping can make it
longer for text full of quotes or control characters, and only the board writes that text. A
goal title can be at most 2,000 characters, the length of a company mission.

The guidance tells agents to work the focus first, finish and land work in review before
starting new work, and ask the board through an approval if the focus needs more agents, runs
or budget. Agents never change their own limits.

**The focus is advice.** If it cannot be read within 500 ms, or the read fails, agents get
their normal context and order, as if no focus were set.

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
| REST | `GET/POST /api/companies/{id}/goals`, `PATCH/DELETE /api/goals/{id}`, `GET /api/companies/{id}/goals/focus`, `GET /api/companies/{id}/goals/progress` |
| CLI | `goal create/update --kind --horizon --target-date --success-criteria` (board only), `goal focus` |
| Agents | `companyFocus` in the heartbeat context, focus-first inbox |
| Web | Current focus panel and planning details on the Goals page, planning fields in goal properties and the New Goal dialog |

## Not yet

- A time-boxed "focus push" that reallocates agents, runs and routines with one board
  approval and undoes it at the deadline.
- A success metric that Paperclip measures itself, such as open pull requests from linked PRs.
