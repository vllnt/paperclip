# Web app migration to Next.js, measured route by route

Date: 2026-10-10
Status: Approved for execution on 2026-10-20 (maintainer). The plan check against `main` of that day is section 12, the slice order and acceptance checks are section 13, and the baseline protocol is section 14. The second plan check (2026-10-21) is section 15: it replaces the landing order of section 6.4 and maps every route to its slice. Where a later section corrects an earlier one, the later one wins: the version pin of section 4.3 is one such case.
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
- **Readiness and failure of `app.prepare()`.** `listen` does not wait for it, so the API, the websockets and run recovery start as fast as today, and the restart cost that #103 is reducing does not grow.
  - The UI counts as ready only when `prepare()` resolves within **60 s**, counted from the moment `prepare()` starts (which is later than the process start if the startup-memory fallback below delays it). Until then a page request waits for it, up to the same deadline.
  - On rejection or timeout: the error is logged; every UI route answers **503** with a plain error page served by Express (not by Next.js); the API keeps working; `/api/health` reports `ui: "failed"` with **HTTP 503**. The Compose healthcheck tests only the HTTP status (`deploy/compose.yaml:40-45`), so it fails after its retries.
  - While `prepare()` is pending, `/api/health` reports `ui: "starting"` and keeps today's status code (200 with `status: "starting"` during recovery, `server/src/routes/health.ts:240`), so a normal start does not flap.
  - M0's deploy gate adds one UI request: the deploy check fetches `/` and expects 200, next to `/api/health`.
  - Tests in M0: a forced `prepare()` failure and a forced timeout each give UI 503 and health 503 while an API read answers 200.
  - The new `ui` field goes into the OpenAPI registration of `/api/health` (`server/src/routes/openapi.ts:1863-1953` on `origin/main`): the 200 body gains `ui`, and the 503 body, which today allows only `error: "database_unreachable"` (`:1940-1949`), gains a UI-failure variant. The UI and CLI health types follow, in M0. Found, not this plan's: the 200 `status` enum is `["ok", "unhealthy"]` (`:1871`), but the route also returns `"starting"` (`server/src/routes/health.ts:240-241`).
  - Side effects to accept (open question 11):
    - agents and the CLI that read `/api/health` see 503 while the UI is failed, although the API works;
    - at `compose up`, the gateway waits for a healthy app (`depends_on: paperclip: {condition: service_healthy}`, `deploy/compose.yaml:98-99`), so a deploy with a failed UI does not start or recreate the gateway, and the API is unreachable through it until a rollback; a gateway that is already running is not stopped;
    - plain Compose does not restart an unhealthy container; recovery is the operator's rollback.
- **Cache contract for personalised responses.** Every response from the Next.js handler counts as personal: the HTML of any page, and RSC (Flight) responses (`?_rsc=` or the `RSC: 1` header). Three kinds are not personal and keep their own headers: `/_next/static/*` (immutable, served by Express), the files of `ui/public` (favicons, manifest, fonts: `express.static` before Next.js, 1 hour as today) and `/sw.js` (`no-cache`, as today).
  - They carry `Cache-Control: private, no-store` and a `Vary` that includes `Cookie`, plus the `Vary` values that Next.js adds for RSC. Express enforces both on the way out: it wraps the response headers of the Next.js handler, so no value set by Next.js can weaken them.
  - **Service worker** (`ui/public/sw.js`; in M0 its template moves out of `public/` and a `/sw.js` route handler serves it): it stores only same-origin requests without a query string whose path is a hashed asset (`ui/public/sw.js:55-59`; M0 adds `/_next/static/`), and it never stores a response marked `private` or `no-store` (`:84-91`). HTML navigations and `?_rsc=` requests never enter its cache.
  - **Ingress:** no proxy in front may cache these responses. The compose file runs an nginx gateway whose config is a host file (`deploy/compose.yaml:79-86`, `/var/lib/paperclip/nginx.conf`), and production uses an operator-managed ingress; neither config is in this repository. M0's deploy gate: the operator confirms that no cache directive (nginx `proxy_cache` or the ingress's equivalent) applies to the app, and the deploy check fetches one HTML page and one `?_rsc=` response through the ingress and checks both headers.
  - **M0 acceptance:** a header test on both response kinds; a CacheStorage listing after a session holds only `/assets/` and `/_next/static/` entries; and the two-user isolation run (section 8): user B never receives user A's HTML, Flight payload or hydrated cache.
- Standalone output cannot be used with a custom server ("These cannot be used together", Next.js custom server docs), so the image keeps `next` in its runtime `node_modules`.
- **Measured in the M0 spike** (section 8, rows Memory, Start, Image and CI): on the built image in a container with `--memory 2g --memory-swap 2g` and the compose `NODE_OPTIONS=--max-old-space-size=1536` (`deploy/compose.yaml:24, 34`): resident memory at steady state and its startup peak, with no out-of-memory kill in 10 parallel cold loads or 5 restarts; time from process start to the first UI 200; image size and build time.
- **Startup memory.** #115's first, not yet valid baseline rounds put `main`'s startup RSS peak near 1.97 GiB, measured on a plain host process, not in the container. Startup is therefore the likely pinch point (section 8 measures it in the container). If M0's startup gate fails, `prepare()` starts only after startup recovery reaches `ready`, so the two peaks do not stack; the UI is then ready later.
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
  - **Router location:** the pathname and search come from `usePathname` and `useSearchParams`, which also work on the server. The hash comes from `window.location.hash`, and the state and the key from `history.state` (React Router's `usr` and `key`), both read through `useSyncExternalStore` with a server snapshot of `{ hash: "", state: null, key: "default" }`, so the first browser render matches the server HTML (M0c). The navigation type comes from `popstate`. Because Next.js history entries carry no React Router `key` and scroll memory (`ui/src/components/Layout.tsx:590-616`) is keyed by it, the bridge stamps one into `history.state` with `replaceState`, merged with Next's own fields, in an effect after the pathname has changed (Next.js writes its entry only after the navigation commits).
  - **Navigator:** `history.pushState` between two catch-all paths; `router.push(href, { scroll: false })` whenever the current or the target route is migrated, because a native `pushState` only syncs the URL and does not render a new segment. Route state that must cross that boundary moves to the Query cache (the issue page's header seed already has one: `prefetchIssueDetailForNavigation`, `ui/src/lib/issueDetailCache.ts:185-196`). A registry of migrated route patterns in `ui/src/lib/router.tsx` decides which way.
  - React Router hooks keep working everywhere, including the plugin bridge (`ui/src/plugins/bridge.ts:29`).
- `app/[companyPrefix]/layout.tsx` renders the board shell (`CloudAccessGate`, then `Layout`, or `ProductionLayout` when the instance has the streamlined UI off, `ui/src/App.tsx:885`: sidebar, breadcrumbs, the Cmd+K launcher) for board paths and bare children for public paths. Both shells move; #95 and #116 edit both. The launcher (#86, merged; #95, open) moves with `Layout` unchanged; it is not rewritten.
- `App.tsx` keeps its routes, but the board branch renders an `<Outlet/>` instead of `Layout`, because the shell is now the segment layout.
- The 16 non-test files that import `react-router-dom` directly (speed plan, section 6.2) move behind `ui/src/lib/router.tsx`, and a lint rule keeps them there. Only `ui/app/**` and `ui/src/lib/router*` may import `next/navigation` or `next/link`. Storybook can then keep `@storybook/react-vite` with a mocked router.
- **Boot data comes from the server.** `app/layout.tsx` reads session, health, experimental settings, the company list and board access through the REST API during the request and hands them to the Query cache. Each call has a short timeout (about 1 s) and fails open: on an error, a timeout or a 401, the page renders without that entry and the browser fetches it as today. Public pages skip the company calls. This removes the A1 and A2 levels of speed plan section 3.2 from the browser (-140 ms on `wan`) but adds the five in-process calls to the time to first byte (about +30-50 ms with S = 30 ms, run in parallel), so the expected gain is **about -90 to -110 ms on `wan`** [D]. It replaces the speed plan's boot script (S3), which is not built.
- **No silent fallback in production.** If the ingress sends the upstream name as `Host` and the public name only in `X-Forwarded-Host`, and `TRUST_PROXY` is unset (the compose default), every server read can fail and fall back without anyone noticing, because the fixture has no ingress. So the root layout writes `<meta name="paperclip-ssr-boot" content="ok">` or `content="fallback"`.
  - **Anonymous requests:** in `authenticated` mode, when the request carries no session cookie, the root layout makes only the session and health calls (in `local_trusted` mode the caller is the board without a cookie, so all five calls run), and skips the company list, experimental settings and board access. Those three answer 403 to an anonymous visitor (`assertBoard`: `server/src/routes/companies.ts:410-411`, `server/src/routes/instance-settings.ts:257-261`, `server/src/routes/authz.ts:32-34, 48-49`), and the browser fetches them as today. The decision uses the cookie's presence, not the session answer, so it adds no serial level. It must recognise both of Better Auth's cookie sets (the secure names and the loopback names, chosen by the request host, `server/src/auth/better-auth.ts:345-350`), taking the names from the auth module rather than hard-coding one; otherwise a signed-in user on one kind of host counts as anonymous and loses the server boot data.
  - **`ok`** means every boot call that was made was answered by the API's own handling: a 2xx, a 401, or an authorization 403 from a route's access check.
  - **`fallback`** means at least one boot call timed out, failed on the network, got a 5xx, or got the private-hostname guard's 403. The guard's 403 is told apart by its fixed messages (defined at `server/src/middleware/private-hostname-guard.ts:52-54` and sent at `:75-93`; both name `paperclipai allowed-hostname`).
  - The server logs a count of fallbacks with the endpoint and status. The deploy check fetches one page anonymously through the ingress and asserts `ok`.
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

- A server-only module (`ui/src/lib/server-api.ts`) calls the REST API in the same process, at the address the server actually listens on (`server.address()`; the bind host can be loopback, a LAN or tailnet address, or custom, `server/src/index.ts:999`). A wildcard bind (`0.0.0.0` or `::`, as in the compose file) maps to loopback. It forwards the caller's `Cookie` and `Host` unchanged, and sends `Accept-Encoding: identity` to skip compression on loopback. `Host` must be the original: Better Auth chooses its cookie set (secure or loopback names) from the request host (`server/src/auth/better-auth.ts:150-153, 345-350`), so a loopback `Host` would not find the session cookie.
- **Trusted-proxy contract for `X-Forwarded-Host` and `X-Forwarded-Proto`.** The transport forwards them only when the page request's peer is a trusted proxy under the server's own `TRUST_PROXY` setting (`server/src/middleware/trust-proxy.ts:72`, applied at `server/src/app.ts:525`), and then only the values Express resolved for that request (`req.hostname`, `req.protocol`). From any other peer it strips them. A client value never passes through unchecked.
  - Who reads them: `actorMiddleware` (`server/src/middleware/auth.ts:227`), the private-hostname guard (`server/src/middleware/private-hostname-guard.ts:8-18`, enabled at `server/src/app.ts:550-564`), Better Auth (`server/src/auth/better-auth.ts:150-165, 345-350`) and the company checks (`assertCompanyAccess`, `server/src/routes/authz.ts:75-121`).
  - Tests (M0b, where server reads start): forged `X-Forwarded-Host` and `X-Forwarded-Proto` from an untrusted peer, and from a trusted one. A server-render read is never more permissive than the same headers sent directly to `/api`, and it uses the resolved values from a trusted proxy.
  - Found while writing this: the private-hostname guard reads `X-Forwarded-Host` before `Host` without checking the peer (`private-hostname-guard.ts:8-11`). That is today's browser path, outside this plan; it is reported, not changed here.
- The existing `ui/src/api/*` modules get an injectable transport (base URL and headers), so the server and the browser use the same endpoint functions, response types and `queryKeys`. One source of truth; web, API and CLI parity stays in the REST API.
- Each segment creates a per-request `QueryClient`, prefetches with the same query options as the client, and passes `dehydrate(...)` to `<HydrationBoundary>`. Hydrated data is fresh for the client's `staleTime` (30 s, `ui/src/main.tsx:45`).
- The socket-open rule (`ui/src/context/LiveUpdatesProvider.tsx:2064-2066`) must skip queries hydrated or fetched in the last few seconds, or every server-rendered page fetches its data twice. This extends #54 and lands in M0b.
- Every call has a timeout and an error policy: fail open to the browser fetch (section 3.5), never block the HTML on an API error.
- Rate limits: most limiters guard writes (agent creation, `server/src/routes/agents.ts:2894`), but invite reads have a per-IP limiter (`GET /api/invites/:token…`, 20 per minute, `server/src/services/invite-rate-limit.ts`). Server renders would put every visitor into the loopback bucket, so the invite page (M10) keeps fetching in the browser. M1 adds a test that a server render makes only GET requests.
- Server load: every loopback call runs `actorMiddleware`, and every RSC prefetch renders on the server. Each slice reports loopback and RSC requests per page load and the server CPU per render (section 8). Links in long lists (board cards, list rows) start with `prefetch={false}` and switch to the default partial prefetch (`prefetch={null}`, down to `loading.tsx`) on pointer enter or focus; `prefetch={false}` alone also turns off hover prefetch (Link docs). A full prefetch per hovered card would be one server render with its loopback calls each, so it is only the spike's fallback, measured with a hover sweep.

### 4.2 No Server Actions, and why the version still matters

- No `'use server'` anywhere in `ui/`: an ESLint rule, plus a CI check after `next build`. Every `server-reference-manifest.json` under `ui/.next/server/` (the merged `ui/.next/server/server-reference-manifest.json` and the per-page `ui/.next/server/app/**/server-reference-manifest.json`) must have empty `node` and `edge` objects (`{}`); other keys, such as an encryption key, are ignored. The shape comes from the Next.js 16.3.8 source (`crates/next-core/src/next_manifests/mod.rs:433-438`; per-page path in `crates/next-api/src/server_actions.rs:213-216`; merged path read in `packages/next/src/build/index.ts:2325-2330`). M0 confirms it on its first build.
- Defence in depth: Express passes only GET and HEAD to the Next.js handler and answers 405 to other methods, so no request body reaches the Flight decoder of a Server Action.
- That removes the Server Function surface, but not the need to patch: CVE-2025-55182 (December 2025) reached apps that did not define Server Functions. The React Server Components runtime must always be on a patched release.

### 4.3 Version pin

| Item | Pin | Reason |
|---|---|---|
| `next` | **16.4.1 or newer, exact** (corrected on 2026-10-20, section 12.1 row 4: three advisories published 2026-10-14 affect every release up to 16.4.0, including the 16.3.8 below) | Original text for 16.3.8, kept for the record: released 2026-09-30. It fixes the seven advisories published that day (one high: SSRF in image optimisation; five medium; one low) and includes the earlier critical fixes (16.3.6 `next/og` RCE, 16.3.3 image-optimisation RCE, 16.2.11 Server Actions SSRF on custom servers). It is the newest release older than the install cooldown. The cooldown is the build host's configuration, not this repository's (pnpm `minimum-release-age=10080` minutes and npm `min-release-age=7` days in the host's user config). `16.4.0` (2026-10-06) clears it on 2026-10-13. M0 rechecks the cooldown and the advisories at install time and records the registry dates in its PR |
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
| S4, intent prefetch on hover, focus, launcher highlight | for migrated routes, `next/link` prefetch: long lists switch a link's `prefetch` from `false` to the default partial prefetch on pointer enter or focus. The launcher's rows are not links: on highlight it calls `router.prefetch(href)` (partial by default, down to `loading.tsx`) and the route's Query prefetch through the shared `ui/src/api/*` modules. Same limits as the speed plan: one in flight, first level only. The issue-link data prefetch that exists today stays. The spike measures launcher navigation this way |
| S5, feedback in one frame, matching skeletons | `loading.tsx` per segment (a prefetched Suspense fallback) plus `useLinkStatus` for slow links |
| S6, slow-page fixes (bounded lists, run fetched by id, inbox gate, issue-page reads) | framework-neutral client and API changes; each lands in or before its route's slice, and the server render benefits too |
| S7, persisted Query cache | **dropped** once M0c lands: a server-rendered first paint already shows data, and no company data has to be kept in the browser. Until M0c, catch-all routes keep today's behaviour |
| S8, service worker and HTTP | folded into M0 (`/_next/static/` rule, build id, navigation preload measured) |
| S9, render work (#50 item F) | framework-neutral; the web-perf series owns it |
| S10, budgets | the JS budget moves to the Next.js build in M0 and is lowered per slice |

### 6.3 New pages from other plans (#114 Workflows, #116 Workroom)

The rule (maintainer decision, 2026-10-10):

- **If M0 has merged when the page is built:** it is built into the Next.js app. Until M0b lands, that means a client page inside the catch-all (a React Router route in `App.tsx`), because before M0b an App Router segment renders without the board shell. After M0b, it is an App Router segment under `ui/app/[companyPrefix]/…`, with `loading.tsx`, a server prefetch through the REST API and `HydrationBoundary`.
- **If M0 has not merged:** it is a page in today's Vite app (a React Router route in `App.tsx`), plus a row in the route inventory (speed plan, section 4.1) so a migration slice moves it. Known rows today: the Workroom on `chats/:agentRef` (#116) moves in M5; #114's project workflow view sits under project detail and moves in M6; its Workflows entry over pipelines moves with the pipelines pages in M9.
- **Either way:** routing only through `ui/src/lib/router.tsx`, data through `ui/src/api/*` with TanStack Query and `queryKeys`, layout preferences in cookies (not `localStorage`), and no `next/*` imports outside `ui/app/**` and `ui/src/lib/router*` (section 3.5).

### 6.4 Landing order with the open pull requests that touch the same files

Maintainer decision, 2026-10-10. Each later pull request merges `main` into its branch (no rebase, no force push).

| Pull request | Files it shares with this plan | Order |
|---|---|---|
| #119, bounded shutdown (D0) | `server/src/index.ts`, `server/src/shutdown.ts` | first |
| #95, the launcher replaces the search page and the sidebar "New task" | `ui/src/App.tsx`, `Sidebar.tsx`, `Sidebar.production.tsx`, `SidebarSearchTrigger.tsx`, `CommandPalette.tsx`, `ui/src/index.css`, the Dockerfile test line | after #119 |
| #115's backend harness (B0, `tests/perf/backend/`; branch not yet pushed) | test scripts only | before the spike; slice H depends on it and copies none of its files |
| M0, then M0b | `server/src/index.ts`, `server/src/app.ts`, `ui/src/main.tsx`, `ui/src/App.tsx`, both shells | after #95 |
| #115, backend on Effect | its slices that touch `server/src/index.ts` or `server/src/app.ts` | after M0, building on it (mirrored in #115's freeze table) |
| #116 Workroom, #114 Workflows | new pages and one sidebar row in both shells | section 6.3 |
| #117, deferred filter lists | `IssueFiltersPopover.tsx` and the Dockerfile test line | independent; the Dockerfile line merges normally |
| #103 planned-restart drain, #113 flow watchdog | server code and plans | they do not touch the UI shell; no order constraint with M0 to M0c |

## 7. Measurement protocol (updated)

All of the speed plan's section 10 applies. What was learned while measuring #50 to #87 adds these rules:

- **Server-side numbers** (CPU, RSS, event-loop delay, the concurrent API p95, startup) reuse #115's backend harness (`tests/perf/backend/`: `probe-preload.mjs` samples once a second, `run.mjs` drives the open-loop load and the startup metric, `report.mjs` compares interleaved arms). This plan builds no second sampler and copies none of its files: its pull request is a dependency of slice H (section 6.4).
- **One gate step decides.** The probes report numbers; they do not fail. #50's `report.mjs` only prints tables, and #115's `report.mjs` applies its own metric list. So slice H adds `tests/perf/web-app/gate.mjs` with a bands file (`tests/perf/web-app/gate-bands.json`, the section 8 limits). It reads the JSON outputs of `measure.mjs`, `nav-timing.mjs`, `bundle-report.mjs`, the UI probes and #115's `run.mjs` and `probe-preload.mjs`, computes the derived numbers (CPU per page load, API p95 against idle, RSS against `main`), and exits non-zero on any row outside its band. Rows measured on the image (Memory, Start, Image and CI) run `docker run --memory 2g --memory-swap 2g` with the compose `NODE_OPTIONS`, read `OOMKilled` from `docker inspect`, and read the startup peak from the server process's `VmHWM` (`/proc/<pid>/status`), because one-second RSS samples miss short peaks.
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

| Check | Pass | Tool, and what fails it |
|---|---|---|
| Board warm navigation, by click, hover-then-click, Tab then Enter, and launcher Enter | usable p75 on M1 ≤ B1's usable p75, and median ≤ B1's median | `tests/perf/web-app/nav-timing.mjs` (H). Fails when M1's p75 or median is above B1's in the interleaved runs |
| Board cold load, `wan` | LCP median ≤ B1 (the speed plan's ceiling estimate is 300-500 ms against B1's 1,672 ms on the Mac) | #50's `measure.mjs`; `gate.mjs` fails when M1's median is above B1's |
| No regression from M0 + M0b on the 10 harness pages | cold FCP, LCP and TTI medians within +5% or +50 ms of B1, whichever is larger; warm navigation medians within +5% or +20 ms; API calls per load ≤ B1; JS on the wire ≤ B1 + 10%; zero new console errors | `measure.mjs` (vitals, requests, API calls, and the script bytes of each load, `jsBytes`, which works for any build), `nav-timing.mjs` (warm), console errors from `route-smoke.mjs`; `gate.mjs` fails on any cell outside its band. `bundle-report.mjs` runs its own Vite build, so it measures B1 only, not what Next.js serves |
| Every other route | each route loads at desktop and mobile width, with no failed asset and no console error (109 routes in #68's run) | `tests/perf/web-app/route-smoke.mjs` (H; #68 ran it from its working session, H commits it). Fails on any non-200 page, failed asset or console error |
| Router state | scroll restored on back and forward; `location.state` survives; navigation works both ways between the catch-all and M1 | `nav-timing.mjs` back-and-forward scenario, with a scroll position and a `location.state` marker. Fails when the scroll differs by more than 4 px after back, when the marker is lost, or when a navigation leaves the wrong page on screen |
| One SPA root across navigations (section 3.2) | 0 remounts in 20 navigations, back and forward included | `tests/perf/web-app/spa-mounts.mjs` (H), reading two mount counters written only in perf builds (`NEXT_PUBLIC_PAPERCLIP_PERF=1`): one on `Providers`, which must stay at 1 across every navigation from M0b on, and one on the catch-all root, which must stay at 1 across navigations between catch-all routes (crossing to M1 unmounts it by design). Fails when either count is above 1 |
| Websockets | all three upgrade paths (live events, remote runners, setup terminal) open after a page load, in production and in dev; hot reload connects in dev; the live socket stays connected across 20 navigations between the catch-all and M1 | `tests/perf/web-app/ws-persistence.mjs` (H): a browser for the live socket across 20 navigations; a Node websocket client for the runner and terminal paths (the upgrade must reach their own handler; any authorization answer from it counts); a dev run for hot reload. Fails when any upgrade is ended before its own handler answers, or the live socket closes |
| Two users at once, cache headers | neither user receives the other's HTML, Flight payload or hydrated data; every HTML and `?_rsc=` response has `Cache-Control: private, no-store` and `Vary` with `Cookie` | `tests/perf/web-app/two-user-isolation.mjs` (H): two sessions in two companies, 50 concurrent server renders each of HTML and `?_rsc=`, scanned for the other user's ids and for both headers. Fails on any leak or missing header |
| Server load | server CPU per board page load p75 ≤ 150 ms on the measuring machine; 10 parallel board loads keep the API p95 within +20% of its idle value (2 CPUs shared with run orchestration); loopback and RSC requests per load and per minute of a hover sweep reported | #115's `probe-preload.mjs` (CPU, event-loop delay) and `run.mjs` (open-loop API load). One runner in H (`tests/perf/web-app/server-load.mjs`) points `measure.mjs` (`PERF_BASE`) at the server of a `run.mjs` round while that round runs, so the board loads and the API load hit the same process; `gate.mjs` divides the CPU time by the number of loads and compares the API p95 with its idle value. Fails above either limit |
| Memory, 2 GB container, 1.5 GB heap | resident memory +250 MB or less at steady state and +150 MB or less at the startup peak, against `main`; no out-of-memory kill during 10 parallel cold loads or 5 restarts | the built image in `docker run --memory 2g --memory-swap 2g` with the compose `NODE_OPTIONS`: `probe-preload.mjs` RSS samples for the steady state, `VmHWM` for the startup peak, `OOMKilled` from `docker inspect`; `gate.mjs` fails above either limit or on any kill |
| Readiness | a forced `prepare()` failure and a forced timeout give UI 503, `/api/health` 503 and API 200; a normal start gives `/api/health` 200 and `/` 200 | an M0 server test, and the deploy check's UI request. Fails on any other status |
| Start | process start to the first UI 200: +2 s or less; API ready time unchanged | on the same container: a small timer in H (`tests/perf/web-app/start-timer.mjs`) from `docker start` to `/api/health` with `status: "ok"` and to the first UI 200 (`run.mjs`'s startup metric times only a process it starts itself); `gate.mjs` fails above +2 s, or when API readiness moves |
| Image and CI | image +350 MB or less uncompressed (estimate: `next` 186 MB and its Linux SWC binary 97 MB unpacked); image build +5 min or less | a spike step that builds `main` and the M0 branch on the same host and compares `docker image inspect` sizes and build times (the CI job has no size or time check); it starts only with enough free disk for two full images and the build cache, under the same floor as open question 1 (9,000 MiB or more left after the builds); `gate.mjs` fails above either limit |

The spike builds M0, M0b, M0c and M1, because without M0c the board has no server-rendered first paint. If the warm-navigation check fails because the server render after each click is slow, the spike tries two things once: full prefetch on intent (links switch to `prefetch={true}` on hover and focus), and a server component that skips its REST prefetch on client navigations so the page renders from the Query cache filled on intent. If it still fails, the migration stops at M0b, which already removes the boot levels, and the maintainers decide with the numbers.

## 9. Slices

Lanes: **risky** changes the server start, the image or every page; at most one risky PR per deploy window. **Normal** changes one route group.

| Slice | What | Lane | Size | Number to beat (B1, same machine) |
|---|---|---|---|---|
| H | Land #50 (harness); depends on #115's backend harness pull request. Then S1: `laptop` profile, `authenticated` fixture, HTTP/2 proxy, the UI probes `nav-timing.mjs`, `route-smoke.mjs`, `spa-mounts.mjs`, `ws-persistence.mjs`, `two-user-isolation.mjs`, the runners `start-timer.mjs` and `server-load.mjs`, and the gate step `gate.mjs` with `gate-bands.json` | normal | S | - (produces the bar) |
| M0 | After #119 and #95 (section 6.4). Next.js 16.3.8 as a custom handler in Express (GET and HEAD only, private upgrade emitter, telemetry off; readiness and cache contracts, section 3.3); catch-all renders today's SPA client-only; Turbopack build; `/_next/static` with #57's handler; SW, budget and stale-chunk ports; runtime switch `vite`/`next` | **risky** | L | every page: no regression (section 8) |
| M0b | Providers and both board shells into layouts; trusted-proxy contract and forged-header tests; per-request QueryClient on the server; React Router bridged to the Next.js router; server boot data with timeouts; direct `react-router-dom` imports behind the wrapper; socket-open refetch skips fresh data | **risky** | L | cold LCP about -90 to -110 ms on `wan` [D]; no regression elsewhere |
| M0c | The shell renders on the server: no browser globals in `Providers`, `CloudAccessGate`, `Layout`; shell preferences in cookies; plugin slot placeholders | **risky** | M | shell paints from the HTML; no regression; zero hydration errors |
| M1 | Tasks board and list: `[companyPrefix]/issues` segment, layout, `loading.tsx`, REST prefetch; issues view preference moves from `localStorage` (`ui/src/pages/Issues.tsx`) to a cookie so the server renders the right view | normal | M | board LCP 1,672 ms and list 1,120 ms (Mac, [M50]); warm navigation p75 from S1 |
| M2 | Issue detail: `issues/[issueId]`; S6 issue-page fixes; editor and chat thread stay client components | normal | L | issue TTI 4,751 ms (Mac, measured without #53); warm navigation 183 ms network wait [D] |
| M3 | Dashboard; live-run panel starts with the summary | normal | M | LCP 876 ms (Mac) |
| M4 | Inbox, decisions, approvals; inbox waits for its main list only | normal | M | warm navigation 161 ms network wait [D] |
| M5 | Agents list, agent detail with its runs tab and run transcript, agent chats (`chats`, `chats/:agentRef`, the Workroom of #116); run fetched by id | normal | L | agent overview 204 ms and transcript 274 ms network wait [D] |
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
| Start and restart | Express listens; UI served at once | `listen` does not wait for `prepare`; the UI is ready when `prepare()` resolves within 60 s; on failure UI routes and `/api/health` answer 503 | same |
| Deploy check | `/api/health` answers 200 | also `GET /` answers 200; one HTML and one `?_rsc=` response through the ingress carry `Cache-Control: private, no-store` and `Vary` with `Cookie`; the operator confirms no ingress cache applies | same |
| Dev mode | `pnpm dev`: Vite middleware | `next dev` in process; a dev-only upgrade listener, added first, passes `/_next/hmr` to Next.js; `allowedDevOrigins` for a managed hostname; `agentRules` off; `NEXT_TELEMETRY_DISABLED=1`; the managed-runtime HMR placeholder port (`server/src/app.ts:1041-1057`) stays until its supervisor changes | same |
| CSP | none on the HTML | Next.js inline scripts need a nonce if a CSP is added later (Next.js supports one through `proxy.ts`) | same |

## 11. Open questions

| # | Question | Recommendation |
|---|---|---|
| 1 | The M0 install: `next` is a new dependency, which needs an online install | Decided: after this plan is approved; a fresh worktree off `origin/main`; `next` at one exact version, the newest past the host cooldown on install day; 9,000 MiB or more free before and after; load 10 or less; the lockfile change in the M0 pull request. **Needs a maintainer's OK:** M0 also needs `@tailwindcss/postcss` (section 3.4: Next.js runs Tailwind 4 through PostCSS), which is not in the lockfile. Recommendation: allow it in the same install at **4.3.3**, the version of the `tailwindcss` already locked (published 2026-07-16, past the cooldown), under the same pin and cooldown rule |
| 2 | Keep the Vite build in the image for a `vite` runtime switch? | Only while M0 is the newest UI slice (one or two deploy windows). After M0b the Vite build has no shell and the router wrapper imports `next/navigation`, so keeping it working would mean a second entry and its own e2e run. From M0b on, rollback is a revert |
| 3 | Layout preferences that live in `localStorage` (51 non-test files use it; the issues view mode decides the board or list layout) | Move the ones that change the server-rendered layout to cookies, route by route; leave the rest client-only |
| 4 | Drop the persisted Query cache (speed plan S7)? | Yes. Server rendering gives the first paint with data |
| 5 | Storybook framework | Keep `@storybook/react-vite`; components import routing only from the wrapper |
| 6 | Upgrade React Router to v8? | No. It is removed in MF; v7 gets security fixes until then |
| 7 | Who implements | The author of this plan for S1, M0, M0b, M0c and M1; the maintainers decide on other implementers for M2 to M10 after M1's go/no-go, with numbers; one segment directory each, so they do not overlap |
| 8 | A corrected render counter (the harness `renders.mjs` over-counts) | Not needed for the gate (INP is the render metric); commit it only if S9 needs it |
| 9 | Phones and slow links (speed plan open question 1) | Still useful: if phones matter, M10 (public routes) and the mobile profile move earlier |
| 10 | Should the shell render on the server (M0c), with its risk? | Yes. Without it the migration gives no server-rendered first paint, which is the main cold-load gain the maintainers expect |
| 11 | A failed UI makes `/api/health` answer 503 (decided). At `compose up` the gateway is then not started or recreated (`deploy/compose.yaml:98-99`), so the API is unreachable through it until a rollback; a gateway that is already running is not stopped (section 3.3). Keep it? | Keep the decision: a deploy with a failed UI then fails closed, and the deploy check rolls it back. The alternatives are to keep today's health status and rely on the deploy check's `GET /`, or to change the gateway's dependency to `service_started`. This is a maintainer call |

## 12. Plan check against `main` (2026-10-20)

Checked at `origin/main` `1a94022f0`. Pull request states come from `gh pr list`; code facts from a fresh worktree of that commit.

### 12.1 Findings that change the plan

| # | Plan premise | `main` today | Effect |
|---|---|---|---|
| 1 | B1 is `main` plus #53, #54, #57, #68 and #87, all open (speed plan, section 2) | All five merged on 2026-10-19, together with #50 (the plan and the harness). `ui/vite.config.ts` has `precompressAssetsPlugin` and `bundleBudgetPlugin`; `ui/bundle-budget.json` exists | `main` contains B1. Each slice is compared with `main` built and measured in the same session (section 7 already says so). The speed plan's B1 numbers stay a reference. Section 6.1 has no open item; M0 ports #57 and #68 as section 3.4 says |
| 2 | M0 lands after #119 and #95 (section 6.4) | #119 merged on 2026-10-19. #95 (the launcher replaces the search page) was closed without a merge | M0 waits for neither. The #95 row of section 6.4 no longer applies. The launcher from #86 stays in `Layout` unchanged |
| 3 | Slice H depends on #115's backend harness (sections 6.4, 7, 9) | #115 merged as a plan. `tests/perf/backend/` does not exist on `main` | H splits in two (section 13). H1 needs no server sampler. H2 adds the rows that do, with its own one-second sampler, and switches to the backend harness if that lands first. M0 does not merge before every row it is judged on has a tool |
| 4 | `next` **16.3.8** is the pin (section 4.3) | Three advisories published on 2026-10-14 affect every 16.x release up to and including 16.4.0 and are fixed in 16.4.1: GHSA-673q-mjm6-r5xr (critical, remote code execution in `use cache` functions that return typed arrays), GHSA-2464-fhr4-w9xw (critical, remote code execution in image optimisation with SVG files) and GHSA-p3m5-59mp-jv5r (high, denial of service in the App Router with Server Actions) | 16.3.8 must not ship. The pin is **16.4.1 or newer**: the newest 16.4.x that is older than the 7-day install cooldown on install day. 16.4.1 was published at 2026-10-14T17:43Z and clears the cooldown at 2026-10-21T17:43Z; 16.4.2 (2026-10-15T20:57Z) clears it at 2026-10-22T20:57Z. M0's install is not before 2026-10-21T17:43Z. M0 re-reads the advisories of `vercel/next.js` and `facebook/react` at install time and rechecks the React canary that the chosen release vendors. The no-Server-Actions, no-`use cache` and no-image-optimisation rules (sections 3.3 and 4.2) lower the exposure; they do not replace the patch, as section 4.2 already says for CVE-2025-55182 |
| 5 | M0 changes deploy files: a deploy check that fetches `/`, and the gateway dependency of open question 11 (sections 3.3, 10) | Constraint of this work (maintainer instruction, 2026-10-20): `deploy/release.json`, `deploy/compose.yaml` and the semantics of the release workflow do not change | The readiness contract of section 3.3 already works with the compose file as it is: the container health check tests the HTTP status of `/api/health`, and that answers 503 while the UI has failed. The `GET /` and header checks of section 10 become steps of each risky slice's production smoke test (section 13), not a workflow change. Open question 11 is closed: the compose file stays, and the `service_started` alternative is out of scope. A slice that finds it needs a deploy-file change stops and asks for a decision |
| 6 | "At most one risky PR per deploy window" (section 9) | A merge to `main` deploys automatically | A deploy window is one merge plus its production verification. Risky slices (M0, M0b, M0c, MF) merge one at a time, and the production check of one finishes before the next merge |

### 12.2 Counts that moved (no effect on the order)

| Item | Plan | `main` today |
|---|---|---|
| Non-test files that import `react-router` or `react-router-dom` (section 3.5) | 16 | 17 |
| `<Route>` elements in `ui/src/App.tsx` | 269 | 274 |
| Non-test files that use `localStorage` (open question 3) | 51 | 53 |

The Vite-only surface of section 3.4 is unchanged: 8 non-test uses of `import.meta.env` or `import.meta.glob`, and 2 `?raw` or `?url` imports. Line numbers quoted in sections 3 and 4 moved by a few lines (for example `createServer` is at `server/src/index.ts:935` and `listen` at `:1005`); each slice re-reads the lines it edits.

### 12.3 Verified and unchanged

- There is no `next` dependency and no `ui/app/` directory; the UI builds with Vite (`pnpm --filter @paperclipai/ui build`) and Express serves `ui/dist` (`server/src/app.ts:1015-1071`).
- `tests/perf/web-app/` holds `measure.mjs`, `report.mjs`, `bundle-report.mjs`, `interact.mjs`, `live-traffic.mjs`, `renders.mjs`, `make-fixture.mjs` and `run-all.sh`. It has no `laptop` profile, no `authenticated` fixture mode and none of the probes of section 8 (`nav-timing`, `route-smoke`, `spa-mounts`, `ws-persistence`, `two-user-isolation`, `start-timer`, `server-load`, `gate`).
- The production instance runs in `authenticated` mode with private exposure. The nginx gateway template that the operator uses (a file in the operator's infrastructure repository, not in this one) sets no `proxy_cache` and sets `proxy_buffering off`. That settles the gateway layer of the cache gate in section 3.3; the layer in front of the gateway remains the operator's confirmation in M0.
- The health response of the production instance reports `resourceCapacity.level: "critical"` at its last sample on 2026-10-20. The level is the worst of the host's metrics (`server/src/services/resource-capacity.ts`), and the health response does not say which metric drives it. M0 reads which one before it accepts the memory gate of section 8, because a server-rendering process adds resident memory to a host that is already under pressure.

## 13. Slice order and acceptance checks

### 13.1 Checks every slice passes

1. CI is green at the head that merges, including the image build check and `pnpm check:token-gates` for UI changes.
2. An independent review of the diff at that head has no open blocker or major.
3. Before and after against `main` built in the same session on the same machine, for the pages the slice touches: interleaved, at least 5 runs per cell and 2 rounds, load average recorded, requests per load reported (section 7).
4. Screenshots at 1440 px and 390 px, and zero console errors on the touched pages (the run-log 404s that section 2 of the web-perf plan calls fixture noise are excluded).
5. Web, REST and CLI parity (AGENTS.md section 5, rule 8): a migration slice changes no capability, so it says "no capability change". A slice that adds one adds all three surfaces.
6. After the merge, on the production instance: `/api/health` shows the merge commit; the touched pages load at 1440 px and 390 px in a real browser with zero console errors; the slice's metric is measured for them; test data is marked `[qa-test]`, kept to the test company, and cleaned up.
7. Rollback is a revert pull request through the same checks. A regression found in production gets the revert first.

### 13.2 Order

| Order | Slice | Content | Acceptance beyond section 13.1 |
|---|---|---|---|
| 0 | P0 (this plan update) | Sections 12 to 14, the corrected version pin | Documentation only. Every number is reproducible from the command or source it names |
| 1 | H1 | `laptop` profile; `authenticated` fixture mode; the HTTP/2 proxy; `nav-timing.mjs`, `route-smoke.mjs`, `ws-persistence.mjs`, `two-user-isolation.mjs`; `spa-mounts.mjs` (it reads counters that exist from M0b and reports "not applicable" before); `gate.mjs` with `gate-bands.json` for the rows that need no server sampler | The suite runs end to end on `main` and prints the B1 numbers of this machine. `gate.mjs` passes `main` against `main` and fails on a seeded regression. The browser suites stay opt-in and out of `pnpm test` |
| 2 | H2 | `start-timer.mjs`; `server-load.mjs` with a one-second CPU and resident-memory sampler; the image rows (Memory, Start, Image and CI) | Every row of section 8 has a tool and a band. The numbers of `main`'s image are recorded; M0 is judged against them |
| 3 | M0 | Section 3 | Rows of section 8: no regression from M0 and M0b, every other route, websockets, readiness, start, image and CI, memory. A header test for HTML and `?_rsc=`. The image build is reviewed separately, and a production smoke test checks `GET /` and the two headers through the real ingress and the CacheStorage listing. The install is not before 2026-10-21T17:43Z (section 12.1, row 4) and adds `@tailwindcss/postcss` at the version of the locked `tailwindcss` |
| 4 | M0b | Section 3.5 | Rows: router state, one SPA root, two users at once, the forged-header tests, and the cold LCP gain of section 9 |
| 5 | M0c | Section 3.6 | The shell paints from the HTML; zero hydration errors; no regression |
| 6 | M1 | Tasks board and list | The whole go/no-go table of section 8. If it fails, the migration stops at M0b and the numbers go to the maintainers (end of section 8) |
| 7 to 15 | M2 to M10 | One route group each, in the order of section 9. Lists that stay slow in the numbers of M1, M2 and M5 (issues, agents, runs) get bounding or virtualization with optimistic updates in or just after their slice | The route smoke test for the group's routes at both widths; before and after against `main`; the group's number in section 9 |
| 16 | MF | Remove the catch-all, React Router, the bridge, the Vite app entry and build, and the `/assets` handler | No regression on any route; no `react-router` import remains; the image no longer holds `ui/dist` |

## 14. Baseline protocol (production, and the same machine)

The goal is a before and after for every slice, so the before has to exist before M0 deploys. The metrics are the ones the speed plan and the web-perf plan name.

| Metric | Source | Pages |
|---|---|---|
| FCP, LCP, TTI (quiet window), CLS, TBT; requests, API calls, JS bytes on the wire | `measure.mjs` (profiles `desktop`, `wan`, `slow`, plus `laptop` from H1) | dashboard, tasks board, tasks list, issue with 400 comments, agents, routines, costs, audit, settings |
| Warm navigation: input to first visual change and to usable, by click, hover then click, Tab then Enter, launcher Enter, chord, back | `nav-timing.mjs` (H1) | board, issue detail, inbox, dashboard, agent detail, run transcript |
| INP | `interact.mjs` | board, list, issue, dashboard |
| Initial JS and CSS | `bundle-report.mjs` | whole app |

- **Production.** The same pages and metrics are read from the production instance in a real browser. The instance runs in `authenticated` mode, so the browser needs a signed-in session; a board API key does not give the UI one (`/api/auth/get-session` ignores it and the live-events socket accepts only agent keys). Until a session exists, the production baseline and the production check of section 13.1 (item 6) cannot run, and no UI-changing slice merges. The measuring machine's link to the production instance is a fact of the run, so every production number is stated with the profile used and with the round-trip time of `/api/health` from the same machine.
- **Same machine.** Each slice is judged against `main` built and measured in the same session (section 7). H1 prints that baseline.
- **Results.** The numbers are recorded in this section before M0 merges, in a table per profile with the date, the commit, the machine and the load average. The after numbers of each slice are added in the slice's pull request, below the baseline.

Baseline status on 2026-10-20: not recorded. Blocked on an authenticated browser session for the production instance (section 14, first bullet). The local `main` baseline comes with H1.

## 15. Plan check against `main` (2026-10-21)

Checked at `origin/main` `2785c614c`, 46 commits after the check of section 12 (`1a94022f0`). Pull request states come from `gh pr list`; release dates from the npm registry; advisories from the advisory lists of `vercel/next.js` and `facebook/react`.

### 15.1 Findings

| # | Item | `main` or the outside world today | Effect |
|---|---|---|---|
| 1 | Files that M0 and M0b edit | Since `1a94022f0`, `ui/src/App.tsx`, `ui/src/main.tsx`, `Layout.tsx`, `ProductionLayout.tsx`, both sidebars, `ui/vite.config.ts`, `ui/package.json`, the `Dockerfile` and `server/src/index.ts` did not change. `server/src/app.ts` gained one line (`eventSources` passed to the routes). `App.tsx` still has 274 `<Route>` elements; `createServer` is still at `server/src/index.ts:935` and `listen` at `:1005` | The anchors of section 12.2 hold |
| 2 | #115's backend harness (section 12.1, row 3) | #340 added `tests/perf/backend/`: `fault-proxy.mjs`, `faults.mjs` (F1, F4, statement census), `prod-readonly.mjs`, `lib/server.mjs` (starts a checkout's server and waits for health), `lib/stats.mjs` (paired-difference interval of the median) and `lib/census.mjs`. It has no one-second sampler (`probe-preload.mjs`) and no open-loop load runner (`run.mjs`) | H still builds its own CPU and resident-memory sampler (row 3 of section 12.1 stands). It imports `lib/server.mjs` and `lib/stats.mjs` instead of writing them again |
| 3 | Next.js release | No Next.js advisory was published after 2026-10-14. `16.4.1` (2026-10-14T17:43:55Z) fixes the three advisories of that day and clears the 7-day cooldown at 2026-10-21T17:43:55Z. `16.4.2` (2026-10-15T20:57:24Z) has bug fixes only (Turbopack and turbo-tasks backports) and clears it at 2026-10-22T20:57:24Z | The pin is the newest 16.4.x past the cooldown on install day: `16.4.1` for an install before 2026-10-22T20:57Z, `16.4.2` after it |
| 4 | React Server Components advisories | New since section 12: GHSA-xqc2-xf4c-x3h3 (critical, remote code execution in React Server Components) and GHSA-h3gv-c5rc-p453 (high, denial of service in Server Functions), both published 2026-10-14T17:08Z. They affect `react-server-dom-*` up to 19.2.8 and 19.3.0, fixed in 19.2.9 and 19.3.1. `next@16.4.1` vendors the canary `19.3.0-canary-278794d7-20261002` and patches its compiled `react-server-dom-turbopack` in place (commit "[react] Improve Server Component transport protocol" in `v16.4.0...v16.4.1`, 12 files under `packages/next/src/compiled/react-server-dom-turbopack/`) | M0 confirms the fix in the installed files and names it in its pull request. The lockfile has no `react-server-dom-*` package today; the `react` and `react-dom` 19.2.8 of `ui/package.json` serve tooling only (section 4.3) |
| 5 | Free disk on the build host | 6,013 MiB at 12:40Z and about 4,000 MiB at 12:46Z, below the floor of open question 1 (9,000 MiB) | The M0 install waits for the floor. No image is built on the build host: the image rows of section 8 (Memory, Start, Image and CI) run on a CI runner, in a job that builds the base and the head on the same runner (section 15.4) |
| 6 | Production checks without a cookie session (section 14, first bullet) | The production UI checks of 2026-10-21 sent a board key as an `Authorization` header on every browser request, and the pages rendered with data. The live-events socket accepts only agent keys, so live updates are not part of such a check | Item 6 of section 13.1 and the production baseline run this way. A production number is compared only with a number measured the same way, and the live socket rows of section 8 run locally only |
| 7 | The open pull requests | None of the 11 open pull requests touches `ui/`. Five sessions are building UI on branches that are not yet pull requests (section 15.2) | Section 15.2 replaces section 6.4 |

### 15.2 Landing order (replaces section 6.4)

#95 was closed without a merge and #119 merged, so their rows of section 6.4 are gone. Each later pull request merges `main` into its branch (no rebase, no force push). The coordinator of the parallel work sets the merge order of the pull requests that share files.

| Work | Files it shares with this plan | Order |
|---|---|---|
| H (harness) | `tests/perf/web-app/` and one CI workflow for the image rows; no runtime code | first; anytime, normal lane |
| The Inbox and Decisions merge (new tabs `inbox/decide`, `inbox/alerts`, `inbox/archived`; `decisions` and `decisions/queues/:key` become redirects to `inbox/decide`; one sidebar row) | `ui/src/App.tsx`, `Sidebar.tsx`, `Sidebar.production.tsx`, `MobileBottomNav.tsx`, `ui/src/pages/Inbox.tsx` | before M0; M0 merges `main` after it |
| Project routines and goal pages (routines on the project page; Tasks, Routines and Agents tabs on the goal page) | `ui/src/pages/ProjectDetail.tsx`, `Routines.tsx`, `GoalDetail.tsx`; no route change known | independent of M0 to M0c; the pages move in M6 and M7 |
| Policies (a company Policies page, a project Policies section) | a new route in `App.tsx`, a sidebar row, `ProjectDetail.tsx` | before M0: a React Router route plus a row in section 15.3; after M0b: a segment (section 6.3) |
| Databases (`databases`, `databases/:databaseId`, a row page; a `BOARD_ROUTE_ROOTS` entry and unprefixed redirects) | `App.tsx`, both sidebars, `ui/src/lib/company-routes.ts` | as Policies |
| Routine step editor (loop back) | `ui/src/pages/RoutineDetail.tsx` | independent; moves in M7 |
| The Node 24.22.1 security update | `Dockerfile` (base image line) | independent; M0 merges `main` after it |
| M0, then M0b | `server/src/index.ts`, `server/src/app.ts`, `ui/src/main.tsx`, `ui/src/App.tsx`, both shells, `Dockerfile`, `ui/package.json`, `pnpm-lock.yaml` | after the Inbox and Decisions merge; one risky slice per deploy window (section 12.1, row 6) |
| Backend on Effect, slices that touch `server/src/index.ts` or `server/src/app.ts` | the server start | after M0, building on it |

### 15.3 Every route and the slice that moves it

MF removes the catch-all, so every pattern of `App.tsx` has a slice. Paths are under `/:companyPrefix/` unless marked; "redirect" rows move with their target and become server `redirect()` calls. A new page from section 15.2 joins the slice of its group. The `route-smoke.mjs` probe (H) reads the patterns from `App.tsx`, so a route that no row names shows up in its output.

| Slice | Segments |
|---|---|
| M1 | `issues` (board and list); redirects `issues/{all,active,backlog,done,recent}`, `tasks` |
| M2 | `issues/:issueId`; `tests/perf/long-thread` (perf page) |
| M3 | `dashboard`, `dashboard/live`; the index redirect to `dashboard` |
| M4 | `inbox/*` (with the new `decide`, `alerts`, `archived` tabs), `decisions`, `decisions/queues/:key`, `approvals/*`, `review-queue` |
| M5 | `agents/*` (list, detail, runs, run transcript), `chats`, `chats/:agentRef`, `org` |
| M6 | `projects/*` (with the routines, goals and policies sections), `workspaces`, `execution-workspaces/*` |
| M7 | `activity`, `activity/{runs,costs,budgets,timeline}`, `timeline`; redirects `audit/*`, `runs`, `costs`, `budgets`; `routines`, `routines/:routineId`, `routines/:routineId/:section` (with the step editor); `goals`, `goals/:goalId`; `learnings` |
| M8 | `company/*` (settings, members, invites, export, import, secrets and the rest), `company/settings/instance/*`, `instance/settings/adapters`, `companies`, `onboarding`; redirects `settings`, `settings/*`, `tools`, `tools/:tab`; the company Policies page (new) |
| M9 | `apps/*`, `plugins/:pluginId`, `:pluginRoutePath/*` (client-rendered), `skills/*`, `artifacts`, `cases/*`, `pipelines/*`, `status`, `status/:cardId`, redirects `status-cards/*`; `board-chat`, `search`, `u/:userSlug`; `databases/*` (new) |
| M10 | unprefixed: `auth`, `invite/:token`, `oauth-handoff`, `board-claim/:token`, `cli-auth/:id`, `chat-identity/confirm`, `onboarding`, every unprefixed redirect (`UnprefixedBoardRedirect`, `LegacySettingsRedirect`, `CompanyRootRedirect`), the two not-found pages; developer pages `design-guide`, `dev/task-chat-lab`, `ux-lab/*`, unprefixed `tests/perf/long-thread` (client-only) |

### 15.4 Image rows on a CI runner, and what each risky slice needs from the operator

- **Image rows.** H adds a workflow that a pull request runs only when it carries the `perf-image` label. On one hosted runner it builds the production target of the base commit and of the head, one after the other with the same cache settings. It records the uncompressed size (`docker image inspect`) and the build time of each. Then it runs each image with `--memory 2g --memory-swap 2g` and the compose `NODE_OPTIONS` against a throwaway database: `start-timer.mjs` (process start to `/api/health` `ok` and to the first UI 200), 10 parallel cold loads, 5 restarts, `OOMKilled` from `docker inspect`, and the startup peak from `VmHWM`. The JSON goes to the job summary and an artifact, and `gate.mjs` reads it. Two runs on one runner are compared, never numbers from two runners. It changes neither the release workflow nor `deploy/`.
- **What the operator of the production instance checks for each risky slice** (M0, M0b, M0c, MF), before and after its merge:
  - the deploy check: `GET /` answers 200 next to `/api/health`. Section 12.1, row 5 keeps the release workflow as it is, so this is a step of the operator's deploy script or of the slice's production smoke test;
  - the new `ui` field of `/api/health` (`starting`, `ready`, `failed`) and HTTP 503 while the UI has failed. The container health check reads only the status code. The operator confirms that the deploy script rolls back on that 503, which is what open question 11 relies on;
  - the ingress: no cache directive applies to the app, and one HTML response and one `?_rsc=` response through the ingress carry `Cache-Control: private, no-store` and a `Vary` with `Cookie`;
  - memory: which metric drives `resourceCapacity.level` (section 12.3, last bullet), and the container's resident memory before and after, since the memory row of section 8 is measured on the CI runner, not on the production host.

### 15.5 The M0 install, step by step

1. Measure free disk right before the install. It must be at least 9,000 MiB plus the install's size.
2. Install `next` at the pin of section 15.1, row 3, and `@tailwindcss/postcss@4.3.3` (the locked `tailwindcss` version; published 2026-07-16, past the cooldown), both exact.
3. Measure free disk right after. Below 9,000 MiB: stop, and keep the lockfile change out of any merge until the floor is back.
4. The M0 pull request records both disk numbers, the two versions with their registry dates, the advisory check of section 15.1, rows 3 and 4, and the vendored-React check.

### 15.6 M0 runs Next.js as a second process (maintainer decision, 2026-10-21)

The fallback of section 3.3 ("If the custom server is not viable") becomes the design, before the spike. The reason is the V8 heap, not the container limit. In production the main server process has about 1.55 GB resident memory, with `--max-old-space-size=1536`, and a startup peak (`VmHWM`) of 1,310 MiB. A Next.js server inside that process would share the same heap, and nothing measures the room left in it. A second process has its own heap and its own limit.

| Part | Section 3.3 (in-process) | Now |
|---|---|---|
| Where Next.js runs | `next({ … })` in the Express process | a child process started by the server (`ui/next-server.mjs`: `next()`, `prepare()`, an HTTP server on `127.0.0.1` with port 0), with its own `--max-old-space-size` (`PAPERCLIP_UI_MAX_OLD_SPACE_MB`, default 512) |
| Requests | a late Express route calls the Next.js handler | the same late route proxies GET and HEAD to the child with `node:http` (no new dependency). Other methods still get 405; `/_next/image` and `/_next/mcp` still get 404; Express still sets `Cache-Control: private, no-store` and adds `Cookie` to `Vary` on every proxied response |
| Websocket upgrades | a private `EventEmitter` given to Next.js, and a dev-only dispatcher | no upgrade reaches the child in production. In dev, one listener added first forwards `/_next/hmr` to the child's port |
| Readiness | `prepare()` within 60 s | the child reports `ready` over IPC within 60 s of its start. The rest of the contract holds: UI 503 and `/api/health` 503 with `ui: "failed"` while the API answers. The maintainer decided on 2026-10-21 that a failed UI fails the deploy closed (open question 11) |
| Supervision | - | a crash after `ready` restarts the child with backoff (1 s doubling to 30 s); shutdown stops it within the existing stop budget (SIGTERM, then SIGKILL after 10 s) |
| Cost | one heap | one more process and one loopback hop per page request (about 1 ms). The memory row of section 8 sums both processes' resident memory, and adds the main process heap, read through the inspector on the CI runner only, at `--memory 2g` and at `3g` |
| Image (section 10) | `next` in the runtime `node_modules` | unchanged |

Production memory for the gate, measured after the restart into `2785c614c`: main server `VmHWM` 1,310 MiB; resident memory of all processes 1,805 MiB three minutes after the start; sum of the per-process peaks 2,212 MiB; the container is at 71% of a 3 GiB limit (an operator override of the 2g compose default).

### 15.7 Route slices M2 to M10: a checklist any implementer can follow

M2 to M10 start after M1's go (section 8). Each slice owns one segment directory, `ui/app/[companyPrefix]/<segment>/`, as section 15.3 lists, so two or three implementers can work at the same time without sharing files. Shared files (`ui/src/lib/router.tsx` with its registry of migrated patterns, the `ui/src/api/*` modules) take additive changes only, and the later pull request merges `main` first.

A slice is ready to merge when all of these hold:

1. **Segment.** `page.tsx` is a server component. It creates a per-request `QueryClient`, prefetches through the shared `ui/src/api/*` functions with the client's query keys and options, and passes `dehydrate(...)` to `<HydrationBoundary>`. Each prefetch has a timeout of about 1 s and fails open to the browser fetch. Only GET requests go out (a test checks it). `loading.tsx` has the shape of the final layout. The old page component stays a client component below the boundary.
2. **Routing.** The slice adds its patterns to the registry in `ui/src/lib/router.tsx`. Links to them go through the wrapper. Long lists use `prefetch={false}` and switch to the default on pointer enter or focus. An unrecognised param renders the catch-all's content, not `notFound()` (section 2). The React Router route stays in `App.tsx` until MF.
3. **Server safety.** The moved tree reads browser globals only in effects or in client-only components. Layout preferences that change the server render are cookies. Plugin slots render a placeholder of reserved size.
4. **Numbers.** The `perf-web` workflow with `Perf-Slice: M<n>` in the pull request body: the gate passes for the slice's rows (`gate-bands.json`, `slices.M<n>`). That means no regression on the 10 harness pages against B1 on the same runner, and the slice's own number of section 9 is reported. `route-smoke.mjs --only <segment>` passes at 1440 and 390 px, with zero console errors.
5. **Parity.** "No capability change" (AGENTS.md rule 8). A slice that adds a capability adds the REST route, the OpenAPI entry and the CLI command too.
6. **After the merge.** Production health shows the merge commit. The slice's pages load at 1440 and 390 px with zero console errors in a real browser (the read-only method of section 15.1, row 6). The slice's metric is measured there with `measure.mjs --read-only`. Rollback is a revert pull request.

| Slice | Pages to measure (the harness keys, or the route) | Watch for |
|---|---|---|
| M2 | `issue-long`, `issue-short` | the editor and chat thread stay client components; the header seed of `prefetchIssueDetailForNavigation` moves to the Query cache |
| M3 | `dashboard` | the live-run panel starts with the summary |
| M4 | `inbox/*`, `approvals/*` (route-smoke) | the inbox waits for its main list only; the Decisions redirects of section 15.2 |
| M5 | `agents`, agent detail, run transcript | the run is fetched by id; the Workroom (`chats/:agentRef`) |
| M6 | project detail (route-smoke) | the routines, goals and policies sections from section 15.2 |
| M7 | `routines`, `costs`, `audit` | the step editor; the goal tabs |
| M8 | `settings` | the gates that render nothing today (`HiddenSettingsPageGate`) get a loading state |
| M9 | route-smoke for its segments | plugin pages stay client-rendered; databases from section 15.2 |
| M10 | the public routes (route-smoke, signed out) | the invite page keeps fetching in the browser (rate limit, section 4.1); server `redirect()` for the unprefixed routes |

## Appendix A. Sources outside the repository

- Next.js custom server (docs version 16.4.0): https://nextjs.org/docs/app/guides/custom-server
- Next.js linking and navigating, native History API, `loading.tsx` prefetch (docs version 16.4.0): https://nextjs.org/docs/app/getting-started/linking-and-navigating
- Next.js migration guide from Vite: https://nextjs.org/docs/app/guides/migrating/from-vite
- Next.js 16 (App Router uses a built-in React canary): https://nextjs.org/blog/next-16
- Next.js security advisories: https://github.com/vercel/next.js/security/advisories
- React security advisories: https://github.com/facebook/react/security/advisories
- `next` release dates: the npm registry (`npm view next time`)
