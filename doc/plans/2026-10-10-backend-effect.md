# Backend on Effect 4: one runtime for time, failure and cleanup, measured before and after

Date: 2026-10-10
Status: Plan only (docs). No Effect code, no install and no measurement run is part of this pull request.
Branch: `docs/backend-effect-plan`
Anchors: `origin/main` `d9804ac4f`. Effect facts come from the published `effect@4.0.0` type files and the official migration guides. They were read from the package registry and a CDN. Nothing was installed.

## 0. Decision summary

**Proposal.** Put an Effect runtime under the existing backend, one slice at a time, and keep a slice only if a measured before-and-after shows that it is not slower, not bigger in memory, and more reliable.

**What "Effect everywhere" means here (a scope call for the user).** Effect becomes the way the backend writes time, failure and cleanup: timeouts, retries, concurrency caps, cancellation, resource release, typed errors and dependency wiring. It does **not** replace Express, drizzle, pino, ws or zod. Reason: Effect's own `http`, `sql`, `socket`, `schema` and `observability` modules are marked `@stability unstable` (section 3). Those are the modules that would replace the libraries above. The stable core is what this plan uses (section 9, rule 1).

**Order.**

1. Measure B0 on `main`, before any Effect code (section 4).
2. The bounded shutdown (#103 slice D0) lands first, in plain TypeScript. It is not part of this plan.
3. Slice E0: an Effect runtime at the edge, plus one converted helper, `database-retry.ts` (section 7.4).
4. A go/no-go with stated numbers at three checkpoints: after E0, after E3 and after E6 (section 8).
5. More leaf services. Heartbeat and recovery slices come last, one per deploy window.

**What is already known (verified at `d9804ac4f`).**

- Effect is used nowhere today: 0 imports in `server/src`, `packages`, `cli` and `ui`.
- The hand-written helpers that Effect replaces are counted in section 5. Section 5 also names the cost that Effect adds.
- 66 pull requests are open. The files they touch are the freeze list (section 7.3).

**What this plan needs decided** is in section 12. The three decisions with the most effect are Q1 (the scope call above), Q2 (the version pin) and Q3 (the numeric thresholds).

## 1. Goal and constraints

The user asked (2026-10-10): "consolidate codebase with effect packages (latest 4 version), backend should effect everywhere imo, plus compare before/after backend performance and scalability, memeory usage, cpu usage, make it overall learner and more reliable, faster etc".

Read as five outcomes: **one set of tools** for async work, **measured** performance, scalability, memory and CPU, **leaner** code, **more reliable** behavior, and **faster** behavior. "Learner" is read as "leaner".

Constraints, all binding:

- **Reuse before extending.** Use an existing harness before a new one. Delete a hand-written helper when Effect replaces it. Do not keep both.
- **No second system.** One validator (zod), one log format (pino), one tracing path (the operator-gated OpenTelemetry path), one record of runs (`heartbeat_run_events`). Section 6.
- **Incremental, never a big bang.** Old and new code run side by side. Each slice is one revertible change.
- **Do not touch a file that an open pull request touches.** Section 7.3.
- **Web, API and CLI parity: not applicable.** This is an internal change. It adds no user-facing capability. The measurement tooling is a developer script. If a slice changes a documented API behavior, that slice must say so and carry the parity work.
- **Public repository.** No instance, host, company or agent names in this plan, in code, in commits or in the pull request.
- **Data path.** Effect tracing feeds the **observability** path (`server/src/instrumentation.ts`, `doc/observability.md`). It never feeds **Telemetry** (`packages/shared/src/telemetry/`). See `AGENTS.md` section 5.7.
- **Disk.** The shared host is at the floor (about 8.9 GiB free; the rule is 9 GiB or more for an install). No install and no measurement run happen without the maintainers' go.

## 2. Verified facts about the code (`d9804ac4f`)

| Fact | Anchor |
| --- | --- |
| 0 imports of `effect` or `@effect/*`. | `git grep -E "from ['\"](effect\|@effect/)"` over `server/src packages cli ui`: 0 files. No `package.json` names Effect. |
| 1,769 `.ts` files under `server/src`. | `git ls-tree -r origin/main server/src`. |
| Stack: Express `^5.1.0`, pino `^10.0.0`, pino-http `^11.0.0`, ws `^8.21.3`, zod `^4.4.3`, drizzle-orm `^0.45.2`, TypeScript `^7.0.2`, vitest `^4.1.11`. | `server/package.json`. |
| Node `>=24.11.0`. TypeScript is `strict`, target `ES2023`, `NodeNext` modules. | `package.json` `engines`; `tsconfig.base.json`. |
| `@opentelemetry/api` is a hard dependency. The OpenTelemetry SDK, exporters and auto-instrumentation are **optional peer dependencies**. | `server/package.json` (`dependencies` and `peerDependencies` with `optional: true`). |
| There is no linter configuration (no ESLint, Biome or oxlint file). An import-boundary gate exists: `scripts/check-module-boundaries.mjs`, with an import extractor. It is wired as the root script `check:module-boundaries`. A search of `.github`, `Dockerfile` and the root `package.json` found no other reference to it. Other scripts were not searched. | `scripts/check-module-boundaries.mjs`; `package.json:48`. |
| Largest services: `chat-channels.ts` 1.4 MB, `heartbeat.ts` 1.25 MB, `tool-access.ts` 0.7 MB, `native-runtime/native-session-executor.ts` 0.5 MB, `issues.ts` 0.46 MB. | `git ls-tree -r -l origin/main server/src`. |
| Shutdown has no overall bound, the HTTP listener closes last, and the drain is serial. This plan does not re-measure it. #103 plans the fix (slice D0). | Section 2.1 and #103. |

### 2.1 The edges where a runtime would attach

| Edge | Today | Anchor |
| --- | --- | --- |
| Startup | `startServer()` loads config, picks external or embedded Postgres, migrates, builds the services and the Express app, binds the listener, **then** runs recovery (phase `recovering`, then `ready`). `GET /api/health` answers 200 with `status: "starting"` until `ready`. | `server/src/index.ts:195-1006`, `:1934`; `server/src/routes/health.ts:240` |
| Shutdown | One `shutdown()` function with 11 steps. These steps have **no time bound**: the scheduler-idle wait, the run drain, and the app-services shutdown. No timeout was found on the embedded Postgres stop either. The HTTP listener closes at step 9, after all of them. A 5 s `Promise.race` around the finalizer drain abandons its inner `while` loop; it does not stop it. | `index.ts:1985-2089`; `shutdown.ts:10-37,54-89,241-274`; `heartbeat.ts:15494-15705,21845-21857`; `app.ts:1326-1363` |
| Signal handlers | Four registration sites: `index.ts:2091,2094`, `instrumentation.ts:551-552`, `app.ts:1370,1373`. | same files |
| Timers | 13 boot-time loops (execution-control sweeps 15 s, run-usage derivation 60 s, temp sweeper, heartbeat scheduler 30 s, database backup, feedback flush, chat reconcile 1 s, plugin job tick 30 s, live-events ping 30 s, and more). Per-resource lease timers exist as well. The outer heartbeat tick has no single-flight flag in the range read. It does not await long work: each sweep is handed to a tracked set. `waitForHeartbeatSchedulerIdle` is an unbounded `while` loop. The database-backup interval and the live-events ping interval are never cleared. | `index.ts:1147-1214,1692-1882,1909`; `realtime/live-events-ws.ts:245-254` |
| WebSocket | Three servers share one HTTP server. The live-events server does not check `bufferedAmount`, never calls `wss.close()` and sends to every subscriber from one global emitter. | `index.ts:964-985`; `live-events-ws.ts:227-347`; `services/live-events.ts:7-8` |
| Express | Express `^5.1.0`. 69 router factories in `app.ts`. 903 route registrations. Handlers are bare `async (req, res)`: Express 5 forwards rejections. No async wrapper exists. One error middleware maps `HttpError`, `ZodError`, body-parser errors and the rest. | `app.ts:512-1139`; `middleware/error-handler.ts:126-302`; `errors.ts:1-44` |
| Errors | `throw badRequest/unauthorized/forbidden/notFound/conflict/...(`: **3,349** sites in routes and services. `throw new Error(`: **1,521** sites. | `git grep`, non-test files |
| Wiring | **111** `xService(db)` factories, composed by hand. No container. 224 module-level `Map`/`Set` declarations and 43 module-level `let` declarations in `services/`. Tests use `vi.mock` (458 calls in 181 files), option injection and real embedded Postgres. | `services/*.ts`; `index.ts:879-890,1259-1319` |
| Config | A typed `Config` with 44 keys, built from a config file and ad-hoc env parsing. **348** other `process.env` reads in 113 files. | `config.ts:57-102,123-390` |
| Logging | pino `^10` and pino-http `^11`. 98 files import the logger. No request-scoped child logger. Success lines of the busiest endpoints are silenced by policy. | `middleware/logger.ts:23-42,82-218`; `middleware/http-log-policy.ts:3-12,96-109` |
| OpenTelemetry | Gate: `OTEL_EXPORTER_OTLP_ENDPOINT` (`instrumentation.ts:42`). Without it the bootstrap resolves at once and nothing starts. | `instrumentation.ts:42,304-306,493-522` |
| Database | postgres.js through drizzle. Default pool of 10. **608** `.transaction(` calls in 140 files and no shared helper. 26 files declare their own transaction type alias. | `packages/db/src/client.ts:130-284`; `git grep` |

Size for scale: `chat-channels.ts` 38,507 lines, `heartbeat.ts` 32,602, `tool-access.ts` 20,368, `routes/issues.ts` 18,833, `services/issues.ts` 13,488, `native-session-executor.ts` 13,015. `index.ts` is 2,157 lines and `app.ts` is 1,378.

## 3. Effect 4: what the plan relies on

**Versions (registry, 2026-10-10).** `latest` is `4.0.2` (2026-10-07). `4.0.0` came out 2026-10-01 and `4.0.1` on 2026-10-05. Companion packages are at `4.0.3` (2026-10-10). The host's npm cooldown is `min-release-age=7`. So `4.0.0` is the newest installable today. `4.0.1` becomes installable about 2026-10-12 (`@effect/opentelemetry@4.0.1`: 2026-10-11).

**One version for all packages.** Every Effect package shares one version number, and each companion has a peer dependency on the same `effect` version (`@effect/platform-node@4.0.3` and `@effect/opentelemetry@4.0.3` require `effect@^4.0.3`). Pin every Effect package to the **same exact version**.

**Stability.** The official guide marks these modules `@stability unstable`: `ai`, `cli`, `cluster`, `devtools`, `eventlog`, `http`, `http-api`, `jsonschema`, `observability`, `persistence`, `process`, `reactivity`, `rpc`, `schema`, `socket`, `sql`, `workflow`, `workers`. An unstable API "may receive breaking changes in minor releases". Modules in packages other than `effect` (for example `@effect/platform-node`, `@effect/sql-pg`, `@effect/opentelemetry`, `@effect/vitest`) are currently unstable too. Untagged APIs follow strict semver. **Consequence:** this plan uses only the untagged core modules (section 9, rule 1) and pins the exact version.

**Footprint.** `effect@4.0.0` has no runtime dependencies. The registry reports 49.5 MB unpacked in 2,561 files. Whether a root import (`from "effect"`) loads every module at runtime is **not verified**; the package exports each module as a subpath (`effect/Effect`), so the guide requires subpath imports (section 9, rule 1) and E0 measures the difference. Requirements from the package README: TypeScript 5.9 or newer (TypeScript 7 recommended), Node 18 or newer, `strict` on. The repository meets all three.

**API names checked in the 4.0.0 type files** (read from the CDN, not installed):

| Need | Verified API | Note |
| --- | --- | --- |
| Run Effect from plain code | `ManagedRuntime.make(layer, { memoMap? })` returns a runtime with `runFork`, `runPromise`, `runPromiseExit`, `runSync`, `runCallback`, `dispose()` and `disposeEffect`. | `Runtime<R>` no longer exists. |
| Concurrency cap | `Semaphore.make(n)`, `makeUnsafe(n)`, `withPermits`, `withPermit`, `withPermitsIfAvailable`, `take`, `takeIfAvailable`, `release`, `resize`. | |
| Retry and backoff | `Schedule.exponential`, `fibonacci`, `spaced`, `fixed`, `recurs`, `jittered` (random factor 0.8 to 1.2), `during`, `upTo({ duration, times })`, `while`, `max`, `min`, `concat`, `addDelay`, `modifyDelay`. | `upTo` checks its duration only at schedule steps. A long attempt is **not** cut short. A per-attempt timeout is a separate tool. |
| Cancellation reaches I/O | `Effect.tryPromise` and `Effect.promise` pass an `AbortSignal` to the callback. | |
| Bounded parallel work | `Effect.all` and `Effect.forEach` accept `concurrency`. | |
| Forking | `forkChild`, `forkDetach`, `forkScoped`, `forkIn` (v3 `fork` is `forkChild`; v3 `forkDaemon` is `forkDetach`). Options: `startImmediately`, `uninterruptible`. | `forkAll` and `forkWithErrorHandler` were removed. |
| Cleanup | `Scope.make("sequential" or "parallel")`, `Scope.close(scope, exit)`, `Scope.addFinalizer`, `Scope.fork`. | |
| Custom logger | `Logger.make`, `Logger.layer(loggers, { mergeWithExisting })`. `Options` has `message`, `logLevel`, `cause`, `fiber`, `date`. | `Options` has **no** annotations or spans. |
| Custom tracer | `Tracer.make`, a `Span` interface (`end`, `attribute`, `event`, `addLinks`), provided with `Effect.provideService(program, Tracer.Tracer, tracer)`. The default `nativeTracer` makes in-memory spans and exports nothing. | No no-op tracer export; `DisablePropagation` is the nearest. |

**Behavior from the migration guides.**

- **The process stays alive while a fiber waits.** v4 keeps the process alive from inside the core runtime (a reference-counted keep-alive timer). In v3 this needed `runMain`. Test: the process must still exit after the runtime is disposed.
- **`runMain` from `@effect/platform-node` installs its own SIGINT and SIGTERM handlers and calls `process.exit`.** The server already owns its signal handling (`server/src/index.ts`). This plan does **not** use `runMain`.
- **`Effect.runFork(effect)` and `Effect.runForkWith(services)`** are the run functions on `Effect` itself. `ManagedRuntime` is the bridge used here because it holds one `Layer` for the life of the process.

**Not verified.** The 4.0.0 `Effect.d.ts` file was too large to read in full. These names are expected from v3 and are **not** yet confirmed for v4: `Effect.timeout`, `Effect.retry` (with the v4 `Schedule`), `Effect.acquireRelease`, `Effect.addFinalizer`, the members of `Effect.RunOptions` (in particular a `signal`), `Effect.fn`, how `zod` schemas pass through `StandardSchema`, and TypeScript 7 type-checking time on Effect types. The first task of slice E0 is a spike that confirms each one against the installed package.

**What Effect claims about cost (vendor claims, not measurements).** The release notes say the fiber runtime was rewritten for "lower memory overhead, faster execution, and simpler internals", with no figures. The one figure, "roughly 70 kB in v3 to about 20 kB in v4", is for a minimal browser bundle of `Effect`, `Stream` and `Schema`. It says nothing about a Node server. **The go/no-go uses our own numbers only.**

## 4. B0: the baseline, measured on `main` before any Effect code

### 4.1 Rules of measurement

1. **One machine, interleaved, repeated, with the spread.** Never compare numbers from two machines. The web-app baseline in #50 was measured on a laptop. Do not mix it with numbers from the shared host.
2. **Load gate.** The shared host has 12 cores, and its load average has ranged from 4 to 50. A round starts only when the 1-minute load average is at most 6. Record the load average, free memory, time and commit for every round. Discard and repeat a round that breaks the gate, and log the discards.
3. **Pin how the server starts.** The same command, environment, Node version and `NODE_ENV=production` (JSON logs, no pretty transport) for B0 and for every slice. No watch mode. A separate `PAPERCLIP_HOME`, `PAPERCLIP_INSTANCE_ID`, `PAPERCLIP_CONFIG` and database. **Not** the default embedded Postgres port 54329 and never a shared data directory. The plan picks `tsx src/index.ts`, because a full `pnpm build` needs the runner vendor build. This is not verified on the host and must be confirmed in the first B0 run.
4. **Canary.** Before every round, one canary run must start and finish. A server that starts inside a linked worktree with `PAPERCLIP_IN_WORKTREE=true` suppresses run execution (`heartbeat.ts:9821-9826`; `tickTimers` returns zeros at `:32461-32467`). Such a round measures an idle scheduler. It is void.
5. **Ready means `status: "ok"`.** `/api/health` answers 200 while the server still starts (`status: "starting"`, `health.ts:240`). Poll the field, not the status code.
6. **Open loop for latency.** Send requests at a constant arrival rate below saturation, so a stall shows in the tail (a closed loop hides it: "coordinated omission"). Use a closed-loop ramp only to find peak throughput.
7. **Warm-up.** Discard the first 60 s of each scenario.
8. **Record** the commit, Node version, start command, fixture seed, and every round's load average with the result.

### 4.2 The metrics

| Id | Metric | How it is measured | Existing tool |
| --- | --- | --- | --- |
| M1 | API latency (p50, p95, p99) and throughput for the busiest endpoints | New open-loop and closed-loop load script on Node's built-in `fetch`. Read set: start from the endpoints whose success logs the log policy silences (`http-log-policy.ts:3-12`: health, activity, dashboard, heartbeat runs, issues, live runs, sidebar badges). That suggests high traffic, but the reason is not stated in the code, so the final list comes from observed request counts at B0 time. Write set: add a comment, update an issue. The exact paths are read from the route table. | None for load. PR #50 `measure.mjs` gives single-browser latency only. |
| M2 | Heartbeat scheduler tick duration | **Proxy, no code:** wake-to-start latency from database timestamps (`agent_wakeup_requests` to `heartbeat_runs`), at a fixed wake rate. **True tick time** needs a three-line log at the end of the tick in `index.ts`. That file is on the freeze list (section 7.3). See Q5. | None. The tick logs counts only (`index.ts:1716-1718`). |
| M3 | Runs one process drives at once | New ramp with the fake provider (the `process` adapter or the fake `codex` bins under `tests/e2e/fixtures/`). Stop at the first of these limits (proposals, set before the run and not changed after it): event-loop lag p99 above 100 ms, wake-to-start p95 above 30 s, or RSS growth that does not level off. Many agents with one run each (the per-agent cap is 1 to 50, `heartbeat.ts:722-724`). | None. |
| M4 | RSS and heap | A preload file (`node --import`) samples `process.memoryUsage()` once per second and writes NDJSON. An outside sampler reads `/proc/<pid>/status` as a cross-check. No change to `server/src`. | None in the server. |
| M5 | CPU per request and per run | `process.cpuUsage()` in the preload divided by completed requests (M1) and completed runs (M3). Cross-check with `/proc/<pid>/stat`. | None. |
| M6 | Event-loop lag | `monitorEventLoopDelay` in the preload; report p50, p99, max. | None (0 hits in the code). |
| M7 | Startup | The harness records the spawn time and polls `/api/health` until `status: "ok"`. Report also `startupRecovery.phase` times. Do not use `processStartedAt` (it is module-load time, `server-info.ts:172`). Five cold starts. | Partial: log markers only. |
| M8 | Shutdown time and runs lost per restart | Start 30 runs on the fake provider. Send SIGTERM. Record time to exit, exit code, and the end state of each run (`interrupted` with `server_shutdown_interrupted`, `failed` with `process_lost`, and so on). | Partial: the hot-restart report lists `lostRunIds`; no total shutdown time exists. |
| M9 | Behavior under faults | F1: a database blip of a stated length (1 s) during open-loop load. Ending all backends (`pg_terminate_backend`, the technique in `packages/db/src/__fixtures__/postgres-connection-recovery.mjs`) lets the pool reconnect at once, so the blip is only milliseconds long. For a controlled length, first set `ALLOW_CONNECTIONS false` on the instance's database, end the backends, and set it back after the stated time. This is a design choice to confirm when the harness is built. Report failed requests and the time until p99 recovers. F2: a fake provider that never answers; report that other runs and requests keep their latency. F3: a websocket client that connects and never reads, while events publish at a fixed rate; report RSS growth and other clients' latency. | DB-level tests only. No fault run against a live server. |
| M10 | Fixture | `make-fixture.mjs` from #50 (1,000 issues, 10,000 runs, seed `20261009`). Add wakeup rows and agents that execute. | #50 only (not on `main`). |
| M11 | Dev loop | `tsc --noEmit` for the server: wall time and peak memory, five interleaved runs. | None. |
| M12 | Install weight | `du` of the production dependency tree and the size of the production image, before and after the dependency. | None. |

### 4.3 What exists, and what the gaps are

Searched: Smoke Lab, the eval kernel, `tests/perf/*`, the release-smoke and e2e suites, the benchmark scripts, the observability reports (#70 on `main`, #73 open), the health route, and a grep for load tools and in-process meters. **Result:**

- **Reused:** the boot recipes in `tests/e2e/playwright.config.ts:63-96` and `tests/perf/issue-detail/playwright.config.ts:19-57`; `make-fixture.mjs` (#50); the fake provider bins; the DB-termination technique; the memory-sampling pattern in `server/scripts/benchmark-tool-gateway-listing.ts`; the `lostRunIds` report.
- **Not suitable:** Smoke Lab (connection checks, no timing), the eval kernel (a matrix orchestrator), `release-smoke` and `test:e2e` (pass or fail), the `run_usage_records` reports (they describe runs, not the server).
- **Gaps, so the harness adds code:** a concurrent HTTP load generator (no load tool is a dependency; a grep for autocannon, k6, artillery, wrk, tinybench, mitata, clinic, 0x and prom-client found none); a process sampler (0 hits for `monitorEventLoopDelay`, `process.memoryUsage` and `process.cpuUsage` in the server); tick, startup and shutdown timers; a fault runner against a live server; wakeup fixtures.

### 4.4 The harness (new code, and only for the gaps)

Location: `tests/perf/backend/`, next to the existing perf directories.

- `run.mjs`: starts the server with the pinned command, waits for `status: "ok"`, runs the canary, runs a scenario, sends SIGTERM, and collects the files.
- `load.mjs`: the load generator. No new dependency.
- `probe-preload.mjs`: the in-process sampler (M4, M5, M6). It lives outside `server/src`, so `main` is measured without editing it.
- `faults.mjs`: F1 to F3.
- `report.mjs`: median and spread for each metric, and the pass or fail rows of section 8.
- The fixture comes from #50. **#50 must land first** (it is docs and tooling only), or the harness copies the script with `git archive origin/docs/web-perf-baseline tests/perf/web-app`.

### 4.5 Scenarios

- **A, steady mix:** open loop at 50% of the measured saturation rate for 10 minutes (M1, M4, M5, M6).
- **B, saturation ramp:** closed loop (M1 throughput).
- **C, run capacity:** the ramp for M3, with M4 to M6 sampled.
- **D, restart:** M8.
- **E, startup:** five cold starts (M7).
- **F, faults:** F1 to F3 (M9), each during scenario A.

### 4.6 Cost, and the gate

An install into a new worktree of `main` was about 150 to 220 MB on this host. A small fixture (300 issues, 1,500 runs) took about 4 minutes and 28 MB in an earlier run; the full fixture has not been run here. The estimate for B0 is **1 to 2 hours of machine time** (five repeats of each scenario). That is an estimate, not a measurement. **Not started.** It needs the maintainers' go and at least 9,000 MiB free. The host had about 8,950 MiB free when this plan was written. B0 is never run on a developer laptop for comparison with a shared-host slice.

## 5. Where Effect pays off, with anchors

### 5.1 What the code writes by hand today

Counts are from `git grep` at `d9804ac4f`, tests excluded, over `server/src`, `cli/src` and the packages (except the Rust crates). They are regex-bound. A regex can miss a form, and two counts can overlap. The `path:line` anchors were opened unless the table says "not opened". Effect and the other candidate libraries (`fp-ts`, `neverthrow`, `p-limit`, `p-queue`, `async-retry`, `rxjs`) are in no `package.json`. `p-queue`, `p-retry` and `p-timeout` are present only as transitive dependencies of the Slack client.

| Need | Hand-written today | Effect replacement | Replaces? |
| --- | --- | --- | --- |
| **Retry and backoff** | 19 named helpers: **10 in-process** and 9 that compute a retry time that is stored in the database. Only 2 are general retry helpers: `server/src/database-retry.ts:73` (3 attempts, 50 and 100 ms) and `server/src/services/chat-control-admission-retry.ts:4` (50 tries, 100 ms). **Seven separate jitter implementations**, for example `plugin-worker-manager.ts:3088`, `telemetry/client.ts:331`, `environment-runtime.ts:2008`, `heartbeat.ts:2066`. 29 inline timed retry sites by regex. | `Effect.retry` with `Schedule.exponential`, `jittered`, `recurs`, `upTo` | **Yes** for the 10 in-process helpers and the inline sites. **No** for the 9 database-backed schedule calculators (the state is a column) and the 33 no-wait optimistic-lock loops. |
| **Timeouts** | **17 wrappers**, for example `sandbox-callback-bridge.ts:365`, `openclaw-gateway/.../execute.ts:542`, `judge-client.ts:157,431`, `claude-local/.../quota.ts:264` and a duplicate in `codex-local/.../quota.ts:222`, `tool-gateway.ts:6399`, `quota-windows.ts:42`. Inline: **102** `Promise.race` sites (80 have a nearby `setTimeout`) and 19 `setTimeout` that call `abort`. | `Effect.timeout` (the loser is interrupted and the timer is always cleared) | **Yes.** 81 `AbortSignal.timeout(` calls are fine as they are. |
| **Sleep** | **21 separate definitions** of a promise that a `setTimeout` resolves, and 62 inline copies. Nine files use `node:timers/promises` instead. | `Effect.sleep` | **Yes** |
| **Concurrency caps** | **18** per-key serialization chains (a `Map<string, Promise>`; the GitHub plugin alone has five copies of the same idea), **6** bounded queues or pools (`tool-discovery-scheduler.ts:9`, `duplicate-detection.ts:131`, `agent-avatar-pool.ts:6`, `workspace-git-operation-scheduler.ts:178`, `file-resources.ts:66`, `plugin-job-scheduler.ts:212`), **3** bounded-parallel maps (`tool-gateway.ts:472`, `company-portability.ts:119`, `workspace-file-resources.ts:264`), 4 stream queues, 4 time-window rate limiters. | `Semaphore`, `Effect.forEach({ concurrency })`, `Queue` | **Yes** for the 27 caps and maps. **Partly** for the rate limiters and the 24 single-flight maps. **No** for database locks: 58 advisory-lock lines and 447 `FOR UPDATE` lines stay. |
| **Cleanup** | **8** cleanup registries or hand-ordered teardown sequences: `run-resource-ledger.ts:155` (no non-test caller), `ssh.ts:389`, `chat-attachment-read.ts:44`, `native-runner-file-handoff.ts:988`, `app.ts:586`, `live-events-ws.ts:242`, `plugin-host-services.ts:803`, and the shutdown sequence (`app.ts:1326-1363`, `shutdown.ts:104`, about 20 steps). 629 `finally` blocks. | `Scope`, `acquireRelease`, `addFinalizer` | **Yes** for the registries. Most `finally` blocks stay. Only those that cross a cancellable `await` benefit. |
| **Cancellation** | 257 `AbortSignal` references in 111 files. A signal does **not** reach the child-process runner (`server-utils.ts:4660-4681`, `runChildProcess` has no `signal`) or the adapters' `execute()`. Cancel works out of band (`heartbeat.ts:31641-31652`). 38 of 96 `fetch` calls show no signal or timeout nearby. | Fiber interruption, `tryPromise((signal) => ...)` | **Partly.** Effect covers code that already takes a signal. The runner and `execute()` need a wrapper with a kill finalizer. |
| **Typed errors** | 3,349 `throw badRequest/...(` and 1,521 `throw new Error(`. One `HttpError` class. 188 `class ... extends Error`. | Tagged errors | **No, not now.** The `HttpError` shape is the API contract (section 6). Tagged errors are used inside converted code and mapped at the edge. |
| **Dependency wiring** | 111 `xService(db)` factories, composed by hand. No container. 224 module-level `Map`/`Set`. | `Layer`, `Context.Service` | **Later.** Only inside converted services. A repo-wide switch has no measured gain. |
| **Config** | A typed `Config` (44 keys) and 348 other `process.env` reads in 113 files. | `Config` / `ConfigProvider` | **No.** The existing typed `Config` is exposed as a service (section 7.1). A second parser would be a second system. |

**The count of what Effect would replace.** Effect would replace **83 named helper definitions**: 10 retry, 17 timeout, 21 sleep, 27 concurrency (18 + 6 + 3), 8 cleanup. It would also replace about **190 inline sites**: 29 timed retry, about 99 timeout (80 `Promise.race` with a timer and 19 timer-then-abort), and 62 sleep. The retry and sleep counts overlap in places, so 190 is an upper bound. **Both counts are repository-wide**, and they include code under `packages/*` (adapters, plugins, `adapter-utils`) that rule 2 in section 9 keeps out of scope. The B0 report repeats the same regexes restricted to `server/src` to give the in-scope count. These are the maximum, not the plan: the freeze list (section 7.3) removes the files that open pull requests hold, and section 5.2 removes the deliberate cases.

### 5.2 Do not convert (deliberate behavior)

| Where | Why it stays |
| --- | --- |
| `server/src/services/workspace-operations.ts:606-623` | The timeout rejects, but the code joins the underlying callback on purpose: "A deadline cannot prove physical export stopped." `Effect.timeout` would interrupt it, which is the opposite. |
| `server/src/services/tool-discovery-scheduler.ts:9-45` | "Do not free a slot on abort until already-started reads settle." A conversion must keep this. |
| `server/src/services/agent-start-lock.ts:3,28` | After 30 s the lock continues anyway. This is a policy decision in the heartbeat start path. A conversion keeps it until a separate decision. |
| Database advisory locks, `FOR UPDATE`, optimistic-lock loops, database-backed retry schedules | The state lives in the database. |
| `packages/*` (adapters, plugins, `adapter-utils`, `db`, `shared`), `cli`, `ui`, plugin workers | Section 9 rule 2. |

### 5.3 Where the code is already good, and where Effect adds cost

**Already good.** Several modules do this correctly by hand: `runner-prp-outbound.ts:139-168,285-299` (deadline and signal, timers cleared), `workspace-git-stream.ts:31-95` (timeout, SIGTERM, SIGKILL, listener removed), `tool-gateway.ts:472-500` (signal per item), `paperclip-temp-sweeper.ts:135-163` (single flight, abort on stop, `unref`). Converting these gains consistency and a few deleted lines, not a new capability. A plain-TypeScript fix is also available for most gaps below. **Effect is chosen where it removes a bug class by construction or deletes code, not because plain code cannot do it.**

**Gaps Effect closes by construction (anchors opened).**

- **Timers that are never cleared.** Of the first 5 `Promise.race` sites read, 1 leaks. Of 15 of the 28 flagged sites read (including those 5), 4 leak: `plugin-host-services.ts:187-195`, `instrumentation.ts:535-545`, `run-failure-report.ts:129-135`, `execution-target.ts:2576-2584` (the last three are `unref`'d, so they never block exit, but they stay armed). 13 flagged sites were not read.
- **A bounded runner that frees its slot while the job runs on.** `duplicate-detection.ts:131`.
- **A 5 s race that abandons its loop.** `shutdown.ts:10-37` around `heartbeat.ts:21845-21857`.
- **Unbounded waits at shutdown** and **timers that are never cleared at shutdown** (section 2.1).
- **Requests with no timeout or signal.** `feedback-share-client.ts:34-44`; `github-commit-details.ts:108-110` (up to 30 calls in a row).
- **A mutex waiter that cannot be cancelled.** `workspace-runtime.ts:7393-7408`.

**Cost Effect adds (unmeasured here; section 8 measures the ones marked "gate").**

- **Fiber overhead per operation, and memory per fiber** (gate: M1, M4, M5). The vendor gives no figure for a Node server.
- **Module load time** at startup (gate: M7) and **install weight**: 49.5 MB unpacked on disk, no runtime dependencies (gate: M12).
- **Type-check time** (gate: M11). Effect's types are heavy, and the server already has a large type graph.
- **Stack traces.** An Effect failure shows a fiber trace, not the plain call stack. Naming effects reduces the gap (section 9, rule 13).
- **Learning curve.** Generators, layers and `Context.Service` are new to most reviewers. The guide (section 9) is the mitigation.
- **Two styles side by side** for the length of the migration.
- **Unstable surface.** Limited by the rules in section 9.
- **Interop allocation.** Each Promise to Effect crossing allocates. The facade (section 7.1) is where it shows.

## 6. No second system

| Area | Rule | Why | Check |
| --- | --- | --- | --- |
| Validation | **zod stays** the contract in `packages/shared` (UI, CLI and OpenAPI use it). Effect `Schema` is **not** used, not even inside the server. | `schema` is an unstable module (section 3). Two validators for one contract is the failure the overlap rule names. | The boundary gate (section 9) rejects `effect/schema`. |
| Logging | **pino stays** the one log format. Effect code logs through a custom `Logger` that writes to the same pino instance. | One log format and one redaction config. | A test: the same event logged from Effect code and from plain code has the same JSON keys. |
| Tracing | Effect spans go to the **existing** operator-gated OpenTelemetry path. With the gate off, Effect uses a no-op tracer and creates no spans. **No new exporter.** | `@effect/opentelemetry@4.0.3` declares ten peer dependencies. Six of them are OpenTelemetry packages that the server does not declare today (`api-logs`, `sdk-logs`, `sdk-metrics`, `sdk-trace-base`, `sdk-trace-node`, `sdk-trace-web`). Declaring them would widen the install for every operator, with or without OpenTelemetry. A small `Tracer` over `@opentelemetry/api`, which is already a hard dependency, adds none. | A test: gate off means 0 spans created and no allocation per `withSpan`. A test: gate on means Effect spans appear under the HTTP server span. |
| Telemetry | Effect code **never** imports `packages/shared/src/telemetry/`. | `AGENTS.md` section 5.7: Telemetry sends data to a Paperclip endpoint by default. | The boundary gate. |
| Run record | `heartbeat_run_events` stays the record of runs. Effect does not add an event store. | The run-log path. | Review. |
| HTTP, SQL, sockets | Express, drizzle and ws stay. `effect/http`, `effect/sql` and `effect/socket` are not used. | Unstable, and they would replace working code with no measured gain. | The boundary gate. |
| Errors | The `HttpError` helpers in `server/src/errors.ts` stay the one HTTP error shape. Effect tagged errors map to them at the edge. | One error shape for clients and OpenAPI. | A test per mapped error. |

## 7. The migration: edge first, then leaf services

### 7.1 Step 0 (slice E0): an Effect runtime at the edge

**Rule: code lands with its first caller.** An adapter or a layer is added by the first slice that uses it. E0 is therefore small. The design below is the whole edge. The table in section 7.4 says which slice adds which part.

One `ManagedRuntime` for the process, created lazily in `server/src/effect/runtime.ts` from one `Layer`. The layer grows by slice:

- **E0: an empty layer and a no-op `Tracer`.** The no-op tracer makes no spans and no allocation per `withSpan`.
- **E2: a logger layer.** A custom `Logger` that writes to the existing pino instance and replaces the default Effect loggers (`Logger.layer([...])` without `mergeWithExisting`). Spike point: `Logger.Options` has no annotations, so the bridge reads them from `options.fiber` or logs without them.
- **E2: a tracer layer.** With the OpenTelemetry gate on, a small `Tracer` over `@opentelemetry/api` (already a hard dependency). With the gate off, the no-op tracer stays. No `@effect/opentelemetry`.
- **When first needed: a config service and a db service.** A read-only view of the existing typed `Config` (44 keys) and the existing drizzle handle. No second parser and no second pool.

Four adapters in `server/src/effect/edge.ts`. They are the only code that calls a run function (`runFork`, `runPromise`):

1. **Facade (E0).** `edge.facade(effect)` runs an Effect and returns a `Promise`. A converted service uses it to keep its public types. Callers do not change. When all callers of a service are converted, the facade goes. It passes an `AbortSignal` into the run options (spike point: confirm the member name).
2. **Scheduler adapter (E3).** `every(name, interval, effect)` runs a loop with **single flight** (skip a tick while the last one runs), tracks the fiber in a `FiberSet`, and interrupts all of them on stop. This replaces the `setInterval` plus "in-flight" boolean pattern and the unbounded idle wait. **No slice converts the heartbeat tick** until the watchdog's S1 has landed: #104, #75, #73, #108 and S1 touch `index.ts` (section 7.3).
3. **Shutdown adapter (E6, after D0).** `dispose(budgetMs)` disposes the runtime and returns when done or when the budget ends, whichever is first. It adds **one step** to the shutdown that #103 D0 defines. It does not own the order, the signals or the budget. The server keeps its own `process.once("SIGTERM")`. `runMain` is not used (section 3). Until a layer holds a resource that needs a finalizer (a pool, a loop), the runtime has nothing to dispose, and the process exit does not wait for it. **E0 proves this with a test** (the process exits at once with a created and unused runtime).
4. **Route adapter (the first route slice, after B0 shows where).** `handler(effect)` returns an Express handler with an `AbortSignal` that aborts when the request closes, and maps tagged errors to `HttpError` in one function. Express 5 already forwards a rejected promise, so plain handlers need no wrapper.

**Compatibility.** A converted service keeps its exported factory and its public types: methods still return `Promise<T>`, so no caller changes (also not a caller in a frozen file).

**Revert.** Each slice is one commit that touches its own files plus the edge module. Reverting it restores the plain code.

### 7.2 How the first slice is chosen

The criteria: **a leaf** (few callers), **not frozen** (its own file has no open pull request), **hand-written retry, timeout, cleanup or concurrency code that Effect replaces**, **on a path that B0 exercises**, and **a failure a test can show**. A facade keeps the callers unchanged, so a caller in a frozen file does not block a slice.

`server/src/database-retry.ts` meets all five.

- It has 86 lines and 3 importers: `services/dashboard.ts` (4 calls per dashboard request, lines 33, 47, 53 and 90), `services/issue-assignment-wakeup.ts:227` (wake delivery) and `middleware/auth.ts:565` (the cloud-tenant actor lookup only).
- No open pull request touches it or its importers.
- The dashboard is on the read set of M1 (its success logs are silenced by policy, which suggests high traffic; B0 confirms this from request counts), so **the first slice puts 4 fibers on every dashboard request**. This is the honest worst case for overhead. It is not a sheltered corner.
- Its failure test is the fault run F1: a database blip.
- Today the retry has 3 attempts with 50 and 100 ms sleeps. It has no jitter, no total budget, and a sleep that nothing can interrupt (`database-retry.ts:73-86`). So R3 (a retry that respects a budget) has a real before value.

**A shared helper, not a domain service.** The request was one real service plus the edge runtime. A shared helper on the hot path gives a clearer measurement than a domain service off the B0 path (Q13).

**The policy change is separate from the tool change.** E0 changes the policy to a jittered exponential schedule that starts at 50 ms, with a 2 s total budget **per call**, an abort-aware sleep, and the same transient-error predicate. The worst case for one dashboard request is therefore 4 calls of 2 s each (Q3). The policy values are proposals. Fewer errors in F1 could come from the policy alone, not from Effect. So E0 is measured against **two** baselines: B0 on `main` (**arm A**), and the **same new policy written in plain TypeScript** on a throwaway branch (**arm C**, never merged). Effect's own cost is the difference between the slice and arm C. The policy's benefit is the difference between arm C and arm A.

### 7.3 The freeze list

**Rule.** Never convert a file while an open pull request changes it, or while a plan pull request reserves it. Refresh the list from the live pull request files before each slice. Use the REST API (`gh api repos/vllnt/paperclip/pulls/N/files`), because the GraphQL quota runs out. The check takes one call per open pull request.

**Snapshot.** 66 open pull requests, `main` at `d9804ac4f`, 2026-10-10. Files are production code (tests excluded).

| File | Size | Open PRs touching it |
| --- | --- | --- |
| `server/src/index.ts` | 91 KB | #73, #75, #104, #108 |
| `server/src/app.ts` | 54 KB | #41, #45, #57, #61, #69, #73, #75 |
| `server/src/config.ts` | 15 KB | #73, #108 |
| `server/src/services/heartbeat.ts` | 1,254 KB | #7, #27, #29, #31, #63, #65, #71, #74, #80, #85, #93, #98, #104 |
| `server/src/services/recovery/service.ts` | 224 KB | #27, #71, #99, #104 |
| `server/src/services/issue-recovery-actions.ts` | 21 KB | #36, #99 |
| `server/src/services/execution-recovery-resolution.ts` | 20 KB | #33, #99 |
| `server/src/services/legacy-execution-recovery.ts` | 13 KB | #99 |
| `server/src/modules/wake-queue/` (4 of its files) | 7 to 13 KB each | #7, #74 |
| `server/src/routes/issues.ts` | 639 KB | #7, #27, #29, #33, #36, #37, #45, #63 |
| `server/src/services/issues.ts` | 456 KB | #27, #29, #33, #37 |
| `server/src/routes/openapi.ts` | 360 KB | 17 pull requests |
| `server/src/routes/agents.ts` | 338 KB | #24, #31, #33, #45, #61 |
| `server/src/services/environment-runtime.ts` | 197 KB | #75, #79, #93 |
| `server/src/services/workspace-runtime.ts` | 336 KB | #45 |
| `server/src/services/plugin-worker-manager.ts` | 150 KB | #30 |
| `server/src/services/plugin-host-services.ts` | 140 KB | #29, #30, #45 |
| `server/src/services/secrets.ts` | 211 KB | #31, #69 |
| `server/src/services/native-runtime/native-session-executor.ts` | 499 KB | #47 |

**Not touched by any open pull request (as of the snapshot):** `server/src/instrumentation.ts`, `server/src/errors.ts`, `server/src/realtime/live-events-ws.ts`, `server/src/services/task-watchdogs.ts`, `server/src/services/chat-channels.ts`, `server/src/services/tool-access.ts`, `server/src/services/tool-gateway.ts`, `server/src/services/company-skills.ts`, `server/src/services/pipelines.ts`.

**Reserved by plan pull requests (not in the table, because these pull requests carry no code yet). The #103 row describes its draft at the time of writing and may change:**

| Plan | Reserves | Why |
| --- | --- | --- |
| #103 slice D0 (bounded shutdown) and C1 (client retry) | `index.ts` `shutdown`, `shutdown.ts`, `heartbeat.ts` `drainRunningRunsForShutdown`, `routes/health.ts` (a `503 stopping` state), `live-events-ws.ts` (close code 1012), both compose files, the CLI client, the sandbox bridge forwarder | D0 lands **first, in plain TypeScript**. Effect wraps it afterwards (the shutdown adapter in section 7.1). |
| #113 slice S1 (flow watchdog) | `index.ts` (a scheduler step), the issue wake path, three new tables | It adds a step to the tick. The Effect scheduler adapter must not convert the tick before S1 lands. |
| Every other open `docs(plans)` pull request | Read its slice table when you refresh the list. | A plan reserves files before it has code. |

**Heartbeat and recovery slices are risky singles:** at most one per deploy window, never in the same window as another risky pull request, and never while a pull request in the table above is open on the same file.

### 7.4 The slices

All files below were free of open pull requests at the snapshot in section 7.3. Refresh the check before each slice. Sizes are lines of the converted files; the size of new code is an estimate. A slice replaces the number of definitions shown.

| Slice | Content | Files | Lane | Size | Replaces | The number to beat |
| --- | --- | --- | --- | --- | --- | --- |
| **B0** | Harness and report (section 4). No `server/src` change. | `tests/perf/backend/*` | Normal | about 6 new files | none | none: it sets the numbers |
| **E0** | Runtime (empty layer, no-op tracer), `edge.facade`, the boundary gate, the guide, and `database-retry.ts` converted to a jittered exponential schedule with a 2 s budget and an abort-aware sleep. The transient-error predicates stay plain code. | `server/src/effect/*` (new), `server/src/database-retry.ts`, `server/package.json`, `pnpm-lock.yaml`, `scripts/check-module-boundaries.mjs` and its CI step (Q9), `doc/effect-guide.md` | Normal. Needs the online install. | 86 lines converted; about 300 to 500 lines new (estimate) | 1 retry loop and 1 uninterruptible sleep | **Gate 1:** dashboard p99 within +5% of arm A with 4 fibers per request; slice within +5% of arm C; RSS +5%; startup +5% and +300 ms; M11 +10%; R2, R3 and F1 improve |
| **E1** | `tool-discovery-scheduler.ts` as a `Semaphore` plus a bounded wait. **Behavior-preserving:** a started read keeps its slot until it settles. | `server/src/services/tool-discovery-scheduler.ts` | Normal | 54 lines | 1 semaphore with a queue | Tool-listing p99 within +5%; R2: a queued job leaves on abort and a started job keeps its slot, as today |
| **E2** | The pino logger layer and the OpenTelemetry tracer layer (Q7). | `server/src/effect/{logger,tracer}.ts` | Normal | about 150 lines new | none (new capability) | Gate off: 0 spans and no allocation per `withSpan`. Gate on: Effect spans appear under the HTTP server span. Same JSON keys as plain pino |
| **E3** | The scheduler adapter, and `startPaperclipTempSweeper` on it. The call site in `index.ts` does not change (the return shape `{ startup, stop }` stays). | `server/src/effect/edge.ts`, `server/src/services/paperclip-temp-sweeper.ts` | Normal | 163 lines | 1 interval with an in-flight flag | **Gate 2:** R2 and R5 (no timer left after `stop()`; the running pass aborts), no performance regression |
| **E4** | A shared per-key mutex in `server/src/effect/`, replacing the free copies: `agent-start-lock.ts`, `chat-sdk-runtime.ts:3181`, `native-runner-file-handoff.ts:96`. Behavior-preserving, including the 30 s stale rule. | those files | Normal | about 150 lines | 3 of the 18 per-key chains | R2: a cancelled waiter leaves the queue; no new wait |
| **E5** | Timeouts in free server files: `quota-windows.ts`, `run-failure-report.ts`, `plugin-environment-driver.ts`, and a timeout for `feedback-share-client.ts`. | those files | Normal | about 330 lines | 3 wrappers, 2 uncleared timers, 1 call with no timeout | R5: 0 uncleared timers in the converted files |
| **E6** | The shutdown adapter and `Scope` for the teardown registries. **After D0 and after the `index.ts` pull requests land.** | `index.ts`, `app.ts` shutdown, `shutdown.ts` | **Risky single** | to be sized after D0 | up to 8 registries or sequences | **Gate 3:** R1 holds; M8 not worse than D0 |
| **E7 onward** | Heartbeat and recovery: the run drain, the start lock call site, the heartbeat retry code. Only after #74, #99, #104, #98, #93 and #80 have landed, and one per deploy window. | `heartbeat.ts`, `recovery/*` | **Risky singles** | each sized before its start | each named before its start | M2, M3 and M8 against B0 |

Files named only by a candidate list (E4, E5) are confirmed free again before the slice, and a file that an open pull request holds is dropped from that slice. `remote-http-endpoint-guard.ts` (#91) and `github-commit-details.ts` (#101) are already held.

## 8. Targets and the go/no-go

All thresholds are proposals (Q3). They are written so that a reviewer can check them.

**Rule for every number.** The comparison is B0 against the slice, on **one machine**, **interleaved** (B0, slice, B0, slice, and so on), at least **5 pairs**. Report the median and the spread (minimum to maximum). A change counts only if it is larger than the threshold **and** larger than the spread of the B0 runs. If the B0 spread is larger than the threshold, the metric cannot decide, and the result is "inconclusive: repeat in a quiet window". It is never "pass".

**Performance must not regress (against B0).**

| Metric | Threshold |
| --- | --- |
| M1 API latency p50 and p99 for each top endpoint | p50 up to +3%, p99 up to +5% |
| M1 throughput | down by at most 3% |
| M2 scheduler tick duration, median and p99 | up to +5% |
| M3 concurrent runs per process at the stated limit | not lower |
| M4 RSS and heap after 10 minutes of steady load | up to +5% |
| M5 CPU per request and per run | up to +5% |
| M6 event-loop lag p99 | up to +5% or +2 ms, whichever is larger |
| M7 startup (process start to ready) | up to +5% and +300 ms |
| M11 `tsc --noEmit` for the server (dev loop) | up to +10% |

**Reliability must improve, or hold where the plain code is already correct.** Each test is written first, against the plain code on `main`, so it has a recorded red or green result before the slice exists. Arm A is `main`. Arm C is the same behavior in plain TypeScript (E0 only).

| Test | Applies to | Before (arm A) | After (slice) |
| --- | --- | --- | --- |
| R1 Bounded shutdown: 30 runs in flight, stop with the deploy timeout. | E6, and a hold check in every slice | #103 D0 makes it pass in plain code: exit 0 within the budget. | Same result, same bound. Effect must not lengthen it. |
| R2 Cancellation frees resources: cancel at each await point, then count live timers, child processes, temporary directories and held locks. | E0 (retry sleep), E1, E3, E4 | Recorded by a characterization test. The count may be above 0. | 0 at every cancel point. |
| R3 A retry respects a total budget and an abort. Fake clock. (a) A failure that outlasts the policy ends within the budget plus one attempt. (b) An abort during a sleep rejects within 10 ms with the abort reason. | E0 | (a) The 3 attempts end at about 150 ms. (b) Not expressible: the function takes no signal, so a caller that gives up still waits for the sleep and the next attempt. | (a) At most 2 s plus one attempt. (b) Within 10 ms, with no further attempt. |
| R4 Isolation: during F1, F2 or F3, other requests keep their M1 latency within the threshold. | Every slice | Recorded. | Within threshold. |
| R5 Timers: after `stop()` or shutdown, `process.getActiveResourcesInfo()` shows no timer that the converted code created. | E3, E6 | Recorded. Known leaks: section 5.3. | 0. |
| F1 Database blip: a 1 s blip (new connections refused, existing ones ended; see M9) during open-loop load on the dashboard. Count failed requests and the time until p99 recovers. | E0 | Recorded (arm A). | Fewer failed requests than arm A; recovery time not longer. Arm C shows how much of it is the policy. |

**Leaner (deletions).**

- Net production lines in the converted files are at most 0, not counting the new `server/src/effect/` module, the guide and tests.
- The slice deletes at least the helper definitions that it names in advance (section 7.4).
- It adds no dependency except the one pinned `effect` version.

**Decision: three checkpoints, because no single slice proves everything.**

| Checkpoint | When | What it can decide |
| --- | --- | --- |
| **Gate 1** | After E0 | **Cost and footprint.** Every performance row holds against arm A, **and** the Effect-only cost (slice against arm C) is within threshold. R2 and R3 improve and F1 improves. M11 and M12 are within threshold. This does **not** prove that Effect improves reliability. E0's reliability gain comes mostly from the policy. |
| **Gate 2** | After E3 | **Reliability value.** R2 and R5 hold for a real loop with a real cancel, and no performance row regresses. This is the first slice where Effect removes a bug class (timers and in-flight flags) in a real service. |
| **Gate 3** | After E6, with D0 landed | **Shutdown.** R1 holds with Effect in the path, and M8 (runs lost) is not worse than D0 alone. |

- **Go** at a gate only if every row listed for it holds.
- **No-go** if a performance row fails by more than its spread, or a reliability row listed for the gate does not improve. Revert the slice (one commit). The plan closes, or the maintainers override with a written reason. The B0 harness and report stay (Q12).
- **Inconclusive** is not a go. Repeat in a quiet window.

## 9. Coding guide (how Effect code is written here)

Where it goes: this section moves to `doc/effect-guide.md` in slice E0. Effect code lives under `server/src/effect/` (the runtime, the pino logger, the tracer, the error mapper) and inside the service that a slice converts.

1. **Core modules only, imported by subpath.** Allowed: top-level `effect` modules that are not in the unstable list (section 3), imported as `effect/Effect`, `effect/Layer` and so on. **Do not** import from the barrel (`from "effect"`). Examples: `Effect`, `Layer`, `Context`, `Scope`, `Schedule`, `Semaphore`, `Duration`, `Exit`, `Cause`, `Fiber`, `FiberSet`, `FiberMap`, `Deferred`, `Queue`, `ManagedRuntime`. Forbidden: `effect/http`, `effect/http-api`, `effect/sql`, `effect/socket`, `effect/schema`, `effect/process`, `effect/observability`, `effect/workflow`, `effect/rpc`, `effect/cluster`, `effect/ai`, `effect/cli`, `effect/persistence`, `effect/reactivity`, `effect/workers`, `effect/devtools`, `effect/eventlog`, `effect/jsonschema`, and every `@effect/*` package.
2. **Where Effect may be imported.** Only in `server/src/effect/` and in files that a slice converts. **Never** in `packages/shared`, `packages/db`, `cli`, `ui`, plugin code, or `server/src/modules/*/domain` (the domain layer is pure).
3. **Services.** Use `Context.Service` (v4 replaces `Context.Tag`). One service per existing `xService(db)` factory that a slice converts. The factory stays exported and returns the same object, so callers do not change.
4. **Layers.** A layer builds a service once. `ManagedRuntime.make(layer)` holds the layers for the life of the process. A test builds a small test layer. No global singletons.
5. **Edge only.** `runFork`, `runPromise` and `runSync` are called **only** in `server/src/effect/edge.ts` (the facade, the scheduler adapter, the shutdown adapter and the route adapter). Services never call them.
6. **Cancellation.** Pass the request or run `AbortSignal` to the edge with the run options. Use `Effect.tryPromise((signal) => ...)` and pass `signal` to `fetch`, `undici`, child-process helpers and any other call that accepts one.
7. **Errors.** Use tagged error classes. Map them to `HttpError` in one function at the edge. Do not `throw` inside an Effect. Use `Effect.die` only for bugs.
8. **Retry and time.** Use one `Schedule` per policy, with `jittered`, a `recurs` or `upTo` cap, **and** a per-attempt timeout. Remember that `upTo` does not cut a long attempt.
9. **Concurrency.** Use `Semaphore` or the `concurrency` option. Do not write a new `Map<string, Promise>` lock.
10. **Cleanup.** Put release code in a `Scope` finalizer, not in a hand-written `try`/`finally` chain, when the resource crosses an `await` that can be cancelled.
11. **Config.** Read `process.env` only in the existing config layer. A layer receives a typed value.
12. **Logging and tracing.** Use the pino-backed logger and the OpenTelemetry-backed tracer from `server/src/effect/`. Do not create a logger or a tracer elsewhere.
13. **Stack traces.** Name each effect (`Effect.fn("service.method")` or `Effect.withSpan`; the exact v4 names are confirmed in the E0 spike) so a failure shows a useful name. Section 5.3 lists the cost.
14. **Tests.** Use plain `vitest`. Build a `ManagedRuntime` from a test layer and dispose it in `afterEach`. Pure Effect unit tests may join the `Dockerfile` `vitest run` list. Embedded-Postgres suites cannot.
15. **Enforcement.** Extend `scripts/check-module-boundaries.mjs` (it already extracts imports) with rules 1 and 2, and add it to a CI step in slice E0. No new linter.

## 10. Risks

| Risk | Mitigation |
| --- | --- |
| An unstable API changes in a minor release. | Core modules only; exact version pin; a gate on imports (section 9). |
| Type-check time grows. Effect types are heavy, and the server already has a large type graph. | M11 is a go/no-go row. |
| Fibers add memory or CPU per request or per run. | M4 and M5 are go/no-go rows. The measurement uses the real endpoints. |
| Stack traces get worse. | Name effects (rule 13). Compare one real failure before and after. |
| The process does not exit after shutdown because of the v4 keep-alive. | A test: exit within the bound after `dispose()`. |
| A conversion changes behavior in a hot path. | Characterization tests first (R2, R3). One revertible commit per slice. |
| Two styles live in the code for a long time. | The guide (section 9), the boundary gate, and a deletion target per slice. |
| E0's retry policy holds a request longer during an outage (up to 2 s per call, 4 calls on a dashboard request) and could amplify load on a database that is down. | F1 measures p99 and failures during the blip. The policy values are a proposal (Q3). A shorter budget or a circuit breaker is the fallback. |
| Merge conflicts with open pull requests. | The freeze list (section 7.3). Refresh it before each slice. |
| The measurement is noisy on a shared host. | The rule in section 8: interleave, repeat, report the spread, and never pass on inconclusive. |

## 11. The pull request sequence

| Step | Pull request | Content | Needs |
| --- | --- | --- | --- |
| 1 | **This plan** | Docs only. | Plan review. |
| 2 | **B0 harness** | `tests/perf/backend/` and the B0 report (numbers on `main`). No `server/src` change. | The maintainers' go, at least 9,000 MiB free, and #50 landed or copied. |
| 3 | **#103 D0** (not this plan) | Bounded shutdown in plain TypeScript. | Owned by #103. |
| 4 | **E0** | The smallest edge: an empty-layer runtime, `edge.facade`, the boundary gate, the guide, and `database-retry.ts` converted (section 7.4). | An **online install** of one dependency: `effect`, pinned to one exact version. |
| 5 | **Gate 1 report** | E0 against arm A and arm C, in the format of section 8. | Quiet-window measurement. |
| 6 onward | E1 to E6, one pull request each, in the order of section 7.4. Gate 2 follows E3 and Gate 3 follows E6. Heartbeat and recovery singles come last. | Each with its before-and-after row. | The freeze list refreshed first. |

Every pull request after this one follows `.github/PULL_REQUEST_TEMPLATE.md` in full, including the model line.

## 12. Open questions, each with a recommendation

| Id | Question | Recommendation |
| --- | --- | --- |
| **Q1** | **Scope: does "backend should Effect everywhere" mean (A) Effect as the control-flow layer under the existing libraries, or (B) also Effect's own `http`, `sql` and `schema` in place of Express, drizzle and zod?** This is the consequential choice. | **A.** B means unstable APIs in the hot path, a second validator for the shared contract, and a rewrite with no measured gain. If B is wanted later, it needs its own plan and its own B0 comparison. For the user. |
| **Q2** | Which version to pin? Today only `4.0.0` can be installed. `4.0.1` can be installed from about 2026-10-12 and `4.0.2` (`latest`) from about 2026-10-14. | Pin the **newest eligible version on the day the install is approved**, exact, no `^`, the same version for every Effect package. The line is young (the vendor's September release-candidate recap lists concurrency fixes in `Queue`, `Layer.MemoMap` and `Effect.race`), so prefer `4.0.1` or later over `4.0.0` when the dates allow. Never override the cooldown. |
| **Q3** | Are the thresholds in section 8 right, and is E0's retry policy right (jittered exponential from 50 ms, 2 s budget per call, so up to 8 s of waiting on one dashboard request in an outage)? | Use the thresholds as written for the first slice. Tighten them after B0 shows the real spread. A threshold below the B0 spread cannot decide anything. For the policy, keep 2 s per call as the proposal and let F1 show the cost. If F1 shows load amplification, shorten the budget to 1 s. |
| **Q4** | Where to measure? | The shared host, with the load gate in section 4.1, for B0 and for every slice. Never a laptop. |
| **Q5** | M2 (true tick time) needs a three-line log in `index.ts`. That file is on the freeze list. | Take the proxy (wake-to-start latency) in B0 now. Land the log line as one small plain-TypeScript pull request after #104, #73, #75 and #108 merge, then re-take only M2. |
| **Q6** | The fixture script is only on #50's branch. | Land #50 (docs and tooling only). The alternative is a copy with `git archive`, which forks the script. |
| **Q7** | Tracing: a thin `Tracer` over `@opentelemetry/api`, or `@effect/opentelemetry`? | The thin tracer. `@effect/opentelemetry` is an unstable package that needs SDK peers the server does not declare today. E0 ships only a no-op tracer. The OpenTelemetry bridge is the slice after E0, with the two tests in section 6. |
| **Q8** | Which tests gate in CI? CI runs only the `vitest run` list in the `Dockerfile`. | Append the pure unit tests of the edge module (no Postgres). Embedded-Postgres suites cannot go on that line. The B0 harness never gates. |
| **Q9** | Where does `check:module-boundaries` run? A search of `.github` and `Dockerfile` found no call to it. | Run it on `main` first and confirm it passes. Then wire it into one existing required job in E0. This is a CI change, so it needs the landing reviewer. |
| **Q10** | Do plugins get Effect? | No. Plugin worker code and `plugin-sdk` stay as they are. Effect is a server-internal tool in this plan. |
| **Q11** | When does a replaced helper go? | In the same pull request that moves its last caller, or the next one. Never keep both for more than one slice. |
| **Q12** | If the verdict is no-go, what stays? | Revert the slices, **keep the B0 harness and the B0 report**. The harness is useful without Effect. |
| **Q13** | Is a shared helper (`database-retry.ts`) acceptable as the "one real service" of the first slice? | Yes. It sits on the dashboard read path (4 calls per request), it is the target of fault run F1, and it has no open pull request. A domain service off the B0 path would give a weaker measurement. |
| **Q14** | The request was one go/no-go after the first slice. This plan uses three checkpoints (after E0, E3 and E6). Is that acceptable? | Yes. E0 can judge **cost** (speed, memory, footprint) but cannot prove **reliability value**, because its gain comes mostly from the policy change. Gate 2 (a real loop with a real cancel) and Gate 3 (shutdown, after D0) can. A single early gate would approve on cost alone or reject for a reason E0 cannot show. |
