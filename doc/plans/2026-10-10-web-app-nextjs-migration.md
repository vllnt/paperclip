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
  - **Anonymous requests:** in `authenticated` mode, when the request carries no session cookie, the root layout makes only the session and health calls (in `local_trusted` mode the caller is the board without a cookie, so all five calls run), and skips the company list, experimental settings and board access. Those three answer 403 to an anonymous visitor (`assertBoard`: `server/src/routes/companies.ts:410-411`, `server/src/routes/instance-settings.ts:257-261`, `server/src/routes/authz.ts:32-34, 48-49`), and the browser fetches them as today. The decision uses the cookie's presence, not the session answer, so it adds no serial level.
  - **`ok`** means every boot call that was made was answered by the API's own handling: a 2xx, a 401, or an authorization 403 from a route's access check.
  - **`fallback`** means at least one boot call timed out, failed on the network, got a 5xx, or got the private-hostname guard's 403. The guard's 403 is told apart by its fixed message (`server/src/middleware/private-hostname-guard.ts:75-93`; its texts point to `paperclipai allowed-hostname`).
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
| `next` | **16.3.8**, exact | Released 2026-09-30. It fixes the seven advisories published that day (one high: SSRF in image optimisation; five medium; one low) and includes the earlier critical fixes (16.3.6 `next/og` RCE, 16.3.3 image-optimisation RCE, 16.2.11 Server Actions SSRF on custom servers). It is the newest release older than the install cooldown. The cooldown is the build host's configuration, not this repository's (pnpm `minimum-release-age=10080` minutes and npm `min-release-age=7` days in the host's user config). `16.4.0` (2026-10-06) clears it on 2026-10-13. M0 rechecks the cooldown and the advisories at install time and records the registry dates in its PR |
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

## Appendix A. Sources outside the repository

- Next.js custom server (docs version 16.4.0): https://nextjs.org/docs/app/guides/custom-server
- Next.js linking and navigating, native History API, `loading.tsx` prefetch (docs version 16.4.0): https://nextjs.org/docs/app/getting-started/linking-and-navigating
- Next.js migration guide from Vite: https://nextjs.org/docs/app/guides/migrating/from-vite
- Next.js 16 (App Router uses a built-in React canary): https://nextjs.org/blog/next-16
- Next.js security advisories: https://github.com/vercel/next.js/security/advisories
- React security advisories: https://github.com/facebook/react/security/advisories
- `next` release dates: the npm registry (`npm view next time`)
