# Web app migration to Next.js, measured route by route

Date: 2026-10-10
Status: Plan only. No code ships with this pull request. The M0 code PR starts after this plan is approved and after a maintainer allows the install of the new dependency.
Branch: `docs/web-app-speed-nextjs-plan`
Evidence base: `doc/plans/2026-10-10-web-app-speed-nextjs-plan.md` (same pull request, fact-checked). It holds the route inventory, the B0 and B1 numbers, the boot waterfall and the constraints. This plan does not repeat them; it cites them as "speed plan, section N".

## 1. Decision record

- **Decision (maintainer, 2026-10-10):** migrate the web app (`ui/`) to the Next.js App Router, completely, and remove React Router and the Vite app build at the end.
- **What the speed plan recommended, and why (considered, not chosen):** stay on the single-page app and finish it (speed plan, section 0). Its reasons: the slow pages are slow because of serial API levels, page code that loads after the click, missing loading states, unbounded lists and render cost; every option can reach about 0 ms network wait on warm navigation with intent prefetch; a migration costs a router rewrite across about 250 files, a rendering server in the 2 GB container and the React Server Components attack surface.
- **How this plan keeps that evidence honest:**
  - The speed plan's B1 numbers are the bar. Every migration slice must meet or beat B1 on the same machine (section 8), or it does not merge.
  - The causes in speed plan section 5.6 are fixed inside the migration slices, not left behind (section 6.2).
  - The risks the speed plan named (server memory and CPU, the Flight endpoint, plugin slots, keyboard focus, tests, deploy) each have a guard in this plan (sections 3 to 5).

## 2. Target shape

```
 browser ──HTTPS──> ingress ──> Express, one Node process (server/src/index.ts:929)
                                  ├─ /api/*, /api/auth/*               REST (unchanged; the only data path)
                                  ├─ /api/companies/:id/events/ws      live events (unchanged)
                                  ├─ /_plugins/*, /llms/*, /mcp/*, /runtime-tools/*   unchanged
                                  ├─ /_next/static/*                   express.static, immutable, br/gz siblings (#57's handler, re-pointed)
                                  └─ everything else ──> Next.js request handler (custom server, same process)
                                                           │
                       app/layout.tsx (server) ── fetches boot data through the REST API with the caller's cookie
                         └─ <Providers> (client): QueryClient, theme, company, live updates, toasts, React Router bridge
                              ├─ app/page.tsx                         "/" (SPA, client-only, until M10)
                              └─ app/[companyPrefix]/layout.tsx       board shell (sidebar, launcher), client
                                   ├─ issues/page.tsx + loading.tsx   M1: server component, REST prefetch, HydrationBoundary
                                   ├─ issues/[issueId]/…              M2
                                   ├─ …                               M3-M10
                                   └─ [[...rest]]/page.tsx            catch-all: today's React Router routes, client-only
```

Rules that hold in every slice:

- **One process, one origin, the same cookie auth.** Next.js runs as a request handler inside the existing Express server, after every existing route and before nothing else (section 3).
- **One data path.** Server components read through the same REST API with the caller's session. No direct service or database calls from `ui/`. **No Server Actions:** all mutations stay on REST through TanStack Query (section 4).
- **One UI tree at a time per route.** A route is served either by its App Router segment or by the catch-all, never both. Rollback of a route = delete its segment; the catch-all serves it again, because the React Router route stays in `App.tsx` until the final slice.

## 3. M0: adoption with no visible change

### 3.1 What M0 changes

| Part | Today | After M0 |
|---|---|---|
| Who builds the UI | `vite build` (`ui/vite.config.ts`) | `next build` (Turbopack). The Vite build stays in the image during the migration, behind a runtime switch, for rollback |
| Who serves HTML | Express reads `ui/dist/index.html` per request (`server/src/app.ts:984-1036`) | the Next.js handler; `app/layout.tsx` produces the `<head>` (branding, theme boot script, startup guard) |
| Routes | React Router `<BrowserRouter>` (`ui/src/main.tsx:69`) | the same React Router tree, rendered client-only inside `app/page.tsx` and `app/[companyPrefix]/[[...rest]]/page.tsx` |
| Static assets | `/assets/*` via `express.static`, 1 year, immutable | `/_next/static/*` via `express.static` with the same headers, served before the Next.js handler |
| Dev mode | Vite middleware (`server/src/app.ts:1072-1133`), HMR on a separate port | `next({ dev: true })` in the same process; its HMR upgrade is claimed before the live-events handler, which destroys unclaimed upgrades (`server/src/realtime/live-events-ws.ts:292-316`) |
| Runtime switch | - | `PAPERCLIP_UI_RUNTIME=next` (default after the first deploy window) or `vite` (today's path, kept until the final slice) |

Why two catch-all files and not one root `[[...slug]]`: later slices add `app/[companyPrefix]/issues/…`, and Next.js rejects an optional catch-all next to another dynamic segment at the same level. `app/page.tsx` serves `/`; `app/[companyPrefix]/[[...rest]]/page.tsx` serves every other path, including the unprefixed and public routes, which React Router still matches inside it.

### 3.2 How the two routers share one URL

- Inside the catch-all, React Router's `BrowserRouter` keeps navigating with `history.pushState`. The Next.js docs say that native `pushState` and `replaceState` calls integrate with the Next.js router and keep `usePathname` and `useSearchParams` in sync, without reloading the page (docs version 16.4.0, "Native History API").
- M0 must prove three things with a mount counter on the SPA root: 20 in-app navigations do not remount it; browser back and forward across those entries do not reload or remount; a hard reload of any deep URL renders the right page.
- If any of these fails, M0 stops (the go/no-go in section 8 lists it).

### 3.3 Custom server inside Express

- `next({ dev, dir: "<repo>/ui", httpServer: server })` is created after `createServer` (`server/src/index.ts:929`) and before `listen` (`:999`). `app.ts` registers a late-bound handler as the last route.
- `app.prepare()` starts at boot, but `listen` does not wait for it. The API, the socket and run recovery start as fast as today; a page request waits for the `prepare` promise. This keeps the restart cost that the planned-restart work (#103) is reducing from growing.
- Standalone output cannot be used with a custom server ("These cannot be used together", Next.js custom server docs), so the image keeps `next` in its runtime `node_modules`.
- **Measured in the M0 spike** (section 8): resident memory idle and during 10 parallel cold loads in a 2 GB container with `--max-old-space-size=1536` (`deploy/compose.yaml:24, 34`); time from process start to the first 200 HTML response; image size; `next build` time in CI.
- **If the custom server is not viable** (memory over the gate, an upgrade conflict, or a `prepare` cost that blocks the event loop): run `next start` as a second process in the same container on a loopback port, and let Express proxy every non-API path to it. One origin and cookie auth stay the same; the cost is a second process to supervise and a loopback hop for each page request.
- The read-only root file system (`deploy/compose.yaml:6`): no runtime cache is enabled (no ISR, no image optimisation, no `'use cache'`), and M0 checks that Next.js writes nothing outside `/tmp`. If it does, mount a tmpfs for that path.

### 3.4 What M0 must port from the Vite build

The Vite surface is small: 7 non-test lines use `import.meta.env` (`DEV`, `MODE`, `VITE_FEEDBACK_TERMS_URL`), 2 imports use `?raw` or `?url`, 1 uses `import.meta.glob`, and `ui/vite.config.ts` has one custom plugin.

| Vite feature | Next.js equivalent in M0 |
|---|---|
| `serviceWorkerBuildIdPlugin` stamps `sw.js` (`ui/src/lib/vite-sw-build-id.ts`) | a route handler for `/sw.js` that stamps the Next.js build id, `Cache-Control: no-cache`; the worker's public-asset rule (`ui/public/sw.js:58-59`) also accepts `/_next/static/` |
| `__PAPERCLIP_BUILD_COMMIT__` define | `env` in `next.config.ts` |
| `@` and `lexical` aliases | `tsconfig` paths and `turbopack.resolveAlias` |
| `@tailwindcss/vite` | `@tailwindcss/postcss`; `ui/src/index.css` and the token gates stay as they are |
| `?raw` imports | a `turbopack.rules` entry (shown in the Next.js Vite migration guide) |
| `VITE_FEEDBACK_TERMS_URL` | `NEXT_PUBLIC_FEEDBACK_TERMS_URL` |
| `keepNames`, `drop: console` (`ui/vite.config.ts`) | `compiler.removeConsole`; function names in error reports are checked in M0 and accepted or fixed |
| `index.html` inline scripts (theme boot, startup guard) | the same scripts in `app/layout.tsx`; the startup guard also listens for Next.js chunk load errors |
| #68's bundle budget plugin | a build check on the Next.js build output (first-load JS per route); the budget numbers carry over |
| #68's stale-chunk reload (`vite:preloadError`) | the same reload on Turbopack chunk load errors inside the catch-all; removed in MF if Next.js covers it |

The other Vite configs (`vite.preview.config.mjs`, `vite.flow-preview.config.mjs`, `vite.qa.config.mjs`) are developer tools. They stay on Vite. Vite also stays as the engine of Vitest and of Storybook (`@storybook/react-vite`).

### 3.5 M0b: providers and the board shell move into layouts

M0 keeps everything inside the catch-all, so a later App Router route would render without the sidebar, and the providers would remount when the user crosses between a migrated route and the catch-all. M0b fixes that before the first route moves:

- `app/layout.tsx` renders a client `<Providers>`: the module-level `QueryClient`, theme, company, live updates, toasts, tooltips, dialogs, and a React Router `<Router>` whose `location` comes from Next.js `usePathname` and `useSearchParams`. Its navigator uses `history.pushState` for catch-all paths and `router.push` for migrated paths (a registry of migrated route patterns in `ui/src/lib/router.tsx`). React Router hooks keep working everywhere, including the plugin bridge (`ui/src/plugins/bridge.ts:29`).
- `app/[companyPrefix]/layout.tsx` renders the board shell (`CloudAccessGate`, `Layout`: sidebar, breadcrumbs, the Cmd+K launcher) for board paths and bare children for public paths. The launcher (#86, merged; #95, open) moves with `Layout` unchanged; it is not rewritten.
- `App.tsx` keeps its routes, but the board branch renders an `<Outlet/>` instead of `Layout`, because the shell is now the segment layout.
- **Boot data comes from the server.** `app/layout.tsx` reads session, health, experimental settings, the company list and board access through the REST API during the request and hands them to the Query cache. This removes the A1 and A2 levels of speed plan section 3.2 (-140 ms on `wan`, -160 ms on `slow`, -360 ms on `mobile` [D]). It replaces the speed plan's boot script (S3), which is not built.
- The shell stays client-rendered in M0b (`ssr: false`), so the 1,331 browser-global lines of the speed plan (section 6.3) do not have to be server-safe yet.
- The 16 non-test files that import `react-router-dom` directly (speed plan, section 6.2) move behind `ui/src/lib/router.tsx`, and a lint rule keeps them there. Only `ui/app/**` and `ui/src/lib/router*` may import `next/navigation` or `next/link`. Storybook can then keep `@storybook/react-vite` with a mocked router.

## 4. Data path, security and the version pin

### 4.1 Server components read through the REST API

- A server-only module (`ui/src/lib/server-api.ts`) calls `http://127.0.0.1:<PORT>/api/...` in the same process. It forwards the caller's `Cookie`, `Host`, `X-Forwarded-Host` and `X-Forwarded-Proto`, so that `actorMiddleware` (`server/src/middleware/auth.ts:227`), the private-hostname guard (`server/src/app.ts:550-564`) and the company checks (`assertCompanyAccess`, `server/src/routes/authz.ts:75-121`) see the same request as from the browser. It sends `Accept-Encoding: identity` to skip compression on loopback.
- The existing `ui/src/api/*` modules get an injectable transport (base URL and headers), so the server and the browser use the same endpoint functions, response types and `queryKeys`. One source of truth; web, API and CLI parity stays in the REST API.
- Each segment creates a per-request `QueryClient`, prefetches with the same query options as the client, and passes `dehydrate(...)` to `<HydrationBoundary>`. Hydrated data is fresh for the client's `staleTime` (30 s, `ui/src/main.tsx:45`).
- The socket-open rule (`ui/src/context/LiveUpdatesProvider.tsx:2064-2066`) must skip queries hydrated or fetched in the last few seconds, or every server-rendered page fetches its data twice. This extends #54 and lands in M0b.
- Rate limits: `express-rate-limit` guards agent creation and token setup, not page reads (`server/src/routes/agents.ts:2894`), so loopback reads from one IP do not trip a limiter. M1 adds a test that a server render makes only GET requests.

### 4.2 No Server Actions, and why the version still matters

- No `'use server'` anywhere in `ui/`: an ESLint rule, plus a CI check that the build's server-reference manifest is empty.
- That removes the Server Function surface, but not the need to patch: CVE-2025-55182 (December 2025) reached apps that did not define Server Functions. The React Server Components runtime must always be on a patched release.

### 4.3 Version pin

| Item | Pin | Reason |
|---|---|---|
| `next` | **16.3.8**, exact | Released 2026-09-30. It fixes the seven advisories published that day (one high: SSRF in image optimisation; five medium; one low) and includes the earlier critical fixes (16.3.6 `next/og` RCE, 16.3.3 image-optimisation RCE, 16.2.11 Server Actions SSRF on custom servers). It is the newest release older than the install cooldown on this host (pnpm `minimum-release-age=10080` minutes, npm `min-release-age=7` days). `16.4.0` (2026-10-06) clears the cooldown on 2026-10-13 |
| React used by the App Router | the canary that `next@16.3.8` vendors | the App Router ships its own React canary build; `react` and `react-dom` 19.2.8 stay in `package.json` for tooling. M0 records the vendored version and checks it against the React Server Components advisories (the latest, GHSA-wx67-qw84-cm4g of 2026-07-21, is fixed in 19.2.8 builds) |
| `react-router-dom` | 7.18.4, unchanged | removed in MF; no v8 upgrade |
| Re-check | at M0 install time | take the newest patch of the newest minor that is older than 7 days and has no open advisory; re-read the advisories of `vercel/next.js` and `facebook/react` |

The plugin bridge hands the host's React to plugins (`ui/src/plugins/bridge-init.ts:71-90`). After M0 that is the App Router's canary build, not 19.2.8. The plugin e2e tests in M0 are the check.

## 5. What must survive unchanged

| Item | How it survives | Checked by |
|---|---|---|
| Live updates over the websocket, optimistic updates | client providers in the root layout (M0b); no change to `LiveUpdatesProvider` or mutation hooks | e2e; a probe that the socket stays connected across 20 navigations between migrated and catch-all routes |
| Plugin UI slots (20 slot types) | client components only; plugin pages (`plugins/:pluginId`, settings plugin pages) stay client-rendered; on server-rendered pages a slot renders a placeholder of reserved size and mounts after hydration | plugin e2e; no layout shift from a slot |
| Cmd+K launcher (#86 merged, #95 open) | lives in `Layout`, which becomes the segment layout in M0b and stays mounted; the launcher calls `router.prefetch` for a highlighted migrated route | the launcher e2e spec; focus does not move during hydration |
| Black-and-white tokens, token gates | `ui/src/index.css` imported by `app/layout.tsx`; `pnpm check:token-gates` scans the same sources plus `ui/app/**` | the token-gate check in each slice |
| Vitest UI tests | unchanged components; routing tests move with each route; tests run on React 19.2.8, production on the vendored canary, so e2e runs on the Next.js build | per slice |
| e2e and release smoke | `webServer` and the smoke image build with `next build` from M0 | per slice |
| Storybook | stays on `@storybook/react-vite`; components never import `next/*` directly (section 3.5) | `build-storybook` in M0 |

## 6. No overlap, nothing cancelled

### 6.1 The open perf PRs (#50 series)

| PR | Disposition | Reason |
|---|---|---|
| #50, plan and harness | **land as is** | the harness (`tests/perf/web-app/`) measures every migration slice; it lives only on #50's branch today; its author recommends landing it |
| #53, issue polling | **land as is** | client data behaviour; survives unchanged |
| #54, socket-open refetch filter | **land as is** | client data behaviour; M0b extends the same rule to freshly hydrated queries |
| #87, live-run placeholder size | **land as is** | client layout behaviour; survives unchanged |
| #57, precompressed assets | **land as interim** | it serves `/assets/*` for B1 and for the `vite` runtime switch. M0 re-points the same handler to `/_next/static/*`, because whether the Next.js handler compresses responses for a custom server is not settled (checked in M0). The `/assets/*` part goes in MF |
| #68, lazy routes and budget | **land as interim** | it gives B1 its measured first-load gain for the weeks the catch-all serves most routes; `lazy()` imports keep splitting under Turbopack. Route splitting is superseded route by route by App Router segments; the budget moves to the Next.js build in M0 and survives; the stale-chunk reload is ported in M0 and removed in MF if Next.js covers it |

### 6.2 The speed plan's SPA fixes

| Speed plan slice | Where it lives under Next.js |
|---|---|
| S1, harness: warm-navigation probe, `laptop` profile, `authenticated` fixture | unchanged; it is the measuring tool, and it lands before M0 (section 7) |
| S2, spike | replaced by the M0 + M1 spike (section 8) |
| S3, parallel boot calls | replaced by server boot data in `app/layout.tsx` (M0b); the boot script is not built |
| S4, intent prefetch on hover, focus, launcher highlight | for migrated routes, `next/link` prefetch (viewport, hover, touch) plus `router.prefetch` from keyboard focus and the launcher highlight, with the same limits (one in flight, first level only); the issue-link data prefetch that exists today stays |
| S5, feedback in one frame, matching skeletons | `loading.tsx` per segment (a prefetched Suspense fallback) plus `useLinkStatus` for slow links |
| S6, slow-page fixes (bounded lists, run fetched by id, inbox gate, issue-page reads) | framework-neutral client and API changes; each lands in or before its route's slice, and the server render benefits too |
| S7, persisted Query cache | **dropped**: a server-rendered first paint already shows data, and no company data has to be kept in the browser |
| S8, service worker and HTTP | folded into M0 (`/_next/static/` rule, build id, navigation preload measured) |
| S9, render work (#50 item F) | framework-neutral; the web-perf series owns it |
| S10, budgets | the JS budget moves to the Next.js build in M0 and is lowered per slice |

### 6.3 New UI from the other planning sessions

The software factory (Workflows canvas) and the Workroom sessions add pages while this migration runs. The rule:

- **Until M0 and M0b both land:** new pages are client components under `ui/src/pages`, registered as React Router routes in `App.tsx`, so they run inside the catch-all. They import routing only from `ui/src/lib/router.tsx`, fetch through `ui/src/api/*` with TanStack Query and `queryKeys`, keep layout preferences in cookies (not `localStorage`), and import nothing from `next/*`.
- **After M0b:** new pages are App Router segments under `ui/app/[companyPrefix]/…`, with `loading.tsx`, a server prefetch through the REST API and `HydrationBoundary`.
- M0 alone is not enough for the second rule, because before M0b a segment renders without the board shell.

## 7. Measurement protocol (updated)

All of the speed plan's section 10 applies. The caveats from #50's author add these rules:

- **Get the harness** with `git archive` of #50's branch (`tests/perf/web-app/`) until #50 lands. Outside the repo, link `packages` and `node_modules` next to the scripts, or `make-fixture.mjs` fails. Override the defaults with `PERF_BASE`, `PERF_DB_URL`, `PERF_INSTANCE`.
- **One machine per comparison.** B0 and B1 in the speed plan were measured on a Mac. A slice is judged only against B1 measured on the same machine, in the same session, interleaved (B1, slice, B1, slice), at least 5 runs per cell and 2 rounds, with the median, p75 and spread. Numbers from different machines are never compared; the speed plan's numbers are a reference, not the bar.
- **Under load above about 10, a single pass is noise.** Record the load average with every run; a comparison is invalid when the load changes more than 2x between the arms.
- **Request counts do not depend on machine speed.** Every slice reports requests per load and per navigation; they are the most reliable numbers on a shared host.
- **HTTP/2.** Local Chrome talks HTTP/1.1 with 6 connections to the fixture server, which makes many small chunks look worse than behind the HTTP/2 ingress. S1 adds a TLS HTTP/2 proxy built with Node's `http2` module (no new dependency) in front of the server, so migration and SSR comparisons see production-like multiplexing.
- **Service worker:** run with `serviceWorkers: "block"` when a probe intercepts requests.
- **Announcement:** dismiss the Connectors announcement first, or it becomes the LCP (the fixture script does this).
- **Restart the server after swapping a UI build:** the static compression handler reads its file list at startup.
- **Runs:** a worktree instance does not execute runs. Probes that need live runs insert run rows with SQL.
- **Layout shift:** test 0, 1, 2, 4 and many items for any count-dependent layout (#87's lesson), cold and warm, at 390 and 1440 px.
- **Requests per change:** report each event type alone (priority, title, comment, status, new issue), not a mixed percentage.
- **Render counts:** do not use `renders.mjs` totals; they over-count. INP is the render metric.
- **Fixture size:** the full 1,000-issue, 10,000-run fixture has not been run on the shared build host; measure where the disk allows it, and state the fixture size with every number.

## 8. Go/no-go: the M0 + M1 spike

The spike builds M0, M0b and M1 (the board and the list) on a local branch, after the install is allowed. It continues the migration only if all of these hold, measured as section 7 says:

| Check | Pass |
|---|---|
| Board warm navigation, by click, hover-then-click, Tab then Enter, and launcher Enter | usable p75 on M1 ≤ B1's usable p75, and median ≤ B1's median |
| Board cold load, `wan` | LCP median ≤ B1 (the speed plan's ceiling estimate is 300-500 ms against B1's 1,672 ms on the Mac) |
| No regression from M0 + M0b on the 10 harness pages | cold FCP, LCP and TTI medians within +5% or +50 ms of B1, whichever is larger; warm navigation medians within +5% or +20 ms; API calls per load ≤ B1; JS on the wire ≤ B1 + 10%; zero new console errors |
| One SPA root across navigations (section 3.2) | 0 remounts in 20 navigations, back and forward included |
| Live socket | stays connected across 20 navigations between the catch-all and M1 |
| Memory, 2 GB container, 1.5 GB heap | resident memory +250 MB or less at idle; no out-of-memory during 10 parallel cold loads |
| Start | process start to the first HTML 200: +2 s or less; API ready time unchanged |
| Image and CI | image +350 MB or less uncompressed (estimate: `next` 186 MB and its Linux SWC binary 97 MB unpacked); image build +5 min or less |

If the warm-navigation check fails because the server render after each click is slow, the spike tries full prefetch on intent (`router.prefetch` on hover, focus and launcher highlight) once. If it still fails, the migration stops at M0b, which already removes the boot levels, and the maintainers decide with the numbers.

## 9. Slices

Lanes: **risky** changes the server start, the image or every page; at most one risky PR per deploy window. **Normal** changes one route group.

| Slice | What | Lane | Size | Number to beat (B1, same machine) |
|---|---|---|---|---|
| H | Land #50 (harness), then S1 (warm-navigation probe, `laptop` profile, `authenticated` fixture, HTTP/2 proxy) | normal | S | - (produces the bar) |
| M0 | Next.js 16.3.8 as a custom handler in Express; catch-all renders today's SPA client-only; Turbopack build; `/_next/static` with #57's handler; SW, budget and stale-chunk ports; runtime switch `vite`/`next` | **risky** | L | every page: no regression (section 8 row 3) |
| M0b | Providers and board shell into layouts; React Router bridged to Next.js location; server boot data; direct `react-router-dom` imports behind the wrapper; socket-open refetch skips fresh data | **risky** | L | cold LCP -140 ms on `wan` [D]; no regression elsewhere |
| M1 | Tasks board and list: `[companyPrefix]/issues` segment, layout, `loading.tsx`, REST prefetch; issues view preference moves from `localStorage` (`ui/src/pages/Issues.tsx`) to a cookie so the server renders the right view | normal | M | board LCP 1,672 ms and list 1,120 ms (Mac, [M50]); warm navigation p75 from S1 |
| M2 | Issue detail: `issues/[issueId]`; S6 issue-page fixes; editor and chat thread stay client components | normal | L | issue TTI 4,751 ms (Mac, measured without #53); warm navigation 183 ms network wait [D] |
| M3 | Dashboard; live-run panel starts with the summary | normal | M | LCP 876 ms (Mac) |
| M4 | Inbox, decisions, approvals; inbox waits for its main list only | normal | M | warm navigation 161 ms network wait [D] |
| M5 | Agents list, agent detail, runs; run fetched by id | normal | L | agent overview 204 ms and transcript 274 ms network wait [D] |
| M6 | Projects, project detail, workspaces | normal | M | from S1 |
| M7 | Activity, runs, costs, budgets, routines, goals | normal | M | from S1 |
| M8 | Company and instance settings | normal | M | from S1 |
| M9 | Apps, plugins (client-rendered), skills, artifacts, cases, pipelines, status cards | normal | L | from S1 |
| M10 | Public routes (auth, invite, OAuth hand-off, board claim, CLI auth, onboarding) and the unprefixed redirects (server `redirect()` after resolving the company through the REST API) | normal | M | from S1 |
| MF | Remove the catch-all, React Router, the bridge, the Vite app entry and build, the `vite` runtime switch, #57's `/assets` handler; plugin bridge maps the SDK router hooks to Next.js navigation | **risky** | L | no regression on any route |

Each route slice: SSR-safety review of the moved tree (browser globals only in effects or client-only components), layout preferences from cookies, REST prefetch and hydration, `loading.tsx` with the final layout's shape, links to it through the wrapper (`next/link` for migrated routes), before and after against B1 on the same machine, desktop and mobile screenshots, zero console errors. Rollback: revert the slice; the catch-all serves the route again.

Order: H, M0, M0b, M1 (the spike decides here), then M2 to M10 (each one deploy window, normal lane, can follow one another quickly), then MF.

## 10. Deploy and CI

| Item | Today | During the migration | After MF |
|---|---|---|---|
| Dockerfile build stage | `pnpm --filter @paperclipai/ui build` (Vite) | `next build` and `vite build` (the runtime switch) | `next build` |
| Runtime image | `ui/dist` | `ui/.next` (without `.next/cache`), `ui/public`, `next` in `node_modules`, and `ui/dist` | without `ui/dist` |
| Image size | baseline | +350 MB uncompressed or less (gate) [D] | lower than during |
| CI build time | `vite build` 4.2 s in a 12-minute image build [CI] | + `next build` (not measured; gate +5 min) | `next build` only |
| Start and restart | Express listens; UI served at once | `listen` does not wait for `prepare`; pages wait for it | same |
| Dev mode | `pnpm dev`: Vite middleware | `next dev` in process; HMR upgrade claimed before the live-events handler; the managed-runtime HMR placeholder port (`server/src/app.ts:1041-1057`) stays until its supervisor changes | same |
| CSP | none on the HTML | Next.js inline scripts need a nonce if a CSP is added later (Next.js supports one through `proxy.ts`) | same |

## 11. Open questions

| # | Question | Recommendation |
|---|---|---|
| 1 | The M0 install: `next` is a new dependency, which needs an online install on a host at its disk floor | Install in a fresh worktree only after a maintainer's go and with 9,000 MiB or more free; pin 16.3.8 or the re-checked newest patch older than 7 days |
| 2 | Keep the Vite build in the image during the migration, for the `vite` runtime switch? | Yes, until MF. It costs a few seconds of build and the `ui/dist` files, and it gives the operator a rollback without a rebuild |
| 3 | Layout preferences that live in `localStorage` (51 non-test files use it; the issues view mode decides the board or list layout) | Move the ones that change the server-rendered layout to cookies, route by route; leave the rest client-only |
| 4 | Drop the persisted Query cache (speed plan S7)? | Yes. Server rendering gives the first paint with data |
| 5 | Storybook framework | Keep `@storybook/react-vite`; components import routing only from the wrapper |
| 6 | Upgrade React Router to v8? | No. It is removed in MF; v7 gets security fixes until then |
| 7 | Who implements | The author of this plan for S1, M0, M0b and M1; route slices M2 to M10 can go to other implementers once M1 sets the pattern, one segment directory each, so they do not overlap |
| 8 | The corrected render counter from #50's author | Not needed for the gate (INP is the render metric); commit it only if S9 needs it |
| 9 | Phones and slow links (speed plan open question 1) | Still useful: if phones matter, M10 (public routes) and the mobile profile move earlier |

## Appendix A. Sources outside the repository

- Next.js custom server (docs version 16.4.0): https://nextjs.org/docs/app/guides/custom-server
- Next.js linking and navigating, native History API, `loading.tsx` prefetch (docs version 16.4.0): https://nextjs.org/docs/app/getting-started/linking-and-navigating
- Next.js migration guide from Vite: https://nextjs.org/docs/app/guides/migrating/from-vite
- Next.js 16 (App Router uses a built-in React canary): https://nextjs.org/blog/next-16
- Next.js security advisories: https://github.com/vercel/next.js/security/advisories
- React security advisories: https://github.com/facebook/react/security/advisories
- `next` release dates: the npm registry (`npm view next time`)
