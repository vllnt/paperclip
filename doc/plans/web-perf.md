# Web app performance: baseline, bottlenecks, targets

Status: Phase 1 (measure) complete on 2026-10-09 at `a91d77cc4`. Phase 2 (small PRs, each with before/after numbers) not started.
Scope: the board UI (`ui/`), plus the server code that serves it. No behavior or API contract changes beyond performance.

## 1. Summary

The app is fast once it is loaded and quiet when idle. It is slow to start and wasteful when data changes.

| Question | Answer (baseline) |
|---|---|
| Is the board fast on a good machine? | Yes. Tasks board at 1,000 issues: LCP 0.46 s, INP 40 ms (localhost, no throttling). |
| Does it meet LCP < 2.0 s on a realistic link? | No. 50 Mbps / 40 ms RTT / 2x CPU: FCP 2.1 s, LCP 2.7 s. At 9 Mbps / 4x CPU: LCP 9.9 s. Nothing paints until a 9 MB script has arrived. |
| Why? | Every page ships in one eager bundle: 9.1 MB raw, 2.5 MB gzip, 46 chunks on first load. `App.tsx` imports about 100 pages eagerly and lazy-loads 8. The app server does not compress static assets. |
| Idle request storms? | Board and dashboard: none (0 requests/min). Issue detail: 81 requests/min per open tab. |
| Cost of live updates | 12 mutations/min on an open board: 185 requests/min, 1.1 MB/min. One mutation causes about 2,600 component re-renders on the board and about 14,000 on the list. |
| What is already fine? | API latency (p50 12-190 ms, p95 <= 343 ms), INP, idle CPU (0 React commits while idle), fonts (`font-display: swap`). |

## 2. Method

Everything below is reproducible with the scripts in `tests/perf/web-app/`.

**Fixture** (`seed-fixture.mjs`, deterministic): one company, 32 agents, 8 projects, 1,000 issues (20% backlog, 25% todo, 12% in progress, 13% in review, 25% done, 5% cancelled; 15% are sub-issues), 912 comments including one 400-comment thread, 10,000 heartbeat runs over 10.5 days, 10,000 cost events, about 22,000 activity rows, 28 runs with real log files (one of 8,000 lines). It approximates the shape of a large real company; it is not a copy of one.

**Browser runs** (`measure.mjs`): Playwright + Chromium, a fresh context per run (cold HTTP cache), CDP throttling, PerformanceObservers for FCP, LCP, layout shift, long tasks and Event Timing. TTI and TBT use a Lighthouse-style calculation (first 5 s window with no long task and at most 2 requests in flight; TBT is long-task time over 50 ms between FCP and TTI). "Settled" is the last fetch/XHR completion or DOM mutation. The Lighthouse CLI was not used: it is not installed and the disk has no room for it, and the observers give the same metrics.

| Profile | Network | CPU | Meant to represent |
|---|---|---|---|
| `desktop` | localhost, none | 1x | upper bound; isolates app work from transfer |
| `wan` | 50 Mbps, 40 ms RTT | 2x | laptop on a Tailnet or office link (the target profile) |
| `slow` | 9 Mbps, 50 ms RTT | 4x | phone or distant peer |

Other probes: `bundle-report.mjs` (what ships on first load, per package and per page), `live-traffic.mjs` (requests and websocket frames per minute, idle and under mutations), `renders.mjs` (React commits and component re-renders via a stub DevTools hook against the production build), `interact.mjs` (INP on scripted interactions), `report.mjs` (markdown tables and before/after deltas), `run-all.sh` (the whole suite).

**Caveats, so the numbers are read correctly**
- The server, embedded Postgres and browser share one Mac. Load average during runs was 4.9 to 7.0 (desktop), 7.0 to 4.0 (slow) and 18 to 53 (wan, other sessions were running). Medians of 3 to 5 runs are reported; the `wan` numbers are the noisiest (one board run hit LCP 9.4 s and was outvoted). Compare before and after under similar load and read single runs with care.
- Requests are local, so API latency excludes network time and database round trips. Production latency will be higher.
- The Connectors announcement (see bottleneck 9) was dismissed first. Undismissed, it is the LCP element on every page at about 3.4 s.
- Run-log fetches that return 404 (runs without a seeded log) are fixture noise, not app errors.
- Production is Tailnet-only behind an operator-managed ingress. Whether that ingress compresses static assets could not be checked from this repo (open question 1).

## 3. Baseline

### 3.1 JavaScript on first load (`bundle-report.mjs`)

| | Raw | Gzip | Brotli |
|---|---|---|---|
| Initial JS (46 chunks) | 9,076 KB | 2,538 KB | 1,970 KB |
| of which entry chunk | 6,393 KB | 1,717 KB | |
| Lazy chunks (225), loaded on demand | 6,039 KB | | |
| Initial CSS (1 file) | 508 KB | 71 KB | 54 KB |

What is in the eager bundle. The bundler reports per-module sizes before minification (15,793 KB in total against 9,076 KB shipped), so the share of the initial JS is the reliable column; the minified size is that share applied to 9,076 KB, an estimate.

| Group | Share | About (minified) | Note |
|---|---|---|---|
| `src/components/**` | 29% | 2.6 MB | page-specific folders included: `task-chat` 3.2%, `connections` 1.5%, `issue-properties` 1.1% |
| Page code (`src/pages/**`) | 26% | 2.4 MB | `apps/*` 4.4%, `tools/*` 1.3%, IssueDetail 1.4%, Pipelines, CompanySkills, Secrets, AgentDetail about 1.2-1.3% each, DesignGuide 0.9% |
| `src/lib` | 4.0% | 360 KB | |
| `@paperclipai/shared` | 4.7% | 430 KB | zod validators and constants imported at runtime (zod alone 0.9%) |
| `react-dom` | 2.8% | 255 KB | needed |
| `@xterm/xterm` | 2.6% | 235 KB | terminal; one page |
| CodeMirror (`view`, `state`, `language`, `commands`) | 3.2% | 290 KB | code editor; a few pages |
| `@mdxeditor/editor` + `lexical` | 3.1% | 285 KB | markdown editor, its own 783 KB (raw) chunk |
| `@assistant-ui/core` | 1.7% | 150 KB | task chat |
| `motion-dom` + `framer-motion` | 1.7% | 155 KB | animation |
| `src/fixtures` | 0.3% | 30 KB | test fixtures in the production bundle |

Dev-only surfaces ship to everyone: `DesignGuide`, `BootstrapSetupUxLab`, `ResponsibleUserDenialUxLab`, `CrossIssueCollaborationUxLab`, `TaskChatLab`, `IssueChatLongThreadPerf`.

Per-route view: all of the above is "initial" for every route, because only 8 pages are lazy (`CompanyExport`, `Agents.production`, `Routines.production`, `RoutineDetail.production`, `CompanySkills.production`, `CompanyActivity.production`, `Costs.production`, `OrgChart.production`). A route's own code is small next to the shared shell; the cost is that every route pays for every other route.

The server serves `/assets/*` and `index.html` without `Content-Encoding` (verified with `Accept-Encoding: br, gzip`). `/api/*` is gzipped by its own middleware. Assets are hashed and `immutable`, so repeat visits are cheap until the next deploy changes every hash.

### 3.2 Vitals and requests, cold load, 1,000 issues

`desktop` (n = 5):

| page | FCP ms | LCP ms | CLS | TTI ms | TBT ms | settled ms | requests | API calls | API KB |
|---|---|---|---|---|---|---|---|---|---|
| dashboard | 272 | 472 | 0.050 | 573 | 0 | 588 | 98 | 45 | 211 |
| tasks-list | 252 | 500 | 0.000 | 466 | 0 | 504 | 89 | 39 | 132 |
| tasks-board | 252 | 464 | 0.104 | 534 | 0 | 540 | 107 | 48 | 251 |
| issue-long (400 comments) | 252 | 500 | 0.001 | 3,844 | 36 | 6,641 | 159 | 108 | 235 |
| issue-short | 252 | 500 | 0.005 | 3,851 | 22 | 6,625 | 145 | 91 | 262 |
| agents | 264 | 388 | 0.000 | 508 | 0 | 548 | 94 | 36 | 116 |
| routines | 256 | 400 | 0.000 | 426 | 0 | 472 | 88 | 38 | 117 |
| costs | 248 | 396 | 0.000 | 432 | 0 | 475 | 93 | 43 | 125 |
| audit | 252 | 376 | 0.000 | 406 | 0 | 458 | 85 | 35 | 112 |
| settings | 256 | 392 | 0.000 | 395 | 0 | 434 | 76 | 26 | 12 |

`wan` (n = 3, the target profile):

| page | FCP ms | LCP ms | CLS | TTI ms | TBT ms | settled ms | requests | API calls | API KB |
|---|---|---|---|---|---|---|---|---|---|
| dashboard | 2,076 | 2,732 | 0.112 | 2,911 | 16 | 2,971 | 99 | 45 | 210 |
| tasks-list | 2,156 | 3,228 | 0.028 | 3,290 | 51 | 3,721 | 88 | 38 | 132 |
| tasks-board | 2,088 | 2,736 | 0.103 | 3,054 | 66 | 2,988 | 98 | 38 | 249 |
| issue-long | 2,092 | 2,952 | 0.001 | 6,808 | 280 | 10,735 | 150 | 99 | 234 |
| agents | 2,164 | 2,512 | 0.000 | 3,538 | 43 | 3,700 | 92 | 34 | 115 |

`slow` (n = 3; routines, costs, audit and settings are within 4% of agents):

| page | FCP ms | LCP ms | CLS | TTI ms | TBT ms | settled ms | requests | API calls |
|---|---|---|---|---|---|---|---|---|
| dashboard | 9,344 | 9,744 | 0.111 | 10,066 | 119 | 10,150 | 98 | 45 |
| tasks-list | 9,368 | 9,964 | 0.000 | 10,116 | 163 | 9,968 | 89 | 39 |
| tasks-board | 9,408 | 9,924 | 0.106 | 10,284 | 167 | 10,176 | 98 | 47 |
| issue-long | 9,340 | 10,280 | 0.005 | 13,850 | 825 | 17,083 | 167 | 116 |
| agents | 9,316 | 9,616 | 0.000 | 9,922 | 107 | 9,868 | 94 | 36 |

FCP equals the time to download the entry script: with this bundle nothing paints before about 8 s of transfer at 9 Mbps.

### 3.3 API latency and calls per load (`desktop`, n = 5, local server)

Every call is quick: p50 12-190 ms, p95 at most 343 ms. The cost is the number and size of calls.

| page (calls, KB) | heaviest by bytes | slowest p50 |
|---|---|---|
| tasks-board (48, 251 KB) | 7 column queries, 17 KB each; inbox issue list 79 KB; run list 19 KB | `/skills` 167 ms |
| dashboard (45, 211 KB) | inbox issue list 79 KB; issue list 76 KB; run list 19 KB | `/skills` 187 ms |
| issue-long (108, 235 KB) | `activity` 3 x 28 KB; run list 19 KB; 12 run-log reads | `/skills` 172 ms |

Duplicates: on every page each shell endpoint (`health`, `adapters`, `auth/get-session`, `companies?scope`, `instance/settings/*`, `plugins*`, `cli-auth/me`, `sidebar-preferences/me`, `routines`, `sidebar-badges`) is fetched twice, about 140 ms apart, with no reload in between. Cause: `LiveUpdatesProvider` runs `invalidateQueries({ type: "active" })` when the websocket opens (`ui/src/context/LiveUpdatesProvider.tsx`, `onopen`), which refetches everything the page just fetched. The comment explains the intent (close the gap before the first subscription), but the rule is blanket. `/api/health`, `/api/adapters`, the session and the plugin lists are not changed by any live event.

### 3.4 Live-update traffic (`live-traffic.mjs`; busy = 17 mutations in 90 s, about 12/min)

| scenario | requests/min | KB/min | requests per mutation | websocket frames/min |
|---|---|---|---|---|
| board, idle | 0 | 0 | | 0 |
| dashboard, idle | 0 | 0 | | 0 |
| **issue detail, idle** | **81** | 17 | | 0 |
| board, busy | 185 | 1,105 | 16.3 | 11.3 |
| dashboard, busy | 57 | 1,368 | 5.1 | 11.3 |
| issue detail, busy | 187 | 908 | 16.5 | 11.3 |

- #32 holds: idle board and dashboard are silent.
- Issue detail idle: 116 `live-runs` reads in 120 s (58/min), 40 `browsers` reads (20/min), 6 `interactions`. `ui/src/pages/IssueDetail.tsx:1473` sets `refetchInterval: 1000` on `live-runs` with no condition; other observers of the same key use 3 s and React Query takes the shortest. The websocket already invalidates this key on run events.
- Board busy: 182 of 277 requests are the 7 column queries, refetched in full on every flush (26 flushes for 17 mutations); `labels` refetches 26 times although label data did not change.
- Dashboard busy: few requests but 1.4 MB/min, because two 76-79 KB issue lists refetch on every flush.

### 3.5 Render counts (`renders.mjs`, 11 mutations in 60 s, production build)

| page | idle 20 s | commits | component renders | top offenders |
|---|---|---|---|---|
| tasks-board | 0 commits | 53 | 28,347 | issue cards, `IssueLinkQuicklook`, sidebar nav items |
| tasks-list | 0 | 49 | 153,664 | per-row `Popover`/`PopoverTrigger` (10,140 each), `TaskLinkCells` (9,748) |
| issue-long | 0 | 55 | 92,046 | `TaskChatBubble` + `Markdown` (about 8,200 each), re-parsed markdown |
| dashboard | 0 | 111 | 96,043 | popovers, links |

Typing 5 characters in the Tasks search: board 13 commits / 7,055 renders; list 11 commits / 21,932 renders, including about 140 sidebar nav item renders on the board, so each keystroke re-renders chrome that does not depend on search.

### 3.6 INP (`interact.mjs`, scripted: search typing, filter popover, scroll, open item, thread composer)

| scenario | desktop (n = 3) | slow, 4x CPU (n = 2) | worst step at 4x CPU |
|---|---|---|---|
| board | 40 ms | 136 ms | open filter 136 ms |
| list | 40 ms | 108 ms | open filter 108 ms |
| issue-long | 24 ms | 36 ms | type in composer 36 ms |
| dashboard | 16 ms | 32 ms | nav to tasks 32 ms |

INP passes today with a small margin at 4x CPU on the board. The render counts above are the reason the margin will shrink on busier companies.

## 4. Top 10 bottlenecks, ranked

Impact 1-5 (users affected x severity). Effort 1 (hours) to 3 (days). Priority = impact / effort; ties broken by impact.

| # | Bottleneck | Evidence | Impact | Effort | Priority | Fix |
|---|---|---|---|---|---|---|
| 1 | Issue detail polls `live-runs` every 1 s forever (plus `browsers` every 3 s) | 81 requests/min idle per open tab; settle 6.6 s at `desktop`, 17 s at `slow` | 4 | 1 | 4.0 | Poll fast only while a run is live or the issue is in progress; otherwise rely on the existing websocket invalidation with a slow safety poll; use the visibility-aware interval hook |
| 2 | Static assets are served uncompressed | Entry 6,393 KB raw vs 1,717 KB gzip vs 1,300 KB brotli; `desktop` JS transfer 9,094 KB | 4 (0 if the ingress already compresses) | 2 | 2.0 | Precompress `.br`/`.gz` at UI build; negotiate `Accept-Encoding` in the static handler; keep `immutable` and `Vary` correct |
| 3 | Websocket open refetches everything just fetched | Every shell endpoint fetched twice on every page; about 20 extra requests per load | 2 | 1 | 2.0 | Exclude instance-static query roots from the on-open invalidation; keep the blanket rule for data live events can change |
| 4 | Layout shift on the board and dashboard | Board CLS 0.104 (columns, 0.087 at 718 ms); dashboard grid 0.043 | 2 | 1 | 2.0 | Reserve column and card-grid space until data arrives |
| 5 | One eager bundle for about 100 pages | 9.1 MB / 2.5 MB gz initial; FCP 2.1 s at `wan`, 9.3 s at `slow`; dev labs and fixtures included | 5 | 3 | 1.7 | Route-level `lazy()` with one `Suspense` per layout outlet; preload on hover or idle; keep xterm, CodeMirror, mdxeditor and assistant-ui off the critical path; drop dev-only labs and fixtures from production |
| 6 | Board refetches 7 columns of up to 200 issues on every change | 16.3 requests and about 95 KB per mutation; only 10 cards per column are shown | 3 | 2 | 1.5 | Invalidate only the affected columns; first page smaller than 200 where the column count is not needed; skip the unrelated `labels` refetch |
| 7 | Re-render amplification on live updates and typing | Board 28k, list 154k, thread 92k renders per 11 mutations; 7k-22k renders per 5 keystrokes | 3 | 3 | 1.0 | Memoize rows, cards and chat bubbles with stable props; keep router location and search state out of the sidebar; split `IssuesList` state |
| 8 | `@paperclipai/shared` runtime code in the UI bundle | 746 KB raw, 139 KB of it zod | 3 | 3 | 1.0 | Import types and constants from narrow subpaths; mark the package side-effect free so validators drop out |
| 9 | Connectors promo is a late LCP and its image is never cached | Appears at about 3.4 s, becomes the LCP on every page until dismissed; 187 KB PNG with `private, no-store` | 1 | 1 | 1.0 | Cache the image (the id is versioned); do not let a delayed overlay compete for LCP |
| 10 | Shell fetches full issue lists to compute the inbox badge | 79 KB inbox list and 19 KB run list on every page; dashboard also fetches a 76 KB list, refetched on every flush | 2 | 3 | 0.7 | A count-only source, or a smaller `limit` plus fields; needs an additive API, so last |

Smaller items, not ranked: `/skills` is the slowest call on every page (p50 about 170 ms); the `documents/plan` probe returns 404 as a normal answer and logs a console error on every issue open; the thread issues 12 run-log reads per issue; Inter is shipped unsubsetted (344 KB roman) with a one-hour cache and no preload.

PR order follows risk and dependency, not only priority (section 6): 5 lands second because it is the only change that moves FCP, and 2 should be measured before and after 5 so the two effects stay separable.

## 5. Targets

| Target | Metric and profile | Baseline | Goal |
|---|---|---|---|
| LCP < 2.0 s on the board at 1,000 issues | `wan`, cold, median of 5 | 2,736 ms | < 2,000 ms |
| LCP stretch | `slow`, cold | 9,924 ms | < 4,000 ms |
| LCP guard | `desktop` | 464 ms | no worse than 600 ms |
| INP < 200 ms on the board | `slow` (4x CPU), scripted interactions | 136 ms | < 200 ms always; stretch < 100 ms |
| Initial JS -30% | `bundle-report.mjs`, initial set | 9,076 KB raw / 2,538 KB gzip | at most 6,353 KB raw / 1,777 KB gzip; expected -60% or better from splitting |
| No idle request storms | `live-traffic.mjs`, idle 120 s, every page measured | issue detail 81/min | at most 5 requests/min on any open page |
| Cost of a change | requests per mutation on an open board / issue | 16.3 / 16.5 | at most 6 |
| Zero console errors | every UI PR, desktop and mobile widths | n/a | 0 (fixture 404s excluded) |

Enforcement: PR 5 adds `tests/perf/web-app/bundle-budget.json` and runs `bundle-report.mjs --check` in CI. The budget is set to the new measured size plus 5% and is lowered by hand when later PRs shrink it. The browser suites stay opt-in; they need a seeded server and are not cheap enough for every push.

## 6. Phase 2: PR sequence

Each PR: its own branch from `main`, one concern, before/after tables from `report.mjs`, desktop and mobile screenshots, zero console errors, existing tests green plus a regression test where cheap. Rebase on the black/white theme PR if it lands first; the changes below do not touch theme or token files.

| PR | Change | Expected effect | Guardrail |
|---|---|---|---|
| A | Issue detail: poll `live-runs`/`activeRun`/`browsers` only while needed (bottleneck 1) | issue idle 81/min to 5/min or less; settle time drops by seconds | test: no poll when no live run; test: websocket event still refreshes a run that starts while idle |
| B | Skip on-open refetch for instance-static queries (3) | about 20 fewer requests per load | test: static roots excluded, issue/dashboard roots still invalidated |
| C | Precompressed static assets (2) | wire size about -75% (brotli) when the ingress does not compress | test: `Content-Encoding`, `Vary`, `ETag`, range/`304` behavior; falls back to identity |
| D | Route-level code splitting, dev labs and fixtures out of production, bundle budget in CI (5) | initial JS -60% or better; FCP at `wan` toward 1 s | route smoke test for every lazy route; budget check; no flash of empty shell |
| E | Board: targeted column invalidation, layout-shift reservation (4, 6) | requests per mutation 16 to 6 or fewer; CLS < 0.05 | existing board tests plus a count test |
| F | Memoization of list rows, cards, chat bubbles; isolate sidebar from search/location (7) | renders per mutation down 5x or more | render-count probe in the PR; INP not worse |
| G | Shared package tree-shaking, promo image caching (8, 9) | initial JS further down; promo no longer an LCP risk | bundle budget lowered |

Not planned unless the numbers justify it: virtualizing board columns (they render 10 cards by default and the list already renders in capped batches, 2,400 DOM nodes at 1,000 issues), a service-worker precache, and server-side indexes (API p95 is under 350 ms on 10,000 runs and 22,000 activity rows; revisit with production latencies).

## 7. Incidental findings (out of scope here, reported for owners)

1. Concurrent agent creation in one company fails with a 500: `ensureCompanyDefaultAgentGrants` (`server/src/services/built-in-agents.ts`) inserts grants check-then-insert for every agent, so two simultaneous creates both insert the same `principal_permission_grants` row and one hits `principal_permission_grants_unique_idx`. The seed script creates agents one at a time because of it.
2. Deleting a company that has run costs fails with a 500: the delete removes `heartbeat_runs` before the `cost_events` rows that reference them (`cost_events_heartbeat_run_id_heartbeat_runs_id_fk`). Found while cleaning a test company; the cleanup order was `cost_events`, `activity_log`, then the API delete.
3. The `documents/plan` probe and run-log reads turn expected "absent" answers into 404 console errors.

## 8. Open questions

1. Does the production ingress compress `/assets/*.js`? Check `content-encoding` on one hashed asset at the real origin. If it does, PR C is optional and bottleneck 2 drops out; if it does not, PR C is the cheapest large win.
2. Real production API p50/p95 and typical client links (Tailnet peers vs phones) would replace the `wan`/`slow` assumptions.
3. Is the 1 s issue poll protecting a known websocket gap (missed run events)? PR A keeps a slow safety poll and the existing reconnect reconciliation; confirm that is acceptable.

## 9. Reproduce

```sh
pnpm install --frozen-lockfile
pnpm --filter @paperclipai/plugin-sdk ensure-build-deps && pnpm --filter @paperclipai/plugin-sdk build
node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts worktree init --no-seed --server-port 3190
pnpm --filter @paperclipai/ui build --outDir ../server/ui-dist --emptyOutDir
(cd server && PORT=3192 PAPERCLIP_UI_DEV_MIDDLEWARE=false PAPERCLIP_MIGRATION_AUTO_APPLY=true npx tsx src/index.ts)
# set PERF_BASE / PERF_DB_URL if `worktree init` chose other ports
node tests/perf/web-app/seed-fixture.mjs
tests/perf/web-app/run-all.sh baseline          # full suite, about 35 minutes
node tests/perf/web-app/measure.mjs --label baseline-desktop --runs 5 --profiles desktop
node tests/perf/web-app/report.mjs baseline-desktop after-desktop   # before -> after table
node tests/perf/web-app/bundle-report.mjs
```

Do not measure while another build is writing `server/ui-dist`, and never point the seed script at a shared instance.
