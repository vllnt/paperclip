# Platform migration: Next.js, Turborepo and a Convex backend, one domain at a time

Date: 2026-10-21
Status: Plan only (docs). No code and no install. Step 1 (the early verdict, section 1) went to the maintainers on 2026-10-21 at about 13:40 UTC. This document is step 2.
Anchors: `origin/main` `9d0c732c2`. Every repository fact cites `path:line` at that commit.
Labels:

- **[R]** a repository fact at `9d0c732c2`;
- **[S]** a primary outside source, listed in appendix A with its version or its fetch date (2026-10-21);
- **[O]** an operator measurement or decision given to this plan, not in the repository;
- **[A]** an assumption or an estimate that a named slice measures.

## 0. Summary

- **Request (maintainer, 2026-10-21):** "migrate to nextjs, turborepo, convex (backend) fully, leverage @vllnt/* packages i own". Earlier the same day: "the nextjs migration done asap".
- **Answer.** It is possible as a strangler, one domain at a time, in about 5 to 9 months [A] (section 8.9). Convex becomes the system of record for data. A Node service stays for the work that Convex cannot run: agent processes, SSH, sandboxes, runner websockets, plugins, MCP, and the REST layer that agents and the CLI use.
- **Agents see no change.** The REST paths, the OpenAPI document, the CLI's commands, the runner API, the bridge allowlist and the skills stay the same. The REST layer becomes a façade over Convex, and it stays after the migration (section 6).
- **Order:**
  1. Turborepo T0 now, and the Next.js lane as it is planned (M0 to MF).
  2. A Convex spike and a rehearsal of the whole data lifecycle (C0), then a go/no-go gate (G1).
  3. The foundation (C1).
  4. Peripheral domains, in waves that the coupling graph confirms.
  5. The heartbeat split into modules, on Postgres.
  6. The **core wave**: every table behind a control-plane invariant, and every parent that those tables reference with a blocking foreign key, moves together (issues, runs, agents, budgets, costs, approvals, projects, goals, the company row). It has its own rehearsal first.
  7. Chat channels and plugins late, then Postgres retired, apart from what section 10 keeps.
- **Kill criteria** can stop the Convex program at G1 or at any later gate (section 9). The fallback is the Postgres path with the parked Effect plan.
- **Costs to accept:**
  - cheap upstream syncs end for good (section 5.7);
  - the plugin SQL contract needs a Postgres for plugins, or a replacement (section 6.6);
  - every install needs a Convex backend next to the server, under a license that needs a legal review (section 4.10);
  - search changes from trigram matching to token search (section 4.8);
  - for months, two stores run side by side, with a fence, a capture and a mirror between them (section 7).
- **User decisions:** section 10, each with a recommendation.

## 1. Step 1: the early verdict

| Question | Verdict | Why |
|---|---|---|
| Does Next.js M0 fit the target? M0 runs Next.js as a second process, and every page reads through the REST API | **Yes. Keep M0 to M1 as planned.** Two rules for M0b, at no extra cost: (a) pages read and write only through the `ui/src/api/*` modules and `queryKeys`, so that a domain can later swap its hooks to Convex without page changes; (b) the Next.js server entry imports nothing from `server/src`, so that it can later run as its own app. Do not adopt Convex's Next.js server rendering helpers now | REST stays the agent and CLI contract (section 6), so a Next.js app on REST is not throwaway work. On `main`, the second process is the fallback of `doc/plans/2026-10-10-web-app-nextjs-migration.md:94`. The Next.js lane made it the design on 2026-10-21 [O], in a plan update that is not on `main` yet. Convex marks its Next.js server rendering support as beta [S] |
| Should the Effect 4 backend lane stop or change? | **Stop E0b and every later slice.** Keep the plain TypeScript work that protects production until cutover: the fault harness (#319), E0a (the retry budget), and the retry predicate fix. Effect stays a candidate only for the long-lived Node runtime tier, and that choice waits for G1 | The Effect plan puts an Effect runtime under the Express and drizzle service layer (`doc/plans/2026-10-10-backend-effect.md:10-14`). Convex replaces that layer. If G1 kills Convex, the Effect plan reopens unchanged |
| Should feature sessions keep adding Drizzle tables? | **Yes, with the Convex-ready rules of section 7.1.** Each new domain is a module with `domain/`, `application/` and `adapters/` layers (`server/src/modules/README.md:3-31`, enforced by `pnpm check:module-boundaries`, `package.json:48`). Then the move replaces only `adapters/` | Convex is months away. Blocking new features until then would stop product work |
| Can Turborepo land early, independently and cheaply? | **Yes. T0 is one small PR** (section 8.0) | No task graph exists today. The root runs `pnpm -r build` (`package.json:19`), and no `turbo.json` exists at the root |

## 2. What exists today

All rows are [R] at `9d0c732c2`, except rows marked [O].

| Area | Fact | Anchor |
|---|---|---|
| Workspace | pnpm 9.15.4 workspaces: `packages/*`, `packages/adapters/*`, `packages/plugins/*`, `packages/plugins/examples/*`, `server`, `ui`, `cli` | `pnpm-workspace.yaml:1-14`, `package.json:112` |
| Task graph | None. `build` is `pnpm -r build` and `typecheck` is `pnpm -r typecheck`. No `turbo.json` exists at the root | `package.json:19, 21` |
| Image build | A hand-ordered chain of filtered builds: the plugin SDK, the UI, the bundled plugins, the server, with test steps between them | `Dockerfile:148, 168, 174-186, 194` |
| CI | Unit tests run in 9 matrix lanes with a full install each. They do not block a merge yet (`continue-on-error`) | `.github/workflows/unit-tests.yml:3-10, 35-54` |
| CI | Every pull request builds the production image target | `.github/workflows/image-build-check.yml:42` |
| CI | `doc/` changes run the full gate. Only `docs/` and `screenshots/` are skipped | `scripts/ci/classify-changes.mjs:12-13` |
| Server | Express 5, drizzle-orm 0.45, ws 8, better-auth 1.7.2 | `server/package.json:81, 87, 89, 105` |
| Server size | About 410,000 lines of non-test code in `server/src/services` (`find … \| wc -l`). Only 3 feature modules use the module layers: `active-run-watchdog`, `run-dispatch`, `wake-queue` | `server/src/modules/` |
| UI | React 19.2, React Router 7.18, Vite 8, TanStack Query 5, Tailwind 4.3. Components follow shadcn "new-york". 363 files in `ui/src/pages` (215 non-test) | `ui/package.json:54, 66, 71, 88, 90`; `ui/components.json:3` |
| Orchestration | `server/src/services/heartbeat.ts` has 34,886 lines. `heartbeatService` starts at `:10212` and `appendRunEvent` at `:14965` | `wc -l`; the two lines |
| Chat channels | `server/src/services/chat-channels.ts` has 38,507 lines | `wc -l` |
| Boot loops | In-process intervals: execution reconciliation, run usage records, heartbeat scheduler | `server/src/index.ts:1194, 1212, 1226` |
| Plugin jobs | An in-process plugin job scheduler | `server/src/app.ts:849` |
| Websockets | Three upgrade handlers on one HTTP server: remote runners (`/api/runner/v1/connect/*`), the setup terminal, live events | `server/src/index.ts:935, 970-974`; `server/src/realtime/runner-prp-ws.ts:16` |
| Live events | One in-process `EventEmitter`, so fan-out works only inside one process. 31 non-test publish calls | `server/src/services/live-events.ts:7, 28, 48` |
| Activity log | `logActivity` writes the row, emits a plugin event-bus event and publishes a live event | `server/src/services/activity-log.ts:7, 46-47, 152, 217` |
| Remote execution | SSH transport and sandbox providers (Daytona, E2B, Modal, Kubernetes and others) | `packages/adapter-utils/src/execution-target.ts:1377`; `packages/adapter-utils/src/ssh.ts:64`; `packages/plugins/sandbox-providers/` |
| Schema | 152 schema files, 239 `pgTable(` calls, 257 `jsonb(` columns, 5 `nullsNotDistinct` uniques, 316 SQL migrations | `packages/db/src/schema/`; `packages/db/src/migrations/`; for example `summary_slots.ts:31` |
| Row locks | 478 lines with `FOR UPDATE`, `.for("update")` or `SKIP LOCKED` in 100 non-test files | for example `server/src/modules/run-dispatch/adapters/postgres.ts:219, 231` |
| Invariant locks | The checkout release locks the issue row and its run row in one transaction. The budget hard stop pauses the agent or the company in the same flow | `server/src/services/issues.ts:7779-7795`; `server/src/services/budgets.ts:218, 242` |
| Advisory locks | 68 non-test lines with `pg_advisory*`, 13 of them `pg_try_advisory_xact_lock` single-flight guards. One holds a lock on a dedicated connection across I/O | `server/src/routes/cases.ts:75`; `server/src/services/paperclip-temp-sweeper.ts:104`; `server/src/services/run-usage-records.ts:390`; `server/src/services/native-runtime/native-workspace-finalization-ownership.ts:67-68` |
| Transactions and SQL | 634 `.transaction(` lines and about 1,600 lines with raw `` sql` `` fragments in non-test `server/src` | grep counts |
| Counters | The issue counter on the company row, raised with `max(issue_number)` inside the issue insert | `packages/db/src/schema/companies.ts:14`; `server/src/services/issues.ts:10310-10321` |
| Search | Trigram GIN indexes on issue titles, identifiers and descriptions, on comment bodies, on cases, and on documents. A relevance rubric that accepts ID forms such as `PAP-42`, `pap42` and `PAP 42` | `packages/db/src/schema/issues.ts:143-145`, `issue_comments.ts:63`, `cases.ts:51-53`; `packages/db/src/migrations/0079_company_search_document_indexes.sql`; `doc/SEARCH.md:1-12` |
| Auth | better-auth with the drizzle adapter. Agent API keys are stored as SHA-256 hashes and looked up by hash. Board API keys have their own table | `server/src/auth/better-auth.ts:264, 312`; `packages/db/src/schema/agent_api_keys.ts:7, 21`; `server/src/middleware/auth.ts:71`; `packages/db/src/schema/board_api_keys.ts:4` |
| Company scope | `assertCompanyAccess`, with 287 calls in `server/src/routes` | `server/src/routes/authz.ts:75` |
| Response redaction | REST answers pass through redaction before they leave the server: agent rows, approval payloads, secret-like config keys, event payloads | `server/src/routes/agents.ts:3367`; `server/src/routes/approvals.ts:27`; `server/src/routes/environments.ts:86`; `server/src/redaction.ts:953` |
| Files | Storage providers for local disk and S3 | `server/src/storage/provider-registry.ts:6`; `server/src/storage/s3-provider.ts:84` |
| REST contract | 952 route handler lines (`router.get(` and the other methods, non-test). The OpenAPI document is defined in one file of 12,847 lines | grep count in `server/src/routes/`; `wc -l server/src/routes/openapi.ts` |
| CLI | `paperclipai` 0.3.1 calls REST through one HTTP client. Some commands open the database directly: routines, the first-admin bootstrap, onboarding, worktrees, and a database check | `cli/package.json:2-3`; `cli/src/client/http.ts:53, 166`; `cli/src/commands/routines.ts:202`; `cli/src/commands/auth-bootstrap-ceo.ts:82`; `cli/src/commands/onboard.ts:590`; `cli/src/commands/worktree.ts`; `cli/src/checks/database-check.ts` |
| Bridge | The sandbox callback bridge allowlist, synced with the skill. Its body limit is about 10 MiB | `packages/adapter-utils/src/sandbox-callback-bridge.ts:73, 165-170` |
| Skills | The skill calls REST paths, for example `GET /api/agents/me` | `skills/paperclip/SKILL.md:96` |
| Plugin SQL | Plugins get a SQL client for their own Postgres namespace, with read-only joins to 13 core tables (companies, projects, goals, agents, issues, issue documents, issue relations, issue comments, heartbeat runs, cost events, approvals, issue approvals, budget incidents). The wiki plugin uses it | `packages/plugins/sdk/src/types.ts:629-637`; `packages/db/src/schema/plugin_database.ts:16-22`; `packages/shared/src/constants.ts:1490-1504`; `packages/plugins/plugin-llm-wiki/src/wiki/core.ts:940` |
| Module seam | Feature modules with `domain`, `application` and `adapters` layers. A checker bans drizzle and Postgres imports outside `adapters/` | `server/src/modules/README.md:3-31`; `scripts/check-module-boundaries.mjs:11` |
| Company removal | One service removes a company and its rows | `server/src/services/companies.ts:629` |
| Install | Paperclip installs with `npx paperclipai onboard` and starts an embedded PostgreSQL when `DATABASE_URL` is unset | `README.md:355`; `doc/DATABASE.md:5-21` |
| Build contract | V1 names PostgreSQL through Drizzle as the store, with a single-tenant deployment and a multi-company data model | `doc/SPEC-implementation.md:36, 62, 107-110` |
| Fork | The fork tracks upstream `master`. Upstream publishing workflows are off on this fork | `VLLNT.md:3-8` |
| Convex today | A plugin manages a company's Convex Cloud deployments. A Convex team has a deployment quota (300) | `doc/convex-plugin.md:3-6`; `packages/plugins/plugin-convex/package.json:2` |
| Deploy | The app runs with a read-only root file system, `--max-old-space-size=1536` and a 2 GB memory limit in the compose file. Postgres 17 runs in a second service with 1 GB | `deploy/compose.yaml:9, 28, 38, 53, 60, 70` |
| Production [O] | The production container runs with a larger limit than the compose default and uses about 1.9 GB resident at steady state. The database dump is about 1.9 GB. More than one live company shares the instance. A release drain holds runs for about a minute | operator figures of 2026-10-21 |

## 3. Outside facts this plan relies on

All rows are [S]. Appendix A gives the URLs. Versions come from the npm registry on 2026-10-21.

| Topic | Fact |
|---|---|
| Versions | `convex` 1.47.0 (2026-10-15). `turbo` 2.11.10 (2026-10-20). `next` 16.4.2 (2026-10-15). `better-auth` 1.7.12 (2026-10-20). `@convex-dev/better-auth` 0.12.5 (2026-06-27). `convex-test` 0.0.63. The self-hosted backend's latest release is `precompiled-2026-10-10-72ce13c` |
| Function time | Queries and mutations: 1 s of user code (database time excluded). Convex-runtime actions: 30 min on the limits page, 10 min on the actions page (the two pages disagree). Node actions: 10 min |
| Memory and arguments | Actions: 64 MiB (Convex runtime) and 512 MiB (Node). Arguments up to 16 MiB, Node actions 5 MiB. Return values 16 MiB |
| Documents | 1 MiB per document. 1,024 fields. Nesting depth 16. 8,192 array elements |
| Per transaction | 16 MiB read, 32,000 documents scanned ("documents not returned due to a `filter` count as scanned"), 4,096 index ranges, 16 MiB written, 16,000 documents written |
| Indexes and tables | 32 indexes per table, 16 fields per index, 10,000 tables per deployment |
| Scheduling | A mutation can schedule 1,000 functions. A scheduled mutation runs exactly once; a scheduled action runs at most once. Auth does not pass to the scheduled function |
| Concurrency | Cloud deployment classes. S16: 16 queries, 16 mutations, 64 actions at once, 4 MiB/s of mutation writes. S256 (Pro): 256, 256, 512, 8 MiB/s. Self-hosted backends set concurrency with `APPLICATION_MAX_CONCURRENT_*` variables instead of a class |
| Transactions | Mutations are serializable through optimistic concurrency control. A write conflict is retried inside Convex several times. The error docs advise selective indexed reads and few writes to one document |
| Determinism | Mutations "must be deterministic, and cannot call third party APIs". Node is for actions only |
| HTTP actions | Served on `<deployment>.convex.site`, or on a custom domain on Pro. Responses up to 100 MiB; multipart bodies up to 20 MiB; 64 MiB of memory. CORS is manual |
| Clients | `ConvexHttpClient` is stateful and must not be shared across server requests. `ConvexClient` subscribes over a websocket. `setAdminAuth` is internal, not a public API. Internal functions "can only be called by other functions and cannot be called directly from a Convex client"; the dashboard and the CLI can also run them |
| Auth | Custom JWT providers ("Only RS256 and ES256 are currently supported"; fields `issuer`, `jwks`, `algorithm`, `applicationID`) and OIDC through `auth.config.ts`. `applicationID` is checked against the `aud` claim. The docs warn that "omitting `applicationID` is often insecure": without it, a token minted for another service can be reused. A function's identity "is guaranteed to have `tokenIdentifier`, `subject` and `issuer` fields"; nested custom-JWT claims are read with dotted names such as `identity["properties.email"]`. The docs do not say that `aud` is readable in a function. Convex Auth is beta. `@convex-dev/better-auth` 0.12.5 needs `better-auth >=1.6.11 <1.7.0`. Its supported plugin list names neither the organization plugin nor the API key plugin |
| Search | One search field per index and up to 16 filter fields. BM25 ranking. Only the last term matches by prefix. No typo tolerance. At most 1,024 results scanned. Vector search runs in actions only |
| Files | Upload URLs expire after 1 hour. A file URL lets anyone with it read the file, and only deleting the file revokes it. An R2 component exists |
| Self-hosting | License FSL-1.1 with Apache-2.0 as the future license (`LICENSE.md`). "A Permitted Purpose is any purpose other than a Competing Use." A Competing Use "means making the Software available to others in a commercial product or service" that (1) "substitutes for the Software", (2) substitutes for another product or service that Convex offers using the Software "that exists as of the date we make the Software available", or (3) "offers the same or substantially similar functionality as the Software". "Permitted Purposes specifically include using the Software: 1. for your internal use and access". Each version becomes Apache-2.0 "on the second anniversary" of its release (`LICENSE.md` at `95d8719cb693`). Storage: SQLite by default, or Postgres 17 or MySQL 8, close to the backend. "All the free-tier features" of Cloud. Ports: 3210 (API), 3211 (HTTP actions), 6791 (dashboard). An admin key controls the deployment. Upgrades go by export and import. No HA or scheduled backup procedure is documented. A usage beacon (a random id and the backend version) is sent unless `DISABLE_BEACON=true` |
| Local deployments | `npx convex dev` can run the backend as a local subprocess with no account; state lives in `.convex`. Beta, "not recommended for production use" |
| Import and export | `npx convex import` takes CSV, JSONL, JSON arrays (8 MiB at most) and ZIP files. Import is atomic per table unless `--append` is used. Import is the only way to keep given `_id` values. Streaming export (Fivetran) needs Pro; streaming import (Airbyte) is on all plans; both are beta |
| Plans and regions | Pro includes 25 M function calls, 50 GB of database storage and 300 deployments, with periodic backups and log streams. Regions: US East, EU (Ireland), Sydney, Canada; outside the US the price is 1.3x; a region cannot change later. The pricing page did not render for this plan, so seat prices are not quoted |
| Components | Sandboxed sub-backends with their own tables. A component call is a sub-transaction of the calling mutation. Published components include migrations 0.3.7, workpool 0.4.14, workflow 0.4.10, aggregate 0.3.3, sharded counter 0.2.3, rate limiter 0.4.2 and R2 0.10.4 |
| Turborepo | Add it to an existing pnpm workspace with `pnpm add turbo --save-dev --workspace-root`. Tasks use `dependsOn: ["^build"]`, `outputs` and `inputs`. Empty `outputs` cache only logs. The cache is local by default; a remote cache can be any server that implements the published API. `--affected` filters to packages changed on the branch. `turbo prune --docker` writes a pruned workspace and lockfile. Nested packages are not supported |
| Next.js | 16.4.2 needs Node 20.9 or newer. The App Router uses a built-in React canary. `middleware` is now `proxy`. `output: "standalone"` cannot be used with a custom server. Several instances need a shared cache handler |
| better-auth | 1.7.12. An API key plugin (`@better-auth/api-key`; its 1.7.x line needs better-auth 1.7) and an organization plugin |

**The `@vllnt/*` packages** (npm registry, 2026-10-21; repositories under `github.com/vllnt`, read at the commits named):

| Package | Version and maturity | Fit (section 5.4) |
|---|---|---|
| `@vllnt/convex-helpers` | 0.1.0, MIT. 10 of its 11 published versions are canaries. Peers: `convex ^1.45.0`, `zod ^4.3.6`, `@modelcontextprotocol/sdk ^1.29.0`. "Typed host-side helpers for Convex backends — builders, errors, validators, relationships" | **Adopt** for the custom function builders (company scope, actor) and validators, after C0 checks its peers against the workspace |
| `@vllnt/convex-idempotency` | 0.1.0, MIT, component | **Adopt** for retried Node-to-Convex writes |
| `@vllnt/convex-events` | 0.1.0, MIT, component, "append-only per-subject activity feed" | **Evaluate in C0** as the activity log store |
| `@vllnt/convex-api-keys` | 0.2.0, 15 releases, Apache-2.0 (README at `9b260a848958`). SHA-256 hashes, its own key prefix format, and `validate` is a mutation that tracks usage | **Not for agent keys at first:** its key format cannot take today's keys, so adopting it means re-issuing every agent key. Revisit after the core wave |
| `@vllnt/convex-permissions`, `@vllnt/convex-memberships` | 0.1.0 each, MIT, components (RBAC; ReBAC tuples) | **Skip for now.** Paperclip has its own grants and memberships model. Revisit in the core wave |
| `@vllnt/convex-notifications`, `-comments`, `-invitations`, `-slugs`, `-flags`, `-metering`, `-tokens` | 0.1.0 each, MIT, components | **Case by case** in each domain's Shadow slice. Use one only when its data model matches Paperclip's without a translation layer |
| `@vllnt/convex-mcp` | 0.3.1, MIT, exposes Convex functions as MCP tools | **Skip.** Paperclip's MCP surface stays in the Node tier (section 6.3) |
| `@vllnt/ui` | 0.3.0, 97 releases, MIT. Radix, CVA and Tailwind; peers `react >=19`, `next >=14`, `tailwindcss >=3`. Its source at `e7ebd543e900` has a Gantt chart (`packages/ui/src/components/organisms/gantt-chart/`); C0 checks that the published 0.3.0 contains it | **Adopt per component** where `DESIGN.md`'s token-only rule holds. Do not swap components wholesale |
| `@vllnt/typescript`, `@vllnt/eslint-config` | 2.0.0 each, MIT | **Optional.** Paperclip has its own TypeScript base and gates |
| `@vllnt/logger` | 0.1.2 | **Skip.** One log format (pino) stays |
| `create-vllnt-app` (repository, at `9ed256a32bca`) | Scaffolds Turborepo with `packages/backend` (Convex), `packages/client` (hooks) and apps. Rule: apps never import Convex directly; `@repo/client` is the single entry (`cli/templates/fullstack/AGENTS.md:38-39, 73`). Convex can run on Cloud or self-hosted with the same app code (`README.md`) | **Adopt the layout and the client rule** (section 4.2) |

Every `@vllnt/*` Convex package is pre-1.0. Pin exact versions. Fix a defect in the package's own repository, which is outside this plan.

## 4. Target architecture

### 4.1 Shape

```
 browser ─HTTPS─> ingress ─┬─> Node tier (server/, Express)            ───────────┐
   │                       │    ├─ /api/*  REST façade (paths, OpenAPI, CLI,       │
   │                       │    │          bridge, skills unchanged)               │
   │                       │    ├─ ws: /api/runner/v1/connect/*, setup terminal,   │
   │                       │    │      live events (shrinks per domain)            │
   │                       │    ├─ /mcp/*, /_plugins/*, /llms/*, runtime tools     │
   │                       │    ├─ auth: better-auth sessions, agent and board     │
   │                       │    │        keys, JWT minting + JWKS (section 4.5)    │
   │                       │    ├─ orchestrator: wakes, claims, runs, recovery,    │
   │                       │    │   agent processes (local, SSH, sandboxes),       │
   │                       │    │   plugin workers and jobs, file storage          │
   │                       │    └─ GET/HEAD pages ─> Next.js process (apps/web)    │
   │                       │                                                       │
   │                       └─> Convex API port only (no dashboard, no admin key)   │
   └── Convex client (websocket, user JWT) ──────────> Convex backend <────────────┘
       reactive reads of migrated domains              (queries, mutations,         Node tier calls Convex
       (through packages/client hooks)                  scheduled functions,        with a service JWT that
                                                        components)                 carries the acting actor
```

- **Convex** owns the data of every migrated domain: documents, indexes, transactions, reactive queries, the activity rows of those domains, and scheduled clean-up.
- **The Node tier** owns every long-running process and every outside call. Today's server is that tier. Its services become thin callers of one mutation per step (section 6.1).
- **Next.js** owns pages. It reads through REST on the server (M0 to M1) and, for migrated domains, through Convex in the browser (section 4.9).

### 4.2 Repository layout and Turborepo

| Path | Role | When |
|---|---|---|
| `turbo.json` (root) | The task graph: `build`, `typecheck`, `test`, `lint`, `dev`, with `^build` dependencies | T0 |
| `ui/` | The Next.js app. It moves to `apps/web/` only after MF, if at all; Turborepo does not need the move | Next.js lane |
| `packages/backend/` | `convex/`: schema, functions, `auth.config.ts`, `convex.config.ts` with components, and the pure domain rules each migrated domain shares with the Node tier | C1 |
| `packages/client/` | Typed hooks. It grows out of `ui/src/api/*`. A hook calls Convex for a migrated domain and REST for the others. Pages import only this package | C1, then each domain |
| `packages/shared/` | zod validators, types and the response serializers (section 4.7) stay the contract of REST, the CLI, OpenAPI and the Convex queries | unchanged, then grows |
| `server/` | The Node tier and the REST façade | unchanged path |
| `packages/db/` | Drizzle and Postgres, until the retirement step | removed in phase 6, apart from what section 10 keeps |

Turborepo rules: `turbo ls` must list exactly the packages that pnpm lists. Packages whose builds have side effects (the Rust runner, the plugin SDK's `ensure-build-deps`) start with `cache: false` until their `inputs` and `outputs` are proven.

### 4.3 What Convex owns, and the rules its limits impose

| Convex limit [S] | Rule in this plan |
|---|---|
| 1 s of user code per query or mutation | Mutations do one logical step. Long work runs in the Node tier or in a workpool of actions |
| 32,000 documents scanned and 16 MiB read per transaction | Every read uses an index. Company data is read through an index whose prefix is `companyId`. Lists are paginated. A bulk change is a paginated migration (the migrations component), never one mutation |
| 16,000 documents and 16 MiB written per transaction | Imports and backfills run in batches of at most 500 documents [A, measured in C0] |
| 1 MiB per document, 8,192 array elements | Large text stays in documents of its own (comment bodies, run log chunks). Unbounded arrays become child tables |
| No outside calls in mutations | Outside calls (GitHub, providers, SSH) run in the Node tier, or in actions that call mutations |
| Optimistic concurrency, retried inside Convex | Hot documents get few writers. Section 7.2 maps each lock pattern |
| Mutation write throughput (Cloud: 4 MiB/s on S16, 8 MiB/s on S256; self-hosted: set by its concurrency settings) | The run log is the highest-volume writer. C0 measures its bytes per second on production-shaped load before the core wave is planned |

### 4.4 The Node runtime tier

What stays in Node, and why:

| Concern | Today | Why it stays in Node |
|---|---|---|
| Agent processes (local, SSH, sandboxes) | `packages/adapter-utils/src/execution-target.ts:1377`, `packages/plugins/sandbox-providers/` | Child processes, file systems and SSH sessions cannot run in a Convex function. A Node action runs for 10 min at most [S] |
| Remote runner and setup terminal websockets | `server/src/index.ts:970-971` | Long-lived bidirectional sockets with per-run state |
| Orchestration loops | `server/src/index.ts:1194, 1212, 1226` | They control processes. They move their **state** to Convex: claims and status writes become mutations. A Convex cron can replace a timer only where no process control is needed |
| Plugin workers and jobs | `server/src/app.ts:849` | Plugins run code from outside the repository |
| MCP endpoints, runtime tools, `/llms/*` | `server/src/routes/connection-intents.ts:90` | Contract surfaces (section 6) |
| File storage | `server/src/storage/` | Private files with an auth check on each read (section 4.8a) |
| REST façade | `server/src/routes/` | Section 6.1 |

How the Node tier reads and writes Convex:

- **One SQL transaction becomes one mutation.** For a migrated domain, the logic that today runs inside one `db.transaction` block runs inside one Convex mutation in `packages/backend`. The Node use case makes one call per step, never a sequence of reads and writes. The pure `domain/` rules (`server/src/modules/README.md:10-15`) are shared, so both stores apply the same policy.
- A module port gets a second adapter, `adapters/convex.ts`, next to `adapters/postgres.ts`. The store router (section 7.6) chooses one per domain and company. Most services are not modules yet (section 2), so each domain starts with a module refactor on Postgres.
- Per request, a fresh `ConvexHttpClient` with the acting actor's service JWT, because the client is stateful [S]. Long-lived subscriptions (the outbox drain of section 7.4) use one `ConvexClient` per purpose.
- Every write from Node carries an idempotency key, so that a retry after a network error does not apply twice (`@vllnt/convex-idempotency`).
- **Latency matters.** Today one heartbeat step can run several SQL statements against a Postgres on the same host. Each Convex call costs one network round trip. C0 measures a full heartbeat step end to end (section 8.1).

### 4.5 Auth

- **better-auth stays in the Node tier as the identity provider.** Sessions, the cookie names and the board API keys work as today (`server/src/auth/better-auth.ts:312`).
- **Convex trusts the Node tier through custom JWT providers** (`auth.config.ts` with `issuer`, the JWKS URL, ES256 and `applicationID` [S]). The Node tier signs short-lived tokens, serves its JWKS and rotates its keys. Two kinds of token, each with **its own provider entry: its own `iss` and its own `applicationID` (`aud`)**. A function cannot rely on reading `aud`, but `issuer` is always on the identity [S], so the builders tell the two kinds apart by `identity.issuer`:
  - a **user token** (issuer `…/user`) for the browser's Convex client. It comes from an authenticated REST endpoint that checks the `Origin` header and accepts only same-site session cookies (CSRF protection). `sub` is the user id. Its lifetime is a few minutes;
  - a **service token** (issuer `…/service`) for the Node tier's own calls. The acting actor (board user, agent, run) and the company sit in claims nested under one namespace, read with dotted names [S].
- **Every function that the Node tier calls is public and accepts only the service issuer.** A Convex client cannot call an internal function [S]. The admin key, which the dashboard and the CLI use, never reaches the runtime. Internal functions serve only Convex-to-Convex calls (schedulers, crons, components).
- **Every public function checks identity.** A public function can be reached by anyone who knows the backend URL. Each one goes through a builder that rejects a call without a valid token of the expected issuer. Browser queries accept only the user issuer.
- **Agent API keys stay hashed and are checked in Node.** The hash lookup moves with the core wave (`packages/db/src/schema/agent_api_keys.ts:21` becomes a Convex index on `keyHash`). Agents never call Convex directly; they call REST (section 6).
- **The `lastUsedAt` write.** Today every agent request writes `lastUsedAt` on its key row (`server/src/middleware/auth.ts:453-456`). On Convex that write is throttled to at most once a minute per key [A], so the key document does not become a conflict point.
- **The backend's exposure.** Only the Convex API port is reachable through the ingress, with TLS. The dashboard port and the admin key stay off the public network. The admin key lives in the operator's secret store and is used only by deploys and CI.
- **Why not `@convex-dev/better-auth` now:** it needs `better-auth <1.7.0` and the server runs 1.7.2, and its supported plugin list does not name the organization or API key plugins [S]. Revisit when the component supports 1.7 (user decision U5).

### 4.6 Company scoping and multi-tenancy

- Every Convex table of a company domain has `companyId`. Every index used for company reads starts with it. Global lookups by `uuid` (for example an issue by id, `server/src/services/issues.ts:11648-11652`) and by `keyHash` have their own indexes, and the builder checks the company of the document it finds.
- A custom query builder and a custom mutation builder (from `@vllnt/convex-helpers`) resolve the actor from the token, load its membership and grants, and give the handler a company-checked context. They replace `assertCompanyAccess` (`server/src/routes/authz.ts:75`) for that domain.
- Board-only actions, approval gates and company boundaries apply exactly as today (`AGENTS.md:144`).
- The activity entry of a mutation is written in the same mutation, so the rule "activity logging for mutating actions" holds inside one transaction. The plugin event and the live event that `logActivity` sends today (`server/src/services/activity-log.ts:46-47, 152`) come from the outbox drain (section 7.4), so every writer sends them, not only REST.
- Instance-wide records (instance settings, announcement dismissals) live in tables without `companyId`, and their builders check instance roles instead.

### 4.7 What the browser may read

- Today every REST answer passes through redaction before it leaves the server (`server/src/routes/agents.ts:3367`, `server/src/routes/approvals.ts:27`, `server/src/routes/environments.ts:86`, `server/src/redaction.ts:953`). A Convex query that returns a raw document would skip it and could send secret-like config keys to a browser.
- **Rule: a public query returns the REST response shape, never a raw document.** The redaction and response serializers move to `packages/shared`, and both the REST route and the Convex query call them.
- Fields that no browser may read (secret material, adapter credentials) stay in tables that no public query reads, or stay in the Node tier.
- The golden suite (section 6.7) compares the Convex query output with the REST output for the same actor.
- Each UI hook slice gets a security review of the queries it adds.

### 4.8 Search

- Today: trigram GIN indexes on issues, comments, cases and documents, and a rubric that accepts loose ID forms (section 2; `doc/SEARCH.md:1-12`).
- Convex text search ranks by BM25, matches only the last term by prefix, has no typo tolerance and scans at most 1,024 results [S]. A substring such as `pap42` does not match `PAP-42` by itself.
- Plan:
  - identifiers get a normalized key field and an index (an exact or prefix range read);
  - text gets one search index per searchable kind, over a denormalized `searchText` field with `companyId` as a filter field;
  - the `doc/SEARCH.md` rubric becomes a golden test suite, with one part per searchable kind (issues, comments, cases, documents);
  - search of each kind keeps reading the Postgres mirror (section 7.4), which keeps its trigram indexes, until its part of the suite passes on Convex. Issues do not flip before their part passes.

### 4.8a Files and storage

- File **bytes** stay in today's storage providers (`server/src/storage/provider-registry.ts:6`). Reads stay behind the REST auth check.
- File **metadata** moves to Convex with its domain.
- Convex file storage is not used for private attachments: a file URL lets anyone with it read the file, and only deleting the file revokes it [S]. Convex storage is acceptable for public assets such as company logos.

### 4.9 Realtime

- Today one in-process `EventEmitter` fans out live events (`server/src/services/live-events.ts:7`). It cannot cross processes.
- For a migrated domain, the browser reads through Convex reactive queries in `packages/client` hooks, with the response shapes of section 4.7. The live-events socket no longer carries that domain's change events to those pages.
- Writes keep going through REST during the transition. The REST path also runs the domain's guards, and it keeps the CLI and agents on one write path.
- Pages that are not on Convex yet keep their live events: the outbox drain publishes them for every Convex write (section 7.4).
- The live-events socket stays for domains that are still on Postgres, and for high-rate streams (run log tails) until the run log store is decided (U9).
- The runner and terminal sockets stay in the Node tier for good.

### 4.10 Hosting: self-hosted Convex or Convex Cloud

| Factor | Self-hosted, next to the server [S] | Convex Cloud [S] |
|---|---|---|
| Latency from the Node tier | Same host: no WAN round trip | One WAN round trip to the region per call; the production host's region is not in this repository |
| Operations | One more stateful service. Upgrades by export and import. No documented HA or scheduled backup; the plan adds nightly exports (section 7.9) | Managed. Periodic backups on Pro |
| Memory on the host | Adds the backend's resident memory to a container that already uses about 1.9 GB [O]. Measured in C0 | None on the host |
| Storage engine | SQLite by default, or Postgres 17, the version that already runs in the compose file (`deploy/compose.yaml:60`) | Managed |
| Exposure | The API port through the ingress with TLS; the dashboard and admin key private (section 4.5) | Convex's endpoints |
| Outside data paths | A usage beacon unless `DISABLE_BEACON=true`. The plan sets it, as the Next.js plan turns off Next.js telemetry | Cloud terms |
| Cost | Host resources only | Pro: 25 M function calls included, then a price per extra million. Agent traffic per month is unknown and C0 estimates it |
| Data residency | On the operator's host | A chosen region, fixed at creation; 1.3x outside the US |
| License | FSL-1.1. Internal use is permitted. Shipping the backend inside every install is distribution to others, and the Competing Use clause then needs a legal reading (U8) | Cloud terms |
| Feature set | "All the free-tier features" of Cloud | All plan features |
| Installs (`npx paperclipai onboard`, `README.md:355`) | The CLI would start a backend next to the server. Local deployments are beta and "not recommended for production use", so a production install runs the self-hosted backend binary or image | Each install needs a Cloud account |

**Recommendation (U2):** self-hosted, on the same host, for production, if C0 shows the backend fits the memory budget and the latency gates. Its own database lives in the existing Postgres 17 service during the transition; SQLite is the alternative. Cloud stays available for engineers' preview deployments. G1 decides with numbers.

### 4.11 Development and tests

- `pnpm dev` starts a local Convex deployment next to the server. No account is needed [S].
- Unit tests of Convex functions use `convex-test` (0.0.63, pre-1.0). Integration tests run against a local backend started by the test runner, as embedded Postgres is today.
- CI adds one job: Convex code generation and typecheck of `packages/backend`, and its tests. The job joins the image-build check only once the image contains the backend (C1).

## 5. Decision records

### 5.1 Turborepo

- **Decision:** add Turborepo as the task runner of the existing pnpm workspace, in three slices (T0 to T2, section 8.0).
- **Alternatives:**
  - keep `pnpm -r`: no cache, and every CI lane rebuilds everything;
  - Nx: more features, but a larger tool and its own project model;
  - Lage or moon: smaller communities, no match with the maintainer's other repositories (`create-vllnt-app` uses Turborepo).
- **Costs and risks:**
  - one dev dependency with a native binary, installed under the build host's install rules;
  - wrong `inputs` or `outputs` give stale cache hits, so side-effect builds start uncached;
  - no remote cache in T0. A remote cache needs a token and a server, which is a user decision (U10).
- **Removed:** `pnpm -r` in root scripts (T0). The hand-ordered filtered builds in the `Dockerfile` (T2), only if the image build check stays green and the image content is the same.

### 5.2 Convex as the system of record

- **Decision (requested by the maintainer):** move the data of every domain to Convex, one domain at a time, gated by C0 and G1.
- **Alternatives:**
  - **stay on Postgres**, with the Effect plan for reliability. The lowest risk and no new runtime. It does not give reactive queries or the maintainer's Convex stack;
  - **Postgres plus a sync engine** for realtime (for example ElectricSQL or Zero). It keeps SQL, but it is a second system to run;
  - **Convex** (chosen): reactive queries, serializable transactions, typed functions, the maintainer's components. The cost is a rewrite of the data layer, and of every SQL-specific behavior.
- **Costs and risks:** sections 7 and 9. The largest: the lock-based invariants (section 7.2), the plugin SQL contract (section 6.6), response redaction (section 4.7), search (section 4.8), install size and license (section 4.10), the end of upstream syncs (section 5.7), and months of two stores.
- **Removed at the end:** drizzle and the migration journal (apart from what section 10 keeps), embedded Postgres in dev, the in-process live-events fan-out for data changes, the 68 advisory-lock sites and the 478 row-lock lines (as SQL; their semantics move to section 7.2).

### 5.3 Next.js

- **Decision (already taken in the Next.js plan):** migrate `ui/` to the App Router, route by route. This plan changes nothing in M0 to MF, apart from the two M0b rules of section 1.
- **After M0b:** a page reads through `packages/client` hooks. For a migrated domain, a client component subscribes with Convex. A server component keeps the REST read for the first paint, until Convex's Next.js server rendering leaves beta and a slice measures it.
- **No Server Actions** stays the rule. Convex mutations, called through REST during the transition, are the write path.

### 5.4 The `@vllnt/*` packages

- **Decision:** the adopt, evaluate and skip list in section 3.
- **Alternatives:** the general-purpose `convex-helpers` (0.1.128) and the `@convex-dev/*` components. They stay in use where no `@vllnt/*` package covers the need (migrations, workpool, aggregate, rate limiter).
- **Risks:** pre-1.0 packages with one maintainer, mostly canary releases, with extra peers (`zod ^4.3.6` and the MCP SDK for `@vllnt/convex-helpers`). Pin exact versions. Each adoption has a small spike test in the slice that adopts it.
- **Removed:** nothing today. Paperclip uses no published `@vllnt/*` package yet; its three in-repo plugins only carry the scope name (`packages/plugins/plugin-convex/package.json:2`).

### 5.5 The auth bridge

- **Decision:** better-auth in Node, custom JWT to Convex (section 4.5).
- **Alternatives:** `@convex-dev/better-auth` (blocked by the version range); Convex Auth (beta, and no CLI setup on self-hosted [S]); a hosted IdP (a new vendor and a data path).
- **Costs:** a JWKS endpoint, key rotation and a CSRF-protected token endpoint in the Node tier.
- **Removed:** nothing until the core wave. Then better-auth's tables need a store: either keep them in a small Postgres, or move them when the component supports better-auth 1.7 (U5).

### 5.6 The Effect lane

- **Decision:** stop E0b and every later slice. Keep #319, E0a and the retry predicate fix in plain TypeScript.
- **Why:** Convex replaces the service layer that Effect would sit under (`doc/plans/2026-10-10-backend-effect.md:10-14`).
- **Reopens:** if G1 or a later gate kills Convex, the Effect plan resumes as written. If Convex goes ahead, Effect may come back for the Node tier's process control only, after G1.

### 5.7 The relationship with upstream

- **Fact:** the fork merges upstream `master` (`VLLNT.md:3-8`), and #275 is the open sync.
- **Effect of this plan:** upstream changes to a migrated domain's services or schema can no longer merge mechanically. Each one becomes a manual port into Convex. After the core wave, upstream merges reach only code that does not touch data: adapters, the adapter utilities, skills, and parts of the UI.
- **Decision for the maintainer (U4):** settle #275 (merge or close) before C1, then treat upstream as a source for cherry-picks, not a merge target.

## 6. Contract preservation

### 6.1 REST and OpenAPI: a façade

- The Express routes stay. A route of a migrated domain calls its module's use case. The use case calls **one Convex mutation or query per step** through the Convex adapter (section 4.4), instead of drizzle. Paths, status codes, JSON shapes and the OpenAPI document do not change.
- The façade **stays after the migration**. Reasons:
  - one origin and the same cookie and key auth;
  - the CLI, the bridge allowlist, the skills and the rate limiters stay on the same paths;
  - Convex HTTP actions would need a rewrite of 952 route handlers, would run in 64 MiB, and would answer on `convex.site` unless the plan pays for a custom domain on Pro [S].
- New capabilities still ship on the web UI, REST with OpenAPI, and the CLI in one pull request (`AGENTS.md:141`).

### 6.2 The CLI

- Commands that call REST (`cli/src/client/http.ts:53`) do not change.
- **Commands that open the database directly** need a plan each. C0 lists them all; the known ones are:

| Command | Today | Plan |
|---|---|---|
| `routines` (some subcommands) | `cli/src/commands/routines.ts:202` | Move to REST before the routines domain flips. Until then, the command refuses to write a flipped domain |
| First-admin bootstrap | `cli/src/commands/auth-bootstrap-ceo.ts:82` | Stays on Postgres while the auth tables do (U5). Moves to REST or to a Convex call in the core wave |
| `onboard` | `cli/src/commands/onboard.ts:590` | Also starts the Convex backend and deploys the functions (U3) |
| `worktree`, the database check | `cli/src/commands/worktree.ts`; `cli/src/checks/database-check.ts` | Developer tools: also set up and check a local Convex deployment |
| Backups | the `db:backup` script (`package.json`) | Also runs the Convex export (section 7.9) |

- The write guard of section 7.4 rejects any direct Postgres write to a flipped company's rows, so a missed command fails loudly instead of losing data.

### 6.3 The runner API, websockets and MCP

Unchanged, in the Node tier: `/api/runner/v1/connect/*` (`server/src/realtime/runner-prp-ws.ts:16`), the setup terminal, the MCP routes (`server/src/routes/connection-intents.ts:90`) and the runtime tools.

### 6.4 The bridge allowlist and the skills

- The allowlist matches REST paths (`packages/adapter-utils/src/sandbox-callback-bridge.ts:170`). The paths do not change, so the list does not change.
- The skill calls the same paths (`skills/paperclip/SKILL.md:96`).

### 6.5 Control-plane invariants

These hold only because every table that one invariant touches moves in the **same wave** (section 7.4a, rule 1). Until that wave, they stay on Postgres with today's locks.

| Invariant | Tables it touches today [R] | How it holds on Convex |
|---|---|---|
| Single assignee | `issues` | The assign mutation reads and writes the issue in one transaction |
| Atomic checkout | `issues` and `heartbeat_runs`, locked together (`server/src/services/issues.ts:7779-7795`; `server/src/modules/run-dispatch/adapters/postgres.ts:215-231`) | One mutation reads the issue and its run and writes the claim. Two concurrent checkouts conflict, and Convex retries the loser, which then sees the claim (section 7.2) |
| Approval gates | `approvals`, `issue_approvals` and the gated object | The gated mutation reads the approval in the same transaction |
| Budget hard stop and auto-pause | `budget_policies`, `budget_incidents`, `cost_events`, and the paused scope: `agents`, `projects` or `companies` (`server/src/services/budgets.ts:218, 229-237, 242, 276-285`). The run-start gate reads the project pause (`budgets.ts:816-858`). Some of these writes run outside any `db.transaction` | The cost write, the budget check and the pause run in one mutation |
| Activity log for mutations | `activity_log` and the mutated table | Written in the same mutation (section 4.6) |
| Issue numbers | `issues` and the company counter (`server/src/services/issues.ts:10310-10321`) | A per-company counter document, raised in the issue insert mutation (section 7.1) |

### 6.6 The plugin SDK

- Plugins get raw SQL on a Postgres namespace, with read-only joins to 13 core tables (`packages/plugins/sdk/src/types.ts:629-637`, `packages/shared/src/constants.ts:1490-1504`). Convex cannot serve that.
- Options (U6):
  - **keep a Postgres for plugin namespaces, with the mirrors of those 13 core tables kept current**. This is the recommendation for the transition: no plugin breaks, and those mirrors are not retired while U6 is open (section 7.3);
  - a new document-store API in the SDK, with SQL deprecated over a release window;
  - both: the new API for new plugins, Postgres for old ones.
- The plugin state, entity and job tables (`plugin_state`, `plugin_entities`, `plugin_jobs`) move like any other domain, behind the same SDK calls, in the late wave.

### 6.7 Contract tests

- A **golden suite** per domain: recorded REST requests and responses (status, shape, ordering, pagination cursors) taken from the Postgres path. The Convex path must give the same answers. It runs in CI and against production for the test company (section 8.7).
- The same suite compares each Convex query used by a page with the REST answer for the same actor (section 4.7).
- The OpenAPI document (`server/src/routes/openapi.ts`) stays as it is. A diff check fails if a migration slice changes it.

### 6.8 The company archive

- The company archive is a company-directed export of the company's own run history: runs, run events, transcripts, costs and activity. Every record passes the read-time redaction module (`AGENTS.md:126-130`; `server/src/services/run-read-redaction.ts`).
- The core wave moves every source it reads. The archive services are not modules today (`server/src/modules/` has three), so the core wave moves them to module ports first, on Postgres. After that they read through the ports, and every record still passes the same redaction module.
- Every core-wave slice that changes an archive source gets the privacy review that `AGENTS.md:137` asks for, and updates `doc/company-archive.md` if the meaning of a record changes.
- The core wave's Verify gate includes a golden comparison of an archive export for the test company, taken from both stores.

## 7. Data migration: Postgres to Convex

### 7.1 Model translation rules (also the rules for new Postgres tables now)

| Postgres | Convex |
|---|---|
| `uuid` primary key | Keep it as an indexed field (`uuid`). It stays the REST and CLI id. Convex's `_id` is internal |
| Foreign keys and `onDelete` cascades | Id fields, checked in the write path. A cascade becomes a paginated deletion through the migrations component, started by the delete mutation. A foreign key between tables that flip in different waves follows section 7.4a rule 3 |
| Unique index | An index and a read-before-insert in the same mutation (serializable, so safe [S]) |
| `nullsNotDistinct` unique | A normalized key field (null as a fixed token) with an index |
| `jsonb` column | A typed nested value with a validator, below 1 MiB per document and 8,192 array elements |
| `timestamptz` | Milliseconds since the epoch |
| Counter column (`companies.issue_counter`) | **A separate counter document per company**, raised in the same mutation. The company document itself is also written by the budget pause, so it must not carry the counter |
| Keyset pagination | Convex `paginate` on an index |
| Trigram search | Section 4.8 |
| Triggers, sequences, advisory locks | Not allowed in new tables now. Section 7.2 maps the old ones |

### 7.2 The transaction model: locks and optimistic concurrency

| Pattern today [R] | Convex equivalent |
|---|---|
| `SELECT … FOR UPDATE` on a row, then a write (478 lines, for example `server/src/modules/run-dispatch/adapters/postgres.ts:219, 231`) | Read the document in the mutation, then write it. The read set makes a concurrent writer conflict. Convex retries it, and the retry sees the new state |
| `FOR UPDATE SKIP LOCKED` queue claims | A mutation picks the first unclaimed item by index and claims it. Under contention, several workers would retry on the same item, so claims spread across index ranges (for example by run id), or the workpool component runs them. C0 measures the conflict rate |
| `pg_advisory_xact_lock(key)` inside one transaction (for example `server/src/routes/cases.ts:75`) | Usually unnecessary, because the mutation itself is serializable. Where code must serialize across several mutations, a lock document per key, written in each one |
| `pg_try_advisory_xact_lock` single-flight guards (13 sites, for example `server/src/services/paperclip-temp-sweeper.ts:104`, `server/src/services/run-usage-records.ts:390`) | A conditional claim on a **lease document** that returns `acquired: false` when another owner holds a live lease. Singleton sweeps become Convex crons where they need no process control, or keep a lease in the Node tier |
| A lock held on a dedicated connection across I/O (`server/src/services/native-runtime/native-workspace-finalization-ownership.ts:67-68`) | A **lease with an expiry, an owner token and a fencing token**. Postgres frees the lock when the connection dies; the lease frees itself when it expires. Every write made under the lease checks the fencing token, so a stale owner cannot write after its lease ends |
| A long transaction with process control inside it | Split it: a mutation claims the step, the Node tier does the I/O, a second mutation records the result. Each call has an idempotency key |
| Retries of transient database errors (`server/src/database-retry.ts:39-52`) | Convex retries write conflicts itself. The Node tier retries network errors with the idempotency key |

### 7.3 The lifecycle of one domain

```
   Postgres is the system of record              Convex is the system of record
 ┌────────────┐  ┌────────────┐  ┌────────────────────────┐  ┌────────────┐  ┌──────────────┐
 │ S: Shadow  │─>│ V: Verify  │─>│ F: Flip, company by    │─>│ R1: drop   │─>│ R2: drop the │
 │ capture +  │  │ diff = 0   │  │ company (test company  │  │ capture    │  │ mirror and   │
 │ backfill   │  │ for 48 h;  │  │ first): fence, drain,  │  │ triggers,  │  │ the Postgres │
 │ to Convex  │  │ golden     │  │ switch, mirror         │  │ after 7    │  │ tables, when │
 │            │  │ suite      │  │                        │  │ days       │  │ no consumer  │
 │            │  │ passes     │  │                        │  │            │  │ is left      │
 └────────────┘  └────────────┘  └────────────────────────┘  └────────────┘  └──────────────┘
   rollback: drop the shadow       rollback: section 7.7, with the mirror      rollback: from
                                   and the diff checker still running          the export only
```

- **R1** removes the capture tooling of the domain. The reverse mirror, the diff checker and the write guard keep running.
- **R2** removes the mirror and the domain's Postgres tables. It needs every consumer to have moved: tables with foreign keys to the domain, SQL joins, search, reports, and, while U6 is open, the plugin core-read tables. In practice most R2 slices run in phase 6.

### 7.4 Capture, backfill and the reverse mirror

- **Capture during Shadow.** A temporary trigger on each table of the domain writes the changed row as JSON into one capture table. Deletes are captured as tombstones. TRUNCATE is refused on captured tables.
  - For one row, row locks make the capture order equal to the commit order. Across rows, a transaction can commit after a later sequence number, so the drain worker **deletes each capture row when it applies it** and never advances a high-water mark.
  - A Node worker applies the changes to Convex by `uuid`, through an idempotent upsert that keeps the newest change of each row.
  - The drain worker and the backfill write through one **capture-apply mutation**, the only exception to the lint rule of the db-writer wrapper (below). It accepts a write only while the company's state for the domain is `postgres` or `fenced`, only from the service issuer with a capture-apply claim, and it writes no outbox entry, so a captured change never goes back to Postgres. C1.4 tests each of these rules.
  - Why triggers, although new tables must not use them: the server has about 1,600 lines of raw SQL and 634 transactions, and some CLI commands write the database directly (section 6.2). Capture inside the application would miss write paths. The triggers are migration tooling: they pass the migration safety checks of `doc/DATABASE.md:215-226` or the slice stops, and they are dropped in R1.
  - Logical replication would avoid triggers, but it needs `wal_level=logical` on the database service, which is a deploy change (U7).
- **Backfill, in this order:**
  1. start capture;
  2. take a consistent snapshot (`REPEATABLE READ`) of the domain's tables;
  3. load the snapshot into Convex: batches of at most 500 rows, or `npx convex import` with JSONL into empty tables for large tables [S];
  4. apply every capture row written since step 1.

  Rows that changed during the load are captured, so nothing is lost. A change that is also in the snapshot is applied again, which the upsert makes harmless.
- **Reverse mirror after Flip.**
  - Every Convex write to a migrated table goes through one **db-writer wrapper** in the mutation builder. The wrapper also writes an outbox document in the same transaction. A lint rule bans direct `ctx.db` writes to migrated tables outside it. Components, scheduled functions and crons use the same wrapper. Imports and dashboard edits on migrated tables are not allowed in production.
  - The wrapper reads the company's route document for the domain (section 7.6) in the same transaction and **refuses the write unless the state is `convex`**. So the fence also stops Convex crons and scheduled functions. A scheduled function or cron that meets the refusal schedules itself again after a short delay instead of failing, so no scheduled work is lost.
  - The Node tier subscribes to the outbox. For each document, in order, it writes the row back to Postgres, sends the plugin event and the live event that `logActivity` sends today, and deletes the outbox document.
  - A row that the mirror cannot apply (a foreign key or a unique violation) is a poison row. It raises an alert, blocks the domain's R1 and R2, and is fixed by hand.
  - So Postgres tables of domains not yet moved keep their joins and foreign keys, search and reports can keep reading Postgres, the activity feed stays complete, and a rollback finds Postgres current.
- **No loop.** The mirror writes with a session setting that the capture triggers check. A trigger skips a mirror-session write **only on a table whose state for that company is `convex`**, which the mirror owns, so a mirrored row is never captured again. On every other table a mirror-session write is captured as usual: for example, a mirrored parent delete that cascades into a child table still on Postgres (section 7.4a rule 3.3). C1.4 tests both cases: a mirrored row is not captured again, and the cascade reaches Convex as a tombstone.
- **Write guard from the fence on.** A trigger on each table of a domain in flight reads the persisted route state (section 7.6) and rejects a write to a company's rows while that state is `fenced` or `convex`, unless the session is the mirror. It is installed with capture in Shadow and is active from step 0 of the flip. A writer that the router does not see (a CLI command, a forgotten loop) fails loudly instead of writing to a store that nobody reads, and it cannot slip a write between the drain and the switch.
- **Read-your-writes.** The mirror lags by seconds. Code on Postgres that must read a migrated domain's fresh state reads it from Convex through the port, not from the mirror. Where a Postgres row will reference a fresh Convex row by foreign key, the mirror barrier of section 7.4a rule 3 applies. The mirror serves joins, foreign keys, search, reports and plugins.

### 7.4a Writes and locks that cross two domains

- Today one SQL transaction can read with a lock or write the tables of two domains (section 6.5 lists the invariants). When one of the two domains is on Convex, that transaction spans two stores and has no single transaction.
- **Rule 1: the coupling graph decides the waves.** C0 builds the graph from four sources:
  - the tables that each `db.transaction` block and each multi-table statement **writes**;
  - the rows that it **locks** with `FOR UPDATE`, `FOR SHARE` or an advisory lock;
  - the **call graph of each invariant flow** (checkout, assignment, approval, budget stop, activity), including writes outside any `db.transaction`. For example, the budget stop pauses a project with a plain update and then cancels work (`server/src/services/budgets.ts:229-237, 252-258`);
  - the **foreign keys** between tables, with their `onDelete` action.

  Its inputs are a static scan of the 634 transaction blocks, of the multi-table statements and of the invariant services, and the drizzle schema.
  - Every table that an invariant flow reads or writes (section 6.5) moves in the same wave. G1 lists those tables per invariant, and fails if an invariant spans two waves.
  - Other tables that one transaction couples move in the same wave, or the transaction is split first, in a plain refactor slice on Postgres.
- **Rule 2: a split write is a saga with an idempotency key.** It is allowed only outside the invariants. The use case writes the Convex side first, then the Postgres side. A failure on the second step retries with the same key, or runs the compensating mutation. The diff checker reports what does not converge.
- **Rule 3: every foreign key between two waves has a named strategy.** G1 fails if one has none. The three strategies:
  1. **Same wave** (the default). It is required when the child's key blocks the parent's delete (`onDelete` NO ACTION or RESTRICT). For example, `issues.project_id`, `issues.goal_id` (`packages/db/src/schema/issues.ts:37, 39`), `cost_events.project_id` (`cost_events.ts:16`) and `projects.goal_id` (`projects.ts:12`) put projects and goals in the core wave.
  2. **Child first.** The child flips before its parent. The child's Postgres mirror table drops that foreign key at the flip, and the parent's delete path applies the `onDelete` action to the Convex child through the port, as a saga. Convex checks that the parent exists through the port when it writes the child. Example: documents, which reference agents with SET NULL (`packages/db/src/schema/documents.ts:16-21`).
  3. **Parent first, with a mirror barrier.** The parent flips before its Postgres children. This is allowed only when every child key is `onDelete` CASCADE or SET NULL, so a mirrored delete cannot fail. A façade write of the parent answers only after the mirror has applied its outbox entry, so a Postgres child created right after it finds its parent. The cascade that a mirrored delete causes in a Postgres child is captured like any other write ("No loop", section 7.4). The parent's delete mutation reads the child domain's route document: it cascades in Convex when the child is `convex`, and it refuses and retries later while the child is `fenced`. Examples: documents (every child key cascades or sets null, for example `packages/db/src/schema/issue_documents.ts:12`) and labels (`issue_labels.ts:10`).
- **Company removal** (`server/src/services/companies.ts:629-640`) deletes every owned table in one transaction today, so the write guard would reject it once a domain has flipped. For a company with flipped domains it first runs a paginated Convex deletion of those domains and waits until the mirror has applied every tombstone to Postgres. Only then does it run today's transaction, which skips the flipped tables. A removed company leaves no rows in either store.
- **Instance-wide tables** (no `companyId`) flip once for the whole instance, after every company's flip of the same domain.

### 7.5 Verification

- A **diff checker** in the Node tier compares each company's rows by `uuid`: counts and a hash of the normalized row. It checks the rows changed since its last pass, and runs a full pass every night. It reports mismatches with their age. It runs from Shadow until R2.
- **Gate V:** 0 mismatches older than 60 s, for 48 hours, on production. The domain's golden suite passes against both stores.
- **Dual read** on the façade for a sample of GET requests in Verify: the answer comes from Postgres, the Convex answer is compared and logged.

### 7.6 Cutover, company by company

- A **store router** holds, per domain, the state of each company: `postgres`, `fenced` or `convex`.
  - **The state is persisted in both stores:** a route table in Postgres, which the write guard and the CLI read, and a route document in Convex, which the db-writer wrapper reads. A change of state writes Postgres first, then Convex. The Node tier caches the state for at most a few seconds; the guard and the wrapper always read the stored value.
  - Every writer checks it: REST routes, background loops, plugin host services and the CLI commands that write directly (section 6.2). A writer that the router misses meets the guard or the wrapper.
  - A writer that meets `fenced` waits and retries. A REST write answers 503 with `Retry-After` if the fence lasts more than a few seconds. The CLI and the skill retry such answers (slice C1.8) before any live company flips.
- The test company flips first. The live companies flip only after the test company has run for at least 48 hours with the gates of section 8.7 green, and only on the maintainers' go.
- The flip of one company:
  0. **fence:** set the state to `fenced`. The write guard now rejects every write except the mirror's. Wait until every Postgres transaction that started before the fence has ended, and until the mirror outbox of every parent domain (section 7.4a rule 3.3) is empty for that company, so that no cascade from a mirrored delete arrives after step 1;
  1. drain capture to zero for that company;
  2. check that the diff is zero;
  3. set the state to `convex`: the guard keeps rejecting Postgres writes, and the wrapper starts to accept Convex writes;
  4. start the reverse mirror for that company.

  The fence lasts from step 0 to step 3: seconds for a peripheral domain [A], measured in the C0 rehearsal, and shorter than a release drain [O]. The core wave has its own bound (section 8.5).
- **Instance-wide reads** (lists across companies, instance admin pages) read both stores during the transition, through the façade.

### 7.7 Rollback

| When | How | Data loss |
|---|---|---|
| During Shadow or Verify | Stop capture and drop the Convex tables of the domain | None. Postgres stayed the system of record |
| After Flip, before R1 | 1. Set the state to `fenced`: the wrapper refuses every Convex write, crons and scheduled functions included, and the guard still rejects Postgres writes. 2. Drain the mirror outbox to zero. 3. Check the diff. 4. Stop the mirror for that company. 5. Re-arm capture for that company. 6. Set the state to `postgres`: the guard stops rejecting | None, when the db-writer wrapper, the write guard and the diff checker hold: every committed Convex write is in the outbox, the fence stops new ones, and capture is armed before Postgres accepts writes again. A poison row blocks the rollback until it is fixed, and is the case to drill in C0 |
| After R1, before R2 | The same, but capture must be installed again first, which is a new Shadow | None, with the same conditions |
| After R2 | Restore from the Convex export into Postgres with the restore script of section 7.9 | Up to the last export. That is why R2 waits for every consumer and needs the maintainers' go |

### 7.8 The last domains and the end of Postgres

- The core wave moves the run tables. Their write volume decides whether the run log (`heartbeat_run_events`) goes to Convex or stays in Postgres as an append-only table that only the Node tier writes (C0 measures it; U9).
- Postgres can end only when the plugin SQL question (section 6.6), the auth tables (section 5.5) and the run log are settled. Until then Postgres shrinks to those parts.
- At the end, `doc/SPEC-implementation.md` (the store, `:62, 107-110`) and `doc/DATABASE.md` get additive updates in the same slice, as `AGENTS.md` rule 4 asks.

### 7.9 Backups and the restore path

- Until the last R2: today's Postgres dumps continue.
- From the first Flip: a nightly `npx convex export` with file storage, kept with the same retention as the database dumps. A monthly restore drill into a throwaway deployment proves it.
- **Before phase 6:** a script that restores a Convex export into the Postgres schema, built while drizzle and the schema still exist, and drilled once per wave on the rehearsal environment of C0.

## 8. Phased plan

### 8.0 Phase 0: now (no data moves)

| Slice | What | Lane | Size | Acceptance | Verify in production |
|---|---|---|---|---|---|
| T0 | Root `turbo.json` with `build`, `typecheck`, `test` and `dev` (`^build`, local cache), root scripts on `turbo run`, `.turbo` in `.gitignore`. No Dockerfile or deploy change | remote | S | `turbo ls` equals the pnpm package list. `turbo run build` gives the same `dist` contents as `pnpm -r build`. A second run is a full cache hit. The image build check is green | Health shows the merge commit. Nothing else changes at run time |
| T1 | CI: `turbo run typecheck test --affected` with an `actions/cache` of `.turbo` in the lanes that build | remote | S | CI time per lane before and after, at least 5 runs each. No lane skips a package that changed | none (CI only) |
| T2 | The Dockerfile build chain becomes one `turbo run build` over the server and the bundled plugins (`Dockerfile:148-194`), optionally on `turbo prune --docker`. The test steps between the builds (`Dockerfile:153-172`) stay, in the same order relative to what they test | remote, risky | M | The same files in the production image (a content diff). The same test steps run. Image build time before and after | Standard release checks |
| R0 | The rules of section 7.1 go into `doc/DATABASE.md` as "Convex-ready tables", so that every feature session sees them | remote | S | Docs only | none |
| — | The Next.js lane: H, M0, M0b, M0c, M1, then M2 to M10 and MF, as its plan says, with the two M0b rules of section 1 | as planned | — | as planned | as planned |

### 8.1 Phase 1: the spike and the rehearsal (C0), and gate G1

C0 runs on a throwaway branch and is never merged. Its report becomes one docs pull request.

- **Port one existing peripheral domain** end to end, with the auth bridge, the company builder, the response serializers and the golden suite. The domain is on `main` and has production data. The coupling graph picks it; sidebar preferences and labels are the candidates.
- **Rehearse the whole lifecycle** for that domain: Shadow with capture and backfill, Verify, Flip with the fence, the reverse mirror, a rollback with a poison row, a re-flip, R1. The rehearsal runs on an isolated environment with a restored copy of a recent production dump on an operator-controlled host (U13), or on a production-shaped fixture if the operator declines. Never on production.
- **Measure:**
  - (a) the round trip of a trivial mutation from the server, p50 and p95, for a self-hosted backend on the same host and for Cloud in the nearest region;
  - (b) one full heartbeat step end to end (claim, start, status update, run log append, cost write) against Convex, compared with Postgres;
  - (c) the conflict and retry rate of a claim mutation with 20 concurrent claimers;
  - (d) the capture triggers' overhead: write latency p95 of the captured tables with and without capture;
  - (e) the backend's resident memory at idle and under (c);
  - (f) the run log write volume on a production-shaped fixture, in bytes per second at the peak;
  - (g) function calls per day, extrapolated from the request counts of a production-shaped fixture, for the Cloud cost estimate;
  - (h) the dev and install path: `pnpm dev` and the CLI onboarding with a local backend, on a clean machine;
  - (i) the coupling graph of section 7.4a, and the wave order of section 8.3 checked against it;
  - (j) the inventory of every direct database writer outside the module ports (section 6.2);
  - (k) the mirror lag, p50 and p95, from a Convex commit to the Postgres row, which is the cost of the mirror barrier (section 7.4a rule 3).
- **G1 passes when all of these hold:**

| Check | Pass |
|---|---|
| Mutation round trip | Self-hosted on the same host: p95 ≤ 10 ms [A]. Cloud: p95 ≤ 40 ms [A] from the production host's network |
| Heartbeat step | p95 within +25 % of the Postgres step [A] on the chosen hosting option |
| Claim conflicts | ≤ 1 % of claims fail after Convex's own retries |
| Capture overhead | Write p95 of captured tables rises by ≤ 20 % |
| Memory | The backend adds ≤ 512 MiB resident at the peak, or the operator approves a larger host |
| Run log volume | The peak is below half of the measured write throughput of the chosen backend, or the run log stays in Postgres (U9) |
| Lifecycle | The rehearsal ends with 0 mismatches after flip, rollback and re-flip. The fence lasts ≤ 10 s. A writer that skips the router is rejected by the guard during the fence |
| Mirror lag | p95 ≤ 1 s [A], so that the mirror barrier adds at most that much to a write |
| Golden suite | 100 % equal for the rehearsed domain, REST and Convex queries |
| Install path | `pnpm dev` works with no Convex account. An install script can start the backend |
| Invariants | A table list per invariant flow (section 7.4a rule 1), from the call graph. Every table of a list is in one wave |
| Coupling | The graph exists. No control-plane invariant spans two waves. No peripheral wave needs more than 3 split writes |
| Foreign keys | Every foreign key between two waves has a strategy from section 7.4a rule 3. No parent-first edge has a NO ACTION or RESTRICT child |

- If G1 fails, the maintainers decide with the numbers. The recommendation is then to stop (section 9).

### 8.2 Phase 2: the foundation (C1)

| Slice | What | Size | Verify in production |
|---|---|---|---|
| C1.1 | `packages/backend` (schema skeleton, `auth.config.ts`, components config), `packages/client` (hook entry, the rule "pages import only this package" as a lint rule), the response serializers moved to `packages/shared` | M | Health shows the merge commit; a sample of REST answers is byte-equal before and after for the test company |
| C1.2 | Node tier: JWT signing, JWKS, key rotation, the user token endpoint with its CSRF checks (with OpenAPI and a CLI command for parity), the service token | M | For the test company: the token endpoint answers for a signed-in user; it refuses a cross-origin request, a missing session and an agent key; the JWKS answers; a user token that calls a service function is rejected, and so is a service token on a browser query |
| C1.3 | Node tier: the Convex client module, the store router with its persisted state (the Postgres route table and the Convex route document), the fence, the idempotency keys | M | The router reports every company on `postgres`; no behavior change |
| C1.4 | Capture and mirror tooling: capture table and trigger generator, drain worker, backfill runner, the capture-apply mutation, db-writer wrapper, write guard. Tests: no loop; a mirrored parent delete whose cascade reaches Convex as a tombstone; each capture-apply rule; the wrapper's refusal outside `convex` | M | None at run time: the tooling is not armed for any table |
| C1.5 | The diff checker and the golden suite runner | M | The golden suite passes against production for the test company on the Postgres path |
| C1.6 | Dev and CI: a local backend in `pnpm dev` and in the integration tests, `convex-test`, the CI job | M | none (dev and CI) |
| C1.7 | Deploy: the backend service with its usage beacon off (`DISABLE_BEACON=true`), an ingress that exposes only the backend's API port, and nightly exports. A deploy-file change goes to the deploy operator as a decision (U7). This slice stops until that decision | S plus the operator's change | The backend's health answers through the ingress; the dashboard port does not; the first nightly export exists |
| C1.8 | Clients: the CLI HTTP client (`cli/src/client/http.ts:166` sends the request; no retry exists today) and the skill's calls retry a 503 that carries `Retry-After`, with a bound on the total wait. Needed before any live company flips | S | A CI test against a stub that answers 503 with `Retry-After`; at run time nothing changes until a fence |

Acceptance for each: unit tests, the module boundary check, and no behavior change for any domain (every company routes to Postgres).

### 8.3 Phase 3: peripheral waves

Each domain ships as a module refactor (when it is not a module yet), then S, V, F, R1 slices (section 7.3), plus one UI slice that moves its hooks to Convex reactive reads. R2 waits for its consumers. The candidate order below is from low to high coupling; the C0 coupling graph confirms or changes it.

| Wave | Candidate domains | Why this order |
|---|---|---|
| 3a | Preferences and dismissals (`*_sidebar_preferences`, `inbox_dismissals`, `announcement_dismissals`), feedback, status cards | Per-user data with little coupling. The C0 domain comes from here |
| 3b | Policies (#346) and Databases and datasets (#347), once they are on `main` with production data | New, few readers, built now with the rules of section 7.1. The datasets filter compiler needs bounded pages, as its plan's 4 MiB page rule already says (`doc/plans/2026-10-21-datasets.md` on #347) |
| 3c | Documents and annotations, labels, folders | Content with clear owners. `issue_documents` and `issue_labels` stay with issues in the core wave. Documents and labels are parents of core tables whose keys cascade or set null, so they flip first with the mirror barrier (section 7.4a rule 3) |
| 3d | Cases and pipelines, work assessments, decisions | Governance objects that no invariant locks, if the graph agrees |
| 3e | Environments, skills, connections | Configuration. Projects, project workspaces and goals are not here: the budget stop pauses projects, and issues and cost events reference projects and goals with keys that block deletes, so they move in the core wave |

### 8.4 Phase 4: the heartbeat split into modules, on Postgres

- Carve the heartbeat into modules behind ports, without a store change. The run dispatch and the wake queue are already modules (`server/src/modules/`). The 34,886-line service splits into claims, run lifecycle, recovery, the run log and cost recording, each with a Postgres adapter. This is 40 to 80 pull requests [A]. It also helps if Convex is stopped.
- Each carve-up slice: the targeted tests of the moved code, and **Verify in production**: health ok at the merge commit, then for the test company one `[qa-test]` issue assigned to an agent runs to completion, with its run log, cost record and activity entries, and the run, wake and recovery error rates of the hour after the release stay within the week's normal range.
- Risky carve-up slices ship alone in their release window, with the release drain.

### 8.5 Phase 5: the core wave

- **One wave for every table behind a control-plane invariant** (section 6.5), and for every parent that those tables reference with a key that blocks deletes (section 7.4a rule 3):
  - issues and every `issue_*` table, comments, attachments' metadata, relations, read states;
  - heartbeat runs, run events, run usage, native run tables, leases and watchdogs;
  - agents, runtime state, task sessions, wakeup requests, config revisions, API keys;
  - budgets, budget incidents, cost and finance events;
  - projects, project workspaces and goals (the budget stop pauses projects; issues and cost events reference projects and goals);
  - execution workspaces, workspace operations, workspace runtime services and execution workspace runtime leases, which run start writes and which reference projects and project workspaces (`packages/db/src/schema/execution_workspaces.ts:20-21`);
  - approvals; routines, which create issues;
  - the company row and its counter document;
  - memberships, invites, join requests and grants, which the actor checks read on every request;
  - the activity log reads.
- **Prerequisites:**
  - phase 4 done;
  - the search golden suite (section 4.8);
  - the per-company counter under load, and the checkout and budget mutations measured in C0;
  - slice C1.8 (clients retry a 503 with `Retry-After`);
  - **a core-wave rehearsal** on the C0 environment: Shadow, Verify, flip, rollback and re-flip of the whole wave while synthetic runs are live, with 0 mismatches and a measured fence. The fence bound for the live flip is the rehearsal's p95 plus a margin, and at most the release drain [O].
- Shadow and Verify run per table group. The Verify gate also compares an archive export from both stores (section 6.8).
- The Flip of one company flips the whole wave at once, behind one fence, **inside a release drain with runs held**, so that no run writes while the fence is up. If the fence passes its bound, the flip rolls back by section 7.7.
- Every slice that changes an archive source gets a privacy review (section 6.8).
- This is the largest and riskiest step. It has its own go from the maintainers after the peripheral waves.

### 8.6 Phase 6: late wave and retirement

- **Late wave:** chat channels (`server/src/services/chat-channels.ts`, 38,507 lines, a module refactor first), plugins' state, entities and jobs, instance settings. Secrets get a security review before they move, or stay in the Node tier.
- **Retirement:** the R2 slices, once their consumers have moved; then remove drizzle and embedded Postgres from the paths that no longer need them. Keep Postgres only for what section 10 decides to keep (plugin namespaces, auth tables, and the run log if U9 keeps it there). Update `doc/SPEC-implementation.md` and `doc/DATABASE.md` additively.

### 8.7 Checks every slice passes

1. CI green at the head that merges, including the image build check.
2. An independent review at that head with no open blocker or major.
3. The module boundary check and the golden suite of the domain.
4. For UI changes: a real browser at 1440 and 390 px with zero console errors, on a local instance with a throwaway data directory.
5. Parity: a slice that adds a capability adds it to the web UI, REST with OpenAPI, and the CLI.
6. **Verify in production**, after the release, in the test company only, with `[qa-test]` data:
   - **module refactor:** the domain's routes answer as before (golden suite on the Postgres path); error rate and p95 within 10 % of the week before for 24 hours;
   - **S:** create and change `[qa-test]` rows through REST and the CLI; the diff checker reports them in Convex within 60 s; write p95 of the captured tables within the G1 capture bound;
   - **V:** the 48-hour diff gate holds; the dual-read log has no mismatch for the domain;
   - **F:** after the test company's flip, the golden suite passes against production for that company; the pages of the domain load at 1440 and 390 px with zero console errors; activity entries, plugin events and live events appear; the domain's REST error rate and p95 stay within 10 % of the week before for 48 hours;
   - **UI hook slice:** the security review of its queries is done; the Convex answers equal the REST answers for the test company's actors;
   - **R1 and R2:** the removed tooling is gone; health is ok; the export of that night contains the domain.

   Clean-up: cancel test issues and pause test routines; never delete.
7. Rollback is the procedure of section 7.7 (after F) or a revert pull request (before F), through the same checks.

### 8.8 Who does what

| Who | Work |
|---|---|
| **The remote lane** (the agent company that builds this repository: three engineer seats, about 3 to 4 PRs a day in total [O]), the main executors | **Seat 1, platform:** T0 to T2, C1.1 to C1.3, C1.6, C1.8. **Seat 2, migration tooling:** C1.4, C1.5, then the S and V slices of each wave. **Seat 3, domains:** the module refactors, the F slices, the UI hook slices, then the heartbeat carve-up |
| **Local sessions** | Merges and the release steps that need maintainer credentials, until the remote lane can do them. Production checks that need a board session. The independent reviews of risky slices. C0 can run locally if the remote lane cannot reach the rehearsal environment |
| **The deploy operator** | C1.7 and every deploy-file change, the host memory decision, backups of the new service, the rehearsal environment (U13) |
| **The maintainers** | The decisions of section 10, the go for the core wave, each live-company flip and each R2 |

Waves 3a to 3c can run in parallel across seats 2 and 3, because each domain has its own tables and module. Only one F slice for a live company runs at a time.

### 8.9 Effort

| Phase | Pull requests [A] | Calendar time [A] |
|---|---|---|
| 0 (T0 to T2, R0) | 4 | 1 week, alongside the Next.js lane |
| 1 (C0 and the rehearsal, report) | 1 (docs) | 2 to 3 weeks |
| 2 (C1) | 11 to 15 | 3 to 4 weeks |
| 3 (about 13 peripheral domains × refactor, S, V, F, UI, R1) | 80 to 120 | 6 to 10 weeks, with the 48-hour gates overlapping |
| 4 (heartbeat carve-up) | 40 to 80 | 6 to 10 weeks, partly parallel with phase 3 |
| 5 (core wave, with its rehearsal and the archive's move to module ports) | 55 to 85 | 7 to 11 weeks |
| 6 (late wave, R2 slices, retirement) | 30 to 50 | 4 to 6 weeks |
| **Total** | **about 220 to 355** | **about 5 to 9 months**, if the remote lane gives about two thirds of its 3 to 4 merged PRs a day to this program and the Next.js lane and feature work take the rest |

## 9. Risks, rollback and kill criteria

| Phase | Risk | Mitigation | Kill or stop criterion |
|---|---|---|---|
| 0 | Stale Turborepo cache hits | Side-effect builds uncached; `dist` content check in T0 | Revert T0 if any build differs from `pnpm -r build` |
| 1 | Latency, contention, capture overhead or memory worse than the gate | G1 numbers | **Kill** if G1 fails and no hosting option passes; the Effect plan reopens |
| 1 | The lifecycle rehearsal loses or duplicates rows | Fix the tooling and rehearse again | **Stop** before C1 if a second rehearsal still ends with a mismatch |
| 1 | No supported production path for installs, or the license reading is negative | Local backend in `pnpm dev`; a backend image for production; legal review (U8) | **Kill** for installs; the maintainers then choose Cloud-only or a Postgres edition (U3) |
| 2 | The JWT bridge weakens auth | One issuer and one `applicationID` per token kind, builders that check `identity.issuer`, CSRF checks; a security review; tests with forged and expired tokens, a wrong issuer, a wrong audience and the wrong token kind | Stop C1 until the review passes |
| 2 | Deploy-file change refused or delayed | U7 early | Phase 3 waits; nothing is lost |
| 3 | Capture triggers slow writes | Measure per domain in S | Stop the domain if the p95 of its writes rises by more than 20 % |
| 3 | A writer bypasses the router | The write guard rejects it; the writer inventory of C0 | A rejected write in production stops the next flip until the writer is routed |
| 3 | Diff mismatches that do not converge | Diff checker with ages; per-row capture apply | Roll the domain back; stop the wave if two domains fail Verify |
| 3 | A Convex query leaks a field that REST redacts | Shared serializers; golden comparison; security review per UI hook slice | Revert the UI hook slice at once; stop UI hook slices until the cause is fixed |
| 3 | A plugin breaks | Plugins keep their SQL namespaces and the mirrors of the core-read tables (section 6.6) | Revert the domain flip |
| 3 | A split write leaves the stores inconsistent | Coupling graph; sagas only outside the invariants; the diff checker | Roll the domain back if a split write leaves a mismatch older than 60 s more than once a day |
| 3 | A foreign key between two waves fails a write or a mirrored delete | A strategy per edge (section 7.4a rule 3), checked at G1; the mirror barrier; company removal through Convex first | A foreign-key poison row or a rejected write stops the next flip until the edge has a working strategy |
| 4 | The heartbeat carve-up changes behavior | Per-slice production check (section 8.4); risky slices alone | Revert the slice; the carve-up continues only with green checks |
| 5 | Search quality drops | Golden rubric suite; Postgres mirror search until it passes | Issues do not flip until the suite passes |
| 5 | Claim or counter conflicts slow dispatch; the run log exceeds write throughput | C0 numbers; claims spread by index; counter document; run log kept in Postgres (U9) | **Stop** the core wave and keep it on Postgres if dispatch latency rises by more than 20 % for the test company |
| 5 | The core flip's fence is too long, so agent writes fail mid-run | Core-wave rehearsal; flip inside a release drain with runs held; client retry on 503 (C1.8) | Roll the flip back if the fence passes its bound; stop the core wave if the rehearsal cannot meet the bound |
| 5 | The company archive loses a record or a redaction | Archive reads through the ports with the same redaction module; golden archive comparison; privacy review (section 6.8) | A mismatch in the archive comparison blocks the core flip |
| 5 | A lease expires while its owner still writes | Fencing tokens checked on each write | A fencing rejection in production stops the next flip until the cause is known |
| 6 | R2 is irreversible apart from the export | R2 only when no consumer is left; the restore script drilled once per wave | Do not start R2 for a domain whose restore drill failed |
| all | Two stores for months: operations cost, reports across stores | The reverse mirror keeps Postgres complete for reports; the store router has a dashboard | **Program kill** if, after phase 3, the remote lane spends more than half its pull requests on migration fixes for 2 weeks in a row |
| all | Upstream drift | U4 | — |
| all | Production memory | Measured in C0. Next.js runs as a second process with its own heap limit, inside the same container limit | Stop and ask the operator before any change that raises the container limit |

## 10. User decisions

| # | Decision | Recommendation |
|---|---|---|
| U1 | Go for C0 now, and for the full program only after G1 | **Yes to C0 now. Decide the program at G1 with the numbers** |
| U2 | Convex hosting for production | **Self-hosted on the same host**, if C0's memory and latency pass. Cloud for engineers' preview deployments only |
| U3 | Installs: a backend started by the CLI, Cloud only, or a Postgres edition kept for installs | **A self-hosted backend started by the CLI, if U8's legal reading allows it.** Upstream publishing workflows are off on this fork (`VLLNT.md:8`), so this affects the maintainers' own instances first |
| U4 | Upstream | **Settle #275 before C1, then cherry-pick only.** Accept that upstream merges end |
| U5 | Auth | **better-auth in Node with a custom JWT to Convex.** Revisit `@convex-dev/better-auth` when it supports better-auth 1.7 |
| U6 | The plugin SQL contract | **Keep a Postgres for plugin namespaces, with mirrors of the 13 core-read tables, during the transition.** Decide on a document API for SDK v2 after phase 3 |
| U7 | Deploy changes: the backend service, its ingress, its backups, logical replication | **Approve the backend service, API-only ingress and nightly exports at C1.7. No logical replication; triggers instead** |
| U8 | The FSL-1.1 license of the self-hosted backend | **Internal use on the maintainers' own instances is a permitted purpose. Get a legal review before the CLI ships the backend to other people's installs** |
| U9 | The run log store | **Decide at G1** from the measured write volume. Default: keep `heartbeat_run_events` in Postgres as an append-only table that only the Node tier writes |
| U10 | Turborepo remote cache | **No remote cache in T0.** Local and CI caches first. Add a self-hosted remote cache only if CI numbers justify it |
| U11 | The Effect lane | **Stop E0b onward.** Keep #319, E0a and the predicate fix |
| U12 | Live-company flips | **Test company first, 48 hours, then the live companies on the maintainers' go, one domain at a time; the core wave as one flip per company** |
| U13 | The rehearsal environment for C0 | **A restored copy of a recent production dump on an operator-controlled host, isolated from production.** A production-shaped fixture if the operator declines |
| U14 | How the core wave flips a live company | **Inside a release drain with runs held, after a core-wave rehearsal on the U13 environment**, with a fence bound from that rehearsal |

## 11. Plans in flight, reconciled

| Plan | Effect of this plan |
|---|---|
| Next.js (`doc/plans/2026-10-10-web-app-nextjs-migration.md`) | Unchanged order and gates. Two M0b rules (section 1). Pages move to `packages/client` hooks when C1 lands |
| Backend on Effect (`doc/plans/2026-10-10-backend-effect.md`) | Stopped at E0a (section 5.6). It reopens if Convex is killed |
| Upstream sync (#275) | U4 |
| Policies (#346), Databases and datasets (#347), goals, routine steps, the Inbox and Decisions merge | Keep shipping on Postgres with section 7.1's rules. Policies and datasets are wave 3b. Goals move with the core wave (section 7.4a rule 3); routines and the inbox's issue-backed data move with the core wave |
| Earlier work items of the remote lane: a repository move, a Next.js plan, a Convex helpers spec, a Gantt component | The repository move is not part of this plan; if it happens, this plan moves with the code. The Next.js work lives in this repository's Next.js plan. The Convex helpers spec is now a published package (`@vllnt/convex-helpers` 0.1.0, section 3). The Gantt component is in `@vllnt/ui`'s source and can serve the goals and projects pages under the token rule |

## Appendix A. Sources outside the repository

Fetched on 2026-10-21. Convex docs pages carry no version; the versions are from the npm registry on the same day.

- Convex limits: https://docs.convex.dev/production/state/limits
- Convex optimistic concurrency control: https://docs.convex.dev/database/advanced/occ ; errors: https://docs.convex.dev/error
- Convex mutations: https://docs.convex.dev/functions/mutation-functions ; actions: https://docs.convex.dev/functions/actions ; runtimes: https://docs.convex.dev/functions/runtimes
- Convex scheduled functions: https://docs.convex.dev/scheduling/scheduled-functions
- Convex HTTP actions: https://docs.convex.dev/functions/http-actions ; custom domains: https://docs.convex.dev/production/custom-domains
- Convex Node clients: https://docs.convex.dev/client/javascript/node ; https://docs.convex.dev/api/classes/browser.ConvexHttpClient ; https://docs.convex.dev/api/classes/browser.ConvexClient
- Convex internal functions: https://docs.convex.dev/functions/internal-functions
- Convex auth in functions (identity fields, custom claims): https://docs.convex.dev/auth/functions-auth
- Convex auth: https://docs.convex.dev/auth ; custom JWT: https://docs.convex.dev/auth/advanced/custom-jwt ; custom OIDC: https://docs.convex.dev/auth/advanced/custom-auth ; Convex Auth: https://docs.convex.dev/auth/convex-auth
- Convex with Better Auth: https://www.better-auth.com/docs/integrations/convex ; supported plugins: https://labs.convex.dev/better-auth/supported-plugins ; component changelog: https://github.com/get-convex/better-auth/blob/main/CHANGELOG.md
- Convex text search: https://docs.convex.dev/search/text-search ; vector search: https://docs.convex.dev/search/vector-search
- Convex file storage: https://docs.convex.dev/file-storage ; uploads: https://docs.convex.dev/file-storage/upload-files ; R2 component: https://www.convex.dev/components/cloudflare-r2
- Convex self-hosting: https://docs.convex.dev/self-hosting ; backend repository: https://github.com/get-convex/convex-backend (`LICENSE.md`, `self-hosted/README.md`, `self-hosted/advanced/postgres_or_mysql.md`, `self-hosted/advanced/upgrading.md`, `self-hosted/advanced/knobs.md`, `self-hosted/advanced/disabling_logging.md`, read at `95d8719cb693`), release `precompiled-2026-10-10-72ce13c`
- Convex local deployments: https://docs.convex.dev/cli/local-deployments
- Convex import and export: https://docs.convex.dev/database/import-export/import ; https://docs.convex.dev/database/import-export/export ; streaming: https://docs.convex.dev/production/integrations/streaming-import-export ; backups: https://docs.convex.dev/database/backup-restore
- Convex regions: https://docs.convex.dev/production/regions
- Convex components: https://docs.convex.dev/components ; https://docs.convex.dev/components/understanding ; migrations, workpool, workflow, aggregate: https://www.convex.dev/components
- Convex with Next.js: https://docs.convex.dev/client/nextjs/app-router/server-rendering
- Turborepo (docs updated 2026-10-20): https://turborepo.dev/docs/getting-started/add-to-existing-repository ; https://turborepo.dev/docs/crafting-your-repository/structuring-a-repository ; https://turborepo.dev/docs/reference/configuration ; https://turborepo.dev/docs/core-concepts/remote-caching ; https://turborepo.dev/docs/reference/run ; https://turborepo.dev/docs/reference/prune
- Next.js 16.4: https://nextjs.org/docs/app/getting-started/installation ; https://nextjs.org/docs/app/api-reference/config/next-config-js/output ; https://nextjs.org/docs/app/api-reference/file-conventions/proxy ; https://nextjs.org/docs/app/guides/custom-server ; https://nextjs.org/docs/app/guides/self-hosting
- better-auth: https://www.better-auth.com/docs/plugins/api-key ; https://www.better-auth.com/docs/plugins/organization
- npm registry (`npm view <package>`): `convex`, `convex-test`, `convex-helpers`, `turbo`, `next`, `better-auth`, `@better-auth/api-key`, `@convex-dev/*`, `@vllnt/*`
- `@vllnt/*` repositories: https://github.com/vllnt (`convex-api-keys` README at `9b260a848958`, `create-vllnt-app` at `9ed256a32bca`, `ui` at `e7ebd543e900`)
