# Web app speed: every page fast by mouse and keyboard, and whether to move to Next.js

Date: 2026-10-10
Status: Plan only. No code ships with this pull request. Implementation starts after the plan is approved.
Branch: `docs/web-app-speed-nextjs-plan`
Builds on: #50 (web-perf plan and the harness `tests/perf/web-app/`), #53, #54, #57, #68, #87 (open), #84 (merged), and the keyboard work in #86 and #95 (open).

## 0. The answer in short

1. **Do not move the web app to Next.js now.** The slow pages are slow for reasons that a framework does not remove: API calls that wait for each other, page code that starts to load only after the click, pages without a loading state, unbounded lists, and heavy first renders (section 5.6). For warm navigation inside the app, which is most of a session, a finished single-page app is as fast as Next.js or faster, because Next.js must still ask the server after each click for per-user live data (section 6.5). A move costs a router rewrite across 248 files, a second server runtime inside a 2 GB container, and a new server attack surface (section 7).
2. **Finish the single-page app instead (option B).** Land the measured perf PRs (baseline B1), then nine slices: start the boot calls at once, prefetch page code and data on intent (hover, focus, launcher highlight), show a skeleton at once on every navigation, fix the named slow pages, keep data across reloads, and set budgets (section 9).
3. **What to expect (`wan` profile, 40 ms, 50 Mbps, 2x CPU):**

   | | B0, `main` | B1, `main` + perf PRs | B, this plan |
   |---|---|---|---|
   | Cold load, board LCP | 2,736 ms [M50] | 1,672 ms [M50] | about 1,550 ms first visit; 0.8-1.0 s repeat visit [D] |
   | Cold load, issue with 400 comments, usable | 6,808 ms [M50] | 4,751 ms [M50] | 2,500 ms or less (target) |
   | Network wait after a click or Enter, first visit | 70-210 ms [D] | 125-275 ms [D] | 0 ms when hovered or highlighted for 150 ms; 70-140 ms otherwise [D] |
   | Network wait on a revisit | 0 ms within 5 min, then a full fetch [D] | same | 0 ms [D] |

   "Usable" means the main region shows real data and accepts input. Every warm navigation also pays the client render of the new page, about 80-240 ms at 2x CPU [D]. No option removes that cost; slices S6 and S9 reduce it.
4. **Server rendering stays possible, behind a number.** Server rendering wins clearly in one case only: the first pixels of a cold load on a slow link, before the JavaScript arrives (about 2 s sooner on `slow`, about 6 s sooner on `mobile` [D]). It does not make the page usable sooner, because the same JavaScript must still load. A cheap probe measures that ceiling without any framework install (section 9.3). If B misses the cold target and the probe shows that server rendering meets it, the next step is React Router framework mode (same Vite, same Express process), not Next.js.

## 1. Goal, scope, and how to read the numbers

**Goal** (the user, 2026-10-10): every view as fast as possible, by mouse and by keyboard; clear numbers before, after, and what to expect; better layouts and loading states.

**Definitions**

- **Cold load:** open a URL in a new tab with an empty HTTP cache. This happens on a new tab, on a link from outside the app, and after each deploy, because a deploy changes every asset name. A parked tab reloads itself while it is hidden after a deploy (`ui/src/lib/service-worker-updates.ts`), so that cost is often hidden from the user.
- **Warm navigation:** a click, Enter, or shortcut inside a loaded app. *First visit* means that the page code and its data are not in memory yet. *Revisit* means that they are.
- **Usable content:** the main region of the page shows real data and accepts input. The harness detects it with a per-page text or selector (`readyText` in `tests/perf/web-app/measure.mjs` on #50), not with LCP, because the LCP element can be a skeleton.
- **INP:** the time from an input to the next paint (Event Timing API).

**Labels on numbers**

| Label | Meaning |
|---|---|
| [M50] | Measured in #50 (`doc/plans/web-perf.md` on that branch), on a Mac with the 1,000-issue fixture, median of 3 to 5 runs. Reused, not fresh. |
| [M68] | Measured in the #68 pull request body (interleaved A/B). Reused. |
| [CI] | Read from the "Build production image" log of a CI run (Vite build output). Fresh, but byte sizes only. |
| [D] | Derived with the model in section 6.1. An estimate that the phase 2 measurement replaces. |
| [F] | Fresh browser measurement. **None yet.** Phase 2 runs only after the manager confirms that the disk allows an install. |

**Profiles** (`tests/perf/web-app/measure.mjs` on #50)

| Profile | Network | CPU | Meant to represent |
|---|---|---|---|
| `desktop` | localhost | 1x | upper bound; app work only |
| `wan` | 40 ms RTT, 50 Mbps | 2x | laptop on a Tailnet or office link; the main target profile |
| `slow` | 50 ms RTT, 9 Mbps | 4x | weak machine or distant peer |
| `mobile` | 150 ms RTT, 1.6 Mbps | 4x, 390 px wide | phone on a weak cellular link (defined in the harness, not used in #50's tables) |
| `laptop` (new, slice S1) | 40 ms RTT, 50 Mbps | 1x | a fast laptop on a remote link; separates network cost from CPU cost |

**Caveats**

- The #50 numbers are at `a91d77cc4` (2026-10-09). `main` has moved since: #84 (board column invalidation) and #48 (theme) merged. The entry chunk grew from 6,393 KB to 6,551 KB raw (+2.5%) [CI, publish job for `3fca7f35e`]. The B0 numbers are therefore close, not exact.
- The #50 fixture runs the server in `local_trusted` mode. Production runs `authenticated`. Company pages wait the same number of round trips in both modes (section 3.2), but in `authenticated` mode the issue page waits one more level (for `/api/cli-auth/me`), and every request does a session lookup. Slice S1 adds an `authenticated` fixture.
- Production link quality, API latency and the mix of devices are unknown (#50 open question 2). The host used for this plan cannot reach the production instance. All numbers come from the fixture.
- Load on the measuring machine makes single runs meaningless (#50 section 10.4). Every comparison in phase 2 is interleaved and repeated (section 10).

## 2. The two baselines

- **B0** is `main` at `38819d350`.
- **B1** is B0 plus #53 (issue polling), #54 (no refetch of instance-level queries when the socket opens), #57 (precompressed br/gz assets), #68 (lazy route chunks and an initial-JS budget), and #87 (live-run placeholder size). All five are open and belong to the web-perf track. #84 is already in B0.

Every option below is compared with **B1**, not B0, so that no framework gets credit for work that the open PRs already do.

## 3. How the app loads today

### 3.1 One process, one origin

```
browser ──HTTPS──> ingress ──> Express, one Node process (server/src/index.ts:929)
                                 ├─ /api/*                     REST, gzip >= 1 KB (server/src/middleware/api-compression.ts)
                                 ├─ /api/companies/:id/events/ws   live events, same HTTP server
                                 │                               (server/src/realtime/live-events-ws.ts:92-93, 291)
                                 ├─ /_plugins/:id/ui/*          plugin UI bundles (server/src/routes/plugin-ui-static.ts:230)
                                 ├─ /assets/*                   hashed JS and CSS, 1 year, immutable (server/src/app.ts:995-1001)
                                 └─ everything else             index.html, no-cache, empty #root (server/src/app.ts:1003-1005, 1027-1037)
```

In development the UI is served through Vite middleware in the same process (`server/src/app.ts:1072-1133`). The deploy compose file runs the image with a read-only root file system, `mem_limit: 2g`, `--max-old-space-size=1536`, and `cpus: 2.0` (`deploy/compose.yaml:6, 24, 34-36`).

### 3.2 Boot sequence: how many round trips before page data

Cold load of a company page, for example `/:companyPrefix/issues`:

```
level  request                                       why it waits
-----  --------------------------------------------  ----------------------------------------------------
 1     GET index.html (9 KB)                          -
 2     GET entry JS + CSS                             found in index.html
       parse and run JS; first paint is a spinner (FCP)
 A1    GET /api/auth/get-session                      CompanyProvider, no `enabled` (ui/src/api/companies-query.ts:76-79)
       GET /api/health                                CloudAccessGate, LiveUpdatesProvider
       GET /api/instance/settings/experimental        App renders a spinner until it loads (ui/src/App.tsx:805, 815)
 A2    GET /api/companies?scope=accessible            enabled only after the session succeeds (ui/src/api/companies-query.ts:90-95)
       GET /api/cli-auth/me (authenticated only)      CloudAccessGate waits for it (ui/src/components/CloudAccessGate.tsx:102-109, 172-174)
 (B1)  GET page chunk                                 lazy() starts when the route renders, after the gate
 A3    GET page data                                  needs selectedCompanyId, which starts as null and is set in an
                                                      effect from the company list (ui/src/context/CompanyContext.tsx:112;
                                                      ui/src/components/Layout.tsx:284-345)
 A4+   dependent page data                            page-specific (section 5.5)
```

So a company page is **5 levels deep on B0** (HTML, JS, A1, A2, A3) in both deployment modes. On B1 a lazy page is **6 levels deep in `authenticated` mode** (production): the gate waits for A2, then the route renders and its chunk loads, then A3. In `local_trusted` mode (the #50 fixture) the gate opens after A1, so the chunk loads in parallel with A2. A1 and A2 are pure overhead: they exist only to learn who the user is and which company the URL names.

At A3, every page also starts the shell queries (`ui/src/components/Sidebar.tsx:64-115`, `ui/src/hooks/useInboxBadge.ts:180-257`, `ui/src/context/EditorAutocompleteContext.tsx:54-67`): inbox badge (including the user's issues, limit 500, full rows, and runs, limit 200), live runs, agents, projects, plugin contributions, skills and routines. They compete with the page data for the same link.

When the live-events socket opens, `LiveUpdatesProvider` invalidates every active query (`ui/src/context/LiveUpdatesProvider.tsx:2064-2066`). #54 excludes instance-level queries. Company page data that arrived before the socket opened is still fetched a second time on a cold load (in-flight queries are not restarted: `cancelRefetch: false`).

### 3.3 Cache behaviour today

| Layer | Behaviour on B0 | Source |
|---|---|---|
| `index.html` | `no-cache`; read from disk on each request; branding comments replaced; no data injected | `server/src/app.ts:1003-1005`, `server/src/static-index-html.ts:5-7` |
| `/assets/*` | 1 year, `immutable`; not compressed on B0 (B1: precompressed br/gz) | `server/src/app.ts:995-1001`; #57 |
| Other static files | 1 hour; `index.html` and `sw.js` `no-cache` | `server/src/static-ui-cache.ts:16-18` |
| `/api/*` | gzip for JSON of 1 KB or more; no shared caching | `server/src/middleware/api-compression.ts` |
| Service worker | Network-first for every non-API GET, including navigations; stores only hashed assets, as an offline fallback; one cache per build | `ui/public/sw.js:48-113` |
| TanStack Query | `staleTime` 30 s, `gcTime` 5 min, refetch on focus; in memory only; no persistence | `ui/src/main.tsx:42-53` |
| Intent prefetch | Issue links only: issue detail and the first comment page on hover, focus, touch and click; not the page chunk | `ui/src/components/IssueLinkQuicklook.tsx:360-391`, `ui/src/lib/issueDetailCache.ts:185-196` |
| Keyboard navigation | The launcher and `g` chords call `navigate()`; no prefetch | `ui/src/components/CommandPalette.tsx:176-179`, `ui/src/lib/keyboardShortcuts.ts:181-211` |

Two consequences:

- With `gcTime` 5 min, the data of a page that you left more than 5 minutes ago is dropped. A revisit after that is a first visit for data.
- The service worker's fetch handler sees every navigation. A navigation in a tab that the worker controls waits for the worker to start. Navigation preload is not enabled (no `navigationPreload` in `ui/`). This cost is not measured yet (slice S8).

## 4. Route inventory

All routes are in `ui/src/App.tsx`. Company routes come from `boardRoutes()` (`ui/src/App.tsx:150-476`) under `/:companyPrefix` with `Layout`. App.tsx has 269 `<Route>` elements, about 242 at run time in the default shell. On B0, 79 page modules load eagerly and 8 lazily; in the default (streamlined) shell only `company/export/*` is lazy. #68 makes 84 pages lazy.

Layout: `CloudAccessGate` and `Layout` (sidebar, breadcrumb, launcher, dialogs) stay mounted across navigations (`ui/src/components/Layout.tsx:618-793`). On B0 there is no Suspense boundary around the layout outlet. #68 adds one (`RouteSuspense`, a centered loader).

### 4.1 Top routes, by importance

"Chunk" is the route's own lazy chunk on B1, gzip, from the #68 CI build log [CI]. "Depth" counts levels to usable content on a B1 cold load in `authenticated` mode, as in section 3.2.

| Tier | Area | Main paths (under `/:companyPrefix/`) | Chunk, gzip | Depth (cold, B1, authenticated) | Loading state | Live data |
|---|---|---|---|---|---|---|
| 1 | Tasks board and list | `issues` (board or list view) | Issues 3 KB (+ shared code) | 6 | Board: skeleton per column; list: skeleton | yes |
| 1 | Issue detail | `issues/:issueId` | IssueDetail 117 KB, plus IssueChatThread 68 KB | 6 (5 in `local_trusted`); sub-panels +1; a UUID link redirects and re-keys, +1 | Skeleton, seeded from router state | yes, plus polls |
| 1 | Dashboard | `dashboard` | 7 KB | 6; live-run cards 7 | Skeleton | yes |
| 1 | Inbox and decisions | `inbox/*`, `decisions`, `approvals/*` | Inbox 32 KB | 6; waits for all 7 queries | Skeleton | yes |
| 1 | Launcher (Cmd+K) | overlay in `Layout` | in the shell | queries run while open | results list | - |
| 2 | Agent detail | `agents/:agentId`, `/:tab` | AgentDetail 55 KB | header 6, overview 7 | Skeleton; runs tab: none ("No runs yet." shows while loading) | yes, plus polls |
| 2 | Run transcript | `agents/:agentId/runs/:runId` | in AgentDetail | 8: the run is found in the agent's full run list | Text "Loading run logs..." | yes, plus polls |
| 2 | Agents list | `agents/{all,active,paused,error,builtin}` | Agents 8 KB | 6 | Skeleton | polls 15 s |
| 2 | Project detail | `projects/:projectId/*` | 12 KB | header 6, issues 7 | Skeleton | yes |
| 2 | Activity, runs, costs | `activity`, `activity/{runs,costs,budgets,timeline}` | Costs 7 KB | 6 | Text "Loading runs…", "Loading…"; costs skeleton | polls 15-30 s |
| 2 | Routines | `routines`, `routines/:routineId` | 9 KB | 6 | Skeleton | detail polls 3 s |
| 3 | Company settings | `company/settings/*` | 7 KB | 5 (no own queries) | None; gates render nothing | badge poll 15 s |
| 3 | Instance settings | `company/settings/instance/*` | small | 6 | Text "Loading…" | - |
| 3 | Projects, goals, skills, apps, plugins | `projects`, `goals/*`, `skills/*`, `apps/*`, `plugins/:pluginId` | 1-40 KB | 6 | Mixed; several gates render nothing | some |
| 4 | Auth, onboarding, labs | `auth`, `invite/:token`, `onboarding`, `ux-lab/*`, `tests/perf/long-thread` | - | - | - | - |

Sources: `ui/src/App.tsx:150-476, 799-888`; loading states in `ui/src/pages/Dashboard.tsx:311-313`, `ui/src/components/IssuesList.tsx:1996`, `ui/src/components/KanbanBoard.tsx:283-285`, `ui/src/pages/IssueDetail.tsx:6855-6874`, `ui/src/pages/AgentDetail.tsx:1152, 3302-3303, 4454-4455`, `ui/src/pages/Inbox.tsx:2735-2737`, `ui/src/pages/CompanySettings.tsx:200-205`, `ui/src/pages/audit/AuditRuns.tsx:251-253`; blank gates in `ui/src/components/HiddenSettingsPageGate.tsx:14` and `ui/src/components/IsolatedWorkspacesRouteGate.tsx:25`.

## 5. Before: B0 and B1 per top route

### 5.1 Cold load

TTFB is not in #50's tables. On the fixture it is one round trip plus a file read: about 40 ms on `wan`, 50 ms on `slow` [D].

`wan` (40 ms, 50 Mbps, 2x CPU):

| Page | FCP B0 → B1 | LCP B0 → B1 | Usable (TTI) B0 → B1 |
|---|---|---|---|
| Dashboard | 2,076 → 624 ms | 2,732 → 876 ms | 2,911 → 1,113 ms |
| Tasks board | 2,088 → 664 ms | 2,736 → 1,672 ms | 3,054 → 2,111 ms |
| Tasks list | 2,156 → 620 ms | 3,228 → 1,120 ms | 3,290 → 1,053 ms |
| Issue, 400 comments | 2,092 → 648 ms | 2,952 → 1,224 ms | 6,808 → 4,751 ms |
| Agents | 2,164 ms (B0) | 2,512 ms (B0) | 3,538 ms (B0) |

`slow` (50 ms, 9 Mbps, 4x CPU):

| Page | FCP B0 → B1 | LCP B0 → B1 | Usable (TTI) B0 → B1 |
|---|---|---|---|
| Dashboard | 9,344 → 1,816 ms | 9,744 → 2,268 ms | 10,066 → 2,630 ms |
| Tasks board | 9,408 → 1,984 ms | 9,924 → 2,604 ms | 10,284 → 3,059 ms |
| Issue, 400 comments | 9,340 → 1,876 ms | 10,280 → 3,236 ms | 13,850 → 6,322 ms |

`desktop`: every page has LCP 376-500 ms on B0; the board is 464 → 484 ms on B1 (three repeats 468, 484, 488). The issue pages have TTI 3,844-3,851 ms and settle at 6.6 s on B0 because of polling and run-log reads.

All numbers [M50] (B0: #50 section 3.2; B1: #50 section 10.2, PR C plus PR D merged locally). Not measured anywhere yet: inbox, agent detail, run transcript, project detail and settings on `wan`/`slow`, and every page on `mobile`.

### 5.2 Warm navigation (click and keyboard)

**No warm-navigation timing exists today.** #50 measured cold loads and scripted interactions only. The values below are the *network wait* after the input on `wan` [D], from the levels in sections 3.2 and 5.5 and the chunk sizes in section 4.1. The client render of the new page comes on top (about 80-240 ms at 2x CPU [D], section 6.1).

| Route | B0, no prefetch | B1, no prefetch | B1, issue link hovered (data prefetched today) | Keyboard on B1 (launcher Enter, `g i`) |
|---|---|---|---|---|
| Board | 93 ms (1 level + 150 KB of lists) | 134 ms (+ chunk 41 ms) | - | 134 ms |
| Issue detail | 70 ms | 157 ms (chunk 87 + 70) | 87 ms (chunk only) | 157 ms; Enter on a list row prefetches data, still 87 ms |
| Inbox | 107 ms (1 level + about 3 × 79 KB) | 161 ms | - | 161 ms (`g i`) |
| Dashboard | 82 ms (+70 for live-run cards) | 125 ms | - | 125 ms |
| Agent detail, overview | 140 ms (2 levels) | 204 ms | - | 204 ms |
| Run transcript | 210 ms (3 levels) | 274 ms | - | 274 ms |

On a revisit within 5 minutes (data in the Query cache, chunk in memory), the network wait is 0 ms on B0 and B1; data refreshes in the background. After 5 minutes the data is gone (`gcTime`), and the first-visit row applies again.

On B1, a navigation to a page whose chunk is not loaded keeps the old page on screen with no feedback until the chunk arrives, because React Router runs navigations inside a transition (#50 section 10.4). The launcher and chords are the worst case: no hover lead, so the chunk and the data load one after the other.

### 5.3 INP

| Scenario | `desktop` | 4x CPU | Source |
|---|---|---|---|
| Board (worst: open filter) | 40 ms | 136 ms | [M50] section 3.6 |
| List (worst: open filter) | 40 ms | 108 ms | [M50] |
| Issue with 400 comments (worst: type in composer) | 24 ms | 36 ms | [M50] |
| Dashboard (worst: nav to tasks) | 16 ms | 32 ms | [M50] |
| Open filter, Linux build host | - | 488 ms board, 368 ms list | measured by the web-perf track at 4x on a slower Linux host (not in #50); relative use only, not comparable to the Mac numbers |
| Launcher: open, type, arrow, Enter | not measured | not measured | slice S1 |

On that host the open-filter cost is one task of about 460 ms: JS 140-240 ms, style recalculation 143-203 ms, paint 140-180 ms, from mounting about 393 components including 62 Radix checkboxes (web-perf track Chromium trace, not in #50). It is render work, not data.

### 5.4 JavaScript bytes

| | B0 | B1 |
|---|---|---|
| Initial JS, raw | 9,076 KB, 46 files [M50] | 4,822 KB, 13 files [M68] |
| Initial JS, gzip | 2,538 KB [M50] | 1,435 KB [M68] |
| Initial JS, brotli (on the wire with #57) | 1,970 KB [M50] | 1,163 KB [M68]; 1,157 KB measured on the wire (dashboard, `wan`) [M50 section 10.2] |
| Entry chunk on `main` today | 6,551 KB raw, 1,776 KB gzip [CI, `3fca7f35e`] | `app-core` 2,411 KB raw / 710 KB gzip; `index` 1,264 / 364; `react-vendor` 306 / 100; `icons` 85 / 25 [CI, #68] |
| CSS | 516 KB raw, 74 KB gzip [CI] | same |
| Budget | none | 5,050,000 B raw / 1,500,000 B gzip (`ui/bundle-budget.json` on #68) |

Per-route chunks on B1 are in section 4.1. The heaviest top-route chunks are IssueDetail (404 KB raw, 117 KB gzip) with IssueChatThread (224 KB raw, 68 KB gzip), and AgentDetail (211 KB raw, 55 KB gzip). `MarkdownEditor` (389 KB raw, 126 KB gzip) is its own chunk [CI, #68].

### 5.5 Requests and API waterfall depth

Cold load, `desktop`, B0 [M50]: dashboard 98 requests / 45 API calls; board 107 / 48; list 89 / 39; issue with 400 comments 159 / 108; agents 94 / 36; settings 76 / 26. On B1, #54 removes 5 to 7 API calls per load (board 48 → 43, settings 26 → 19) [M50 section 10.1]. #53 cuts idle requests on an open issue from 81 to 11 per minute [M50].

Levels after the page starts to render (warm navigation), from the waterfall reading at `38819d350`:

| Page | Level 1 (in parallel) | Then | Source |
|---|---|---|---|
| Board | 7 column queries, 200 rows each; the 100-row list query also runs in board mode (8 issue-list requests); agents, projects, live runs, labels | - | `ui/src/hooks/useBoardColumnIssues.ts:7, 89-114`; `ui/src/pages/Issues.tsx:243-276` |
| Issue detail | detail, comments (50 per page), activity, runs, interactions, attachments, work products, live runs, tree state | active run, children (`listAll`, pages of 500 until the end), created tasks, siblings, browsers, queued comments | `ui/src/pages/IssueDetail.tsx:3102-3405` |
| Dashboard | agents, summary, activity (10), issues (no limit, so 500), projects, members, live runs | issue detail for each live-run card, up to 4 | `ui/src/pages/Dashboard.tsx:86-205`; `ui/src/components/ActiveAgentsPanel.tsx:65-112` |
| Inbox | 7 queries, including 3 issue lists of 500 and 200 runs; the page waits for all of them | - | `ui/src/pages/Inbox.tsx:831-1072, 2388-2395` |
| Agent detail | agent | runtime state, runs (no limit), participant issues, skills | `ui/src/pages/AgentDetail.tsx:799-946` |
| Run transcript | agent | full run list, then the run is picked from it; then run, events, log | `ui/src/pages/AgentDetail.tsx:3306-3313, 3384-3391, 4069-4212` |
| Project detail | project, budgets | project issues (no limit), after the project loads | `ui/src/pages/ProjectDetail.tsx:221-225, 344-369, 861-863` |

### 5.6 Why each slow page is slow

| Page | Cause | Evidence | Fixed by |
|---|---|---|---|
| Every page, cold | Two levels of identity calls (A1, A2) before any page data; the company id is resolved from the full company list | section 3.2 | S3 |
| Every page, cold | The page chunk loads after the gate, then the data (B1 adds one level) | section 3.2 | S4 (loaders start data with the chunk) |
| Every page, cold | The shell fetches the user's 500 issues and 200 runs for the inbox badge on every page; the socket open refetches all page data | `ui/src/hooks/useInboxBadge.ts:180-257`; `ui/src/context/LiveUpdatesProvider.tsx:2064-2066` | S6 (count-only badge source is #50 item 10); S4 (skip the open refetch for queries fetched in the last few seconds) |
| Every page, warm | No prefetch except issue links; keyboard paths never prefetch; no feedback while the chunk loads | sections 3.3, 5.2 | S4, S5 |
| Issue detail | Usable at 4.75 s on `wan` (B1): many polls (1 s live runs on B0), unbounded activity and runs lists, 12 run-log reads, up to 150 comments auto-loaded page by page, a 117 + 68 KB chunk, a `documents/plan` probe that returns 404 on every open | [M50]; `ui/src/pages/IssueDetail.tsx:440, 1473`; `server/src/services/activity.ts:378-447` | #53 (B1), S6 |
| Tasks board | 8 issue-list requests (7 × 200 rows plus the list query); a status change or a new issue refetches all columns (#84 narrowed the other changes); the drag is not optimistic and refetches all 7 columns; a gap of about 1 s between first paint and LCP on `wan` that round trips do not explain | `ui/src/pages/Issues.tsx:274, 290-296`; [M50] | #84 (merged), S6, S9; the gap is traced in S1 |
| Inbox | Waits for all 7 queries; 3 × 500 issues plus 200 runs; the badge fetches the same 500 rows under another key | `ui/src/pages/Inbox.tsx:2388-2395`; `ui/src/hooks/useInboxBadge.ts:225-243` | S6 |
| Dashboard | A 500-row issue list with no limit; live-run cards fetch issue detail one level later; layout shift on mobile | `ui/src/pages/Dashboard.tsx:189-193`; #87 | #87 (B1), S6 |
| Agent detail | Unbounded run list; the overview waits one more level; the runs tab shows "No runs yet." while loading; the same agent is fetched twice under two keys | `ui/src/pages/AgentDetail.tsx:918-922, 3302-3303`; `ui/src/components/AgentContextualSidebar.tsx:63-67` | S5, S6 |
| Run transcript | 8 levels deep: the run is never fetched by its id | `ui/src/pages/AgentDetail.tsx:3306-3313` | S6 |
| Project detail | Issue list with no limit, mounted only after the project loads | `ui/src/pages/ProjectDetail.tsx:221-225, 861-863` | S4 (start both at once), S6 |
| Settings pages | No loading state; gates render nothing while they load | section 4.1 | S5 |
| Filter popover (board, list) | One 460 ms task at 4x CPU: mounts about 393 components | section 5.3 | S9 |

## 6. Options, compared with evidence

### 6.1 Model for derived numbers

| Input | Value | Basis |
|---|---|---|
| One serial API level | RTT + S: 70 ms `wan`, 80 ms `slow`, 180 ms `mobile`, 30 ms `desktop` | S = 30 ms is an assumption; #50 measured p50 12-190 ms per call on the fixture |
| Transfer | 0.156 ms per KB on `wan`; 0.868 on `slow`; 4.88 on `mobile` | profile bandwidth |
| Chunk cost | RTT + brotli size × transfer + raw size × 0.04 ms × CPU factor | the 0.04 ms per raw KB is fitted to B1's measured FCP on `wan` (2 RTT + 181 ms transfer + 4,822 KB × 0.04 × 2 ≈ 640 ms; measured 620-664 ms) |
| Client render of a page | 80-240 ms at 2x CPU | #50 `desktop` LCP minus FCP is 124-212 ms, which includes 3 local API levels; the page alone is assumed to be 40-120 ms at 1x. This is the largest unknown; S1 measures it per route |
| Server-rendered response | RTT + 50-200 ms server time (identity lookup, page data in process, render) + HTML transfer | assumption; the probe in section 9.3 measures the client side of it |

Every derived cell shows its inputs, so a reader can recompute it.

### 6.2 Option B: stay on Vite and React Router 7, and finish the job

What it adds on top of B1 (slices in section 9):

1. **Boot without serial identity calls (S3).** `index.html` gets `<link rel="preload" as="fetch" crossorigin="use-credentials">` hints for the five boot calls, and `main.tsx` starts them in parallel before the first render. The company id is resolved from the URL prefix with the boot list in the same tick. Page queries then start at the first render. Removes A1 and A2 from the serial path: **-140 ms on `wan`, -160 ms on `slow`, -360 ms on `mobile`** [D, 2 × (RTT + S)]. No user data goes into the HTML.
2. **Route intent registry (S4).** One small module maps each top route to its chunk import and its query options. The router wrapper (`ui/src/lib/router.tsx`, the single owner of `Link`, `NavLink` and `useNavigate`) calls it on hover (after a short dwell), on keyboard focus, on touch start, and at navigation time. The launcher calls it when a row stays highlighted. At navigation time the data starts together with the chunk (a client-side loader), so the chunk no longer delays the data.
   - With intent of 150 ms or more: network wait after the input **0 ms** for one-level pages [D].
   - Without intent (chords, fast clicks): wait = max(chunk, data) instead of chunk + data: **board 93 ms (was 134), issue 87 (was 157), agent overview 140 (was 204)** [D].
   - #50 found that *idle* prefetch of many chunks cost 2 s of TTI, and that a boot preload of the open route cost 250 ms of FCP. Intent prefetch of one route is a different thing, but it must pass its own A/B (#50 section 10.5 lists it as not measured).
3. **Immediate feedback and matching skeletons (S5).** The layout stays mounted. Each route gets a skeleton that has the final layout's shape. A navigation that is not ready within about 100 ms shows the skeleton instead of a frozen old page. React Router 7.15 and later has a `useTransitions` prop that stops wrapping router updates in a transition; a per-route Suspense boundary is the other way. The spike compares both.
4. **Query cache that survives a reload (S7).** Longer `gcTime` for top-route data, and an opt-in persisted cache (company-scoped, stamped with the build id, cleared on sign-out). A repeat cold load renders the last data at first paint and refreshes it in the background: **board LCP about 0.8-1.0 s on `wan`** (B1 FCP 664 ms plus render) [D].
5. **Named slow-page fixes (S6)** and **render work (S9)**, which every option needs.

Expected after B (`wan`): see section 6.5. Cost: 9 slices, mostly small or medium, each one revertible on its own. Risk: low to medium. The persisted cache keeps company data in the browser; that needs a decision (open question 3). What breaks: nothing structural. Plugins, the socket, optimistic updates, tests and deploy stay as they are.

### 6.3 Option C: React Router framework mode (keeps Vite)

What it is: React Router's framework mode adds route modules with `loader`/`clientLoader`, `<Link prefetch="intent">`, server rendering with streaming, and its Vite plugin. It can run as a request handler inside the existing Express app (`@react-router/express`), so one process stays one process (to verify in a spike).

Status as of 2026-10-10:

- React Router v8 shipped on 2026-06-17 (ESM-only, `react-router-dom` removed, Node 22.22+ and React 19.2.7+). v7 still gets security fixes. The repo uses `react-router-dom` 7.18.4.
- **React Server Components in React Router are still unstable** in v8.4.0 (2026-09-15). The docs mark every RSC API as unstable and say that unstable features are not for production.
- Server rendering without RSC is stable.

Two steps:

1. **C1, SPA mode (`ssr: false`) with `clientLoader`:** the same result as option B (loaders, intent prefetch, pending UI with `useNavigation`), with framework conventions. It needs the v8 upgrade and a move of 242 routes from `App.tsx` into route modules. It adds no speed over B by itself.
2. **C2, server rendering:** the HTML has the page content, so the first pixels come before the JavaScript. Cold load LCP **about 0.3-0.5 s on `wan`, 0.4-0.7 s on `slow`, about 1 s on `mobile`** [D, ceiling]. The page is not usable until the JavaScript has loaded and hydrated: usable time stays close to B's (section 6.5). Warm navigation with server loaders waits 100-250 ms for the server after each click [D], unless the route uses `clientLoader` with the Query cache, which is option B again.

Cost: C1 about 4 to 6 pull requests (v8 upgrade, route modules, loaders); C2 about 5 to 8 more (server entry in Express, a server-safety audit of 1,391 references to `window`, `document`, `localStorage`, `sessionStorage` or `matchMedia` in non-test UI code, hydration of the Query cache, plugin placeholders). Risk: medium (C1), high (C2). What breaks: route definitions move; every module that reads browser globals at import or render time must be made safe for the server; hydration mismatches appear as console errors.

### 6.4 Option A: Next.js App Router

What it is: React Server Components, streaming server rendering, nested `layout.tsx` and `loading.tsx` files, `<Link>` prefetch, and a client router cache. Next.js 16.3 (2026-08-03) adds opt-in "Instant Navigations": `cacheComponents` and `partialPrefetching` prefetch a route's loading shell before the click.

How it would be adopted: Next.js's own Vite migration guide starts with the whole SPA inside one client-only catch-all route (`app/[[...slug]]`, `ssr: false`, `output: 'export'`). That step gains nothing; the gains come only when routes move to the App Router. Two routers that both write browser history (React Router inside the catch-all, the App Router outside) are hard to combine, so in practice the router swap is one large change or a long period with full page loads between the two worlds (to verify if A is ever pursued).

Expected numbers:

- **Cold load:** the same as C2 for first pixels (0.3-0.5 s LCP on `wan` [D, ceiling]). Server Components could remove some client JavaScript for read-only parts (for example markdown rendering of old comments). The live, interactive parts (board, thread, runs, dashboard panels, inbox, sidebar badges, launcher, plugin slots) stay client components with TanStack Query, so the saving is small: an estimate of 5-15% of initial JS [D].
- **Warm navigation:** per-user live data is dynamic. With the default prefetch, the shell shows at once, and the data needs one server request after the click: **100-250 ms on `wan`** [D]. Full prefetch (`prefetch={true}`) renders the whole target page on the server for every link in view; a board shows about 70 card links. A revisit refetches dynamic data unless it is cached on purpose. To beat this, the app would still prefetch through TanStack Query on intent, which is option B's work.
- **INP:** no change. INP is handler and render work (section 5.3).

Cost: about 18 to 25 pull requests: build and deploy (2-3), the router swap across 248 non-test files and 38 test files that import the router (one very large change or several large ones), the server-safety audit (as in C2), per-route server data for the top 10 routes, a plugin bridge shim (the bridge gives plugins React Router's `useLocation` and `useNavigate`, `ui/src/plugins/bridge.ts:28`), and the service worker's asset rule (`/assets/` becomes `/_next/static/`). Risk: high. What breaks: every route file and link, the plugin SDK router hooks, the Vite build plugins (bundle budget, precompression, service-worker build id), dev mode (Vite middleware), the e2e `webServer` build command, and the release-smoke image.

### 6.5 Side by side (`wan` unless stated)

Cold load, LCP. First visit / repeat visit.

| Route | B0 [M50] | B1 [M50] | B [D] | C2 or A, server-rendered [D, ceiling] |
|---|---|---|---|---|
| Tasks board | 2,736 ms | 1,672 ms | about 1,555 / 760-960 ms | 300-500 ms |
| Dashboard | 2,732 ms | 876 ms | about 750 / about 750 ms | 300-500 ms |
| Tasks list | 3,228 ms | 1,120 ms | about 1,000 / 720-920 ms | 300-500 ms |
| Issue, 400 comments | 2,952 ms | 1,224 ms | about 1,085 / 750-950 ms | 350-550 ms |
| Board on `slow` | 9,924 ms | 2,604 ms | about 2,445; about 2,050 with S10's JS cut | 400-700 ms |
| Board on `mobile` | not measured | about 8.0 s before render [D] | about 7.6 s before render; 5.6 s of it is the JS transfer (1,157 KB br); about 5.4 s with S10 | 0.8-1.3 s |

How the B column is derived:

- **First visit** = measured B1 minus the serial wait that S3 and S4 remove. On the fixture (`local_trusted`) B1 waits A1 + max(A2, chunk) + A3; B waits max(chunk, A3). That saves 117 ms on the board and the list, 128 ms on the dashboard, and 140 ms on the issue page (its queries do not need the company). In `authenticated` mode, B1 also waits for the chunk after A2, so the saving there is 180-230 ms.
- **Repeat visit** = B1 FCP plus 100-300 ms of render from the persisted cache (S7). The dashboard's first visit is already close to its FCP, so persistence adds little there.
- **`slow`** uses the same steps with 80 ms levels; S10 cuts 457 KB of brotli JS, about 400 ms at 0.868 ms per KB.
- **`mobile`** is not measured. The B1 value is 2 round trips (300 ms) + 5,649 ms of JS transfer + 772 ms of evaluation at 4x + 1,272 ms of levels and payload (A1 + max(A2, chunk) + A3, with 732 ms for the board's 150 KB of lists), before render. B waits max(chunk, A3) = 912 ms instead of 1,272 ms. S10 cuts about 2.2 s of JS transfer.

The server-rendered column is RTT + 50-200 ms on the server + HTML transfer + paint, with the CSS loaded in parallel. It is a ceiling: section 9.3 measures it.

Cold load, usable (TTI), `wan`:

| Route | B0 | B1 | B | C2 or A |
|---|---|---|---|---|
| Tasks board | 3,054 ms | 2,111 ms | about 2,000 ms first visit [D] | close to B: hydration needs the same 1.2 MB of JS [D] |
| Issue, 400 comments | 6,808 ms | 4,751 ms | 2,500 ms or less (target; needs S6) | the same causes remain without S6 |

Warm navigation, network wait after the input, first visit (render of 80-240 ms comes on top in every column):

| Route | B1 | B, intent 150 ms or more | B, no intent | C2 with server loaders, or A |
|---|---|---|---|---|
| Board | 134 ms | 0 ms | 93 ms | 100-250 ms |
| Issue detail | 157 ms (87 if hovered) | 0 ms | 87 ms | 100-250 ms |
| Inbox | 161 ms | 0 ms | 107 ms | 100-250 ms + 37 ms payload |
| Agent detail, overview | 204 ms | 0 ms | 140 ms (70 after S6 flattens it) | 100-250 ms |
| Run transcript | 274 ms | 0 ms with a lead of 210 ms or more | 70 ms after S6 fetches the run by id | 100-250 ms |
| Any revisit | 0 ms within 5 min, else as first visit | 0 ms | 0 ms | 100-250 ms unless cached on purpose |

Keyboard: a launcher row that stays highlighted for 150 ms counts as intent. `g` chords and a fast Enter count as no intent. Next.js prefetches links that enter the viewport and again on hover when the prefetch has expired; its docs do not describe a keyboard-focus trigger, so keyboard paths would need the same manual prefetch as B.

INP: the same in every option. Only S9 changes it.

## 7. Hard constraints that can sink a migration

| Constraint | Today | B | C2 (server rendering) | A (Next.js) |
|---|---|---|---|---|
| **Deploy** | One Express process serves UI, API, socket and plugin bundles. Read-only root file system, 2 GB memory limit, 1.5 GB heap, 2 CPUs (`deploy/compose.yaml`) | No change | A request handler inside Express: still one process; server render CPU now comes from the same 2 CPUs that run the orchestration | Either a custom server inside Express (one process; standalone output cannot be used with a custom server) or `next start` as a second process with a proxy for `/api`, `/_plugins` and the socket. Runtime writes need a writable mount on a read-only file system (to verify) |
| **Auth and company scope** | Cookie session (better-auth); `actorMiddleware` (`server/src/middleware/auth.ts:227`); `assertCompanyAccess` in 53 route files, about 271 calls (`server/src/routes/authz.ts:75-121`); non-GET Origin guard (`server/src/middleware/board-mutation-guard.ts`) | No change | Server code must enforce the same company boundaries | Same as C2, for every server component and server function |
| **Data path** | Browser calls the REST API | Same REST API | **Recommendation for C2 and A: server code calls the same REST API in process, with the user's cookie.** This keeps one authorization path and the web, API and CLI parity rule. Calling services directly would copy the authorization checks and drift. The in-process call costs about 1-3 ms instead of a 40 ms round trip, which is the real win of server rendering | Same recommendation. Every Server Function is a public endpoint that must do its own access checks (React Router v8.4.0 docs say the same) |
| **Websocket and optimistic updates** | One socket per company page; events invalidate or patch Query keys; optimistic updates through `onMutate` and `setQueryData` | No change | Unchanged after hydration | Live surfaces must stay client components with Query. A server component would need a full server re-render (`router.refresh()`) per event |
| **Plugin UI slots** | 20 slot types. Bundles are fetched at run time, rewritten to Blob-URL modules, and share the host React through a global bridge; host hooks use browser state, router hooks, `window` and `EventSource` (`ui/src/plugins/slots.tsx:259-455`, `ui/src/plugins/bridge-init.ts:71-90`) | No change | Render a placeholder of reserved size on the server; mount the plugin after hydration | Same as C2, plus a shim that maps the bridge's React Router hooks to Next.js navigation, or the plugin SDK contract breaks |
| **Keyboard-first** | Launcher and shortcuts live in `Layout`, which persists; #86 adds an action registry; #95 makes the launcher replace the search page | Hooks in the router wrapper and the launcher (S4) | Unchanged code, re-tested after hydration (focus must not move during hydration) | Re-test focus handling; the App Router has its own scroll handling on navigation |
| **Security surface** | No server rendering | No change | Server rendering without RSC adds no RSC endpoint | RSC adds the Flight protocol endpoint. CVE-2025-55182 ("React2Shell", December 2025, CVSS 10) allowed unauthenticated remote code execution through it, and more Next.js security releases followed in September 2026. The operator must track and deploy framework security releases quickly |
| **Tests** | Vitest: 399 `.test.tsx` and 286 `.test.ts` files in `ui/src`, about 365 render with `createRoot`; e2e Playwright: 43 specs, `webServer` builds the UI with Vite; release smoke runs the Docker image; `pnpm check:token-gates` checks CSS tokens | Add tests per slice | Hydration tests; e2e unchanged | Router mocks change in the 38 test files that import the router; e2e build command and release smoke image change. Token gates are unaffected in every option |
| **CI time and image size** | UI build is a few seconds inside a 12-minute image build (`vite build` 4.2 s, [CI]) | No change | Small: one more Vite build for the server bundle | `next build` replaces `vite build`, and Vite stays for Vitest; `next` and its dependencies join the runtime image. Not measured |

## 8. Targets ("after")

| Target | Profile | B1 today | Target | Reached by |
|---|---|---|---|---|
| Cold LCP, every tier 1 and 2 route | `desktop` | 376-500 ms (B0) | < 1.0 s | already met on the fixture; keep as a guard |
| Cold LCP, first visit | `wan` | 876-1,672 ms (4 routes measured) | < 1.5 s | B for the dashboard, list and issue page; the board is just above the line (about 1,555 ms [D]) until S1 explains its 1 s gap between first paint and LCP; C2 or A with margin |
| Cold LCP, repeat visit | `wan` | as first visit | < 1.0 s | B with S7; C2 or A |
| Cold LCP | `slow` | 2,268-3,236 ms | < 3.0 s | B with S6 and S10; C2 or A with margin |
| Cold usable (TTI) | `wan` | 1,053-4,751 ms | < 2.5 s | any option, only with S6 for the issue page |
| Warm navigation, usable, after hover or highlight of 150 ms or more, or a revisit | `laptop` (1x CPU, 40 ms) | not measured | < 200 ms, p75 | B (network wait 0; render only); A and C2 need a server request after the click |
| Warm navigation, usable, no intent (chords, fast click) | `laptop` | not measured | < 300 ms, p75 | B; A and C2 are similar |
| Visible feedback after any navigation input | any | none until the chunk arrives | next frame (< 50 ms) | B (S5); A and C2 by design |
| INP, typing and keyboard actions | `desktop` | 16-40 ms (B0, scripted set, [M50]); launcher not measured | < 100 ms, p75, including the launcher | S9 in every option |
| INP, any scripted interaction | 4x CPU | 36-136 ms (B0, Mac, [M50]) | < 200 ms | S9 |
| Initial JS | build | 1,435 KB gzip | < 1,000 KB gzip; budget lowered in the same PR | S10 (trim `app-core`) |
| Top-route chunk | build | up to 117 + 68 KB gzip (issue) | < 60 KB gzip each; issue < 100 KB | S6, S10 |
| Layout shift | `desktop`, `mobile` | board 0.10 (B0, [M50]); phone-size dashboard, first visit: 0.001-0.251 with #87, 0.080-0.380 on `main`; 0 on later visits (#87 body) | < 0.05 | #87, S5 |

Why these numbers: 1.0 s and 1.5 s are where people stop noticing a wait for a page that they asked for; 200 ms is the edge of "instant" for a click; 100 ms for typing keeps keys from feeling late. `laptop` is the main target for warm navigation because the 2x CPU of `wan` adds render cost that most users' machines do not have; the `wan` numbers are still reported.

## 9. Recommendation and slices

### 9.1 Target data flow (option B)

```
 input: hover (dwell) | focus | touch | launcher highlight | click | Enter | g-chord
                                   │
                                   ▼
                route intent registry (ui/src/lib/route-intent.ts, new; called from
                ui/src/lib/router.tsx and the launcher)
                  │                                   │
        import(page chunk)                 queryClient.prefetchQuery(route queries)
                  │                                   │
                  ▼                                   ▼
        /assets/*.js (br, immutable)       /api/...  (same REST API, same authz checks)
                  │                                   │
                  └───────────► page renders from the Query cache ◄─── websocket events
                                         │                             (invalidate or patch keys)
                                         ▼
                 Layout stays mounted; the route skeleton shows if not ready in ~100 ms

 cold boot:
 index.html (no-cache) ─ preload hints ─► /api/health, /api/auth/get-session,
     │                                    /api/instance/settings/experimental,
     │                                    /api/companies?scope=accessible, /api/cli-auth/me
     ├─► entry JS + CSS (br)              (all in parallel with the JS download)
     ▼
 main.tsx: restore the persisted cache (company-scoped, build-stamped) → first render shows data
     ▼
 company id from the URL prefix + boot list → page queries start at the first render
```

### 9.2 Slices

Each slice is one pull request from `main`, with before and after tables from the harness, desktop and mobile screenshots, zero console errors, and a rollback by revert. Slices that change behaviour for users ship behind an instance experimental setting until their numbers hold.

| Slice | What | Size | Expected effect | Proof | Rollback |
|---|---|---|---|---|---|
| S0 | Land B1: #53, #54, #57, #68, #87 (web-perf track) | done, in review | section 5 | already measured | revert per PR |
| S1 | Harness: warm-navigation probe (mouse, launcher, chords, back), `laptop` profile, `authenticated` fixture, per-route readiness, trace of the board's FCP-to-LCP gap; fresh B0 and B1 numbers [F] | S, test-only | the missing "before" numbers | probe output | none needed |
| S2 | Spike (local, throwaway, not merged): S3 to S5 and S7 prototypes on the board and the issue page, plus the server-rendering ceiling probe | local | go/no-go (section 9.3) | decision table | none |
| S3 | Boot: preload hints, parallel boot calls, company id from the URL prefix | S | cold -140 ms `wan`, -160 `slow`, -360 `mobile` [D] | harness cold, `authenticated` | revert |
| S4 | Route intent registry and loaders for tier 1 and 2 routes; router wrapper and launcher hooks; skip the socket-open refetch of data fetched in the last few seconds | M | first-visit wait 0 ms with intent; max(chunk, data) without | new warm-navigation probe | setting off, or revert |
| S5 | Loading states: skeletons with the final layout per route; feedback within one frame; no blank gates; runs tab and settings states; space reserved for board columns (web-perf item E2b) | M | no frozen or blank page area; CLS < 0.05 | screenshots, CLS, probe | revert |
| S6 | Slow pages: issue page (run-log reads on demand, first comment page only, unbounded lists bounded, chunk split), run fetched by id, inbox waits for its main list only, dashboard and project lists bounded, agent overview flattened | M × 3 | issue usable < 2.5 s on `wan`; transcript 8 → 6 levels | harness | revert per PR |
| S7 | Query cache: longer `gcTime` for top routes; persisted cache, opt-in first | M | repeat cold LCP about 0.8-1.0 s on `wan` [D]; revisits always from cache | harness repeat visit | setting off |
| S8 | HTTP and service worker: navigation preload or no fetch handler for navigations; cacheable promo image; font caching | S | removes the worker start from navigations [not measured] | harness | revert |
| S9 | Render work: memoization (web-perf item F), lazy filter options, launcher typing | M | INP < 100 ms `desktop`; open filter well under 200 ms at 4x | `interact.mjs` | revert |
| S10 | Budgets: trim `app-core` (web-perf item G), per-route chunk budget, an opt-in navigation-time check | M | initial JS < 1,000 KB gzip; `slow` LCP about -400 ms [D, 457 KB less at 0.868 ms/KB] | bundle budget in CI | revert |

Order: S1, S2, then S3 and S4 (largest gain for the effort), S5, S6, S7, S9, S10, S8. S6 parts can run in parallel with S3-S5 because they touch other files.

### 9.3 Early go/no-go: the spike on the two slowest routes

The two slowest routes on B1 are the **issue page** (usable at 4.75 s on `wan`) and the **tasks board** (the slowest LCP on `wan`, 1.67 s). The spike needs the phase 2 install and the manager's go.

Two measurements, no framework install:

1. **B prototype:** S3, S4, S5 and S7 on these two routes only, on a local branch.
2. **Server-rendering ceiling probe:** load each page on B1, wait until it is usable, and save the full HTML. Serve that HTML for the same URL (Playwright `page.route`) with the real assets and API. The page paints from the HTML before any JavaScript runs, which is the best case for any server-rendering framework, minus the server's own render time. Add the server's data time for the same page (API timings, in process) to get the ceiling.

The numbers that decide:

| Result | Decision |
|---|---|
| B prototype: network wait after a hovered or highlighted input is 0 ms, usable p75 < 200 ms on `laptop`, and first-visit cold LCP < 1.5 s on `wan`, on both routes | **GO for B**: continue with S3 and later |
| B prototype misses the warm target because render takes more than 150 ms | Still GO for B. Render cost is the same in every option; S6 and S9 move first |
| B prototype misses a cold LCP target (`wan` first visit > 1.5 s, `slow` > 3.0 s, or `mobile`, where the user says phones matter) on either route, **and** the ceiling probe is at least 500 ms better on that profile and route | Open option C2 as a separate plan with its own spike; keep B (C2 builds on B's loaders) |
| Otherwise | Close the server-rendering question for this cycle |
| Next.js | No-go unless C2 is blocked by something that only Server Components solve and React Router's RSC support is still unstable at that time |

## 10. Measurement protocol

- **Harness:** reuse `tests/perf/web-app/` from #50. It is not on `main`; other branches extract a frozen copy with `git archive` of #50's branch, as the web-perf track does.
- **Builds:** B0 (`main`), B1 (`main` with the five PRs merged on a local throwaway branch, never pushed), and the spike variants. Build each with plain `vite build` (the e2e web server builds with `NODE_ENV=test`, which adds about 300 KB gzip).
- **Server:** a worktree instance with its own embedded Postgres, in `authenticated` mode with a test user, and in `local_trusted` mode for comparison with #50. The 1,000-issue fixture from `make-fixture.mjs`.
- **Profiles:** `desktop`, `laptop`, `wan`, `slow`, `mobile`.
- **New probe `nav-timing.mjs` (S1).** For each target route, starting from a loaded source route:
  1. click without hover;
  2. hover for 150 ms, then click;
  3. Tab to the link, then Enter;
  4. launcher: Cmd+K, type a query, wait for results, ArrowDown to the row, wait 0 or 150 ms, Enter;
  5. chord (`g i`; later chords from #86's slice 2a);
  6. browser back to the previous page;
  7. revisit after the `gcTime` has passed (Playwright's clock moves the timers forward).

  Each scenario records: input to first visual change; input to usable (readiness selector visible, then two animation frames); the requests that started after the input and their serial depth; long tasks; and the INP of the input itself.
- **A/B discipline:** interleave the variants (ABBA), at least 5 runs per cell per round, 2 rounds. Report the median, p75 and the min-max spread, and the load average. A comparison is invalid when the load changes more than 2x between the two arms. Numbers from a shared Linux build host are relative only: the INP of the same build differs between that host and the Mac used by #50.
- **Disk:** phase 2 is `pnpm install --offline --frozen-lockfile` in a fresh worktree, only after the manager's go and with 9,000 MiB or more free.

## 11. Open questions

| # | Question | Recommendation |
|---|---|---|
| 1 | How often do people cold-load the app on a phone or a slow link? That is the only case where server rendering wins a lot (section 6.5). | Ask the user. If phones on cellular are common, give S10 (less JS) a higher priority and run the ceiling probe on `mobile` first |
| 2 | What are the real round-trip time and API latency to the production instance? | One manual check by the operator from a normal client (browser dev tools, `/api/health` timing); no new collection code |
| 3 | The persisted Query cache keeps company data in the browser (IndexedDB) on the user's device. | Ship it opt-in behind an instance experimental setting, company-scoped, build-stamped, 24 h maximum age, cleared on sign-out and on loss of company access. Turn it on by default after a week of clean results |
| 4 | Boot data: preload hints or data in the HTML? | Preload hints. No user data in `index.html`, no change to its caching, no CSP nonce needed for data |
| 5 | On a slow navigation, keep the old page until the new one is ready, or show the skeleton at once? | Show the skeleton when the target is not ready within about 100 ms; measure both in S2 |
| 6 | Should the launcher prefetch the highlighted row? | Yes, after 150 ms on the same row, at most one prefetch in flight, top result included |
| 7 | Upgrade to React Router v8 now? v7 gets security fixes only. | A separate small PR after B1. B does not need it; C does |
| 8 | Collect real-user timings? | Not now. It would be a Telemetry or Observability change (AGENTS.md section 5, rule 7) with its own review. Revisit if the fixture and production disagree |
| 9 | Who implements? | The web-perf track (owner of B1) for S1 and S3-S10, with the launcher hook in S4 coordinated with the owners of #86 and #95 |

## 12. Coordination

- #50, #53, #54, #57, #68 and #87 belong to the web-perf track. This plan does not change them. It depends on them landing (S0).
- #86 and #95 (launcher, action registry, launcher replacing the search page) belong to their own thread. S4 adds one call from the launcher's highlighted row to the route intent registry, after those PRs merge.
- `DESIGN.md` and the token gates apply to the skeletons in S5.
- The harness stays opt-in (AGENTS.md section 7). No browser suite becomes part of the default `pnpm test`.

## Appendix A. Sources outside the repository

- Next.js 16.3 release notes, 2026-08-03: https://nextjs.org/blog/next-16-3
- Next.js `<Link>` prefetch behaviour (docs version 16.4.0): https://nextjs.org/docs/app/api-reference/components/link
- Next.js custom server (standalone output cannot be combined with it): https://nextjs.org/docs/app/guides/custom-server
- Next.js migration guide from Vite: https://nextjs.org/docs/app/guides/migrating/from-vite
- React Router v8 release, 2026-06-17: https://remix.run/blog/react-router-v8
- React Router changelog (v8.4.0, RSC unstable; `useTransitions` stabilized in v7.15.0): https://reactrouter.com/changelog
- React Router transitions and the `useTransitions` prop: https://reactrouter.com/explanation/react-transitions
- CVE-2025-55182 (React Server Components remote code execution): https://vercel.com/changelog/cve-2025-55182 and https://react.dev/blog/2025/12/11/denial-of-service-and-source-code-exposure-in-react-server-components
