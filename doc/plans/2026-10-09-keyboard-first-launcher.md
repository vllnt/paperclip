# Keyboard-first board UI and a context-aware Cmd+K launcher

Date: 2026-10-09. Status: plan, decisions D1-D5 taken, independent review
pending. Base: `main` at `53ec251fb`.

## 1. Goal

The user asked for two outcomes:

1. **A Cmd+K launcher.** It holds every action, grouped for the current view,
   with the most likely commands first. Ranking is local and instant (tier 1).
   Jev (`typesafe-ai/jev`) adds only an optional, asynchronous intent
   suggestion (tier 2). The user must confirm a suggestion before it runs.
2. **A board UI that works fully by keyboard.** Navigation, search over all
   entities (including activity and audit entries), and control of every page
   work without a mouse.

Product rules that apply:

- Web, API and CLI parity: each user-facing capability ships on the web UI,
  the REST API (listed in OpenAPI) and the `paperclipai` CLI. Keyboard
  affordances (focus, chords, the palette itself) are UI-only. The
  capabilities behind them (search, intent resolution, each action's
  operation) need API and CLI surfaces.
- Company scoping, permission checks and activity logging (`AGENTS.md` §5, §8).
- Token-only UI styling (`DESIGN.md`, `pnpm check:token-gates`).

## 2. Current state (verified at `53ec251fb`)

### 2.1 Palette and shortcuts

- `ui/src/components/CommandPalette.tsx` (453 lines) is mounted eagerly in
  `Layout.tsx:784` (the default streamlined shell) and
  `Layout.production.tsx:774`. It binds Cmd/Ctrl+K itself.
  `Layout.openSearch` (`Layout.tsx:348`) opens it by dispatching a synthetic
  Meta+K `keydown`.
- Its actions are hard-coded rows. Its order comes from cmdk's own filter,
  steered by `value` strings that prefix the query
  (`${searchQuery} ${project.name}`). `CommandDialog`
  (`ui/src/components/ui/command.tsx`) does not pass props to the inner
  `Command`, so `shouldFilter` cannot be set today.
- Task search calls `issuesApi.list({ q, limit: 10,
  includeRoutineExecutions: true })`, not `/search`.
- Shortcuts: `useKeyboardShortcuts` handles `/ ? c [ ]` and `g i`. The pure
  resolvers are in `ui/src/lib/keyboardShortcuts.ts`. `IssueDetail.tsx` runs
  capture-phase handlers for `y`, `g c` and `g f`. `IssuesList.tsx` has j/k,
  arrows and Enter. The cheatsheet is a hard-coded `sections` array.
- `<main id="main-content" tabIndex={-1}>` and a "Skip to Main Content" link
  exist (`Layout.tsx:631`). There is no global `:focus-visible` rule.

### 2.2 Search, permissions, CLI

- `GET /companies/:companyId/search` (`server/src/routes/issues.ts:7832`)
  returns `issue`, `artifact`, `agent` and `project` results. Comments and
  documents count only as issue snippets. Goals, routines, skills,
  approvals, runs and activity are not searchable. It allows board and agent
  actors, with a rate limit of 60 requests per minute. OpenAPI lists it
  without query parameters, 403 or 429 (`server/src/routes/openapi.ts:9605`).
- Trigram indexes exist on issues, comments, documents and cases only.
- No list endpoint for agents, projects, goals, routines, approvals,
  activity or runs takes a text query.
- There is no "effective permissions" endpoint. The UI reads
  `CurrentBoardAccess` (`ui/src/api/access.ts:235`: instance admin,
  membership roles) and gates a few actions with it
  (`ui/src/hooks/useCompanyInviteAccess.ts`).
- The CLI (commander, `cli/src/index.ts`) has no company `search` command.
  CLI/API parity tests are per domain (`cli/src/__tests__/*-parity.test.ts`).
- There is no action registry anywhere in the repo.

### 2.3 Mouse-only gaps per page

Method: an AST pass over 683 non-test `.tsx` files in `ui/src`, plus reading.
Counts:

- 46 `onClick` handlers on `div`/`tr`/`li`/`span` without a role. 24 of them
  do real work; the rest only stop propagation.
- 31 hover-revealed controls (`opacity-0 group-hover:`) with no focus
  equivalent.
- 81 icon-only buttons without `aria-label` (about 25 have no accessible
  name at all).
- 79 raw form controls with `outline-none` and no focus style.
- 6 `DndContext`s, 4 of them without `KeyboardSensor`.
- About 17 popover pickers that are a search input plus a list of buttons,
  with no arrow keys and no selected state.
- No keyboard-only e2e spec and no axe check in `tests/e2e`.

Worst gaps, in priority order (paths under `ui/src/`):

| # | Gap | Evidence |
| --- | --- | --- |
| 1 | Kanban: status change is drag-only (Pointer sensor only); cards are fake focus stops around a `Link`; board mode has no j/k | `components/KanbanBoard.tsx:481-483`, `:369-382`; `components/IssuesList.tsx:1457` |
| 2 | Issue, goal and project titles are editable by click only | `components/InlineEditor.tsx:418-426` (the keyboard branch at `:286-300` exists) |
| 3 | Agents org view: cards are `Card onClick`; panning is mouse only | `pages/OrgChart.tsx:611-621`, `:514-519` |
| 4 | Audit timeline chart: run bars are `<g onClick>`, range brush is drag only | `components/timeline/WorkTimelineChart.tsx:606-618`, `:906-959` |
| 5 | Costs per-agent breakdown opens from a `div onClick` | `pages/Costs.tsx:762-764` |
| 6 | Hover-only controls that take focus while invisible | `components/IssueChatThread.tsx:1569`, `:2189`, `:3654`; `pages/Inbox.tsx:465`, `:3311`, `:3334`; `components/folders/FolderControls.tsx:336`; `components/IssueAttachmentsSection.tsx:342` |
| 7 | Popover pickers: Tab-only lists | `components/issue-properties/IssueProperties.tsx:1634`, `:1824`, `:1975`, `:2146`, `:2232`, `:2786`; `components/IssuesList.tsx:2386` |
| 8 | Images and attachments open by click only | `components/IssueAttachmentsSection.tsx:296-301`; `components/MarkdownBody.tsx:940` |
| 9 | Sidebar project and company reordering is drag-only; each project gets an unnamed `role=button` stop | `components/SidebarProjects.tsx:242-248`, `:313-317`; `components/SidebarCompanyMenu.tsx:127`, `:167-174` |
| 10 | Pointer-only resize handles | `components/PropertiesPanel.tsx:378-390`; `pages/AgentDetail.tsx:2963-2966` |

Other findings that the slices use:

- **Search page:**
  - The operator chips render only while the input has focus, so Tab
    removes them (`pages/Search.tsx:497-499`).
  - The page binds its own `/` handler on `window` (`:434-445`). It doesn't
    mark its input with `data-page-search-target`, so `/` opens the palette
    *and* focuses the input.
  - Results have no arrow navigation.
- **`IssuesList` and Inbox:** j/k selection is only visual. It moves no DOM
  focus and sets no `aria-selected` (`components/IssuesList.tsx:1443-1539`,
  `pages/Inbox.tsx:2156-2342`).
- **`HintIcon`:** a focusable button with no name, used about 140 times
  (`components/agent-config-primitives.tsx:79`). `Field` labels have no
  `htmlFor` (`:92`).
- **Mobile sidebar overlay:** no focus trap, `inert` or Escape
  (`components/Layout.tsx:640-655`).
- **Approvals:** no blocking gaps. Plugin pages depend on each plugin.

Code to reuse instead of rebuilding:

- `components/FileTree.tsx:305-441` (roving tree).
- `components/RoutineSubSidebar.tsx:79-138` (roving list with Home/End).
- `components/side-panel/SidePanelTabs.tsx:142-145` (`KeyboardSensor` and
  live-region announcements).
- `components/SidebarShell.tsx:220-236` (keyboard-resizable separator).
- `components/InlineEntitySelector.tsx`, `components/SearchableSelect.tsx`
  (keyboard pickers).
- `plugins/launchers.tsx:150-212` (focus trap and focus restore).
- `lib/main-content-focus.ts` (moves focus to `<main>` after navigation).

## 3. Architecture

```
            packages/shared                          ui/
  +-------------------------------+     +----------------------------------+
  | command-actions.ts (data)     |     | lib/command-action-bindings.ts   |
  |  id, title, keywords, group,  |---->|  icons + global handlers         |
  |  shortcut, operation          |     |  (navigate, dialogs, toggles)    |
  |  commandActionGoChords()      |     | context/CommandActionsContext    |
  | command-action-rank.ts        |     |  controller created in Layout    |
  |  scoreTextMatch,              |     |  useRegisterCommandActions()     |
  |  rankCommandActions,          |     |   <- pages register handlers     |
  |  recordCommandActionUse       |     | CommandPalette (shouldFilter=0)  |
  +-------------------------------+     | useKeyboardShortcuts (g chords)  |
            |          |                | KeyboardShortcutsCheatsheet      |
            v          v                +----------------------------------+
   server (slice 4)   cli (slice 4)
   intent endpoint    `intent` command
```

### 3.1 One action catalog (data only, `packages/shared`)

`packages/shared/src/command-actions.ts` exports `COMMAND_ACTIONS`, a static
typed list (25 entries in slice 1). Each entry has:

| Field | Example | Use |
| --- | --- | --- |
| `id` | `nav.dashboard`, `create.task`, `issue.focus-comment` | stable key for frecency, bindings, Jev answers |
| `title` | "Dashboard", "Create new task" | row label, Jev candidate text (today's palette labels are kept) |
| `keywords` | `["home", "overview"]` | extra match terms |
| `group` | `navigate` / `create` / `general` / `contextual` | empty-query grouping; `contextual` actions run only where a page registers them |
| `shortcut` | `["g", "d"]`, `["c"]` | chord binding and generated cheatsheet |
| `operation` | `{ kind: "navigate", path: "/dashboard" }` or `{ kind: "ui" }` | what the action does |

Slice 2c adds `{ kind: "api", method, path }` operations, which tie an
action to an existing REST route, and a `requires` field for actions that
only some members may run. Slice 1 has no action that needs either.

Why `packages/shared` and not `ui/`: the palette, the chords, the
cheatsheet, the slice-4 intent endpoint (Jev candidates) and the slice-4 CLI
`intent` command read the same list. The catalog holds no React, no icons
and no handlers, so the server and the CLI can import it.

There is no path-to-view map. "Contextual" means "registered by the page that
is mounted now", which the provider already knows. For slice 4, the client
sends the ids of the actions it can run, and the server checks each id
against the catalog.

### 3.2 Bindings (`ui/`)

- `ui/src/lib/command-action-bindings.ts`: icons, and
  `useGlobalCommandActionBindings` for the global actions: navigation, the
  create dialogs from `DialogContext`, the sidebar and panel toggles, and the
  cheatsheet. With the combined inbox flag on, `nav.inbox` keeps today's
  "My work" label and target.
- `ui/src/context/CommandActionsContext.tsx`:
  - `CommandActionsProvider` holds the launcher state: palette open state,
    page registrations and frecency. Each layout shell (`Layout.tsx`,
    `Layout.production.tsx`) wraps its tree in it and reaches it through a
    `handleRef` (`run`, `openCommandPalette`) for its own chords and `/`.
    The state lives in the provider, not in the layout, so opening the
    palette re-renders the palette only, not the shell.
  - Pages call `useRegisterCommandActions({ "issue.open-file": binding | null })`.
    It reads a separate context that holds only the stable `register`, so a
    page does not re-render when the palette opens. A `null` binding means
    "not available here" (for example, the file viewer flag is off). The
    registration is removed on unmount, so a page that is gone never receives
    an action. When several registrations hold the same id, the newest wins.
  - `run(id)` records the use (frecency) and calls the handler.
- `openCommandPalette()` replaces the synthetic Meta+K `keydown` that
  `Layout.openSearch` dispatched.
- Issue detail registers "Archive from inbox", "Open file in this issue"
  and "Comment on this task", each only where it works. This replaces the
  `paperclip:open-file-viewer` window event, which had one sender (the old
  palette) and one listener.
  - "Open file in this issue" needs the file viewer flag. It is not offered
    in the chat shell on phones, where the file browser opens in the hidden
    side panel.
  - "Comment on this task" is offered only in the classic interface. The
    chat shell's composer has no focus handle, so the existing `g c` chord
    is a silent no-op there today (found while building slice 1).
- The palette runs a selected row after its close has committed, and then
  skips Radix's focus restore. Before this, a row that moves focus (the file
  browser, the composer) lost it to the closing dialog's focus trap. Escape
  still restores focus to where it was.
- Two older focus bugs that the launcher exposed, fixed in slice 1:
  - `hasBlockingShortcutDialog` matched only `[aria-modal='true']`, which
    Radix dialogs do not set, so bare shortcuts fired over the app's own
    dialogs. `isInsideOpenModalDialog` (`ui/src/lib/keyboardShortcuts.ts`)
    also matches open Radix dialog and alert-dialog content (shadcn
    `dialog`, `sheet`, `alert-dialog`, and raw primitives such as the image
    gallery), and skips popovers, which Radix renders in a popper wrapper.
  - The layout's post-navigation focus on `<main>` took focus from an open
    dialog. Reopening the launcher right after it navigated, then typing,
    lost the first characters: the dialog's trap pulled focus back and
    selected the query. `shouldFocusMainContentAfterNavigation` now leaves
    focus inside an open modal (reproduced 1 in about 10 runs before, 0 in 40
    after).
- The shortcut sheet grew to about 40 rows. It is capped at 85% of the
  viewport height and its list scrolls.

### 3.3 Tier 1 ranking (local, synchronous)

`rankCommandActions({ query, actions, contextualIds, usage, now })` in
`packages/shared/src/command-action-rank.ts` is pure and has no I/O.

```
score = scoreTextMatch(title, keywords, query)    // null = drop the action
      + (contextualIds has id ? CONTEXTUAL_BOOST (250) : 0)
      + min(250, 50 * log2(1 + uses)) * 0.5^(age / 7 days)
```

- `scoreTextMatch` is today's `scoreProjectMatch`
  (`CommandPalette.tsx:83-95`), moved to `packages/shared` and made
  case-insensitive. The bands are unchanged: exact 1000, prefix 700-900,
  substring below 700, keyword or description 400, in-order subsequence 200.
  The project promotion and the agent filter use the same function, so there
  is one matcher.
- The frecency ceiling (250) keeps "keyword match + frecency" (at most 650)
  below the lowest title-prefix score (700). Usage reorders matches of the
  same strength. It never lifts a weak match over a strong one.
- With an empty query every available action is kept: contextual first,
  then by frecency, then in catalog order.
- Permission filtering happens before ranking: an action without a handler
  is not available. Slice 2c adds `requires`.
- Frecency is stored in `localStorage` under
  `paperclip.commandActionUsage.v1:<companyId>:<userId | __local_board__>`
  (the same key pattern as `paperclip.recentTasks.v2`). It holds action ids
  and timestamps only, at most 200 entries, and drops the least recently
  used. It is per browser (D4).
- Measured: ranking 200 actions has a median under 2 ms (a unit test
  asserts it).

### 3.4 Palette layout

Empty query, top to bottom:

1. **This view**: the actions the current page registered.
2. **Recent**: the 5 most frecent global actions.
3. **Navigate**, **Create**, **General** (minus the rows already shown).
4. **Quick filters**, then the **Tasks**, **Agents** and **Projects** lists
   that today's palette shows.

With a query:

1. **Actions** (at most 8), *if* the best action match is a title prefix or
   better (score at least 700). Otherwise the actions come after the
   entity groups. This is D3: Enter opens the best local match.
2. **Projects** (`scoreTextMatch`, at most 5), **Tasks** (the existing
   `issuesApi.list({ q, includeRoutineExecutions: true })`), **Agents**
   (`scoreTextMatch` over name, role and title, at most 5; today only the
   first 10 agents could ever match).
3. **Search all for "..."**: always present. Cmd/Ctrl+Enter opens `/search`
   from any row. Enter with no match opens `/search`. Both are kept from
   today.
4. **Quick filters**.

The inner `Command` gets `shouldFilter={false}` (passed through a new
`commandProps` prop on `CommandDialog`), so the row order is the order this
code renders. cmdk keeps keyboard selection, `aria-activedescendant` and the
Ctrl+J/K/N/P bindings. The `value` string hacks (`${searchQuery} ${name}`)
are gone; each row's `value` is a stable id (`action:nav.dashboard`,
`project:<id>`).

### 3.5 Chords and the cheatsheet

New `g` chords, bound from the catalog (`commandActionGoChords`) by a new
pure resolver `resolveGoChordKeyAction` in `useKeyboardShortcuts`:

| Keys | Target | Keys | Target |
| --- | --- | --- | --- |
| `g d` | Dashboard | `g r` | Routines |
| `g t` | Tasks | `g v` | Approvals |
| `g i` | Inbox (exists) | `g e` | Activity |
| `g a` | Agents | `g m` | Costs |
| `g p` | Projects | `g s` | Company settings |
| `g o` | Goals | `g k` | Skills |

`IssueDetail.tsx` keeps its capture-phase handler for `g i`, `g c` and
`g f`. It stops propagation for the chords it claims, and passes the others
(`g d`, ...) on to the global handler. Outside issue detail, `g c` and `g f`
are swallowed, so they never fire the bare `c` (new task) shortcut, as
today. `KeyboardShortcutsCheatsheet` renders its "Go to" and "Global"
sections and the chord rows of "Task detail" from the catalog. The list-key
sections (Inbox, Decisions) stay static: those keys move a selection and are
not launcher actions.

### 3.6 Bundle

`#68` (open) sets an initial-JS budget of 1,500,000 gzip bytes and keeps the
palette, `cmdk` and the shortcut hook in the initial bundle. Slice 1 keeps
the palette eager, measures the delta, and reports it. Lazy-loading the
palette body (an eager Cmd+K listener that buffers typed keys until the chunk
loads) is a follow-up only if the measured delta needs it. The perf track
found that idle prefetch hurts TTI, so there is no prefetch.

### 3.7 Focus and lists (slice 2)

- A global `:focus-visible` outline from `--ring` in `ui/src/index.css`.
  `#48` (open) changes `--ring` to `var(--link)` and adds no global rule, so
  the two changes compose.
- One `useListNavigation` hook, extracted from the five existing j/k
  implementations (section 2.3), that also moves DOM focus and sets
  `aria-selected` (slice 2b).
- The skip link exists (`Layout.tsx:630`). Slice 2a adds an e2e check for it.

## 4. Slices

Each slice is one PR against `main`, reviewable alone. Slices 1-3 need no
migration. Slice 4 needs none either, but it waits for `#40`.

### Slice 1: launcher core (tier 1)

- `packages/shared`: `command-actions.ts` (the catalog) and
  `command-action-rank.ts` (`scoreTextMatch`, the moved `scoreProjectMatch`;
  `rankCommandActions`; `recordCommandActionUse`), with unit tests and a
  timing test.
- `ui`:
  - `CommandActionsContext` (controller, provider,
    `useRegisterCommandActions`) and the global bindings.
  - The palette rebuild (section 3.4), the frecency store, and
    `openCommandPalette()`.
  - The `g` chords (section 3.5) and the generated cheatsheet.
  - Issue detail registers its existing contextual actions ("Open file in
    this issue", "Comment on this task", "Archive from inbox") as the first
    "This view" users.
- Fix found on the way: "Create new project" navigated to `/projects` instead
  of calling `openNewProject()` (`CommandPalette.tsx:350`). It now opens the
  dialog, like "Create new task" and "Create new agent".
- `cli`: `paperclipai search <query> [--scope] [--limit] [--json]` over the
  existing `GET /companies/:companyId/search`. Today no CLI command covers
  company search. This gives the launcher's search capability its CLI
  surface (parity), and the API surface already exists.
- CI: append the new unit tests to the `Dockerfile` `vitest run` list
  (`Dockerfile:136`). CI runs no other unit tests.
- e2e: `tests/e2e/command-launcher.spec.ts`, keyboard only: open with
  Cmd/Ctrl+K, type, arrow, Enter navigates; `g d` navigates; `?` shows a
  chord that comes from the catalog.

### Slice 1b: the launcher replaces the search page and the sidebar New Task

User request, 2026-10-10: "search page should be fully replace by cmd+k, and
replace the search in sidebar by search with cmd+k like in best saas ui that
open the launcher" and "remove the new task from sidebar, must be done via
cmd+k". It lands as its own PR, stacked on slice 1, before slice 2a.

- **Sidebar:** both sidebars replace the Search link and the New Task button
  with one Search trigger: a button with "Search…" and the key hint (`⌘K` on
  Apple platforms, `Ctrl K` elsewhere); icon only with a tooltip in the rail.
  It opens the launcher, which is the only way to open it on touch devices.
- **Create:** "Create new task" leads the launcher's first group with an
  empty query. The `c` shortcut, the page buttons and the phone bottom bar's
  New Task stay.
- **Search:** the launcher queries `GET /companies/:companyId/search` (the
  endpoint behind `paperclipai search`) with the typed text and filters.
  Results are grouped by kind, groups ordered by their best result, with a
  "Show more results" row (20 per page, up to the endpoint's offset limit).
  `scope:` and `sort:` are new parser tokens. Loading, empty (with "Create
  task" from the text and "without filters") and error (with Retry) states
  are rows in the launcher. The selection follows the best row when results
  arrive, so Enter opens the best match.
- **Old links:** `/search?...` (with or without the company prefix) goes to
  the dashboard with the launcher open, its text rebuilt from the link's
  query, filters, scope and sort.
- **Removed:** the search page, its filter bar, menu, sheet, chips, sort menu
  and zero-results panel, `lib/search-filters.ts`, the catalog's `nav.search`
  action, and parser helpers only the page used. The PR lists each search
  page feature and where it went, including what was dropped (per-option
  filter counts, the mobile filter sheet's result preview, preview images in
  rows, the exact-identifier redirect, which Enter on the first row replaces).
- **Parity:** no change. The search endpoint, `paperclipai search`, and task
  creation through the API and CLI stay as they are.

### Slice 2: keyboard-only pages

The inventory (section 2.3) is too large for one reviewable PR. It splits
into three PRs, in this order:

- **2a, reachability:** everything in this PR is a small local fix.
  - The global `:focus-visible` rule.
  - `focus-visible:opacity-100` / `focus-within` for the hover-only
    controls (gap 6).
  - Real buttons or links for the click-only `div`s: Costs breakdown,
    org-chart cards, attachment and image openers (gaps 3, 5, 8).
  - `KeyboardSensor` with `sortableKeyboardCoordinates` for the 4
    `DndContext`s without it (gaps 1 and 9, drag part). Drop the unnamed
    `role=button` stop per sidebar project.
  - The `InlineEditor` keyboard branch for single-line titles (gap 2).
  - Keyboard separators for the resize handles, reusing `SidebarShell`
    (gap 10).
  - The search page fixes (chips stay while focus is in the search region,
    one `/` handler through `data-page-search-target`).
  - The two gaps slice 1 found: give the chat shell's composer a focus
    handle (so `g c` and "Comment on this task" work in the default shell),
    and make "Open file in this issue" / `g f` work on phones (a sheet when
    the side panel is hidden).
  - `aria-label` for `HintIcon` and the unnamed icon buttons on the main
    pages.
  - `@axe-core/playwright@4.13.0` (root devDependency, test only, MPL-2.0).
    It drives `tests/e2e/keyboard-a11y.spec.ts`, which scans the main pages
    and Tab-walks each one. The axe rules start as a baseline of today's
    violations, and the count can only go down.
- **2b, lists and pickers:**
  - One `useListNavigation` hook, extracted from the five existing j/k
    implementations, that moves DOM focus and sets `aria-selected`.
    `IssuesList` and Inbox move to it after a check with the issues thread.
  - Kanban board navigation in two dimensions, plus "Move to status".
  - One Command-based picker that replaces the about 17 Tab-only popover
    pickers (gap 7).
  - Timeline chart keyboard access through a list fallback (gap 4).
- **2c, page actions:** pages register their actions with
  `useRegisterCommandActions`:
  - issue detail: status, priority, assignee, labels, project, copy link;
  - agent detail: pause, resume, run a heartbeat;
  - approval detail: approve and reject, with the existing confirmation;
  - routine: run now, pause;
  - project: new task in this project.

  Each action calls an existing API operation. The PR for 2c lists the
  CLI command for each one, and opens a follow-up for any that is missing.

### Slice 3: search over every entity

- `companySearchService` (`server/src/services/company-search.ts:538`)
  returns more kinds: `goal`, `routine`, `approval`, `skill`, `run` and
  `activity` (activity and audit entries).
- Small tables (goals, routines, approvals, skills) use the same ILIKE
  phrase-or-token match and JS scoring as agents and projects
  (`company-search.ts:470-480`, `:526`).
- Activity and runs can be large tables with no trigram index. The match uses
  structured fields (action, entity type, actor and entity names, run
  status), bounded by a recent window and the existing `created_at`
  ordering. Add a trigram index (a migration) only if a measured query plan
  on a seeded company needs one.
- `packages/shared`: the `scope` enum, the result `type` union and the
  validators.
- OpenAPI: document the query parameters, 403 and 429 for the search route
  (today they are missing, `server/src/routes/openapi.ts:9605`).
- CLI: `search --scope` accepts the new kinds.
- UI: the palette entity groups and the `/search` page show the new kinds.
  The palette calls `/search` with a 150 ms debounce and cancels stale
  requests. It keeps `issuesApi.list({ q, includeRoutineExecutions: true })`
  for tasks, because that behaviour is tested today.

### Slice 4: Jev intent suggestion (tier 2)

Waits for `#40` (approved at `6ce3c845`, in the captain's landing order). It
uses `createJudgeClient` and the company secret `AI_GATEWAY_API_KEY` from
`#40` and adds no migration.

- Server: `POST /companies/:companyId/command-intent` with `{ text, view }`.
  - It builds the candidate list from the catalog, filtered for the actor and
    the view.
  - It asks one `choice` question through `JudgeClient.ask` and returns
    `{ suggestion: { actionId, confidence } | null }`.
  - Every judge failure (`no_key`, `timeout`, `cap_exceeded`, `error`) returns
    `suggestion: null` with HTTP 200, so the palette never breaks.
  - A rate limit like the search route's. It mutates nothing, so it writes no
    activity entry.
- UI: when the query has at least 3 characters, the input is idle for
  400 ms, and no local action has a prefix-band match, the palette asks for a
  suggestion. It shows the answer as one "Suggested" row. Nothing runs until
  the user selects that row. A mutating action then opens its normal dialog
  or confirmation.
- CLI: `paperclipai intent "<text>" [--view] [--json]` prints the suggestion
  and its operation. It never runs the action.
- Opt-in: see decision D2.

### Parity per capability

| Capability | Web | REST API | CLI |
| --- | --- | --- | --- |
| Open a page or run a global action by keyboard | palette, chords (1) | none needed: a UI affordance over existing routes | none needed |
| Search entities | palette, `/search` | `GET /companies/:id/search` (exists; more kinds in 3) | `search` (new in 1; kinds in 3) |
| Page actions (status, assign, approve, run) | "This view" rows (2c) | existing routes | existing commands; gaps get follow-ups (2c) |
| Intent suggestion | "Suggested" row (4) | `POST /companies/:id/command-intent` (4) | `intent` (4) |

## 5. Tests and verification

Every slice:

- **Red first.** Each new behaviour gets a test that fails on `main` before
  the code exists.
- **Unit:** the shared catalog (unique ids, unique shortcuts, no global
  single-key shortcut on a key that list pages use), `scoreTextMatch` bands,
  and `rankCommandActions`.
  - Ranking cases: contextual boost, frecency decay, the frecency ceiling,
    empty query, a stable tie order.
  - A timing test: 200 actions ranked in less than 2 ms (median of 50 runs).
- **UI:** `CommandPalette.test.tsx` keeps all its current cases:
  - Search all, Cmd+Enter and empty Enter go to `/search`;
  - the quick-filter chips;
  - the project promotion;
  - `includeRoutineExecutions: true`;
  - the file-viewer action that needs the experimental flag.

  New cases cover the group order, "This view" registration and its removal
  on unmount, frecency, and the chords. One new test renders the real `cmdk`
  (no mock of `@/components/ui/command`), to prove that `shouldFilter={false}`
  reaches cmdk and the row order is ours.
- **CLI:** a parity test in the style of
  `cli/src/__tests__/operations-parity.test.ts` asserts the exact
  `[method, url]` of `search` (slice 1) and `intent` (slice 4).
- **Server (slices 3 and 4):** route tests for company access, agent
  access, rate limit, scope validation, and the judge failure modes
  (`no_key`, `timeout` return `suggestion: null`). OpenAPI coverage passes
  (`openapi-routes.test.ts`).
- **CI gating:** append the new unit test files to the `Dockerfile:136`
  list.
- **e2e** (`pnpm test:e2e`, Playwright): keyboard-only journeys, plus axe from
  slice 2. Seed an agent first, because the onboarding wizard otherwise
  covers every page.
- **Real browser:** at 1440 px and 390 px widths, check the journeys by
  keyboard only, with zero console errors.
- **Bundle:** report the initial-JS gzip delta. If `#68` has merged, its
  budget plugin reports it. If not, compare `vite build` output before and
  after.
- **Checks:** `cd ui && npx tsc --noEmit -p .`, `pnpm check:token-gates`,
  and the touched package tests. The full `pnpm -r typecheck` cannot finish
  on dev hosts without cargo; CI's image build runs it.

## 6. Risks

| Risk | Mitigation |
| --- | --- |
| Enter with a query opens a different row than today (cmdk sorted rows by its own score; now our order decides). | Tests pin the first row for each query shape. Cmd+Enter and empty Enter keep going to `/search`. Decision D3. |
| A new chord or bare key fires while the user types, or over a dialog. | Reuse `isKeyboardShortcutTextInputTarget` and `hasBlockingShortcutDialog`. Unit tests for both guards. |
| Chords collide with page handlers (`IssueDetail` capture phase `g c`/`g f`, Inbox `a y r U`, `IssuesList` j/k). | The catalog test rejects collisions. `IssueDetail` keeps its capture-phase handler. |
| Two layout shells (`Layout.tsx`, `Layout.production.tsx`) drift. | Both mount the same provider and palette. A test renders each shell. |
| Merge conflicts with `#68` (it edits `Layout*.tsx` and `App.tsx`). | Slice 1 touches `Layout*.tsx` in a few lines only. Whichever PR lands second rebases. |
| Frecency storage leaks entity data. | It stores action ids and timestamps only. Entity recents stay in the existing recent-tasks store. |
| Hidden actions look like a permission control. | Hiding is cosmetic. The server stays authoritative. `requires` maps only to signals the UI already reads (`CurrentBoardAccess`: instance admin, membership role). There is no endpoint for effective permissions, and this plan adds none. |
| Activity search scans a large table. | A bounded window, a limit, structured fields. Measure the query plan before adding an index. |
| Slice 4 sends the user's typed text to the AI Gateway (an external service). | Off by default (D2). Fail-open. The daily cap from `#40`. The PR text names the data that leaves the instance. This is a product feature call like `#40`. It is not the Telemetry, Observability or run-log data path (`AGENTS.md` §5.7). |
| `#22` (API coverage matrix, open) ratchets new API routes without a CLI command. | Slices 3 and 4 ship the CLI command in the same PR. |

## 7. Decisions

### For the user

Decided on 2026-10-09: every recommendation below was taken (D1 the table as
written, D2 (a), D3 (a), D4 per browser, D5 90 days). The user can override
any of them.

- **D1. The `g` letters** in section 3.5. Proposal: the table as written.
- **D2. How a company turns on Jev suggestions (slice 4).**
  - **(a) Recommended:** an instance experimental flag
    (`instance_settings.experimental` is JSONB, so no migration), plus the
    company secret `AI_GATEWAY_API_KEY` that `#40` already uses.
  - **(b)** A per-company setting. It needs a column or a settings JSON
    field, and a migration slot in the landing order.
- **D3. Enter with a query.**
  - **(a) Recommended:** Enter opens the best local match (action or
    entity). "Search all" stays one arrow key away, and Cmd/Ctrl+Enter always
    opens `/search`.
  - **(b)** Keep "Search all" as the first row.
- **D4. Frecency per browser** (localStorage, like the theme preference), or
  synced per user on the server. Recommended: per browser now; a sync can
  come later.
- **D5. Activity search window** for slice 3. Recommended: the last 90 days,
  with a "Search all" link to the full activity page.

### Made in this plan (open to review)

- The catalog lives in `packages/shared`, because the server and the CLI need
  it in slice 4.
- Slice 4 waits for `#40` to merge instead of stacking on it. `#40` is
  approved and in the landing order, and slice 4 is last anyway.
- `@axe-core/playwright@4.13.0` (MPL-2.0) is a test-only root
  devDependency. It is older than 7 days, so it passes the npm release-age
  cooldown.
- The palette stays eager in slice 1. Lazy loading happens only if the
  measured bundle delta needs it.
