# Merged navigation: Agents + Chats, Decisions + Inbox, Dashboard + Status

Date: 2026-10-10
Status: proposal for user choice; docs only
Verified base: `origin/main` at `d9804ac4fbd8c277933d112be0b688715ba23594`

This is a sibling plan to #116. It does not
change that pull request. The plan extends the existing Agent Chat contract in
[`doc/plans/2026-09-10-agent-chat.md`](2026-09-10-agent-chat.md) and composes the
existing attention, dashboard, status-card, and sidebar primitives. It does not
add a second chat store, attention feed, org tree, or card system.

## 0. Verified overlap table

The table is the boundary for implementation. A slice may add a composed shell,
route, adapter, or migration only where the table says that the existing
primitive cannot express the behavior.

| Slice | Reused primitive and verified anchor on `origin/main` | Dependency | Proposed flag (default off) | Web surface | API and OpenAPI surface | CLI surface | Migration | Upstream conflict handling |
|---|---|---|---|---|---|---|---|---|
| A. Agents + Chats | Agent routes and tabs (`ui/src/App.tsx:281-292`, `ui/src/pages/agent-detail-navigation.ts:18-63`); the existing `filterOrgTree` and embedded `OrgChart` org view (`ui/src/pages/Agents.tsx:174-192,557-560`); the `AgentConversationsSidebar` wrapper and searchable `AgentConversationSidebar` (`ui/src/components/AgentConversationsSidebar.tsx:19-59`, `ui/src/components/AgentConversationSidebar.tsx:30-56`); `ContextualSidebarFrame` for contextual shells (`ui/src/components/ContextualSidebarFrame.tsx:13-68`); issue-backed identity and unique company/agent/user key (`packages/db/src/schema/issues.ts:31-36,95-104`). | Existing Agent Chat implementation and #116 Workroom boundary. Routines agent-tab work must land in the same workspace contract. | `enableMergedAgentWorkspace` | One agent tree and one agent workspace. Chat is the default pane. Settings and later Routines are tabs in that workspace. `/chats` and `/chats/:agentRef` redirect to the canonical agent route when enabled. | Existing chat, agent, run, and settings endpoints remain authoritative. Add only unread/session metadata endpoints if Q1-Q2 select them. Add every new operation to OpenAPI. | No new chat command. Reuse existing agent/chat commands. Add only selected unread/session inspection commands if the API adds them. | No conversation-table rewrite. If unread state is selected, add a company/user/agent read cursor with the next migration number assigned just in time. | Compose a new workspace shell. Touch route declarations only once. Rebase after #116, #95, #110, and the Routines tab owner land. Do not fork `AgentChat` or `AgentConversationsSidebar`. |
| B. Decisions + Inbox | Attention source kinds (`server/src/services/attention.ts:69-81`) and endpoint (`server/src/routes/attention.ts:18-55`); Decisions route (`ui/src/App.tsx:441-442`); Inbox routes and existing combined flag (`ui/src/App.tsx:443-465`, `:150-152`); local read keys (`ui/src/lib/inbox.ts:22-24`); server dismiss/snooze route (`server/src/routes/inbox-dismissals.ts:48-73`). | #116 Decisions path; #109 dismissal semantics; existing inbox dismissal rows. Decide the fate of `enableCombinedInboxTasks` before implementation. | `enableUnifiedAttention` | One Inbox page with `Needs you` and `Updates` lanes. Decision queues become filters. Existing Inbox and Decisions URLs redirect into stable filters. | Extend the attention feed with Inbox kinds and add per-user read-state endpoints if selected. Preserve company access, board checks, dismissal/snooze behavior, and OpenAPI descriptions. | Build on the Decisions CLI commands planned by #116. Add only the attention/inbox read-state commands required for parity. Do not implement a second decision command set. | Move read state from local storage to a company/user table only if selected. Keep `inbox_dismissals` semantics. Assign the migration number just in time; no historical read backfill is required by default. | Prefer an attention adapter and composed lane view. Do not rewrite `WhatNeedsMe` and `Inbox` together. Rebase after #116, #109, #95, and #110. Keep the old feed available while the flag is off. |
| C. Dashboard + Status | Dashboard route and summary queries (`ui/src/App.tsx:155-157`, `ui/src/pages/Dashboard.tsx:73-172`); Status route and card UI (`ui/src/App.tsx:343-349`, `ui/src/pages/StatusCards/index.tsx:21-103`); `enableStatusCards` catalog flag (`packages/shared/src/feature-catalog.ts:195-201`); status-card API and existing status-card migrations. | Full observability plan (`doc/plans/2026-10-09-full-observability.md`) owns usage and cost placement. #110 owns route migration order. | `enableDashboardStatusCards` | Dashboard is a card grid. Existing metric cards remain built-in cards. Status cards become another card kind. `/status` and `/status/:cardId` redirect to the dashboard card route when enabled. | Reuse dashboard summary and status-card endpoints. Add a card-kind/read-model endpoint only if composition cannot use existing responses. Document it in OpenAPI. | Reuse the existing `dashboard get` command. The current CLI has no status-card command, so add status-card CRUD/refresh commands with parity tests if C1 exposes those operations as part of the merged surface. Add a card-kind command only if a new API is added. | No data merge by default. Keep `status_cards` and dashboard facts in their existing tables. Assign any index or read-model migration just in time. | Add a card-grid shell around existing components. Do not move cost facts out of their owners. Rebase after #110, #87, and #48. Keep Status independently disableable. |
| Cross-cutting navigation | Both shells exist: `ui/src/components/Sidebar.tsx` and `ui/src/components/Sidebar.production.tsx`; `ui/src/App.tsx:885-887` selects the shell. Existing `SidebarSection`, `SidebarNavItem`, and contextual sidebar patterns are the composition points. | Launcher #95/#86, Next.js migration #110, black-and-white theme #48, instant-loading/route-splitting work (#68), and the Routines tab owner. | Each merge has its own flag. Do not add a global `enableMergedNavigation` switch. | One sidebar row per selected merge. Preserve direct links and keyboard navigation. Keep Conference Room separate. | Every behavior that changes server state has a REST and OpenAPI contract. | Every API capability has a matching CLI operation or an explicit documented reason that it is UI-only. | Add only data required by the selected behavior. Route changes do not require a data migration. | The route owner lands the merge once in the Next.js plan. Shell changes use shared primitives and are ported to both sidebar files in the same slice. |

The anchors above were re-read from the verified base. The open plans are
referenced as public dependencies, not treated as code already present in
`origin/main`: #116 is open, #95 is open, #110 is open, and #68 is open. The
black-and-white theme is merged in #48. A future implementation must repeat the
anchor check at its own base before choosing migration numbers.

## 1. Product boundary and naming

Use **Agents** for a direct conversation with one employee and **Workroom** for
an intent-first conversation with the company coordinator. Workroom remains the
surface proposed in #116: selecting an agent is optional, task cards can be
attached as context, and several selected tasks can be acted on together. The
Conference Room remains a separate company-wide chat route behind its existing
flag. Merging navigation must not turn either surface into a general-purpose
chat product.

Use **Inbox** as the attention home if B1 is chosen. It contains decisions and
work updates, while Tasks remains the work-object surface. Use **Dashboard** as
the card home if C1 is chosen. Status is a card kind inside that home, while
Audit remains the owner for usage and cost according to the full-observability
plan.

Each merge gets a separate flag and can be rolled back without disabling the
other two. The old route remains readable while its replacement is enabled, and
redirects preserve query parameters, filters, deep links, and browser history
semantics. Flags are off by default until their slice has real end-to-end proof.

## 2. A. Agents + Chats

### A1 — recommended: one organization tree

Keep the current org chart as the primary tree. Each node shows the agent's
lifecycle state, live-run state, and chat state. The tree can be sorted by
reports-to structure or recent activity. Selecting a node opens one agent
workspace at `/agents/:ref/chat`; Chat is the default pane and the existing
settings navigation remains beside it. The future Routines tab lands in this
workspace rather than creating another agent page.

The current `/chats` picker and conversation rail become compatibility views.
`/chats` redirects to the most recent permitted agent chat, or to the agent tree
when no chat exists. `/chats/:agentRef` redirects to
`/agents/:ref/chat`. A terminated agent stays readable in an `Archived` tree
group and cannot be mistaken for an active roster member. The redirect retains
company context and a deep-linked conversation id when one is present.

A1 uses the existing issue-backed conversation identity. It does not create a
new message table or a second transcript. The selected agent context is a UI
selection; authorization remains the existing company-scoped task and agent
checks. Workroom's coordinator is still the no-agent-choice entry point.

**A1 questions to settle:**

- Do unread indicators belong to each person? The default is a server-side
  per-user cursor, with a local optimistic cache.
- Does the org tree show every permitted agent or only agents with a chat? The
  default is every permitted agent, with recent conversations pinned first.
- Are terminated agents visible? The default is an archived group with history
  links and no new-chat action.

### A2 — conversation-first recency list

Make recent conversations the primary list, grouped by team. Open settings from
the chat header. The org tree is a secondary view. This minimizes navigation for
people who mainly chat, but it hides reporting structure and makes a new agent
harder to discover.

### A3 — keep pages, share navigation

Keep `/agents` and `/chats` as distinct pages and share the tree, search, and
agent-link components. This has the lowest route risk, but preserves two mental
models and does not remove the duplicate chat entry point.

### A implementation slices

1. **A0, inventory and contract:** confirm the #116 Workroom route, the Routines
   tab contract, the agent route reference, and the compatibility redirect matrix.
2. **A1, composed workspace:** add the flag-gated tree/workspace shell, route
   redirects, sort toggle, archived group, loading/error states, and both
   sidebar variants. The existing chat controller remains the data owner.
3. **A2, parity:** expose any selected unread cursor through REST, OpenAPI, and
   CLI. Keep ordinary chat operations unchanged.
4. **A3, qualification:** run the real browser and API journeys in section 5,
   measure route performance, and record the rollback decision.

## 3. B. Decisions + Inbox

### B1 — recommended: one attention system

Make Inbox the single attention home. The server attention service is the one
feed. It gains adapters for the current Inbox item kinds, then the UI renders
two lanes:

- **Needs you:** decisions, approvals, interactions, join requests, recovery
  actions, reviews, and other items that require a choice or response.
- **Updates:** issue changes, mentions, failed runs, alerts, and other
  informational events.

Decision queues become filters over the `Needs you` lane. Existing filters for
mine, recent, unread, blocked, all, approvals, failed runs, and alerts remain
available as filter state. There is one badge, one dismissal model, and one
snooze model.

Read state moves from `localStorage` to a server-side per-user cursor so web,
API, and CLI agree. Dismissal and snooze remain the existing server-side
per-user behavior. The unanswered-dismissal behavior depends on #109; the merge
must not invent a second interpretation of a dismissed decision.

The Decisions CLI commands planned in #116 are implemented once by whichever
slice owns them first. This plan adds only the attention/inbox read-state
operations needed for parity. The OpenAPI document must describe lane, filter,
read, dismiss, snooze, and cursor semantics.

`enableCombinedInboxTasks` is a competing direction. Under B1 the default is
to retire it after a compatibility window: `/inbox/*` continues to redirect to
Inbox filters, and Tasks keeps only work-object views. If maintainers need the
flag during rollout, it may remain as an explicit B1-off compatibility mode;
it must not silently produce a third attention system.

### B2 — keep Inbox in Tasks, fold Decisions into a Tasks view

Keep the existing Inbox-to-Tasks merge and add a Needs-you view to Tasks.
Decisions become task-adjacent cards. This reuses the current combined flag but
makes attention semantics depend on the task list and leaves non-task decisions
harder to find.

### B3 — Decisions absorbs Inbox as an Updates tab

Keep Decisions as the primary label. Add an Updates tab for Inbox items and
retain the existing decision lanes. This gives decisions a clear home, but it
makes ordinary updates look subordinate and keeps the current split in read and
badge semantics longer.

### B implementation slices

1. **B0, feed contract:** enumerate every Inbox item kind and its attention
   representation. Prove ordering, company scoping, dismissal, snooze, and
   cursor behavior before changing the UI.
2. **B1, unified feed:** add the flag-gated two-lane shell, filters, redirects,
   one badge, and both sidebar variants. Keep the current Decisions and Inbox
   pages available when the flag is off.
3. **B2, server read state:** if selected, add the per-user cursor and REST,
   OpenAPI, and CLI parity. Migrate no old local-storage value by default.
4. **B3, qualification:** exercise decisions, approvals, joins, recovery,
   failed runs, issue updates, dismiss, snooze, restore, and deep links.

## 4. C. Dashboard + Status

### C1 — recommended: Dashboard as a card grid

Make Dashboard the home for cards. Keep the current metric cards, live-run
cards, activity, budget, approvals, and active-agent summaries as built-in card
kinds. Render user-defined Status cards as another kind behind
`enableStatusCards`, and gate the composed shell behind
`enableDashboardStatusCards`. `/status` and `/status/:cardId` redirect into the
Dashboard card route while the merge flag is on.

The existing Status refresh and summarizer policies remain unchanged. Status
cards keep their existing create, refresh, recompile, archive, restore, and
settings behavior. Costs and usage stay in Audit under the full-observability
plan; the dashboard card may link to Audit but must not become a second cost
ledger.

C1 does not combine `status_cards` with the dashboard summary table. The first
implementation composes responses in the UI. A server read model is justified
only by a measured loading or consistency problem and needs its own API,
OpenAPI, migration, and rollback decision.

### C2 — Status absorbs Dashboard metrics

Make Status the primary label and add dashboard metrics as built-in Status card
kinds. This makes the experimental feature the default mental model, but it
couples the stable dashboard metrics to the experimental lifecycle.

### C3 — keep pages separate

Keep Dashboard and Status as separate routes, but share card primitives and
cross-links. This is the lowest behavior risk, but it leaves the duplicate home
surfaces and the user's navigation problem intact.

### C implementation slices

1. **C0, card contract:** list current Dashboard summary fields and Status card
   actions. Define loading, empty, archived, and deep-link states.
2. **C1, card grid:** compose the grid behind its own flag, add `/status` redirects,
   preserve Status's flag, and update both sidebars.
3. **C2, parity:** preserve existing REST/OpenAPI/CLI operations. Add a new
   card-kind endpoint only if composition cannot meet measured load and refresh
   targets.
4. **C3, qualification:** run the real dashboard, status-card, refresh, archive,
   restore, and redirect journeys and record before/after route timings.

## 5. Shared implementation and verification contract

### Navigation and migration order

The launcher work in #95 replaces the Search page and the sidebar New Task
control. Its public action catalog currently includes navigation actions in
[`packages/shared/src/command-actions.ts`](../../packages/shared/src/command-actions.ts).
Merged-navigation slices must register their final routes with that owner and
must not add a parallel search or launcher. The launcher remains the single
entry point for global actions.

The Next.js migration in #110 owns route migration order, layouts, and loading
boundaries. Each merged route gets one canonical owner in that migration. If a
slice lands before a route group moves, it implements the same redirect and
composition contract in the current router, then the Next.js owner ports it
once. No slice may migrate a route twice.

The instant-loading and route-splitting work in #68 and the measurement protocol
in #110 are dependencies for performance claims. The merged surface must keep
shell-first loading, route-level loading states, and the initial-JavaScript
budget. A merge is not accepted because a local navigation feels fast.

The Routines agent-tab work in flight owns its tab data and actions. A1 only
provides the workspace slot and route contract. The Routines owner supplies the
content and tests; both changes must agree on the agent reference and loading
states.

The black-and-white theme in #48 owns tokens and contrast. New shells reuse
those tokens and run the existing token gate. No merge introduces page-specific
colors or a second theme.

The full-observability plan owns usage, cost, and Audit. C1 links to those
surfaces and does not copy their data. A and B may show live status or attention
counts, but they do not create a second run ledger or telemetry path.

### Both sidebar shells

The streamlined shell is [`ui/src/components/Sidebar.tsx`](../../ui/src/components/Sidebar.tsx).
The production shell is
[`ui/src/components/Sidebar.production.tsx`](../../ui/src/components/Sidebar.production.tsx).
`ui/src/App.tsx:885-887` selects the shell. Every navigation slice updates both
files, or explicitly proves that a shared component removes the duplication.
Tests must cover expanded, collapsed, mobile, loading, flag-off, and flag-on
states in both shells. A plan that changes only the streamlined shell is
incomplete.

### API, OpenAPI, and CLI parity

The web is not the contract owner. For every new server behavior:

1. Define company scoping, board-user authorization, idempotency, and activity
   logging in the service and route.
2. Add shared types and validators where the payload crosses package boundaries.
3. Add the REST route and OpenAPI entry.
4. Add a CLI operation and parity test, unless the behavior is explicitly a
   browser-only presentation choice such as a local sort toggle.
5. Add cross-company denial and retry tests.

Read state, redirects, filters, dismissal, snooze, and card refresh must have
stable semantics across web, API, and CLI. Direct task and agent links continue
to use existing authorization.

### Real end-to-end journeys

Use the Product E2E harness with a real server, database, browser, and adapter
fixture. Do not replace a merged-flow test with a component mock.

Required A journeys:

- open the agent tree, switch org/recent sort, open an active agent, send a
  chat message, and return through a deep link;
- open a terminated agent's history, confirm no new-chat action, and verify
  company isolation;
- open Workroom, attach several task cards, request a change, and confirm the
  existing task/review path remains authoritative;
- verify the Routines tab appears in the same workspace when its flag is on.

Required B journeys:

- receive an approval, decision, interaction, join request, recovery action,
  issue update, and failed run in the correct lane;
- mark read in the browser, read through the API, and inspect the same state in
  the CLI;
- dismiss, snooze, restore, and deep-link an item; verify #109 behavior for an
  unanswered decision;
- toggle `enableCombinedInboxTasks` and verify no duplicate badge or feed.

Required C journeys:

- load metric cards and status cards together, refresh and recompile a status
  card, archive and restore it, and open a deep link;
- disable either flag and verify the old route remains usable;
- verify costs link to Audit and no card creates a second usage or cost record.

### Performance and scale proof

Measure before and after on the same harness profile and commit. Record cold
load, warm route navigation, first contentful paint, largest contentful paint,
interaction readiness, initial JavaScript, API request count, and feed/card
payload size. Include desktop and mobile profiles. The target is no regression
against the baseline owned by #110; a slice that regresses must stop or reduce
scope.

The default load test recommendation is 100 concurrent authenticated users,
10,000 attention items per company, 1,000 agents, 1,000 status cards, and 10
navigation events per user over 10 minutes. The service must prove bounded
pagination, stable cursors, no duplicate requests, and no cross-company data.
The user may choose a smaller pilot or a larger stress run in Q8 below; the
chosen scale becomes a release gate rather than an implementation guess.

## 6. User questions and defaults

These are decisions for the product owner. The defaults are recommendations,
not implementation authorization.

| ID | Question | Default | Consequence |
|---|---|---|---|
| Q1 | Which Agents + Chats direction should ship first: A1 tree/workspace, A2 conversation-first, or A3 shared navigation? | **A1** | A1 keeps org structure visible and gives #116 Workroom a clear company-vs-agent boundary. |
| Q2 | Should chat unread state be server-side and per user? | **Yes** | Adds a small company/user/agent cursor contract and web/API/CLI parity work. |
| Q3 | Should terminated agents stay in the agent tree? | **Yes, archived** | History remains discoverable; creation and new-chat actions stay disabled. |
| Q4 | Which Decisions + Inbox direction should ship: B1 one attention system, B2 Tasks view, or B3 Decisions with Updates? | **B1** | Requires one attention adapter and retires the competing combined-inbox direction after compatibility. |
| Q5 | What happens to `enableCombinedInboxTasks` under B1? | **Retire after one compatibility window** | Existing `/inbox/*` links redirect to Inbox filters; Tasks stays a work-object view. |
| Q6 | Should read state migrate from local storage to the server? | **Yes, per user** | API and CLI agree across devices; no historical local-read backfill is required. |
| Q7 | Which Dashboard + Status direction should ship: C1 card grid, C2 Status home, or C3 separate pages? | **C1** | Preserves the stable Dashboard mental model and keeps Status experimental. |
| Q8 | Which upstream route owner lands first when #95, #110, #116, or the Routines tab changes the same files? | **The route owner in #110; otherwise rebase and land one composed shell** | Prevents double migration and keeps redirects stable. |
| Q9 | What load-test scale is required before enabling each merge? | **Default scale in section 5** | A larger choice extends the performance lane; a smaller choice limits the rollout claim. |
| Q10 | Should the three merges ship together or independently? | **Independently, A then B then C** | Each flag can roll back alone; sequencing reduces the shared sidebar conflict surface. |
| Q11 | Should the shared agent tree share chat sessions across users, or keep one conversation per user? | **Keep the existing per-company/agent/user identity** | The tree is shared roster navigation, while transcripts and session boundaries remain private to the authenticated user under normal company visibility. |

## 7. Upstream-conflict estimate

These estimates are planning ranges for changed-file families, not promises about
line counts. They assume the current base and composition strategy above. They
must be recalculated after upstream PRs land.

| Option | Likely conflict surface | Estimate | Main collision points | Mitigation |
|---|---|---:|---|---|
| A1 tree/workspace | App routes, both sidebars, chat rail, agent workspace, redirect tests, Routines slot | High: 8–12 shared file families | #116 Workroom rail, #95 launcher row, #110 route/layout migration, Routines agent tab | Land the route contract first, keep `AgentChat` as controller, port one shell component to both sidebars, rebase immediately before implementation. |
| A2 conversation-first | App routes, chat list/rail, header settings links, both sidebars | Medium: 5–8 families | #116 chat rail and #110 route migration | Keep org tree as a secondary view and reuse the existing chat rail. |
| A3 shared navigation | Shared sidebar/search/link components and redirect tests | Low: 3–5 families | #95 sidebar trigger and #110 route redirects | Avoid page rewrites; defer canonical route changes. |
| B1 one attention system | Attention service/types, Inbox and Decisions pages, dismissals, OpenAPI, CLI, both sidebars, read-state migration | High: 10–16 families | #116 Decisions commands, #109 dismissal semantics, #95 sidebar, #110 route migration | Land feed contract before UI; keep old pages behind flags; add no new decision command set. |
| B2 Tasks view | Tasks/Inbox composition, combined flag, both sidebars, redirect tests | Medium-high: 7–11 families | Existing `enableCombinedInboxTasks`, #95 launcher, #110 route migration | Reuse the existing view redirect and make decision cards explicitly task-linked. |
| B3 Decisions + Updates | WhatNeedsMe, attention service, Inbox adapters, both sidebars | Medium: 7–10 families | #116 Decisions UI and #109 dismissal semantics | Preserve Inbox item components and use one badge/read contract. |
| C1 Dashboard card grid | Dashboard, StatusCards, card routes, both sidebars, status API tests | Medium: 6–10 families | #110 route/layout migration, #87 dashboard loading, #48 theme tokens | Keep existing APIs and tables; compose cards before considering a read model. |
| C2 Status home | StatusCards, Dashboard summary, flag gates, both sidebars | Medium-high: 8–12 families | `enableStatusCards`, #110, full observability Audit boundary | Keep Dashboard as a compatibility redirect and retain Status as experimental. |
| C3 shared cards only | Shared card primitives and cross-links | Low: 3–5 families | #48 theme and #110 route migration | No route ownership change; defer merge semantics. |

The highest-risk choice is B1 because it changes the owner of read state and
feed composition. The lowest-risk route to learn is A3 or C3, but those options
do not fully solve the navigation problem. A1, B1, and C1 are recommended only
because they remove duplicate mental models while preserving the current data
owners.

## 8. Exit criteria

The user resolves Q1–Q11. The listed defaults apply unless the product owner changes them. The owner
then converts only the selected options into implementation issues. Before code:

- re-read every source anchor at the new base;
- confirm the dependency heads and route owner;
- choose final flag names and reserve migration numbers just in time;
- publish the OpenAPI and CLI parity contracts;
- write the real Product E2E journeys and performance baselines;
- agree on rollback and the compatibility-window duration.

No code is authorized by this plan alone.
