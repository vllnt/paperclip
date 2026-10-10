# Backend on Effect 4: one runtime for time, failure and cleanup, measured before and after

Date: 2026-10-10
Status: Plan only (docs). No Effect code, no install and no measurement run is part of this pull request.
Branch: `docs/backend-effect-plan`
Anchors: `origin/main` `d9804ac4f`. Effect facts come from the published `effect@4.0.0` type files and the official migration guides. They were read from the package registry and a CDN. Nothing was installed.

## 0. Decision summary

**Proposal.** Put an Effect runtime under the existing backend, one slice at a time, and keep a slice only if a measured before-and-after shows that it is not slower, not bigger in memory, and more reliable.

**What "Effect everywhere" means here (a scope call for the user).** Effect becomes the way the backend writes time, failure and cleanup: timeouts, retries, concurrency caps, cancellation, resource release, typed errors and dependency wiring. It does **not** replace Express, drizzle, pino, ws or zod. Reason: Effect's own `http`, `sql`, `socket` and `observability` modules are marked `@stability unstable` (section 3). Those are the modules that would replace Express, drizzle, ws and the OpenTelemetry path. Effect's core `Schema` module is not tagged unstable, but it would be a second validator next to zod, which is the shared contract of the UI, the CLI and OpenAPI (section 6). The stable core, without `Schema`, is what this plan uses (section 9, rule 1).

**Order.**

1. Measure B0 on `main`, before any Effect code (section 4).
2. A bounded shutdown lands first, in plain TypeScript. No open pull request has it yet (section 7.3). It is not part of this plan, but slice E6 needs it.
3. Slice E0a: the new retry policy for `database-retry.ts` in plain TypeScript. It needs no install and can merge on its own. Slice E0b: the Effect runtime, and the same helper on Effect, with the same policy (section 7.4).
4. A go/no-go with stated numbers at three checkpoints: after E0b, after E3 and after E6 (section 8).
5. More leaf services. Heartbeat and recovery slices come last, one per deploy window.

**What is already known (verified at `d9804ac4f`).**

- Effect is used nowhere today: 0 imports in `server/src`, `packages`, `cli` and `ui`.
- The hand-written helpers that Effect replaces are counted in section 5. Section 5 also names the cost that Effect adds.
- 67 pull requests were open when this plan was reviewed (66 when the list was first built; the new ones are docs only). The files they touch are the freeze list (section 7.3).

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
| 1,769 `.ts` files under `server/src`: 804 production and 965 test files. | `git ls-tree -r origin/main server/src`. |
| Stack: Express `^5.1.0`, pino `^10.0.0`, pino-http `^11.0.0`, ws `^8.21.3`, zod `^4.4.3`, drizzle-orm `^0.45.2`, TypeScript `^7.0.2`, vitest `^4.1.11`. | `server/package.json`. |
| Node `>=24.11.0`. TypeScript is `strict`, target `ES2023`, `NodeNext` modules. | `package.json` `engines`; `tsconfig.base.json`. |
| `@opentelemetry/api` is a hard dependency. The OpenTelemetry SDK, exporters and auto-instrumentation are **optional peer dependencies**. | `server/package.json` (`dependencies` and `peerDependencies` with `optional: true`). |
| There is no linter configuration (no ESLint, Biome or oxlint file). An import-boundary gate exists: `scripts/check-module-boundaries.mjs`, with an import extractor. It scans only `server/src`, so a rule for the other trees needs new scan roots. It is wired as the root script `check:module-boundaries`. A search of `.github`, `Dockerfile` and the root `package.json` found no other reference to it. Other scripts were not searched. | `scripts/check-module-boundaries.mjs`; `package.json:48`. |
| Largest services (decimal MB): `chat-channels.ts` 1.45 MB, `heartbeat.ts` 1.28 MB, `tool-access.ts` 0.74 MB, `native-runtime/native-session-executor.ts` 0.51 MB, `issues.ts` 0.47 MB. | `git ls-tree -r -l origin/main server/src`. |
| Shutdown has no overall bound and the run drain is serial. The listener closes after the run drain. This plan does not re-measure it. No open pull request plans a bounded shutdown: #103's pushed text has the slices D1 and D2 only. | Section 2.1 and #103 at `b7841a81e`. |

### 2.1 The edges where a runtime would attach

| Edge | Today | Anchor |
| --- | --- | --- |
| Startup | `startServer()` loads config, picks external or embedded Postgres, migrates, builds the services and the Express app, sets the phase `recovering`, binds the listener, **then** runs recovery (phase `ready` at the end). `GET /api/health` answers 200 with `status: "starting"` until `ready`. | `server/src/index.ts:195-1006`, `:1934`; `server/src/routes/health.ts:240` |
| Shutdown | One `shutdown()` function with 8 stages, and 7 more inside `finalizeServerShutdown`. These steps have **no time bound**: the scheduler-idle wait, the run drain, and the app-services shutdown. No timeout was found on the embedded Postgres stop either. The HTTP listener closes inside `finalizeServerShutdown`, after the scheduler-idle wait and the run drain, and before the app-services teardown, the database close and the Postgres stop. The listener close itself is capped at 5 s. A 5 s `Promise.race` around the finalizer drain abandons its inner `while` loop; it does not stop it. | `index.ts:1985-2089`; `shutdown.ts:10-37,54-89,241-274`; `heartbeat.ts:15494-15705,21845-21857`; `app.ts:1326-1363` |
| Signal handlers | Four signal registrations in two files: `index.ts:2091,2094` and `instrumentation.ts:551-552`. `app.ts:1370,1373` are `exit` and `beforeExit` hooks; the `exit` hook calls `shutdownAppServices`. | same files |
| Timers | At least 12 boot-time loops (execution-control sweeps 15 s, run-usage derivation 60 s, temp sweeper, heartbeat scheduler 30 s, database backup, feedback flush, chat reconcile 1 s, plugin job tick 30 s, live-events ping 30 s, and more). Per-resource lease timers exist as well. The outer heartbeat tick has no single-flight flag in the range read. It does not await long work: each sweep is handed to a tracked set. `waitForHeartbeatSchedulerIdle` is an unbounded `while` loop. The database-backup interval and the live-events ping interval are never cleared. | `index.ts:1147-1214,1692-1882,1909`; `realtime/live-events-ws.ts:245-254` |
| WebSocket | Three servers share one HTTP server. The live-events server does not check `bufferedAmount`, never calls `wss.close()` and sends to every subscriber from one global emitter. | `index.ts:964-985`; `live-events-ws.ts:227-347`; `services/live-events.ts:7-8` |
| Express | Express `^5.1.0`. 69 router factories in `app.ts`. 903 route registrations. Handlers are bare `async (req, res)`: Express 5 forwards rejections. No async wrapper exists. One error middleware maps `HttpError`, `ZodError`, body-parser errors and the rest. | `app.ts:512-1139`; `middleware/error-handler.ts:126-302`; `errors.ts:1-46` |
| Errors | `throw badRequest/unauthorized/forbidden/notFound/conflict/...(`: **3,349** sites in routes and services. `throw new Error(`: **1,521** sites. | `git grep`, non-test files |
| Wiring | **111** `xService(db)` factories, composed by hand. No container. 207 module-level `Map`/`Set` declarations (plus 18 `WeakMap`/`WeakSet`) and 43 module-level `let` declarations in `services/`. Tests use `vi.mock` (458 calls in 181 files), option injection and real embedded Postgres. | `services/*.ts`; `index.ts:879-890,1259-1319` |
| Config | A typed `Config` with 44 keys, built from a config file and ad-hoc env parsing. **348** other `process.env` reads in 113 files. | `config.ts:57-102,123-390` |
| Logging | pino `^10` and pino-http `^11`. 98 files import the logger. No code uses pino-http's `req.log`. Success lines of the busiest endpoints are silenced by policy. | `middleware/logger.ts:23-42,82-218`; `middleware/http-log-policy.ts:3-12,96-109` |
| OpenTelemetry | Gate: `OTEL_EXPORTER_OTLP_ENDPOINT` (`instrumentation.ts:42`). Without it the bootstrap resolves at once and nothing starts. | `instrumentation.ts:42,304-306,493-522` |
| Database | postgres.js through drizzle. Default pool of 10. **608** `.transaction(` calls in 140 files and no shared helper. About 30 files declare their own transaction type alias (regex in Appendix A). | `packages/db/src/client.ts:130-284`; `git grep` |

Size for scale: `chat-channels.ts` 38,507 lines, `heartbeat.ts` 32,602, `tool-access.ts` 20,368, `routes/issues.ts` 18,833, `services/issues.ts` 13,488, `native-session-executor.ts` 13,015. `index.ts` is 2,157 lines and `app.ts` is 1,378.

## 3. Effect 4: what the plan relies on

**Versions (registry, 2026-10-10).** `latest` is `4.0.2` (2026-10-07). `4.0.0` came out 2026-10-01 and `4.0.1` on 2026-10-05. Companion packages are at `4.0.3` (2026-10-10). The host's npm cooldown is `min-release-age=7`. So `4.0.0` is the newest installable today. `4.0.1` becomes installable about 2026-10-12 (`@effect/opentelemetry@4.0.1`: 2026-10-11) and `4.0.2` on 2026-10-14. The cooldown is a host policy of the `~/.npmrc` (`min-release-age`); the repository's package manager is pnpm 9.15.4, so the rule is applied by policy. The companions at `4.0.3` peer on `effect@^4.0.3`, which is not published yet, so a companion must be pinned to the same version as `effect`.

**One version for all packages.** Every Effect package shares one version number, and each companion has a peer dependency on the same `effect` version (`@effect/platform-node@4.0.3` and `@effect/opentelemetry@4.0.3` require `effect@^4.0.3`). Pin every Effect package to the **same exact version**. **Do not pin 4.0.0 or 4.0.1 for slice E0b.** The release notes of 4.0.1 and 4.0.2 contain fixes that E0b and later slices depend on: 4.0.1 #8629 keeps a fiber's `AsyncLocalStorage` context (the server uses it in `chat-sdk-runtime.ts`, `plugin-host-call-actor.ts` and `native-run-trace.ts`); 4.0.2 #8799 stops `Effect.retry` from retrying failures that contain defects or interruptions; 4.0.2 #8783 fixes a `ManagedRuntime` disposal deadlock when called from one of its own fibers; 4.0.2 #8819 stops `Queue` from losing messages when `take` is interrupted. The earliest sensible pin is therefore 4.0.2, installable on 2026-10-14.

**Stability.** The official guide marks these modules `@stability unstable`: `ai`, `cli`, `cluster`, `devtools`, `eventlog`, `http`, `http-api`, `jsonschema`, `observability`, `persistence`, `process`, `reactivity`, `rpc`, `schema`, `socket`, `sql`, `workflow`, `workers`. An unstable API "may receive breaking changes in minor releases". Modules in packages other than `effect` (for example `@effect/platform-node`, `@effect/sql-pg`, `@effect/opentelemetry`, `@effect/vitest`) are currently unstable too. Untagged APIs follow strict semver. Note that the unstable `effect/schema` subpath holds only the model and the schema compilers; the core `Schema` module has no tag. **Consequence:** this plan uses only a positive list of untagged core modules (section 9, rule 1) and pins the exact version.

**Footprint.** `effect@4.0.0` has no runtime dependencies. The registry reports 49.5 MB unpacked in 2,561 files. The root entry `dist/index.js` is a barrel of about 138 `export * as X` lines, so a root import must evaluate every module in Node ESM. A subpath import loads only that module's graph. Whether a root import (`from "effect"`) loads every module at runtime is **not verified**; the package exports each module as a subpath (`effect/Effect`), so the guide requires subpath imports (section 9, rule 1) and E0b measures the difference. Requirements from the package README: TypeScript 5.9 or newer (TypeScript 7 recommended), Node 18 or newer, `strict` on. The repository meets all three.

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
- **`runMain` from `@effect/platform-node` installs its own SIGINT and SIGTERM handlers.** The fiber keep-alive guide says it also manages exit codes; in the source of `@effect/platform-node-shared` it calls `process.exit` only after a signal or a non-zero code. The server already owns its signal handling (`server/src/index.ts`). This plan does **not** use `runMain`.
- **`Effect.runFork(effect)` and `Effect.runForkWith(services)`** are the run functions on `Effect` itself. `ManagedRuntime` is the bridge used here because it holds one `Layer` for the life of the process.

**Verified by the reviewers (names only).** `Effect.timeout`, `Effect.retry`, `Effect.fn` and `Effect.sleep` are exported by `dist/Effect.js`. `Effect.tryPromise`, `Effect.promise` and `Effect.callback` pass an `AbortSignal`. `Effect.acquireRelease` appears in the vendor's own examples. A `Semaphore.take` waiter leaves the queue when it is interrupted. The root entry is a barrel and `./*` exports each module as a subpath.

**Not verified.** The 4.0.0 `Effect.d.ts` file was too large to read in full. These are **not** yet confirmed for v4: the semantics of `Effect.timeout` (that the loser is interrupted and the timer cleared), `Effect.addFinalizer`, a `signal` member in `Effect.RunOptions`, whether `acquireRelease` runs its acquire step uninterruptibly (one third-party note says it does), that Effect spans nest under the HTTP server span, how `zod` schemas pass through `StandardSchema`, whether `effect/testing` (`TestClock`) fits the fake-clock tests, and TypeScript 7 type-checking time on Effect types. The first task of slice E0b is a spike that confirms each one against the installed package.

**What Effect claims about cost (vendor claims, not measurements).** The beta post says the fiber runtime was rewritten for "lower memory overhead, faster execution, and simpler internals" and gives "roughly 70 kB in v3 to about 20 kB in v4" for a minimal bundle of `Effect`, `Stream` and `Schema`. The 4.0 release post (2026-09-30) gives figures: a minimal program from 35.6 kB to 7.1 kB, throughput from 0.71 million to 4.57 million concurrent tasks per second (6.4 times), and the heap for 50,000 fibers from 157.5 MB to 21.8 MB, as "medians of nine fresh-process runs". The post names no runtime or hardware. **All of these compare Effect 3 with Effect 4. None compares Effect with plain promises**, so none says what Effect costs the server. The 4.0 post also promises bug fixes for 4.x until September 2029 (long-term support). **The go/no-go uses our own numbers only.** Slice E0b reproduces the 50,000-fiber heap figure and measures the added time per facade call as a quiet instrument (metric M13).

## 4. B0: the baseline, measured on `main` before any Effect code

### 4.1 Rules of measurement

1. **One machine, interleaved, repeated, with the spread.** Never compare numbers from two machines. The web-app baseline in #50 was measured on a laptop. Do not mix it with numbers from the shared host.
2. **The base of a comparison is the slice's parent commit.** `main` moves: many open pull requests land between B0 and a slice, and a frozen B0 number would blame Effect for them. So each slice is measured against its own parent commit, rebuilt and run in the same interleaved session. The B0 report is kept for trends, not as the base of a gate.
3. **Load gate.** The shared host has 12 cores, and its load average has ranged from 4 to 50 (6 to 7 on a normal day). Record `uptime` at the start and at the end of every run, with free memory, time and commit. Start a round only when the 1-minute load average is at most 10. Discard and repeat a round whose end reading is above 10, and log the discards. Interleaving and the spread rule (section 8) handle the rest of the noise. Pinning the server to a fixed set of cores with `taskset` is an option when cores are free.
4. **Pin how the server starts.** Use the production command of the `Dockerfile`: `node --import <tsx loader> [--import probe] dist/index.js`, with `NODE_ENV=production` (JSON logs, no pretty transport), from a `tsc` build plus the asset copy steps of the server `build` script. The Rust runner vendor step is skipped, because the baseline serves no runs. A `tsx src/index.ts` start transpiles 1,769 files at start and would distort startup, memory and CPU, so it is not used for gates. Record the Node version (the host runs a newer Node than the `.nvmrc` of 24). Use a separate home, instance id, config and database; not the default Postgres port 54329; no shared data directory; telemetry and update checks off, so the server makes no outside calls.
5. **Canary.** In any scenario that executes runs, one canary run must start and finish before the round. A server that starts inside a linked worktree with `PAPERCLIP_IN_WORKTREE=true` suppresses run execution (`heartbeat.ts:9821-9826`; `tickTimers` returns zeros at `:32461-32467`). Such a round measures an idle scheduler. It is void.
6. **Ready means `status: "ok"`.** `/api/health` answers 200 while the server still starts (`status: "starting"`, `health.ts:240`). Poll the field, not the status code.
7. **Open loop for latency.** Send requests at a constant arrival rate below saturation, so a stall shows in the tail (a closed loop hides it: "coordinated omission"). Use a closed-loop ramp only to find peak throughput. The steady rate is 50% of that peak, found once per mix and never recalibrated per arm.
8. **Warm-up.** Discard the first 30 s of each scenario.
9. **Record** the commit, Node version, start command, fixture seed, and every round's load average with the result. A round is void on any request error, unfinished request or failed preflight.
10. **Pre-registration.** After B0, the report sets for each gated metric the smallest change that the instrument can detect: the larger of the threshold and twice the B0 spread. A metric whose smallest detectable change is more than twice its threshold is **not gated by that instrument**. A quieter instrument takes its place: M13 (the micro-benchmark of the facade) and CPU time per request. This is decided from the B0 data before the first slice runs and is not changed afterwards. A gate uses at most 10 pairs. If a metric is still inconclusive after that, the maintainers decide with the data in front of them.

### 4.2 The metrics

| Id | Metric | How it is measured | Existing tool |
| --- | --- | --- | --- |
| M1 | API latency (p50, p95, p99) and throughput for the busiest endpoints | New open-loop and closed-loop load script on Node's built-in `fetch`, in two mixes. `mixed` starts from the endpoints whose success logs the log policy silences (`http-log-policy.ts:3-12`: health, activity, dashboard, heartbeat runs, issues, live runs, sidebar badges). That suggests high traffic, but the reason is not stated in the code, so the final list comes from observed request counts. `dashboard` is the dashboard alone: slice E0b puts four fibers on each dashboard request, and a mix dominated by the 1,000-issue list could not show that. Both are read-only, so rounds do not drift. Writes are not measured in B0. | None for load. PR #50 `measure.mjs` gives single-browser latency only. |
| M2 | Heartbeat scheduler tick duration | **Proxy, no code:** wake-to-start latency from database timestamps (`agent_wakeup_requests` to `heartbeat_runs`), at a fixed wake rate. **True tick time** needs a three-line log at the end of the tick in `index.ts`. That file is on the freeze list (section 7.3). See Q5. | None. The tick logs counts only (`index.ts:1716-1718`). |
| M3 | Runs one process drives at once | New ramp with the fake provider (the `process` adapter or the fake `codex` bins under `tests/e2e/fixtures/`). Stop at the first of these limits (proposals, set before the run and not changed after it): event-loop lag p99 above 100 ms, wake-to-start p95 above 30 s, or RSS growth that does not level off. Many agents with one run each (the per-agent cap is 1 to 50, `heartbeat.ts:722-724`). | None. |
| M4 | RSS and heap | A preload file (`node --import`) samples `process.memoryUsage()` once per second and writes NDJSON. An outside sampler reads `/proc/<pid>/status` as a cross-check. No change to `server/src`. | None in `server/src`. |
| M5 | CPU per request and per run | `process.cpuUsage()` in the preload, minus the idle rate, divided by completed requests (M1) and completed runs (M3). Cross-check with `/proc/<pid>/stat`. | None. |
| M6 | Event-loop lag | `monitorEventLoopDelay` in the preload; report the median of the per-second p99 values, the maximum, and the overall maximum. | None (0 hits in `server/src`). |
| M7 | Startup | The harness records the spawn time and polls `/api/health` until `status: "ok"`. The startup phase is sampled by polling: the server keeps only the latest phase (`startup-recovery-state.ts`), and the phase `starting` is never visible over HTTP. Do not use `processStartedAt` (it is module-load time, `server-info.ts:172`). Five cold starts. | Partial: log markers only. |
| M8 | Shutdown time and runs lost per restart | Start 30 runs on the fake provider. Send SIGTERM. Record time to exit, exit code, and the end state of each run **from the database** (`interrupted` with `server_shutdown_interrupted`, `failed` with `process_lost`, and so on). B0 measures the idle shutdown only. | Partial. The `lostRunIds` report exists only for a guarded hot restart. |
| M9 | Behavior under faults | **F1:** a database blip of a stated length (1 s) during open-loop load. Ending all backends once lets the pool reconnect at once, so the blip would last only milliseconds. For a controlled length, a loop ends every other backend (`pg_terminate_backend`, the technique in `packages/db/src/__fixtures__/postgres-connection-recovery.mjs`) every 25 ms for 1 s, so new connections keep failing with closed-connection errors, which `database-retry.ts` classifies as transient. `ALLOW_CONNECTIONS false` is not used: it is expected to fail with a state that neither predicate set contains. Before the first F1 run, a test on `main` shows that the wrapped dashboard calls retry under this fault. The dashboard also has at least three unwrapped queries (`agentRows`, the recursive run-activity query, the budget overview); report their failures separately. Report failed requests and the time until p99 recovers. **F2:** a fake provider that never answers; other runs and requests keep their latency. **F3:** a websocket client that connects and never reads, while events publish at a fixed rate; report RSS growth and other clients' latency. | DB-level tests only. No fault run against a live server. |
| M10 | Fixture | `make-fixture.mjs` from #50's pinned head (1,000 issues, 10,000 runs, seed `20261009`). Add wakeup rows and agents that execute for M2, M3 and M8. | #50 only (not on `main`). |
| M11 | Dev loop | `tsc --noEmit` for the server: wall time and peak memory, five interleaved runs. | None. |
| M12 | Install weight | `du` of the production dependency tree and the size of the production image, before and after the dependency. | None. |
| M13 | Fiber cost, quiet instrument | A micro-benchmark with no server: heap for 50,000 fibers (reproducing the vendor's figure on this host), and the time added per facade call against a plain promise. It needs Effect installed, so it runs in slice E0b. | None. |

### 4.3 What exists, and what the gaps are

Searched: Smoke Lab, the eval kernel, `tests/perf/*`, the release-smoke and e2e suites, the benchmark scripts, the observability reports (#70 on `main`, #73 open), the health route, and a grep for load tools and in-process meters. **Result:**

- **Reused:** the boot recipes in `tests/e2e/playwright.config.ts:63-96` and `tests/perf/issue-detail/playwright.config.ts:19-57`; `make-fixture.mjs` (#50); the fake provider bins; the DB-termination technique; the memory-sampling pattern in `server/scripts/benchmark-tool-gateway-listing.ts`. The `lostRunIds` hot-restart report is **not** reused: the server writes it only for a guarded hot restart (a marker from `scripts/request-hot-restart.ts`), and a plain SIGTERM writes nothing.
- **Not suitable:** Smoke Lab (connection checks, no timing), the eval kernel (a matrix orchestrator), `release-smoke` and `test:e2e` (pass or fail), the `run_usage_records` reports (they describe runs, not the server).
- **Gaps, so the harness adds code:** a concurrent HTTP load generator (no load tool is a dependency; a grep for autocannon, k6, artillery, wrk, tinybench, mitata, clinic, 0x and prom-client found none); a process sampler (0 hits for `monitorEventLoopDelay`, `process.memoryUsage` and `process.cpuUsage` in `server/src`); tick, startup and shutdown timers; a fault runner against a live server; wakeup fixtures.

### 4.4 The harness (new code, and only for the gaps)

Location: `tests/perf/backend/`, next to the existing perf directories.

- `run.mjs`: starts the server with the pinned command, waits for `status: "ok"`, runs the canary, runs a scenario, sends SIGTERM, and collects the files.
- `load.mjs`: the load generator. No new dependency.
- `probe-preload.mjs`: the in-process sampler (M4, M5, M6). It lives outside `server/src`, so `main` is measured without editing it.
- `faults.mjs`: F1 to F3.
- `report.mjs`: median and spread for each metric, and the pass or fail rows of section 8.
- The fixture comes from #50. The B0 run reads `make-fixture.mjs` from #50's pinned head with `git show <sha>:tests/perf/web-app/make-fixture.mjs` into a scratch directory and **commits no copy**. #50 is a dependency of the B0 harness pull request. The code pull requests use the landed file.

### 4.5 Scenarios

- **A, steady mix:** open loop at 50% of the measured saturation rate for 10 minutes (M1, M4, M5, M6).
- **B, saturation ramp:** closed loop (M1 throughput).
- **C, run capacity:** the ramp for M3, with M4 to M6 sampled.
- **D, restart:** M8.
- **E, startup:** five cold starts (M7).
- **F, faults:** F1 to F3 (M9), each during scenario A.

### 4.6 Cost, and the gate

**Go given (2026-10-10).** B0 runs in a new worktree off `origin/main`, with `pnpm install --offline --frozen-lockfile` only (B0 adds no dependency), and only when at least 9,000 MiB is free both before and after. The server uses the embedded Postgres that the code starts when `DATABASE_URL` is unset, on a local port, with no outside network calls, and it is stopped when the run ends. The worktree is removed when B0 is done. The raw numbers go in the harness pull request body. An install into a new worktree of `main` was about 150 to 220 MB on this host. A small fixture (300 issues, 1,500 runs) took about 4 minutes and 28 MB in an earlier run; the full fixture has not been run here. The estimate for B0 is **1 to 2 hours of machine time** (five repeats of each scenario). That is an estimate, not a measurement. B0 is never run on a developer laptop for comparison with a shared-host slice. The code pull request for E0b needs its own, separate go: it adds a dependency, so it needs an online install.

## 5. Where Effect pays off, with anchors

### 5.1 What the code writes by hand today

Counts are from `git grep` at `d9804ac4f`, tests excluded, over `server/src`, `cli/src` and the packages (except the Rust crates). They are regex-bound. A regex can miss a form, and two counts can overlap. The `path:line` anchors were opened unless the table says "not opened". Effect and the other candidate libraries (`fp-ts`, `neverthrow`, `p-limit`, `p-queue`, `async-retry`, `rxjs`) are in no `package.json`. `p-queue`, `p-retry` and `p-timeout` are present only as transitive dependencies of the Slack client.

| Need | Hand-written today | Effect replacement | Replaces? |
| --- | --- | --- | --- |
| **Retry and backoff** | 19 named helpers: **10 in-process** and 9 that compute a retry time that is stored in the database. Only 2 are general retry helpers: `server/src/database-retry.ts:73` (3 attempts, 50 and 100 ms) and `server/src/services/chat-control-admission-retry.ts:4` (50 retries, 100 ms). **Seven separate jitter implementations**, for example `plugin-worker-manager.ts:3088`, `telemetry/client.ts:331`, `environment-runtime.ts:2008`, `heartbeat.ts:2066` (this one has its ratio set to 0 at `heartbeat.ts:873`). 29 inline timed retry sites by regex. | `Effect.retry` with `Schedule.exponential`, `jittered`, `recurs`, `upTo` | **Yes** for the 10 in-process helpers and the inline sites. **No** for the 9 database-backed schedule calculators (the state is a column) and the 33 no-wait optimistic-lock loops. |
| **Timeouts** | **17 wrappers**, for example `sandbox-callback-bridge.ts:365`, `openclaw-gateway/.../execute.ts:542`, `judge-client.ts:157,431`, `claude-local/.../quota.ts:264` and a duplicate in `codex-local/.../quota.ts:222`, `tool-gateway.ts:6399`, `quota-windows.ts:42`. Inline: **102** `Promise.race` sites (80 have a nearby `setTimeout`) and 19 `setTimeout` that call `abort`. | `Effect.timeout` (the loser is interrupted and the timer is always cleared) | **Yes.** 81 `AbortSignal.timeout(` calls are fine as they are. |
| **Sleep** | **21 separate definitions** of a promise that a `setTimeout` resolves, and 62 inline copies. Nine files use `node:timers/promises` instead. | `Effect.sleep` | **Yes** |
| **Concurrency caps** | **18** per-key serialization chains (a `Map<string, Promise>`; the GitHub plugin alone has five copies of the same idea), **5** bounded queues or pools (`tool-discovery-scheduler.ts:9`, `duplicate-detection.ts:131`, `agent-avatar-pool.ts:6`, `workspace-git-operation-scheduler.ts:178`, `plugin-job-scheduler.ts:212`), **3** bounded-parallel maps (`tool-gateway.ts:472`, `company-portability.ts:119`, `workspace-file-resources.ts:264`), 4 stream queues, and 5 rate limiters (4 time-window limiters, plus the synchronous `acquire(key)` limiter in `routes/file-resources.ts:66`). | `Semaphore`, `Effect.forEach({ concurrency })`, `Queue` | **Yes** for the 26 caps and maps. **Partly** for the rate limiters and the 24 single-flight maps. **No** for database locks: 58 advisory-lock lines and 447 `FOR UPDATE` lines stay. |
| **Cleanup** | **8** cleanup registries or hand-ordered teardown sequences: `run-resource-ledger.ts:155` (no non-test caller), `ssh.ts:389`, `chat-attachment-read.ts:44`, `native-runner-file-handoff.ts:988`, `app.ts:586`, `live-events-ws.ts:242`, `plugin-host-services.ts:803`, and the shutdown sequence (`app.ts:1326-1363`, `shutdown.ts:104`, about 20 steps). 629 `finally` blocks. | `Scope`, `acquireRelease`, `addFinalizer` | **Yes** for the registries. Most `finally` blocks stay. Only those that cross a cancellable `await` benefit. |
| **Cancellation** | 257 `AbortSignal` references in 111 files. `AdapterExecutionContext.signal` exists (`adapter-utils/src/types.ts:203`) and is set at `heartbeat.ts:26612`. The ACPX engine, the Grok adapter and the Hermes gateway read it; the local CLI adapters do not. The child-process runner has no signal (`server-utils.ts:4660-4681`, `runChildProcess`). Cancel also works out of band (`heartbeat.ts:31641-31652`). 38 of 96 `fetch` calls show no signal or timeout nearby. | Fiber interruption, `tryPromise((signal) => ...)` | **Partly.** Effect covers code that already takes a signal. `runChildProcess` and the adapters that do not read the signal need a wrapper with a kill finalizer. |
| **Typed errors** | 3,349 `throw badRequest/...(` and 1,521 `throw new Error(`. One `HttpError` class. 188 `class ... extends Error`. | Tagged errors | **No, not now.** The `HttpError` shape is the API contract (section 6). Tagged errors are used inside converted code and mapped at the edge. |
| **Dependency wiring** | 111 `xService(db)` factories, composed by hand. No container. 207 module-level `Map`/`Set` (plus 18 weak ones). | `Layer`, `Context.Service` | **Later.** Only inside converted services. A repo-wide switch has no measured gain. |
| **Config** | A typed `Config` (44 keys) and 348 other `process.env` reads in 113 files. | `Config` / `ConfigProvider` | **No.** The existing typed `Config` is exposed as a service (section 7.1). A second parser would be a second system. |

**The count of what Effect would replace.** Effect would replace **82 named helper definitions**: 10 retry, 17 timeout, 21 sleep, 26 concurrency (18 + 5 + 3), 8 cleanup. It would also replace about **190 inline sites**: 29 timed retry, about 99 timeout (80 `Promise.race` with a timer and 19 timer-then-abort), and 62 sleep. The retry and sleep counts overlap in places, so 190 is an upper bound. **Both counts are repository-wide**, and they include code under `packages/*` (adapters, plugins, `adapter-utils`) that rule 2 in section 9 keeps out of scope. The B0 report repeats the same regexes restricted to `server/src` to give the in-scope count. Slices E0a to E6 name about 18 of the 82 definitions; the rest sit in frozen files or out of scope. These are the maximum, not the plan: the freeze list (section 7.3) removes the files that open pull requests hold, and section 5.2 removes the deliberate cases.

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

**Gaps that Effect would close by construction (anchors opened).**

- **Timers that are never cleared.** Of the first 5 `Promise.race` sites read, 1 leaks. Of 15 of the 28 flagged sites read (the 28 are the `Promise.race` sites that have a nearby `setTimeout` and no nearby `clearTimeout`; the 15 include those 5), 4 leak: `plugin-host-services.ts:187-195`, `instrumentation.ts:535-545`, `run-failure-report.ts:129-135`, `execution-target.ts:2576-2584` (the last three are `unref`'d, so they never block exit, but they stay armed). 13 flagged sites were not read.
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

### 5.4 The cheaper path: plain TypeScript

Every gap in 5.3 also has a plain fix: a shared `sleep(ms, signal)`, `withTimeout(promise, ms, signal)`, `retry(run, policy, signal)`, a keyed mutex, `DisposableStack` for cleanup (Node support was not checked), and `AbortSignal.any` and `AbortSignal.timeout` (81 uses already). A plain helper set would delete the same duplicates with a smaller change and no new dependency. Effect is chosen because the user asked for it, and because it gives one tested set for time, failure and cleanup, with interruption that reaches the work. The plan keeps the comparison honest in two ways. Slice E0a is the plain fix, merged and measured first, so Effect's own cost is the difference between E0b and E0a. And a slice that claims a reliability gain is measured against a plain-fix arm (section 8, "Evidence standard").

## 6. No second system

| Area | Rule | Why | Check |
| --- | --- | --- | --- |
| Validation | **zod stays** the contract in `packages/shared` (UI, CLI and OpenAPI use it). Effect's `Schema` is **not** used, not even inside the server. | Two validators for one contract is the failure the overlap rule names. The reason is not stability: the core `Schema` module has no unstable tag. Only the `effect/schema` subpath (model and compilers) does. | The boundary gate rejects `effect/Schema` and `effect/schema` by name. |
| Logging | **pino stays** the one log format. Effect code logs through a custom `Logger` that writes to the same pino instance. | One log format and one redaction config. | Slice E2 test: the same event logged from Effect code and from plain code has the same JSON keys. |
| Tracing | Effect spans go to the **existing** operator-gated OpenTelemetry path. With the gate off, no Effect span is exported. **No new exporter.** Effect code uses `Effect.fnUntraced` by default, so it makes no span unless a span is wanted and allowed. | `@effect/opentelemetry` is an unstable package (every package outside `effect` is) with ten peer dependencies, eight of them optional. The server declares fewer OpenTelemetry packages today. A small `Tracer` over `@opentelemetry/api`, which is already a hard dependency, adds none. | Slice E2 tests: gate off means 0 spans exported and bounded overhead (the M13 style micro-benchmark). Gate on means Effect spans appear under the HTTP server span. |
| Span allowlist | `AGENTS.md` section 5.7 gives the lighter observability review only while a change stays inside the closed span-attribute allowlist (`doc/observability.md`). | A new tracer file is a new exporter of span names, attributes, events and exit causes. | Slice E2 defines the allowlist, redacts `Exit` causes, updates `doc/observability.md`, and names the review level in its pull request. |
| Telemetry | Effect code **never** imports `packages/shared/src/telemetry/`. | `AGENTS.md` section 5.7: Telemetry sends data to a Paperclip endpoint by default. | The boundary gate. |
| Run record | `heartbeat_run_events` stays the record of runs. Effect does not add an event store. | The run-log path. | Review. |
| HTTP, SQL, sockets | Express, drizzle and ws stay. `effect/http`, `effect/sql` and `effect/socket` are not used. | Unstable, and they would replace working code with no measured gain. | The boundary gate. |
| Errors | The `HttpError` helpers in `server/src/errors.ts` stay the one HTTP error shape. Effect tagged errors map to them at the edge. The facade rethrows the **original** error value: Effect's `tryPromise` wraps a failure in `Cause.UnknownError` unless a `catch` is given. | One error shape for clients and OpenAPI. `error-handler.ts` and the existing retry test branch on the original error. | Slice E0b test: the original error value reaches the caller. |

## 7. The migration: edge first, then leaf services

### 7.1 The edge: an Effect runtime under plain code

**Rule: code lands with its first caller.** An adapter or a layer is added by the first slice that uses it. The design below is the whole edge. The table in section 7.4 says which slice adds which part.

One `ManagedRuntime` for the process, created lazily in `server/src/effect/runtime.ts` from one `Layer`. The layer grows by slice:

- **E0b: an empty layer.** There is no tracer, no logger layer and no service yet.
- **E2: a logger layer and a tracer layer.** A custom `Logger` that writes to the existing pino instance and replaces the default Effect loggers (`Logger.layer([...])` without `mergeWithExisting`). Spike point: `Logger.Options` has no annotations, so the bridge reads them from `options.fiber` or logs without them. A small `Tracer` over `@opentelemetry/api` (already a hard dependency) when the OpenTelemetry gate is on. When the gate is off, no Effect span is exported. No `@effect/opentelemetry`.
- **When first needed: a config service and a db service.** A read-only view of the existing typed `Config` (44 keys) and the existing drizzle handle. No second parser and no second pool.

The adapters live in `server/src/effect/edge.ts`. They are the only code that calls a run function (`runFork`, `runPromise`):

1. **Facade (E0b).** `edge.facade(effect, { signal })` runs an Effect and returns a `Promise`. A converted service uses it to keep its public types, so callers do not change. When all callers of a service are converted, the facade goes. It must (a) rethrow the **original** error value, not Effect's wrapper; (b) keep the caller's async context, so `AsyncLocalStorage` stores and the active OpenTelemetry span survive the call (the server uses `AsyncLocalStorage` in `chat-sdk-runtime.ts`, `plugin-host-call-actor.ts` and `native-run-trace.ts`); (c) pass the `AbortSignal` into the run options (spike point: confirm the member name). E0b tests all three.
2. **Scheduler adapter (E3).** `every(name, interval, effect)` runs a loop with **single flight** (skip a tick while the last one runs), tracks the fiber in a `FiberSet`, and interrupts all of them on stop. This replaces the `setInterval` plus "in-flight" boolean pattern. **No slice converts the heartbeat tick** until the flow watchdog's S1 (#113) has landed: #104, #75, #73, #108 and S1 touch `index.ts` (section 7.3).
3. **Shutdown adapter (E6).** `dispose(budgetMs)` disposes the runtime and returns when done or when the budget ends, whichever is first. It adds **one step** to a shutdown that already has a bound. It does not own the order, the signals or the budget. The server keeps its own `process.once("SIGTERM")`. `runMain` is not used (section 3). No such bounded shutdown exists yet (section 7.3), so E6 waits for it.
4. **Route adapter (the first route slice; not yet planned).** `handler(effect)` returns an Express handler with an `AbortSignal` that aborts when the request closes, and maps tagged errors to `HttpError` in one function. Express 5 already forwards a rejected promise, so plain handlers need no wrapper.

**The process must still exit.** Version 4 keeps the process alive from inside the runtime with a reference-counted timer that is not `unref`'d. Two tests guard this: E0b proves that the process exits at once with a created and idle runtime, and E3 proves it after a loop is stopped.

**Compatibility.** A converted service keeps its exported factory and its public types: methods still return `Promise<T>`, so no caller changes (also not a caller in a frozen file).

**Revert.** Each slice is one commit that touches its own files plus the edge module. Reverting it restores the plain code.

### 7.2 How the first slice is chosen

The criteria: **a leaf** (few callers), **not frozen** (its own file has no open pull request), **hand-written retry, timeout, cleanup or concurrency code that Effect replaces**, **on a path that B0 exercises**, and **a failure a test can show**. A facade keeps the callers unchanged, so a caller in a frozen file does not block a slice.

`server/src/database-retry.ts` meets all five.

- It has 86 lines. The retry loop is about 24 of them (lines 63 to 86). The rest are the transient-error predicates, which stay plain code.
- It has 3 importers: `services/dashboard.ts` (4 calls per dashboard request, lines 33, 47, 53 and 90), `services/issue-assignment-wakeup.ts:227` (wake delivery) and `middleware/auth.ts:565` (the cloud-tenant actor lookup only). `auth.ts:32-35` also re-exports it under the name `retryOnTransientDbConnectionError`, and the test `server/src/__tests__/cloud-tenant-transient-db-retry.test.ts` uses that alias and asserts exactly 3 calls. That test is the arm A baseline for R3, and E0a rewrites it for the new policy.
- No open pull request touches it, its importers or that test.
- The dashboard is on the read set of M1 (its success logs are silenced by policy, which suggests high traffic; B0 confirms this from request counts), so **E0b puts 4 fibers on every dashboard request**. This is the honest worst case for overhead. The dashboard also has at least three queries outside the retry (`agentRows`, the recursive run-activity query, the budget overview).
- Today the retry has 3 attempts with 50 and 100 ms sleeps. It has no jitter, no total budget, and a sleep that nothing can interrupt (`database-retry.ts:73-86`).

**A shared helper, not a domain service.** The request was one real service plus the edge runtime. A shared helper on the hot path gives a clearer measurement than a domain service off the B0 path (Q13).

**Two slices, so that each measurement is clean.** The new retry policy and the move to Effect are two changes. If they ship together, a gain in the fault run could come from the policy and not from Effect.

- **E0a, plain TypeScript, no install.** The policy: delays that start at 50 ms and double, with a random spread of about 20% either way, at most 5 retries (at most about 1.9 s of sleeping), the same transient-error predicates, and an optional `signal` parameter that stops the wait and rejects with the abort reason. No caller passes a signal yet, so the abort is exercised by unit tests only. A production gain needs callers that pass the request-close signal; that is a later slice. E0a can merge on its own if F1 improves.
- **E0b, Effect, needs the install.** The same policy, the same predicates and the same signature, written with `Effect.retry`, `Schedule.exponential`, `Schedule.jittered` and `Schedule.recurs`. Its base is the head of E0a. So Effect's own cost is the difference E0b minus E0a, and the policy's benefit is E0a minus `main`.

**The behavior change in an outage.** With 5 retries, one call can hold a request for about 2 s instead of about 150 ms. The first call that runs out of retries throws, so a dashboard request in a total outage fails after about 2 s plus the attempts. In a flapping outage the four wrapped calls could each wait. F1 measures it (Q3). There is no per-attempt timeout in E0a or E0b: the attempt is a promise that takes no signal, so a timeout would leave the query running while the next attempt starts, the hazard in 5.2. The bound uses `Schedule.recurs` and a delay cap, not `Schedule.upTo`, which checks its duration only between attempts and can overshoot.

### 7.3 The freeze list

**Rule.** Never convert a file while an open pull request changes it, or while a plan pull request reserves it. Refresh the list from the live pull request files before each slice. Use the REST API (`gh api repos/vllnt/paperclip/pulls/N/files`), because the GraphQL quota runs out. The check takes one call per open pull request.

**Snapshot.** 67 open pull requests when the plan was reviewed (66 when the list was first built; the new ones are docs only), `main` at `d9804ac4f`, 2026-10-10. Files are production code (tests excluded). The table lists 19 of the 116 production files that open pull requests touch. The full list is regenerated before each slice. Three shared files are touched by many pull requests and need a mechanical rebase instead of a freeze: `server/package.json` (#22, #41), `pnpm-lock.yaml` (#41, #42) and the `Dockerfile` (15 pull requests).

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
| A bounded shutdown (not in any pull request) | `index.ts` `shutdown`, `shutdown.ts`, `heartbeat.ts` `drainRunningRunsForShutdown`, `routes/health.ts`, `live-events-ws.ts`, the compose files | #103's pushed text (`b7841a81e`) has the slices D1 and D2 only. A draft with a bounded shutdown was reported by its owner but is not in the pull request. Until it is pushed, this plan reserves nothing for it, and E6 waits (Q16). **Ask the owner before E3 changes `live-events-ws.ts`:** a draft may close websockets there. |
| #113 slice S1 (flow watchdog) | `index.ts` (a scheduler step), the issue wake path, three new tables | It adds a step to the tick. The Effect scheduler adapter must not convert the tick before S1 lands. |
| Every other open `docs(plans)` pull request | Read its slice table when you refresh the list. | A plan reserves files before it has code. |

**Heartbeat and recovery slices are risky singles:** at most one per deploy window, never in the same window as another risky pull request, and never while a pull request in the table above is open on the same file.

### 7.4 The slices

All files below were free of open pull requests at the snapshot in section 7.3, except the three shared files named there, which need a mechanical rebase. Refresh the check before each slice. Sizes are changed lines of the named files unless marked "whole file"; the size of new code is an estimate. Slices E0a to E6 name about 18 of the 82 definitions counted in 5.1.

| Slice | Content | Files | Lane | Size | Replaces | The number to beat |
| --- | --- | --- | --- | --- | --- | --- |
| **B0** | Harness and report (section 4). No `server/src` change. | `tests/perf/backend/*` | Normal | about 8 new files | none | none: it sets the numbers |
| **E0a** | The new retry policy in plain TypeScript, with a `signal` parameter. | `server/src/database-retry.ts`, `server/src/middleware/auth.ts` (the re-export), `server/src/__tests__/cloud-tenant-transient-db-retry.test.ts` | Normal. No install. | about 40 changed lines plus tests | none (new policy) | F1: fewer failed requests than `main`, and recovery not longer. R3 passes. M1 dashboard p99 within +5% of `main` |
| **E0b** | The runtime (empty layer), `edge.facade`, the boundary gate, the guide, and `database-retry.ts` on Effect with the E0a policy. | `server/src/effect/*` (new), `server/src/database-retry.ts`, `server/package.json`, `pnpm-lock.yaml`, `Dockerfile` (one line in the `vitest run` list), `scripts/check-module-boundaries.mjs` and its CI step (Q9), `doc/effect-guide.md` | Normal. **Needs the online install**, pinned to 4.0.2 or later. | about 24 lines of loop replaced; about 300 to 500 lines new (estimate) | 1 retry loop and 1 uninterruptible sleep | **Gate 1:** E0b against E0a. Dashboard p99 +5% with 4 fibers per request, RSS +5%, CPU per request +5%, event-loop p99 +5% or +2 ms, startup +5% and +300 ms, `tsc` +10%, M12 within the limit, M13 reported. R2, R3, the `AsyncLocalStorage` test, the error identity test and the exit test hold |
| **E1** | `tool-discovery-scheduler.ts` as a `Semaphore` plus a bounded wait. **Behavior-preserving:** a started read keeps its slot until it settles. | `server/src/services/tool-discovery-scheduler.ts` | Normal | 54 lines (whole file) | 1 semaphore with a queue | Tool-listing p99 +5%; R2: a queued job leaves on abort, and a started job keeps its slot, as today |
| **E2** | The pino logger layer and the OpenTelemetry tracer layer (Q7), with the span allowlist and redaction (section 6). | `server/src/effect/{logger,tracer}.ts`, `doc/observability.md` | Normal | about 150 lines new | none (new capability) | Gate off: 0 spans exported and bounded overhead. Gate on: Effect spans appear under the HTTP server span. Same JSON keys as plain pino |
| **E3** | The scheduler adapter. Targets: the live-events ping interval and the missing `wss.close()` (`realtime/live-events-ws.ts`, a known leak), and `startPaperclipTempSweeper` (already correct; a parity check). The call site in `index.ts` does not change (the return shape `{ startup, stop }` stays). | `server/src/effect/edge.ts`, `server/src/realtime/live-events-ws.ts`, `server/src/services/paperclip-temp-sweeper.ts` | Normal | about 513 lines (whole files) | 2 intervals with in-flight flags | **Gate 2:** R5 goes from at least 1 leaked timer on the live-events server to 0, and the sweeper stays at 0. The exit test holds. Arm P (the same live-events fix in plain TypeScript) is reported |
| **E4** | A shared per-key mutex in `server/src/effect/`, replacing free copies: `agent-start-lock.ts`, `chat-sdk-runtime.ts:3181`, `native-runner-file-handoff.ts:96`. Behavior-preserving, including the 30 s stale rule. | those files | Normal | changed lines about 150 (estimate) | 3 of the 18 per-key chains | R2: a cancelled waiter leaves the queue. The `AsyncLocalStorage` test holds in `chat-sdk-runtime.ts`. No new wait |
| **E5** | Timeouts in free server files: `quota-windows.ts`, `plugin-environment-driver.ts`, `run-failure-report.ts`, and a timeout for `feedback-share-client.ts`. | those files | Normal | changed lines about 330 (estimate) | 2 wrappers, 1 uncleared timer, 1 call with no timeout | R5: 0 uncleared timers in the converted files |
| **E6** | The shutdown adapter and `Scope` for the teardown registries. **Only after a bounded shutdown has landed and the `index.ts` pull requests have landed.** | `index.ts`, `app.ts` shutdown, `shutdown.ts` | **Risky single** | to be sized then | up to 8 registries or sequences | **Gate 3:** R1 holds; M8 not worse than the bounded shutdown alone |
| **E7 onward** | Heartbeat and recovery: the run drain, the start lock call site, the heartbeat retry code. Only when the freeze rule allows it, and one per deploy window. | `heartbeat.ts`, `recovery/*` | **Risky singles** | each sized before its start | each named before its start | M2, M3 and M8 against the parent commit |

Files named only by a candidate list (E4, E5) are confirmed free again before the slice, and a file that an open pull request holds is dropped from that slice. `remote-http-endpoint-guard.ts` (#91) and `github-commit-details.ts` (#101) are already held.

## 8. Targets and the go/no-go

The thresholds are proposals, decided as written (Q3). They are written so that a reviewer can check them.

**Rule for every number.** The comparison is a slice against its **parent commit** (section 4.1, rule 2), on **one machine**, **interleaved** (parent, slice, parent, slice, and so on), at least **5 pairs** and at most 10. Report the median and the spread (minimum to maximum). A change counts only if it is larger than the threshold **and** larger than the spread of the parent runs. If the parent spread is larger than the threshold, the metric cannot decide at that threshold, and section 4.1 rule 10 applies: the metric moves to a quieter instrument, decided from the B0 data before the first slice. The result is never "pass" by default.

**Performance must not regress (slice against parent).**

| Metric | Threshold |
| --- | --- |
| M1 API latency p50 and p99, for the `dashboard` mix and the `mixed` mix | p50 up to +3%, p99 up to +5% |
| M1 throughput | down by at most 3% |
| M2 scheduler tick duration, median and p99 | up to +5% |
| M3 concurrent runs per process at the stated limit | not lower |
| M4 RSS and heap after the steady scenario | up to +5% |
| M5 CPU per request and per run | up to +5% |
| M6 event-loop lag p99 | up to +5% or +2 ms, whichever is larger |
| M7 startup (process start to ready) | up to +5% and +300 ms |
| M11 `tsc --noEmit` for the server (dev loop) | up to +10% |
| M12 install weight and image size | grows by no more than the unpacked size of the pinned `effect` (49.5 MB for 4.0.0); both numbers reported |
| M13 added time per facade call | 4 calls per dashboard request must add at most 1% of the dashboard p50 |

**Reliability must improve, or hold where the plain code is already correct.** Each test is written first, against the parent commit, so it has a recorded red or green result before the slice exists.

| Test | Applies to | Before (parent) | After (slice) |
| --- | --- | --- | --- |
| R1 Bounded shutdown: 30 runs in flight, stop with the deploy timeout. | E6, and a hold check in every slice | The result of a bounded shutdown in plain code. **No open pull request has one yet** (section 7.3). | Same result, same bound. Effect must not lengthen it. |
| R2 Cancellation frees resources: cancel at each await point, then count live timers, child processes, temporary directories and held locks. | E0a, E0b (the retry sleep), E1, E3, E4 | Recorded by a characterization test. The count may be above 0. | 0 at every cancel point. |
| R3 A retry respects its bound and an abort. Fake clock. (a) A failure that outlasts the policy ends after at most 5 retries and about 1.9 s of sleeping. (b) An abort during a sleep rejects within 10 ms with the abort reason, and no further attempt starts. | E0a, then a hold in E0b | (a) 3 attempts, about 150 ms. (b) Not expressible: the function takes no signal. | (a) as stated. (b) as stated. The existing test that asserts exactly 3 calls is rewritten for the new policy. |
| R4 Isolation: during F2 or F3, other requests keep their M1 latency. | Every slice | Scenario A without a fault is the reference. | Within the M1 threshold of that reference. (F1 hits every request, so R4 does not apply to it.) |
| R5 Timers: after `stop()` or shutdown, `process.getActiveResourcesInfo()` shows no timer that the converted code created. | E3, E5, E6 | Recorded. Known leaks: section 5.3. | 0. |
| F1 Database blip: 1 s of closed connections (see M9) during open-loop load on the dashboard. Count failed requests and the time until p99 recovers. | E0a against `main`; hold in E0b | Recorded. | Fewer failed requests than `main`; recovery not longer. |
| Context test: the `AsyncLocalStorage` store and the active OpenTelemetry span are the same inside and after a facade call. | E0b, E4 | Not applicable. | Same value. |
| Error identity test: the original error value reaches the caller. | E0b | The existing test asserts the message `Failed query`. | Same assertion. |
| Exit test: the process exits at once with a created and idle runtime. After `stop()` of a loop it also exits. | E0b, E3 | Not applicable. | Exit within 1 s. |

**Leaner (deletions).**

- In the converted files, lines after the slice are at most lines before it. E0a is exempt (it adds a parameter and a policy); E0b is judged against E0a.
- The report also gives the **cumulative** net lines, including `server/src/effect/`, the guide and tests.
- The slice deletes at least the helper definitions that it names in advance (section 7.4).
- It adds no dependency except the one pinned `effect` version.

**Evidence standard.** A slice that claims only consistency (one tool instead of several) is judged on "not worse". A slice that claims a **reliability gain** is also measured against a **plain-fix arm** (arm P): the same defect fixed in plain TypeScript on a throwaway branch. The report says whether Effect added anything the plain fix did not. Gates 2 and 3 decide "not worse, and the defect is removed". They do not decide "better than plain". Q15 asks whether that is enough.

**Decision: three checkpoints, because no single slice proves everything.**

| Checkpoint | When | What it can decide |
| --- | --- | --- |
| **Gate 1** | After E0b | **Cost and footprint.** Every performance row holds for E0b against E0a, and R2, R3, the context test, the error identity test and the exit test hold. This does **not** prove that Effect improves reliability. The policy benefit (F1) belongs to E0a against `main`, and E0a can merge before any install. |
| **Gate 2** | After E3 | **Reliability value, first real case.** R5 goes from at least 1 leaked timer to 0 on the live-events server, the sweeper stays at 0, the exit test holds, and no performance row regresses. Arm P is reported. |
| **Gate 3** | After E6, with a bounded shutdown landed | **Shutdown.** R1 holds with Effect in the path, and M8 (runs lost) is not worse than the bounded shutdown alone. |

- **Go** at a gate only if every row listed for it holds.
- **No-go** if a performance row fails by more than its spread, or a row listed for the gate does not hold. Revert the slice (one commit). The plan closes, or the maintainers override with a written reason. The B0 harness and report stay (Q12).
- **Re-run Gate 1** on any bump of the pinned Effect version, because patch releases have changed `Effect.retry`, `ManagedRuntime` and `Queue` behavior (section 3).
- **Inconclusive** is not a go. Repeat in a quiet window, up to 10 pairs, then the maintainers decide.

## 9. Coding guide (how Effect code is written here)

Where it goes: this section moves to `doc/effect-guide.md` in slice E0b. Effect code lives under `server/src/effect/` (the runtime, the pino logger, the tracer, the error mapper) and inside the service that a slice converts.

1. **A positive list of modules, imported by subpath.** Allowed: `effect/Effect`, `effect/Layer`, `effect/Context`, `effect/Scope`, `effect/Schedule`, `effect/Semaphore`, `effect/Duration`, `effect/Exit`, `effect/Cause`, `effect/Fiber`, `effect/FiberSet`, `effect/FiberMap`, `effect/Deferred`, `effect/Queue` and `effect/ManagedRuntime`. Any other module needs an amendment to this plan, because the package has about 138 top-level modules and some are tagged unstable or experimental (for example `Arbitrary`). **Never** `Schema` (either path), **never** `from "effect"` (the barrel loads every module), **never** a subdirectory (`effect/http`, `effect/sql`, `effect/socket`, `effect/process`, `effect/observability`, `effect/workflow`, `effect/rpc`, `effect/cluster`, `effect/ai`, `effect/cli`, `effect/persistence`, `effect/reactivity`, `effect/workers`, `effect/devtools`, `effect/eventlog`, `effect/jsonschema`), and **never** an `@effect/*` package.
2. **Where Effect may be imported.** Only in `server/src/effect/` and in files that a slice converts. **Never** in `packages/shared`, `packages/db`, `cli`, `ui`, plugin code, or `server/src/modules/*/domain` (the domain layer is pure).
3. **Services.** Use `Context.Service` (v4 replaces `Context.Tag`). One service per existing `xService(db)` factory that a slice converts. The factory stays exported and returns the same object, so callers do not change.
4. **Layers.** A layer builds a service once. `ManagedRuntime.make(layer)` holds the layers for the life of the process. A test builds a small test layer. No global singletons.
5. **Edge only.** `runFork`, `runPromise` and `runSync` are called **only** in `server/src/effect/edge.ts` (the facade, the scheduler adapter, the shutdown adapter and the route adapter). Services never call them.
6. **Cancellation.** Pass the request or run `AbortSignal` to the edge with the run options. Use `Effect.tryPromise((signal) => ...)` and pass `signal` to `fetch`, `undici`, child-process helpers and any other call that accepts one.
7. **Errors.** Use tagged error classes inside converted code. Map them to `HttpError` in one function at the edge. The facade rethrows the original error value: use `Effect.tryPromise({ try, catch: (error) => error })`. Do not `throw` inside an Effect. Use `Effect.die` only for bugs.
8. **Retry and time.** Use one `Schedule` per policy, with `jittered`, `recurs` and a cap on any delay. `Schedule.upTo` checks its duration only between attempts and can overshoot. Add a per-attempt timeout only for an attempt that takes a signal. Without a signal the query keeps running while the next attempt starts (the hazard in 5.2).
9. **Concurrency.** Use `Semaphore` or the `concurrency` option. Do not write a new `Map<string, Promise>` lock.
10. **Cleanup.** Put release code in a `Scope` finalizer, not in a hand-written `try`/`finally` chain, when the resource crosses an `await` that can be cancelled. Check in the spike whether `acquireRelease` runs its acquire step uninterruptibly.
11. **Config.** Read `process.env` only in the existing config layer. A layer receives a typed value.
12. **Logging and tracing.** Use the pino-backed logger and the OpenTelemetry-backed tracer from `server/src/effect/`. Do not create a logger or a tracer elsewhere.
13. **Names and spans.** Use `Effect.fnUntraced` by default, so an effect makes no span and the gate-off case costs nothing. Use `Effect.fn` only where a span is wanted and its name and attributes are in the allowlist (section 6). Confirm both names in the spike.
14. **Tests.** Use plain `vitest`. Build a `ManagedRuntime` from a test layer and dispose it in `afterEach`. Pure Effect unit tests may join the `Dockerfile` `vitest run` list. Embedded-Postgres suites cannot. The spike decides whether `effect/testing`'s `TestClock` fits the fake-clock tests next to vitest's fake timers.
15. **Enforcement.** Extend `scripts/check-module-boundaries.mjs` (it already extracts imports, and today scans only `server/src`) with new scan roots and rules 1 and 2, and add it to a CI step in slice E0b. Rules 5 to 8 are enforced by review. No new linter.

## 10. Risks

| Risk | Mitigation |
| --- | --- |
| An unstable API changes in a minor release. | A positive module list, an exact version pin, and a gate on imports (section 9). Re-run Gate 1 on any version bump. |
| Patch releases change behavior that the plan uses (`Effect.retry`, `ManagedRuntime` disposal, `Queue`, `AsyncLocalStorage`). | Pin 4.0.2 or later (section 3). The context test and the exit test guard the two that touch this server. |
| The v4 keep-alive timer is not `unref`'d, so a stopped loop or an idle runtime could hold the process open. | The exit test in E0b and E3. |
| `AsyncLocalStorage` and the OpenTelemetry context are lost across a fiber. | The facade keeps the caller's context. The context test in E0b and E4. |
| The facade changes the error a caller sees. | The facade rethrows the original value. The error identity test and the existing retry test. |
| The new retry policy holds a request longer in an outage and amplifies load on a database that is down. | F1 measures it. The policy values are proposals (Q3). A shorter budget or a circuit breaker is the fallback. |
| Type-check time grows. Effect types are heavy, and the server already has a large type graph. | M11 is a gate row. |
| Fibers add memory or CPU per request or per run. | M4, M5 and M13 are gate rows. The measurement uses the real endpoints and a micro-benchmark. |
| Stack traces get worse. | Name effects (rule 13). Compare one real failure before and after. |
| A conversion changes behavior in a hot path, or breaks a deliberate non-cancel. | Section 5.2 lists the cases. Characterization tests first. One revertible commit per slice. |
| Two styles live in the code for a long time. | The guide (section 9), the boundary gate, a deletion target per slice, and the cumulative net line count. |
| Merge conflicts with open pull requests, and with upstream merges. `VLLNT.md` says the fork merges upstream regularly. | The freeze list (section 7.3). Prefer files that upstream rarely changes. Refresh before each slice. |
| The measurement is noisy on a shared host. | The rules in 4.1 and section 8: interleave, repeat, report the spread, pre-register what each instrument can detect. |
| The in-scope share of the 82 definitions is smaller than the headline. | The B0 report counts again for `server/src`. The slices name what they replace. |

## 11. The pull request sequence

| Step | Pull request | Content | Needs |
| --- | --- | --- | --- |
| 1 | **This plan** | Docs only. | Plan review. |
| 2 | **B0 harness** | `tests/perf/backend/` and the B0 numbers in its body. No `server/src` change. | #50 is a dependency (the fixture script is read from its pinned head, with no copy). The harness has run on the shared host. |
| 3 | **A bounded shutdown** (not this plan) | Plain TypeScript. **No pull request has it today** (Q16). | An owner. |
| 4 | **E0a** | The retry policy in plain TypeScript, with its tests. | No install. |
| 5 | **E0b** | The smallest edge: an empty-layer runtime, `edge.facade`, the boundary gate, the guide, and `database-retry.ts` on Effect. | A separate go for the **online install** of `effect`, pinned to one exact version, 4.0.2 or later (installable from 2026-10-14). |
| 6 | **Gate 1 report** | E0b against E0a, in the format of section 8. | Quiet-window measurement. |
| 7 onward | E1 to E6, one pull request each, in the order of section 7.4. Gate 2 follows E3 and Gate 3 follows E6. Heartbeat and recovery singles come last. | Each with its before-and-after row. | The freeze list refreshed first. |

Every pull request after this one follows `.github/PULL_REQUEST_TEMPLATE.md` in full, including the model line. The E0a and E0b pull requests state the change in outage latency (section 7.2), because it reaches the cloud-tenant actor lookup and the wake path.

## 12. Open questions, each with a recommendation

| Id | Question | Recommendation |
| --- | --- | --- |
| **Q1** | **Scope: does "backend should Effect everywhere" mean (A) Effect as the control-flow layer under the existing libraries, or (B) also Effect's own `http`, `sql` and `schema` in place of Express, drizzle and zod?** | **Decided: A** (2026-10-10). Effect runs the server logic. Express, drizzle, pino, ws and zod stay at the edges. **B is considered and not chosen:** it means unstable APIs in the hot path, a second validator for the shared contract, and a rewrite with no measured gain. Re-check B when a module turns stable, as its own measured slice with its own plan. |
| **Q2** | Which version to pin? Today only `4.0.0` can be installed. `4.0.1` can be installed from about 2026-10-12 and `4.0.2` (`latest`) from 2026-10-14. | **Decided as recommended:** on the day the install is approved, pin the newest version past the cooldown, exact, no `^`, the same version for every Effect package, never overriding the cooldown. **A refinement for the maintainers to confirm:** that day should be 2026-10-14 or later, and E0b should not be built or measured on 4.0.0 or 4.0.1, because 4.0.1 and 4.0.2 fix `AsyncLocalStorage` handling (#8629), `Effect.retry` on defects and interruptions (#8799), a `ManagedRuntime` disposal deadlock (#8783) and `Queue` message loss on interrupt (#8819). |
| **Q3** | Are the thresholds in section 8 right, and is the E0a retry policy right (delays from 50 ms, at most 5 retries, about 1.9 s of sleeping)? | **Decided as recommended** (2026-10-10): use the thresholds as written and tighten them once B0 shows the spread. The review added a rule so that this cannot deadlock a gate: section 4.1 rule 10 sets, from the B0 data, what each instrument can detect, and moves a metric to a quieter instrument when its spread is larger than its threshold. Keep the policy as the proposal and let F1 show the cost. If F1 shows load amplification, shorten the budget to 1 s. |
| **Q4** | Where to measure? | The shared host, with the load gate in section 4.1, for B0 and for every slice. Never a laptop. |
| **Q5** | M2 (true tick time) needs a three-line log in `index.ts`. That file is on the freeze list. | Take the proxy (wake-to-start latency) in B0 now. Land the log line as one small plain-TypeScript pull request after #104, #73, #75 and #108 merge, then re-take only M2. |
| **Q6** | The fixture script is only on #50's branch. | **Decided.** Do not wait for #50 to land. B0 reads the script from #50's pinned head with `git show` and commits no copy. The plan lists #50 as a dependency of the harness pull request. The code pull requests use the landed file. |
| **Q7** | Tracing: a thin `Tracer` over `@opentelemetry/api`, or `@effect/opentelemetry`? | The thin tracer. `@effect/opentelemetry` is an unstable package with ten peer dependencies (eight of them optional). E0b ships no tracer. The OpenTelemetry bridge is slice E2, with the tests and the span allowlist in section 6. |
| **Q8** | Which tests gate in CI? CI runs only the `vitest run` list in the `Dockerfile`. | Append the pure unit tests of the edge module (no Postgres). Embedded-Postgres suites cannot go on that line. The B0 harness never gates. The `Dockerfile` is touched by 15 open pull requests, so the edit is one line and a mechanical rebase. |
| **Q9** | Where does `check:module-boundaries` run? A search of `.github`, `Dockerfile` and the root `package.json` found no other reference. It scans only `server/src`. | Run it on `main` first and confirm it passes. Then wire it into one existing required job in E0b, with new scan roots. This is a CI change, so it needs the landing reviewer. |
| **Q10** | Do plugins get Effect? | No. Plugin worker code and `plugin-sdk` stay as they are. Effect is a server-internal tool in this plan. |
| **Q11** | When does a replaced helper go? | In the same pull request that moves its last caller, or the next one. Never keep both for more than one slice. |
| **Q12** | If the verdict is no-go, what stays? | Revert the slices, **keep the B0 harness and the B0 report**. The harness is useful without Effect. |
| **Q13** | Is a shared helper (`database-retry.ts`) acceptable as the "one real service" of the first slice, split into E0a (plain) and E0b (Effect)? | Yes. It sits on the dashboard read path (4 calls per request), it is the target of fault run F1, and it has no open pull request. The split makes E0a a real plain-TypeScript control and keeps the install out of the first merge. A domain service off the B0 path would give a weaker measurement. |
| **Q14** | The request was one go/no-go after the first slice. This plan uses three checkpoints (after E0b, E3 and E6). Is that acceptable? | **Decided as recommended** (2026-10-10). Yes. E0b can judge **cost** (speed, memory, footprint) but cannot prove **reliability value**, because the policy gain belongs to E0a. Gate 2 (a real defect removed) and Gate 3 (shutdown, once a bounded shutdown exists) can. A single early gate would approve on cost alone or reject for a reason E0b cannot show. |
| **Q15** | What is the evidence standard? The user asked for Effect. A plain-TypeScript fix closes most of the gaps in 5.3 as well (5.4). | Accept "not worse, and the defect is removed" for Gates 2 and 3, and report arm P so the maintainers can see where the plain fix is as good. Do not claim that Effect beats plain TypeScript unless arm P shows it. |
| **Q16** | Who owns the bounded shutdown? #103's pushed text (`b7841a81e`) has the slices D1 and D2 only. A draft with a bounded shutdown was reported but is not in the pull request. | The owner pushes it into #103, or opens its own pull request. If neither happens, this plan adds the bound as a plain-TypeScript slice before E6. Until then E6 and Gate 3 have no prerequisite and do not start. |

## Appendix A. How the counts were made

Counts come from `git grep -E` at `d9804ac4f`, non-test files, and a reviewer re-ran most of them. The lists of named definitions (19 retry, 17 timeout, 21 sleep, 18 per-key, 5 pools, 3 maps, 8 cleanup) are lists of anchors that were read, not regex counts.

- Effect imports: `from ['"](effect|@effect/)` over `server/src packages cli ui`: 0.
- Domain errors: `throw (badRequest|unauthorized|forbidden|notFound|conflict|unprocessable|tooManyRequests|payloadTooLarge)\(` (3,349) and `throw new Error\(` (1,521), in `server/src/routes` and `server/src/services`.
- Transactions: `\.transaction\(` in `server/src` (608 calls in 140 files). Own alias: `type (DbTransaction|DbOrTransaction|Tx|DbTx) = ` finds 26; a looser form finds about 30.
- Environment: `process\.env` outside `config.ts` and `config-file.ts` in `server/src` (348 in 113 files).
- Wiring: `export function [a-zA-Z]+Service\(` in `server/src/services` (111); `\b[a-zA-Z]+Routes\(` in `app.ts` (69); `router\.(get|post|put|patch|delete)\(` in `server/src/routes` (903); `vi\.mock\(` in server tests (458 in 181 files).
- Module state in `services/`: `^(export )?const X = new (Map|Set)(<|\()` (207), the weak forms (18), and `^(export )?let X` (43).
- Timeouts: `Promise\.race\(` (102), `AbortSignal\.timeout\(` (81), `setTimeout\(\s*\(\)\s*=>\s*\w*[cC]ontroller\.abort\(` (19). Of the 102 races, 80 have a `setTimeout` within -30/+12 lines (heuristic), and 28 of those have no `clearTimeout` in that window.
- Inline sleeps: `new Promise(<[^>]*>)?\(\s*\(?\s*(resolve|res|r|done|resolveWait)\s*\)?\s*=>\s*\{?\s*setTimeout` finds 74 lines; 12 are inside the helper bodies, so 62 are inline.
- Timed retries: a `for` loop over `attempt|retry|tries|index|i` with a bound named `max|retries|attempts|delays|backoff` finds 43 loops, 10 of them with a wait within 45 lines; `setTimeout\([^;]*\b(attempt|attempts|retry|retries|retryCount|backoff\w*|failures|consecutive\w*|delays?\[\w+\])\b` finds 24 lines in 20 files. The union is 29 sites. Both regexes miss some forms (six are known).
- Locks: `pg_advisory_xact_lock` and `pg_try_advisory_xact_lock` (58 lines in the two forms) and `.for("update"` (447).
- `AbortSignal` references: 257 in 111 files; `fetch(` with no `signal` or timeout within 14 lines: 38 of 96 (heuristic).
- Open pull request files: `gh api repos/vllnt/paperclip/pulls?state=open` and `pulls/N/files` (REST), production files only.
