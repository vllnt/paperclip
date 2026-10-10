# Web app migration to Next.js, measured route by route

Date: 2026-10-10
Status: Plan only. No code ships with this pull request. The M0 code PR starts after this plan is approved and after a maintainer allows the install of the new dependency.
Branch: `docs/web-app-speed-nextjs-plan`
Evidence base: `doc/plans/2026-10-10-web-app-speed-nextjs-plan.md` (same pull request, fact-checked). It holds the route inventory, the B0 and B1 numbers, the boot waterfall and the constraints. This plan does not repeat them; it cites them as "speed plan, section N".

## 1. Decision record

- **Decision (maintainer, 2026-10-10):** migrate the web app (`ui/`) to the Next.js App Router, completely, and remove React Router and the Vite app build at the end.
- **What the speed plan recommended, and why (considered, not chosen):** stay on the single-page app and finish it (speed plan, section 0). Its reasons: the slow pages are slow because of serial API levels, page code that loads after the click, missing loading states, unbounded lists and render cost; every option can reach about 0 ms network wait on warm navigation with intent prefetch; a migration costs a router rewrite across about 250 files, a rendering server in the 2 GB container and the React Server Components attack surface.
- **How this plan keeps that evidence honest:**
  - B1 is the bar: every migration slice must meet or beat B1 **re-measured on the same machine in the same session** (sections 7 and 8), or it does not merge. The speed plan's B1 numbers (measured on a Mac) are the reference for what to expect.
  - The causes in speed plan section 5.6 are fixed inside the migration slices, not left behind (section 6.2).
  - The risks the speed plan named (server memory and CPU, the Flight endpoint, plugin slots, keyboard focus, tests, deploy) each have a guard in this plan (sections 3 to 5).

## 2. Target shape

```
 browser ──HTTPS──> ingress ──> Express, one Node process (server/src/index.ts:929)
                                  ├─ /api/*, /api/auth/*               REST (unchanged; the only data path)
                                  ├─ upgrades: /api/companies/:id/events/ws (live events),
                                  │   /api/runner/v1/connect/* (remote runners),
                                  │   /api/environment-custom-image-setup-sessions/:id/terminal/ws  (all unchanged;
                                  │   Next.js never sees an upgrade except /_next/hmr in dev)
                                  ├─ /_next/image, /_next/mcp           404 (not used; both had advisories)
                                  ├─ /_plugins/*, /llms/*, /mcp/*, /runtime-tools/*   unchanged
                                  ├─ /_next/static/*                   express.static, immutable, br/gz siblings (#57's handler, re-pointed)
                                  └─ every other GET/HEAD ──> Next.js request handler (custom server, same process);
                                                               other methods get 405
                                                           │
                       app/layout.tsx (server) ── fetches boot data through the REST API with the caller's cookie
                         └─ <Providers> (client): QueryClient (one per request on the server, one in the browser),
                                                   theme, company, live updates, toasts, React Router bridge
                              ├─ app/page.tsx                         "/" (SPA, client-only, until M10)
                              └─ app/[companyPrefix]/layout.tsx       board shell (sidebar, launcher), client
                                   ├─ issues/page.tsx + loading.tsx   M1: server component, REST prefetch, HydrationBoundary
                                   ├─ issues/[issueId]/…              M2
                                   ├─ …                               M3-M10
                                   └─ [[...rest]]/page.tsx            catch-all: today's React Router routes, client-only
```

Rules that hold in every slice:

- **One process, one origin, the same cookie auth.** Next.js runs as a request handler inside the existing Express server, after every existing route (section 3). It never sees a websocket upgrade in production (section 3.3).
- **One data path.** Server components read through the same REST API with the caller's session. No direct service or database calls from `ui/`. **No Server Actions:** all mutations stay on REST through TanStack Query (section 4).
- **One UI tree at a time per route.** A route is served either by its App Router segment or by the catch-all, never both. Rollback of a route = revert its slice; the catch-all serves it again, because the React Router route stays in `App.tsx` until the final slice.
- **A migrated segment never calls `notFound()` for params it does not recognise** until MF. It renders the catch-all's content instead, because other routes share its URL shape (for example `/u/:userSlug` with the slug `issues` looks like `/:companyPrefix/issues`, `ui/src/App.tsx:854`).

## 3. M0: adoption with no visible change

### 3.1 What M0 changes

| Part | Today | After M0 |
|---|---|---|
| Who builds the UI | `vite build` (`ui/vite.config.ts`) | `next build` (Turbopack). The Vite build stays in the image while M0 is the newest UI slice, behind a runtime switch, for rollback |
| Who serves HTML | Express reads `ui/dist/index.html` per request (`server/src/app.ts:984-1036`) | the Next.js handler; `app/layout.tsx` produces the `<head>` (branding, theme boot script, startup guard) |
| Routes | React Router `<BrowserRouter>` (`ui/src/main.tsx:69`) | the same React Router tree, rendered client-only inside `app/page.tsx` and `app/[companyPrefix]/[[...rest]]/page.tsx` |
| Static assets | `/assets/*` via `express.static`, 1 year, immutable | `/_next/static/*` via `express.static` with the same headers, served before the Next.js handler |
| Dev mode | Vite middleware (`server/src/app.ts:1060-1133`), HMR on a separate port | `next({ dev: true })` in the same process; the one upgrade dispatcher (section 3.3) passes `/_next/hmr` to Next.js |
| Runtime switch | - | `PAPERCLIP_UI_RUNTIME=next` (default after the first deploy window) or `vite` (today's path). It lives only while M0 is the newest UI slice: after M0b the Vite build has no shell, so from M0b on, rollback is a revert |

Why `app/page.tsx` plus `app/[companyPrefix]/[[...rest]]/page.tsx` and not one root `[[...slug]]`: the board shell must be a layout that wraps both the migrated segments and the catch-all, so both must live under `app/[companyPrefix]/`. `app/page.tsx` serves `/`; the catch-all serves every other path, including the unprefixed and public routes, which React Router still matches inside it. A static folder such as `issues` wins over `[[...rest]]`, and deeper paths that no segment matches fall back to the catch-all.

### 3.2 How the two routers share one URL

- Inside the catch-all, React Router's `BrowserRouter` keeps navigating with `history.pushState`. The Next.js docs say that native `pushState` and `replaceState` calls integrate with the Next.js router and keep `usePathname` and `useSearchParams` in sync, without reloading the page (docs version 16.4.0, "Native History API").
- M0 must prove three things with a mount counter on the SPA root: 20 in-app navigations do not remount it; browser back and forward across those entries do not reload or remount; a hard reload of any deep URL renders the right page. It also checks that scroll restoration on back and forward (`ui/src/components/Layout.tsx:590-616`, keyed by `location.key`) and router state (`location.state`, used by `ui/src/pages/IssueDetail.tsx:3073-3077`) still work.
- If any of these fails, M0 stops (the go/no-go in section 8 lists it).

### 3.3 Custom server inside Express

- `next({ dev, dir: "<repo>/ui", httpServer: <private emitter> })` is created after `createServer` (`server/src/index.ts:929`) and before `listen` (`:999`). `app.ts` registers a late-bound handler as the last route. In production it takes GET and HEAD only; other methods get 405, so no request can reach a Server Action decoder. In dev it also lets `POST /__nextjs_*` through, which the error overlay uses. `/_next/image` and `/_next/mcp` get 404. `next.config.ts` sets `turbopack.root` to the repository root (one `?raw` import reaches outside `ui/`) and turns off the managed `AGENTS.md` block that `next dev` writes since 16.3 (`agentRules`), because this repository governs `AGENTS.md`.
- **Websocket upgrades.** On its first request, Next.js attaches its own `upgrade` listener to `httpServer`, or, when none is given, to the request's server (`packages/next/src/server/next.ts:491-514` at v16.3.8). For an upgrade that is not its hot-reload path, it resolves routes and ends the socket when a route matches, and the catch-all matches `/api/companies/:id/events/ws` (with `companyPrefix` = `api`). So Next.js gets a private `EventEmitter` as `httpServer`, never the real server. The three upgrade listeners that exist today (remote runners, the setup terminal and live events, registered at `server/src/index.ts:964-968`) stay unchanged. In dev only, one more listener is added **first** (`server.prependListener("upgrade", …)`), because Node calls listeners in order and the live-events listener destroys paths it does not know (`server/src/realtime/live-events-ws.ts:291-316`). It claims `/_next/hmr`: it re-emits the upgrade to Next's emitter and marks it handled, or destroys the socket when Next has not attached its listener yet (Next attaches it on its first handled request). All three upgrade paths must open after a page load, in production and in dev, and hot reload must connect (go/no-go, section 8). In dev behind a managed hostname, that origin goes into `allowedDevOrigins`.
- `app.prepare()` starts at boot, but `listen` does not wait for it. The API, the socket and run recovery start as fast as today; a page request waits for the `prepare` promise. This keeps the restart cost that the planned-restart work (#103) is reducing from growing.
- Standalone output cannot be used with a custom server ("These cannot be used together", Next.js custom server docs), so the image keeps `next` in its runtime `node_modules`.
- **Measured in the M0 spike** (section 8): resident memory idle and during 10 parallel cold loads in a 2 GB container with `--max-old-space-size=1536` (`deploy/compose.yaml:24, 34`); time from process start to the first 200 HTML response; image size; `next build` time in CI.
- **If the custom server is not viable** (memory over the gate, an upgrade conflict that the dispatcher cannot settle, or a `prepare` cost that blocks the event loop): run `next start` as a second process in the same container on a loopback port, and let Express proxy every non-API GET to it. One origin and cookie auth stay the same, and upgrades never reach Next.js; the cost is a second process to supervise and a loopback hop for each page request.
- The read-only root file system (`deploy/compose.yaml:6`): no runtime cache is enabled (no ISR, no image optimisation, no `'use cache'`), and M0 checks that Next.js writes nothing outside `/tmp`. If it does, mount a tmpfs for that path.
- **Next.js telemetry** is on by default for `next build` and `next dev` and sends data to Vercel. `NEXT_TELEMETRY_DISABLED=1` is set in the Dockerfile, CI and the dev scripts. This is a third-party data path, so it stays off (AGENTS.md section 5, rule 7, names this repo's own data paths).

### 3.4 What M0 must port from the Vite build

The Vite surface is small: 7 non-test lines use `import.meta.env` (`DEV`, `MODE`, `VITE_FEEDBACK_TERMS_URL`), 2 imports use `?raw` or `?url`, 1 uses `import.meta.glob`, and `ui/vite.config.ts` has one custom plugin.

| Vite feature | Next.js equivalent in M0 |
|---|---|
| `serviceWorkerBuildIdPlugin` stamps `sw.js` (`ui/src/lib/vite-sw-build-id.ts`) | a route handler for `/sw.js` that stamps the Next.js build id, `Cache-Control: no-cache`; the template moves out of `ui/public/` so the two do not conflict; the worker's public-asset rule (`ui/public/sw.js:58-59`) also accepts `/_next/static/` |
| `__PAPERCLIP_BUILD_COMMIT__` define | a `NEXT_PUBLIC_PAPERCLIP_BUILD_COMMIT` variable set at build time (the `env` key in `next.config.ts` is a legacy API) |
| `import.meta.env.MODE` and `DEV` | Turbopack supports both natively (`MODE` is the build's `NODE_ENV`); only the `"qa"` mode (`ui/src/pages/IssueDetail.tsx:3200`) needs a `NEXT_PUBLIC_PAPERCLIP_MODE` variable |
| `import.meta.glob` (`ui/src/i18n/locales.ts:7`) | supported by Turbopack since 16.3 ("Built-in glob imports", release notes); checked in M0, else explicit imports |
| #57's `.br` and `.gz` siblings (a Vite plugin) | a post-build step that writes them for `.next/static`; Express serves `/_next/static` with #57's handler |
| `@` and `lexical` aliases | `tsconfig` paths and `turbopack.resolveAlias` |
| `@tailwindcss/vite` | `@tailwindcss/postcss`; `ui/src/index.css` and the token gates stay as they are |
| `?raw` imports | a `turbopack.rules` entry (shown in the Next.js Vite migration guide) |
| `VITE_FEEDBACK_TERMS_URL` | `NEXT_PUBLIC_FEEDBACK_TERMS_URL` |
| `keepNames`, `drop: ["console", "debugger"]` (`ui/vite.config.ts`) | `compiler.removeConsole` (it does not drop `debugger`; a lint rule does); function names in error reports are checked in M0 and accepted or fixed |
| `index.html` inline scripts (theme boot, startup guard) | the same scripts in `app/layout.tsx`; the startup guard also listens for Next.js chunk load errors |
| #68's bundle budget plugin | a build check on the Next.js build output (first-load JS per route); the budget numbers carry over |
| #68's stale-chunk reload (`vite:preloadError`) | the same reload on Turbopack chunk load errors inside the catch-all; removed in MF if Next.js covers it |

The other Vite configs (`vite.preview.config.mjs`, `vite.flow-preview.config.mjs`, `vite.qa.config.mjs`) are developer tools. They stay on Vite. Vite also stays as the engine of Vitest and of Storybook (`@storybook/react-vite`).

### 3.5 M0b: providers and the board shell move into layouts

M0 keeps everything inside the catch-all, so a later App Router route would render without the sidebar, and the providers would remount when the user crosses between a migrated route and the catch-all. M0b fixes that before the first route moves:

- `app/layout.tsx` renders a client `<Providers>`: the `QueryClient`, theme, company, live updates, toasts, tooltips, dialogs, and a React Router `<Router>` bridged to the Next.js router.
  - **QueryClient:** a client component in the root layout also renders on the server, so a module-level client would be shared by every request in the process and could hand one user's session to another. The server creates a new client per request; the browser keeps one (TanStack Query's `getQueryClient()` pattern). A test renders two users' pages at the same time and checks that neither sees the other's data.
  - **Router location:** the pathname and search come from `usePathname` and `useSearchParams`, which also work on the server. The hash, the state and the key come from `history.state` (React Router's `usr` and `key`) through `useSyncExternalStore`, with a server snapshot of `{ hash: "", state: null, key: "default" }`, so the first browser render matches the server HTML (M0c). The navigation type comes from `popstate`. After each `router.push`, the bridge merges a React Router style `key` into `history.state` (`replaceState`), because Next.js entries carry none and scroll memory (`ui/src/components/Layout.tsx:590-616`) is keyed by it.
  - **Navigator:** `history.pushState` between two catch-all paths; `router.push(href, { scroll: false })` whenever the current or the target route is migrated, because a native `pushState` only syncs the URL and does not render a new segment. Route state that must cross that boundary moves to the Query cache (the issue page's header seed already has one: `prefetchIssueDetailForNavigation`, `ui/src/lib/issueDetailCache.ts:185-196`). A registry of migrated route patterns in `ui/src/lib/router.tsx` decides which way.
  - React Router hooks keep working everywhere, including the plugin bridge (`ui/src/plugins/bridge.ts:29`).
- `app/[companyPrefix]/layout.tsx` renders the board shell (`CloudAccessGate`, `Layout`: sidebar, breadcrumbs, the Cmd+K launcher) for board paths and bare children for public paths. The launcher (#86, merged; #95, open) moves with `Layout` unchanged; it is not rewritten.
- `App.tsx` keeps its routes, but the board branch renders an `<Outlet/>` instead of `Layout`, because the shell is now the segment layout.
- The 16 non-test files that import `react-router-dom` directly (speed plan, section 6.2) move behind `ui/src/lib/router.tsx`, and a lint rule keeps them there. Only `ui/app/**` and `ui/src/lib/router*` may import `next/navigation` or `next/link`. Storybook can then keep `@storybook/react-vite` with a mocked router.
- **Boot data comes from the server.** `app/layout.tsx` reads session, health, experimental settings, the company list and board access through the REST API during the request and hands them to the Query cache. Each call has a short timeout (about 1 s) and fails open: on an error, a timeout or a 401, the page renders without that entry and the browser fetches it as today. Public pages skip the company calls. This removes the A1 and A2 levels of speed plan section 3.2 from the browser (-140 ms on `wan`) but adds the five in-process calls to the time to first byte (about +30-50 ms with S = 30 ms, run in parallel), so the expected gain is **about -90 to -110 ms on `wan`** [D]. It replaces the speed plan's boot script (S3), which is not built.
- The shell stays client-rendered in M0b (`ssr: false`), so the 1,331 browser-global lines of the speed plan (section 6.3) do not have to be server-safe yet. Because the children of a client-only boundary are not in the HTML, no page gets a server-rendered first paint until M0c.

### 3.6 M0c: the shell renders on the server

Without this slice, a migrated route gets its data prefetched on the server but no HTML first paint, so the cold-load gain in the speed plan's section 6.5 (LCP 300-500 ms on `wan`, a ceiling) would not appear.

- `Providers`, `CloudAccessGate` and `Layout` become safe to render on the server: no browser globals during render. Known cases: `ui/src/context/SidebarContext.tsx:40-41` reads `window.innerWidth`, `ui/src/context/ThemeContext.tsx:102` reads `localStorage`.
- Preferences that change the shell's first paint (theme, sidebar state) move to cookies that the server reads; the theme boot script stays for the first frame.
- Plugin slots in the shell render a placeholder of reserved size on the server and mount after hydration.
- The catch-all page stays client-only; only the shell and migrated segments render on the server.
- Expected: the shell paints from the HTML before the JavaScript; on catch-all routes, LCP is still the page content, so the gain there is the shell only.

## 4. Data path, security and the version pin

### 4.1 Server components read through the REST API

- A server-only module (`ui/src/lib/server-api.ts`) calls the REST API in the same process, at the address the server actually listens on (`server.address()`; the bind host can be loopback, a LAN or tailnet address, or custom, `server/src/index.ts:999`). A wildcard bind (`0.0.0.0` or `::`, as in the compose file) maps to loopback. It forwards the caller's `Cookie`, `Host`, `X-Forwarded-Host` and `X-Forwarded-Proto`, so that `actorMiddleware` (`server/src/middleware/auth.ts:227`), the private-hostname guard (`server/src/app.ts:550-564`) and the company checks (`assertCompanyAccess`, `server/src/routes/authz.ts:75-121`) see the same request as from the browser. It sends `Accept-Encoding: identity` to skip compression on loopback.
- The existing `ui/src/api/*` modules get an injectable transport (base URL and headers), so the server and the browser use the same endpoint functions, response types and `queryKeys`. One source of truth; web, API and CLI parity stays in the REST API.
- Each segment creates a per-request `QueryClient`, prefetches with the same query options as the client, and passes `dehydrate(...)` to `<HydrationBoundary>`. Hydrated data is fresh for the client's `staleTime` (30 s, `ui/src/main.tsx:45`).
- The socket-open rule (`ui/src/context/LiveUpdatesProvider.tsx:2064-2066`) must skip queries hydrated or fetched in the last few seconds, or every server-rendered page fetches its data twice. This extends #54 and lands in M0b.
- Every call has a timeout and an error policy: fail open to the browser fetch (section 3.5), never block the HTML on an API error.
- Rate limits: most limiters guard writes (agent creation, `server/src/routes/agents.ts:2894`), but invite reads have a per-IP limiter (`GET /api/invites/:token…`, 20 per minute, `server/src/services/invite-rate-limit.ts`). Server renders would put every visitor into the loopback bucket, so the invite page (M10) keeps fetching in the browser. M1 adds a test that a server render makes only GET requests.
- Server load: every loopback call runs `actorMiddleware`, and every RSC prefetch renders on the server. Each slice reports loopback and RSC requests per page load and the server CPU per render (section 8). Links in long lists (board cards, list rows) start with `prefetch={false}` and switch to `prefetch={true}` on pointer enter or focus (`prefetch={false}` alone also turns off hover prefetch, Link docs).

### 4.2 No Server Actions, and why the version still matters

- No `'use server'` anywhere in `ui/`: an ESLint rule, plus a CI check that the build's server-reference manifest is empty.
- Defence in depth: Express passes only GET and HEAD to the Next.js handler and answers 405 to other methods, so no request body reaches the Flight decoder of a Server Action.
- That removes the Server Function surface, but not the need to patch: CVE-2025-55182 (December 2025) reached apps that did not define Server Functions. The React Server Components runtime must always be on a patched release.

### 4.3 Version pin

| Item | Pin | Reason |
|---|---|---|
| `next` | **16.3.8**, exact | Released 2026-09-30. It fixes the seven advisories published that day (one high: SSRF in image optimisation; five medium; one low) and includes the earlier critical fixes (16.3.6 `next/og` RCE, 16.3.3 image-optimisation RCE, 16.2.11 Server Actions SSRF on custom servers). It is the newest release older than the install cooldown on this host (pnpm `minimum-release-age=10080` minutes, npm `min-release-age=7` days). `16.4.0` (2026-10-06) clears the cooldown on 2026-10-13 |
| React used by the App Router | `19.3.0-canary-cbb046ab-20260731`, vendored by `next@16.3.8` (`package.json` of the Next.js repository at `v16.3.8`) | the App Router ships its own React canary build; `react` and `react-dom` 19.2.8 stay in `package.json` for tooling. The canary is dated 2026-07-31, after the fix for the latest React Server Components advisory (GHSA-wx67-qw84-cm4g, 2026-07-21, fixed in 19.2.8); M0 confirms the fix is in it |
| `react-router-dom` | 7.18.4, unchanged | removed in MF; no v8 upgrade |
| Re-check | at M0 install time | take the newest patch of the newest minor that is older than 7 days and has no open advisory; re-read the advisories of `vercel/next.js` and `facebook/react` |

The plugin bridge hands the host's React to plugins (`ui/src/plugins/bridge-init.ts:71-90`). After M0 that is the App Router's canary build, not 19.2.8. The plugin e2e tests in M0 are the check.

## 5. What must survive unchanged

| Item | How it survives | Checked by |
|---|---|---|
| Live updates over the websocket, optimistic updates | client providers in the root layout (M0b); no change to `LiveUpdatesProvider` or mutation hooks; Next.js never receives the upgrade (section 3.3) | e2e; a probe that the socket opens after a page load, in production and in dev, and stays connected across 20 navigations between migrated and catch-all routes |
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
| #50, plan and harness | **land as is** | the harness (`tests/perf/web-app/`) measures every migration slice; it lives only on #50's branch today, so the migration needs it on `main`; it changes no runtime code |
| #53, issue polling | **land as is** | client data behaviour; survives unchanged |
| #54, socket-open refetch filter | **land as is** | client data behaviour; M0b extends the same rule to freshly hydrated queries |
| #87, live-run placeholder size | **land as is** | client layout behaviour; survives unchanged |
| #57, precompressed assets | **land as interim** | it serves `/assets/*` for B1 and for the `vite` runtime switch. M0 re-points the same handler to `/_next/static/*`, with a post-build step that writes the `.br` and `.gz` siblings. Next.js would gzip those files itself (its `compress` option also applies to a custom server), but #57 serves brotli, which is smaller. The `/assets/*` part goes in MF |
| #68, lazy routes and budget | **land as interim** | it gives B1 its measured first-load gain for the weeks the catch-all serves most routes; `lazy()` imports keep splitting under Turbopack. Route splitting is superseded route by route by App Router segments; the budget moves to the Next.js build in M0 and survives; the stale-chunk reload is ported in M0 and removed in MF if Next.js covers it |

### 6.2 The speed plan's SPA fixes

| Speed plan slice | Where it lives under Next.js |
|---|---|
| S1, harness: warm-navigation probe, `laptop` profile, `authenticated` fixture | unchanged; it is the measuring tool, and it lands before M0 (section 7) |
| S2, spike | replaced by the spike over M0 to M1 (section 8) |
| S3, parallel boot calls | replaced by server boot data in `app/layout.tsx` (M0b); the boot script is not built |
| S4, intent prefetch on hover, focus, launcher highlight | for migrated routes, `next/link` prefetch: long lists switch a link's `prefetch` from `false` to `true` on pointer enter or focus. The launcher's rows are not links: on highlight it calls `router.prefetch(href)` (partial by default, down to `loading.tsx`) and the route's Query prefetch through the shared `ui/src/api/*` modules. Same limits as the speed plan: one in flight, first level only. The issue-link data prefetch that exists today stays. The spike measures launcher navigation this way |
| S5, feedback in one frame, matching skeletons | `loading.tsx` per segment (a prefetched Suspense fallback) plus `useLinkStatus` for slow links |
| S6, slow-page fixes (bounded lists, run fetched by id, inbox gate, issue-page reads) | framework-neutral client and API changes; each lands in or before its route's slice, and the server render benefits too |
| S7, persisted Query cache | **dropped** once M0c lands: a server-rendered first paint already shows data, and no company data has to be kept in the browser. Until M0c, catch-all routes keep today's behaviour |
| S8, service worker and HTTP | folded into M0 (`/_next/static/` rule, build id, navigation preload measured) |
| S9, render work (#50 item F) | framework-neutral; the web-perf series owns it |
| S10, budgets | the JS budget moves to the Next.js build in M0 and is lowered per slice |

### 6.3 New UI from the other planning sessions

Other planned features add pages while this migration runs. The rule for them:

- **Until M0 and M0b both land:** new pages are client components under `ui/src/pages`, registered as React Router routes in `App.tsx`, so they run inside the catch-all. They import routing only from `ui/src/lib/router.tsx`, fetch through `ui/src/api/*` with TanStack Query and `queryKeys`, keep layout preferences in cookies (not `localStorage`), and import nothing from `next/*`.
- **After M0b:** new pages are App Router segments under `ui/app/[companyPrefix]/…`, with `loading.tsx`, a server prefetch through the REST API and `HydrationBoundary`.
- M0 alone is not enough for the second rule, because before M0b a segment renders without the board shell.

## 7. Measurement protocol (updated)

All of the speed plan's section 10 applies. What was learned while measuring #50 to #87 adds these rules:

- **Get the harness** with `git archive` of #50's branch (`tests/perf/web-app/`) until #50 lands. Outside the repo, link `packages` and `node_modules` next to the scripts, or `make-fixture.mjs` fails. Override the defaults with `PERF_BASE`, `PERF_DB_URL`, `PERF_INSTANCE`.
- **Board or list view:** the harness picks the view through `localStorage` (`measure.mjs:43-48` on #50). M1 moves that preference to a cookie, so M1 updates the harness to set the cookie, or both rows measure the default view.
- **One machine per comparison.** B0 and B1 in the speed plan were measured on a Mac. A slice is judged only against B1 measured on the same machine, in the same session, interleaved (B1, slice, B1, slice), at least 5 runs per cell and 2 rounds, with the median, p75 and spread. Numbers from different machines are never compared; the speed plan's numbers are a reference, not the bar.
- **Under load above about 10, a single pass is noise.** Record the load average with every run; a comparison is invalid when the load changes more than 2x between the arms.
- **Request counts do not depend on machine speed.** Every slice reports requests per load and per navigation; they are the most reliable numbers on a shared host.
- **HTTP/2.** Local Chrome talks HTTP/1.1 with 6 connections to the fixture server, which makes many small chunks look worse than behind the HTTP/2 ingress. S1 adds a TLS HTTP/2 proxy built with Node's `http2` module (no new dependency) in front of the server, so migration and SSR comparisons see production-like multiplexing. It must also accept HTTP/1.1 (`allowHTTP1`) so the websocket upgrades pass.
- **Service worker:** run with `serviceWorkers: "block"` when a probe intercepts requests.
- **Announcement:** dismiss the Connectors announcement first, or it becomes the LCP (the fixture script does this).
- **Restart the server after swapping a UI build:** the static compression handler reads its file list at startup.
- **Runs:** a worktree instance does not execute runs. Probes that need live runs insert run rows with SQL.
- **Layout shift:** test 0, 1, 2, 4 and many items for any count-dependent layout (#87's lesson), cold and warm, at 390 and 1440 px.
- **Requests per change:** report each event type alone (priority, title, comment, status, new issue), not a mixed percentage.
- **Render counts:** do not use `renders.mjs` totals; they over-count. INP is the render metric.
- **Fixture size:** the full 1,000-issue, 10,000-run fixture has not been run on the shared build host; measure where the disk allows it, and state the fixture size with every number.

## 8. Go/no-go: the spike over M0 to M1

The spike builds the first slices (the board and the list) on a local branch, after the install is allowed. It continues the migration only if all of these hold, measured as section 7 says:

| Check | Pass |
|---|---|
| Board warm navigation, by click, hover-then-click, Tab then Enter, and launcher Enter | usable p75 on M1 ≤ B1's usable p75, and median ≤ B1's median |
| Board cold load, `wan` | LCP median ≤ B1 (the speed plan's ceiling estimate is 300-500 ms against B1's 1,672 ms on the Mac) |
| No regression from M0 + M0b on the 10 harness pages | cold FCP, LCP and TTI medians within +5% or +50 ms of B1, whichever is larger; warm navigation medians within +5% or +20 ms; API calls per load ≤ B1; JS on the wire ≤ B1 + 10%; zero new console errors |
| Every other route | a route smoke over all routes (109 in #68's run), desktop and mobile: each loads, no failed asset, no console error. #68 ran it from its working session; slice H commits it as `tests/perf/web-app/route-smoke.mjs` |
| Router state | scroll restored on back and forward; `location.state` survives; navigation works both ways between the catch-all and M1 |
| Server load | loopback API calls and RSC requests per page load reported; server CPU per board page load p75 ≤ 150 ms on the measuring machine, and 10 parallel board loads keep the API p95 within +20% of its idle value (the container has 2 CPUs shared with run orchestration) |
| One SPA root across navigations (section 3.2) | 0 remounts in 20 navigations, back and forward included |
| Websockets | all three upgrade paths (live events, remote runners, setup terminal) open after a page load, in production and in dev; hot reload connects in dev; the live socket stays connected across 20 navigations between the catch-all and M1 |
| Memory, 2 GB container, 1.5 GB heap | resident memory +250 MB or less at idle; no out-of-memory during 10 parallel cold loads |
| Two users at once | two concurrent server renders by different users: neither response contains the other's data |
| Start | process start to the first HTML 200: +2 s or less; API ready time unchanged |
| Image and CI | image +350 MB or less uncompressed (estimate: `next` 186 MB and its Linux SWC binary 97 MB unpacked); image build +5 min or less |

The spike builds M0, M0b, M0c and M1, because without M0c the board has no server-rendered first paint. If the warm-navigation check fails because the server render after each click is slow, the spike tries two things once: full prefetch on intent (links switch to `prefetch={true}` on hover and focus), and a server component that skips its REST prefetch on client navigations so the page renders from the Query cache filled on intent. If it still fails, the migration stops at M0b, which already removes the boot levels, and the maintainers decide with the numbers.

## 9. Slices

Lanes: **risky** changes the server start, the image or every page; at most one risky PR per deploy window. **Normal** changes one route group.

| Slice | What | Lane | Size | Number to beat (B1, same machine) |
|---|---|---|---|---|
| H | Land #50 (harness), then S1 (warm-navigation probe, `laptop` profile, `authenticated` fixture, HTTP/2 proxy, route smoke script) | normal | S | - (produces the bar) |
| M0 | Next.js 16.3.8 as a custom handler in Express (GET and HEAD only, private upgrade emitter, telemetry off); catch-all renders today's SPA client-only; Turbopack build; `/_next/static` with #57's handler; SW, budget and stale-chunk ports; runtime switch `vite`/`next` | **risky** | L | every page: no regression (section 8) |
| M0b | Providers and board shell into layouts; per-request QueryClient on the server; React Router bridged to the Next.js router; server boot data with timeouts; direct `react-router-dom` imports behind the wrapper; socket-open refetch skips fresh data | **risky** | L | cold LCP about -90 to -110 ms on `wan` [D]; no regression elsewhere |
| M0c | The shell renders on the server: no browser globals in `Providers`, `CloudAccessGate`, `Layout`; shell preferences in cookies; plugin slot placeholders | **risky** | M | shell paints from the HTML; no regression; zero hydration errors |
| M1 | Tasks board and list: `[companyPrefix]/issues` segment, layout, `loading.tsx`, REST prefetch; issues view preference moves from `localStorage` (`ui/src/pages/Issues.tsx`) to a cookie so the server renders the right view | normal | M | board LCP 1,672 ms and list 1,120 ms (Mac, [M50]); warm navigation p75 from S1 |
| M2 | Issue detail: `issues/[issueId]`; S6 issue-page fixes; editor and chat thread stay client components | normal | L | issue TTI 4,751 ms (Mac, measured without #53); warm navigation 183 ms network wait [D] |
| M3 | Dashboard; live-run panel starts with the summary | normal | M | LCP 876 ms (Mac) |
| M4 | Inbox, decisions, approvals; inbox waits for its main list only | normal | M | warm navigation 161 ms network wait [D] |
| M5 | Agents list, agent detail with its runs tab and run transcript; run fetched by id | normal | L | agent overview 204 ms and transcript 274 ms network wait [D] |
| M6 | Projects, project detail, workspaces | normal | M | from S1 |
| M7 | Activity (including the company runs view), costs, budgets, routines, goals | normal | M | from S1 |
| M8 | Company and instance settings | normal | M | from S1 |
| M9 | Apps, plugins (client-rendered), skills, artifacts, cases, pipelines, status cards | normal | L | from S1 |
| M10 | Public routes (auth, invite, OAuth hand-off, board claim, CLI auth, onboarding) and the unprefixed redirects (server `redirect()` after resolving the company through the REST API) | normal | M | from S1 |
| MF | Remove the catch-all, React Router, the bridge, the Vite app entry and build, the `vite` runtime switch, #57's `/assets` handler; plugin bridge maps the SDK router hooks to Next.js navigation | **risky** | L | no regression on any route |

Each route slice: SSR-safety review of the moved tree (browser globals only in effects or client-only components), layout preferences from cookies, REST prefetch and hydration, `loading.tsx` with the final layout's shape, links to it through the wrapper (`next/link` for migrated routes), before and after against B1 on the same machine, desktop and mobile screenshots, zero console errors. Rollback: revert the slice; the catch-all serves the route again.

Order: H, M0, M0b, M0c, M1 (the spike decides here), then M2 to M10 (each one deploy window, normal lane, can follow one another quickly), then MF.

## 10. Deploy and CI

| Item | Today | During the migration | After MF |
|---|---|---|---|
| Dockerfile build stage | `pnpm --filter @paperclipai/ui build` (Vite) | `next build`, plus `vite build` while the runtime switch lives (M0 only); `NEXT_TELEMETRY_DISABLED=1` | `next build` |
| Runtime image | `ui/dist` | `ui/.next` (without `.next/cache`), `ui/public`, `next` in `node_modules` (without the optional `sharp`: no image optimisation), and `ui/dist` while the runtime switch lives (M0 only) | without `ui/dist` |
| Image size | baseline | +350 MB uncompressed or less (gate) [D] | lower than during |
| CI build time | `vite build` 4.2 s in a 12-minute image build [CI] | + `next build` (not measured; gate +5 min) | `next build` only |
| Start and restart | Express listens; UI served at once | `listen` does not wait for `prepare`; pages wait for it | same |
| Dev mode | `pnpm dev`: Vite middleware | `next dev` in process; a dev-only upgrade listener, added first, passes `/_next/hmr` to Next.js; `allowedDevOrigins` for a managed hostname; `agentRules` off; `NEXT_TELEMETRY_DISABLED=1`; the managed-runtime HMR placeholder port (`server/src/app.ts:1041-1057`) stays until its supervisor changes | same |
| CSP | none on the HTML | Next.js inline scripts need a nonce if a CSP is added later (Next.js supports one through `proxy.ts`) | same |

## 11. Open questions

| # | Question | Recommendation |
|---|---|---|
| 1 | The M0 install: `next` is a new dependency, which needs an online install on a host at its disk floor | Install in a fresh worktree only after a maintainer's go and with 9,000 MiB or more free; pin 16.3.8 or the re-checked newest patch older than 7 days |
| 2 | Keep the Vite build in the image for a `vite` runtime switch? | Only while M0 is the newest UI slice (one or two deploy windows). After M0b the Vite build has no shell and the router wrapper imports `next/navigation`, so keeping it working would mean a second entry and its own e2e run. From M0b on, rollback is a revert |
| 3 | Layout preferences that live in `localStorage` (51 non-test files use it; the issues view mode decides the board or list layout) | Move the ones that change the server-rendered layout to cookies, route by route; leave the rest client-only |
| 4 | Drop the persisted Query cache (speed plan S7)? | Yes. Server rendering gives the first paint with data |
| 5 | Storybook framework | Keep `@storybook/react-vite`; components import routing only from the wrapper |
| 6 | Upgrade React Router to v8? | No. It is removed in MF; v7 gets security fixes until then |
| 7 | Who implements | The author of this plan for S1, M0, M0b, M0c and M1; route slices M2 to M10 can go to other implementers once M1 sets the pattern, one segment directory each, so they do not overlap |
| 8 | A corrected render counter (the harness `renders.mjs` over-counts) | Not needed for the gate (INP is the render metric); commit it only if S9 needs it |
| 9 | Phones and slow links (speed plan open question 1) | Still useful: if phones matter, M10 (public routes) and the mobile profile move earlier |
| 10 | Should the shell render on the server (M0c), with its risk? | Yes. Without it the migration gives no server-rendered first paint, which is the main cold-load gain the maintainers expect |

## Appendix A. Sources outside the repository

- Next.js custom server (docs version 16.4.0): https://nextjs.org/docs/app/guides/custom-server
- Next.js linking and navigating, native History API, `loading.tsx` prefetch (docs version 16.4.0): https://nextjs.org/docs/app/getting-started/linking-and-navigating
- Next.js migration guide from Vite: https://nextjs.org/docs/app/guides/migrating/from-vite
- Next.js 16 (App Router uses a built-in React canary): https://nextjs.org/blog/next-16
- Next.js security advisories: https://github.com/vercel/next.js/security/advisories
- React security advisories: https://github.com/facebook/react/security/advisories
- `next` release dates: the npm registry (`npm view next time`)
