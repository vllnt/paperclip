# Platform migration: Next.js, Turborepo and a Convex backend, one domain at a time

Date: 2026-10-21
Status: Plan only (docs). No code and no install. Step 1 (the early verdict, section 1) went to the maintainers on 2026-10-21 at about 13:40 UTC. This document is step 2.
Anchors: `origin/main` `9d0c732c2`. Every repository fact cites `path:line` at that commit.
Labels:

- **[R]** a repository fact at `9d0c732c2`;
- **[S]** a primary outside source, listed in appendix A with its version or its fetch date (2026-10-21);
- **[O]** an operator measurement given to this plan, not in the repository;
- **[A]** an assumption or an estimate that a named slice measures.

## 0. Summary

- **Request (maintainer, 2026-10-21):** "migrate to nextjs, turborepo, convex (backend) fully, leverage @vllnt/* packages i own". Earlier the same day: "the nextjs migration done asap".
- **Answer.** It is possible as a strangler, one domain at a time, in about 3 to 6 months [A] (section 8.9). Convex becomes the system of record for data. A Node service stays for the work that Convex cannot run: agent processes, SSH, sandboxes, runner websockets, plugins, MCP, and the REST layer that agents and the CLI use.
- **Agents see no change.** The REST paths, the OpenAPI document, the CLI, the runner API, the bridge allowlist and the skills stay the same. The REST layer becomes a façade over Convex, and it stays after the migration (section 6).
- **Order:**
  1. Turborepo T0 now, and the Next.js lane as it is planned (M0 to MF).
  2. A Convex spike (C0) with a go/no-go gate (G1).
  3. The foundation (C1).
  4. The domains: new, low-coupling domains first, issues next, agents, heartbeat and runs last.
  5. Postgres retired, apart from what section 10 keeps.
- **Kill criteria** can stop the Convex program at G1 or at any later gate (section 9). The fallback is the Postgres path with the parked Effect plan.
- **Costs to accept:**
  - cheap upstream syncs end for good (section 5.7);
  - the plugin SQL contract needs a replacement (section 6.6);
  - every install needs a Convex backend next to the server (section 4.10);
  - search changes from trigram matching to token search (section 4.8).
- **User decisions:** section 10, each with a recommendation.

## 1. Step 1: the early verdict

| Question | Verdict | Why |
|---|---|---|
| Does Next.js M0 fit the target? M0 runs Next.js as a second process, and every page reads through the REST API | **Yes. Keep M0 to M1 as planned.** Two rules for M0b, at no extra cost: (a) pages read and write only through the `ui/src/api/*` modules and `queryKeys`, so that a domain can later swap its hooks to Convex without page changes; (b) the Next.js server entry imports nothing from `server/src`, so that it can later run as its own app. Do not adopt Convex's Next.js server rendering helpers now | REST stays the agent and CLI contract (section 6), so a Next.js app on REST is not throwaway work. The second process keeps Next.js out of the server heap. That process model is a maintainer decision of 2026-10-21 in the Next.js lane's pending plan update (its section 15.6, not yet on `main`). On `main`, the same design is the fallback of `doc/plans/2026-10-10-web-app-nextjs-migration.md:94`. Convex marks its Next.js server rendering support as beta [S] |
| Should the Effect 4 backend lane stop or change? | **Stop E0b and every later slice.** Keep the plain TypeScript work that protects production until cutover: the fault harness (#319), E0a (the retry budget), and the retry predicate fix. Effect stays a candidate only for the long-lived Node runtime tier, and that choice waits for G1 | The Effect plan puts an Effect runtime under the Express and drizzle service layer (`doc/plans/2026-10-10-backend-effect.md:10-14`). Convex replaces that layer. If G1 kills Convex, the Effect plan reopens unchanged |
| Should feature sessions keep adding Drizzle tables? | **Yes, with the Convex-ready rules of section 7.1.** Each new domain is a module with `domain/`, `application/` and `adapters/` layers (`server/src/modules/README.md:3-31`, enforced by `pnpm check:module-boundaries`, `package.json:48`). Then the move replaces only `adapters/` | Convex is months away. Blocking new features until then would stop product work |
| Can Turborepo land early, independently and cheaply? | **Yes. T0 is one small PR** (section 8.0) | No task graph exists today. The root runs `pnpm -r build` (`package.json:19`), and no `turbo.json` exists at the root |

## 2. What exists today

All rows are [R] at `9d0c732c2`, except rows marked [O].

| Area | Fact | Anchor |
|---|---|---|
| Workspace | pnpm 9.15.4 workspaces: `packages/*`, `packages/adapters/*`, `packages/plugins/*`, `packages/plugins/examples/*`, `server`, `ui`, `cli` | `pnpm-workspace.yaml:1-14`, `package.json:112` |
| Task graph | None. `build` is `pnpm -r build` and `typecheck` is `pnpm -r typecheck`. No `turbo.json` exists at the root | `package.json:19, 21` |
| Image build | A hand-ordered chain of filtered builds: the plugin SDK, the plugins, the UI, the server | `Dockerfile:148, 168, 194` |
| CI | Unit tests run in 10 matrix lanes with a full install each. They do not block a merge yet (`continue-on-error`) | `.github/workflows/unit-tests.yml:3-10, 29-56` |
| CI | Every pull request builds the production image target | `.github/workflows/image-build-check.yml:27` |
| CI | `doc/` changes run the full gate. Only `docs/` and `screenshots/` are skipped | `scripts/ci/classify-changes.mjs:12-13` |
| Server | Express 5, drizzle-orm 0.45, ws 8, better-auth 1.7.2 | `server/package.json:81, 87, 89, 105` |
| UI | React 19.2, React Router 7.18, Vite 8, TanStack Query 5, Tailwind 4.3. Components follow shadcn "new-york". 167 files in `ui/src/pages` | `ui/package.json:54, 66, 71, 88, 90`; `ui/components.json:3` |
| Orchestration | `server/src/services/heartbeat.ts` has 34,886 lines. `heartbeatService` starts at `:10212` and `appendRunEvent` at `:14965` | `wc -l`; the two lines |
| Boot loops | In-process intervals: execution reconciliation, run usage records, heartbeat scheduler | `server/src/index.ts:1194, 1212, 1226` |
| Plugin jobs | An in-process plugin job scheduler | `server/src/app.ts:849` |
| Websockets | Three upgrade handlers on one HTTP server: remote runners (`/api/runner/v1/connect/*`), the setup terminal, live events | `server/src/index.ts:935, 970-974`; `server/src/realtime/runner-prp-ws.ts:16` |
| Live events | One in-process `EventEmitter`, so fan-out works only inside one process. 33 non-test publish calls | `server/src/services/live-events.ts:7, 28, 48` |
| Remote execution | SSH transport and sandbox providers (Daytona, E2B, Modal, Kubernetes and others) | `packages/adapter-utils/src/execution-target.ts:1377`; `packages/adapter-utils/src/ssh.ts:64`; `packages/plugins/sandbox-providers/` |
| Schema | 152 schema files, 239 `pgTable(` calls, 257 `jsonb(` columns, 5 `nullsNotDistinct` uniques, 316 SQL migrations | `packages/db/src/schema/`; `packages/db/src/migrations/`; for example `summary_slots.ts:31` |
| Row locks | 478 lines with `FOR UPDATE`, `.for("update")` or `SKIP LOCKED` in 100 non-test files | for example `server/src/modules/run-dispatch/adapters/postgres.ts:219, 231` |
| Advisory locks | 68 non-test lines with `pg_advisory*` | for example `server/src/routes/cases.ts:75`, `server/src/routes/projects.ts:284` |
| Transactions and SQL | 634 `.transaction(` lines and 1,607 raw `` sql` `` fragments in non-test `server/src` | grep counts |
| Counters | A per-company issue counter, raised inside the issue insert | `packages/db/src/schema/companies.ts:14`; `server/src/services/issues.ts:10321` |
| Search | Trigram GIN indexes on titles, identifiers and comment bodies. A relevance rubric that accepts ID forms such as `PAP-42`, `pap42` and `PAP 42` | `packages/db/src/schema/cases.ts:51-53`, `issue_comments.ts:63`; `doc/SEARCH.md:1-12` |
| Auth | better-auth with the drizzle adapter. Agent API keys are stored as SHA-256 hashes and looked up by hash. Board API keys have their own table | `server/src/auth/better-auth.ts:264, 312`; `packages/db/src/schema/agent_api_keys.ts:7, 21`; `server/src/middleware/auth.ts:71`; `packages/db/src/schema/board_api_keys.ts:4` |
| Company scope | `assertCompanyAccess`, with 288 call sites in `server/src/routes` | `server/src/routes/authz.ts:75` |
| Activity log | `logActivity`, written by mutations | `server/src/services/activity-log.ts:217` |
| Files | Storage providers for local disk and S3 | `server/src/storage/provider-registry.ts:6`; `server/src/storage/s3-provider.ts:84` |
| REST contract | 952 route handler lines (`router.get(` and the other methods, non-test). The OpenAPI document is defined in one file of 12,847 lines | grep count in `server/src/routes/`; `wc -l server/src/routes/openapi.ts` |
| CLI | `paperclipai` 0.3.1 calls REST through one HTTP client | `cli/package.json:2-3`; `cli/src/client/http.ts:53, 166` |
| Bridge | The sandbox callback bridge allowlist, synced with the skill. Its body limit is about 10 MiB | `packages/adapter-utils/src/sandbox-callback-bridge.ts:73, 165-170` |
| Skills | The skill calls REST paths, for example `GET /api/agents/me` | `skills/paperclip/SKILL.md:96` |
| Plugin SQL | Plugins get a SQL client for their own Postgres namespace, with read-only joins to some core tables. The wiki plugin uses it | `packages/plugins/sdk/src/types.ts:629-637`; `packages/db/src/schema/plugin_database.ts:16-22`; `packages/plugins/plugin-llm-wiki/src/wiki/core.ts:940` |
| Module seam | Feature modules with `domain`, `application` and `adapters` layers. A checker bans drizzle and Postgres imports outside `adapters/` | `server/src/modules/README.md:3-31`; `scripts/check-module-boundaries.mjs:11` |
| Install | Paperclip installs with `npx paperclipai onboard` and starts an embedded PostgreSQL when `DATABASE_URL` is unset | `README.md:355`; `doc/DATABASE.md:5-21` |
| Build contract | V1 names PostgreSQL through Drizzle as the store, with a single-tenant deployment and a multi-company data model | `doc/SPEC-implementation.md:36, 62, 107-110` |
| Fork | The fork tracks upstream `master`. Upstream publishing workflows are off on this fork | `VLLNT.md:3-8` |
| Convex today | A plugin manages a company's Convex Cloud deployments. A Convex team has a deployment quota (300) | `doc/convex-plugin.md:3-6`; `packages/plugins/plugin-convex/package.json:2` |
| Deploy | The app runs with a read-only root file system, `--max-old-space-size=1536` and a 2 GB memory limit in the compose file. Postgres 17 runs in a second service with 1 GB | `deploy/compose.yaml:9, 28, 38, 53, 60, 70` |
| Production [O] | The app container has a 3 GiB limit (an operator override), about 1.9 GB resident steady, and a main-process startup peak of 1,310 MiB. The Postgres dump is about 1.87 GB. Two live companies. A release drain holds runs for about 61 s | operator figures of 2026-10-21 |

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
| Concurrency | The S16 class: 16 queries, 16 mutations, 64 actions at once, 4 MiB/s of mutation writes. S256 (Pro): 256, 256, 512, 8 MiB/s |
| Transactions | Mutations are serializable through optimistic concurrency control. A write conflict is retried inside Convex several times. The docs advise selective indexed reads and few writes to one document |
| Determinism | Mutations "must be deterministic, and cannot call third party APIs". Node is for actions only |
| HTTP actions | Served on `<deployment>.convex.site`, or on a custom domain on Pro. Responses up to 100 MiB; multipart bodies up to 20 MiB; 64 MiB of memory. CORS is manual |
| Clients | `ConvexHttpClient` is stateful and must not be shared across server requests. `ConvexClient` subscribes over a websocket. `setAdminAuth` is internal, not a public API |
| Auth | Custom JWT providers (RS256 or ES256) and OIDC through `auth.config.ts`. Convex Auth is beta. `@convex-dev/better-auth` 0.12.5 needs `better-auth >=1.6.11 <1.7.0`. Its supported plugin list names neither the organization plugin nor the API key plugin |
| Search | One search field per index and up to 16 filter fields. BM25 ranking. Only the last term matches by prefix. No typo tolerance. At most 1,024 results scanned. Vector search runs in actions only |
| Files | Upload URLs expire after 1 hour. A file URL lets anyone with it read the file, and only deleting the file revokes it. An R2 component exists |
| Self-hosting | License FSL-1.1 with Apache-2.0 as the future license: the code may not be used to "create another product designed to compete with the hosted Convex Cloud", and each version becomes Apache-2.0 after two years. Storage: SQLite by default, or Postgres 17 or MySQL 8, ideally in the same region. "All the free-tier features" of Cloud. Upgrades go by export and import. No HA or scheduled backup procedure is documented |
| Local deployments | `npx convex dev` can run the backend as a local subprocess with no account; state lives in `.convex`. Beta, "not recommended for production use" |
| Import and export | `npx convex import` takes CSV, JSONL, JSON arrays (8 MiB at most) and ZIP files. Import is atomic per table unless `--append` is used. Import is the only way to keep given `_id` values. Streaming export (Fivetran) needs Pro; streaming import (Airbyte) is on all plans; both are beta |
| Plans and regions | Pro includes 25 M function calls, 50 GB of database storage and 300 deployments, with periodic backups and log streams. Regions: US East, EU (Ireland), Sydney, Canada; outside the US the price is 1.3x; a region cannot change later. The pricing page did not render for this plan, so seat prices are not quoted |
| Components | Sandboxed sub-backends with their own tables. A component call is a sub-transaction of the calling mutation. Published components include migrations 0.3.7, workpool 0.4.14, workflow 0.4.10, aggregate 0.3.3, sharded counter 0.2.3, rate limiter 0.4.2 and R2 0.10.4 |
| Turborepo | Add it to an existing pnpm workspace with `pnpm add turbo --save-dev --workspace-root`. Tasks use `dependsOn: ["^build"]`, `outputs` and `inputs`. Empty `outputs` cache only logs. The cache is local by default; a remote cache can be any server that implements the published API. `--affected` filters to packages changed on the branch. `turbo prune --docker` writes a pruned workspace and lockfile. Nested packages are not supported |
| Next.js | 16.4.2 needs Node 20.9 or newer. The App Router uses a built-in React canary. `middleware` is now `proxy`. `output: "standalone"` cannot be used with a custom server. Several instances need a shared cache handler |
| better-auth | 1.7.12. An API key plugin (`@better-auth/api-key`; its 1.7.x line needs better-auth 1.7) and an organization plugin |

**The `@vllnt/*` packages** (npm registry, 2026-10-21; repositories under `github.com/vllnt`):

| Package | Version and maturity | Fit (section 5.4) |
|---|---|---|
| `@vllnt/convex-helpers` | 0.1.0, 11 releases since 2026-06-14, MIT, peer `convex ^1.45.0`. "Typed host-side helpers for Convex backends — builders, errors, validators, relationships" | **Adopt** for the custom function builders (company scope, actor) and validators |
| `@vllnt/convex-idempotency` | 0.1.0, MIT, component | **Adopt** for retried Node-to-Convex writes |
| `@vllnt/convex-events` | 0.1.0, MIT, component, "append-only per-subject activity feed" | **Evaluate in C0** as the activity log store |
| `@vllnt/convex-api-keys` | 0.2.0, 15 releases, Apache-2.0. SHA-256 hashes, its own key prefix format, and `validate` is a mutation that tracks usage | **Not for agent keys at first:** it cannot import today's keys without a re-issue, and a write on every agent request makes the key document hot |
| `@vllnt/convex-permissions`, `@vllnt/convex-memberships` | 0.1.0 each, MIT, components (RBAC; ReBAC tuples) | **Skip for now.** Paperclip has its own grants and memberships model. Revisit in the access domain wave |
| `@vllnt/convex-notifications`, `-comments`, `-invitations`, `-slugs`, `-flags`, `-metering`, `-tokens` | 0.1.0 each, MIT, components | **Case by case** in each domain's Shadow slice. Use one only when its data model matches Paperclip's without a translation layer |
| `@vllnt/convex-mcp` | 0.3.1, MIT, exposes Convex functions as MCP tools | **Skip.** Paperclip's MCP surface stays in the Node tier (section 6.3) |
| `@vllnt/ui` | 0.3.0, 97 releases, MIT. Radix, CVA and Tailwind; peers `react >=19`, `next >=14`, `tailwindcss >=3`. The source has a Gantt chart (`packages/ui/src/components/organisms/gantt-chart/`) | **Adopt per component** where `DESIGN.md`'s token-only rule holds. Do not swap components wholesale |
| `@vllnt/typescript`, `@vllnt/eslint-config` | 2.0.0 each, MIT | **Optional.** Paperclip has its own TypeScript base and gates |
| `@vllnt/logger` | 0.1.2 | **Skip.** One log format (pino) stays |
| `create-vllnt-app` (repository) | Scaffolds Turborepo with `packages/backend` (Convex), `packages/client` (hooks) and apps. Rule: apps never import Convex directly; `@repo/client` is the single entry (`cli/templates/fullstack/AGENTS.md:38-39, 73` in that repository). Convex can run on Cloud or self-hosted with the same app code (its `README.md`) | **Adopt the layout and the client rule** (section 4.2) |

Every `@vllnt/*` Convex package is pre-1.0. Pin exact versions. Fix a defect in the package's own repository, which is outside this plan.

## 4. Target architecture

### 4.1 Shape

```
 browser ─HTTPS─> ingress ─> Node tier (server/, Express)        ─────────────┐
   │                          ├─ /api/*  REST façade (paths, OpenAPI, CLI,     │
   │                          │          bridge, skills unchanged)             │
   │                          ├─ ws: /api/runner/v1/connect/*, setup terminal, │
   │                          │      live events (shrinks per domain)          │
   │                          ├─ /mcp/*, /_plugins/*, /llms/*, runtime tools   │
   │                          ├─ auth: better-auth sessions, agent and board   │
   │                          │        keys, JWT minting + JWKS (section 4.5)  │
   │                          ├─ orchestrator: wakes, claims, runs, recovery,  │
   │                          │   agent processes (local, SSH, sandboxes),     │
   │                          │   plugin workers and jobs, file storage        │
   │                          └─ GET/HEAD pages ─> Next.js process (apps/web)  │
   │                                                                           │
   └── Convex client (websocket, user JWT) ──────────> Convex backend <────────┘
       reactive reads of migrated domains              (queries, mutations,      Node tier calls Convex
       (through packages/client hooks)                  scheduled functions,     with a service JWT that
                                                        components)              carries the acting actor
```

- **Convex** owns the data of every migrated domain: documents, indexes, transactions, reactive queries, the activity rows of those domains, and scheduled clean-up.
- **The Node tier** owns every long-running process and every outside call. Today's server is that tier. It shrinks as domains move: its services become thin adapters behind module ports (section 4.4).
- **Next.js** owns pages. It reads through REST on the server (M0 to M1) and, for migrated domains, through Convex in the browser (section 4.9).

### 4.2 Repository layout and Turborepo

| Path | Role | When |
|---|---|---|
| `turbo.json` (root) | The task graph: `build`, `typecheck`, `test`, `lint`, `dev`, with `^build` dependencies | T0 |
| `ui/` | The Next.js app. It moves to `apps/web/` only after MF, if at all; Turborepo does not need the move | Next.js lane |
| `packages/backend/` | `convex/`: schema, functions, `auth.config.ts`, `convex.config.ts` with components | C1 |
| `packages/client/` | Typed hooks. It grows out of `ui/src/api/*`. A hook calls Convex for a migrated domain and REST for the others. Pages import only this package | C1, then each domain |
| `packages/shared/` | zod validators and types stay the contract of REST, the CLI and OpenAPI. Convex validators come from the same shapes where possible | unchanged |
| `server/` | The Node tier and the REST façade | unchanged path |
| `packages/db/` | Drizzle and Postgres, until the retirement step | removed in phase 6 |

Turborepo rules: `turbo ls` must list exactly the packages that pnpm lists. Packages whose builds have side effects (the Rust runner, the plugin SDK's `ensure-build-deps`) start with `cache: false` until their `inputs` and `outputs` are proven.

### 4.3 What Convex owns, and the rules its limits impose

| Convex limit [S] | Rule in this plan |
|---|---|
| 1 s of user code per query or mutation | Mutations do one logical step. Long work runs in the Node tier or in a workpool of actions |
| 32,000 documents scanned and 16 MiB read per transaction | Every read uses an index whose prefix is `companyId`. Lists are paginated. A bulk change is a paginated migration (the migrations component), never one mutation |
| 16,000 documents and 16 MiB written per transaction | Imports and backfills run in batches of at most 500 documents [A, measured in C0] |
| 1 MiB per document, 8,192 array elements | Large text stays in documents of its own (comment bodies, run log chunks). Unbounded arrays become child tables |
| No outside calls in mutations | Outside calls (GitHub, providers, SSH) run in the Node tier, or in actions that call mutations |
| Optimistic concurrency, retried inside Convex | Hot documents (a company counter, a run's status document) get few writers. Section 7.2 maps each lock pattern |
| Mutation write throughput (4 MiB/s on S16, 8 MiB/s on S256) | The run log is the highest-volume writer. C0 measures its bytes per second on production-shaped load before the runs domain is planned |

### 4.4 The Node runtime tier

What stays in Node, and why:

| Concern | Today | Why it stays in Node |
|---|---|---|
| Agent processes (local, SSH, sandboxes) | `packages/adapter-utils/src/execution-target.ts:1377`, `packages/plugins/sandbox-providers/` | Child processes, file systems and SSH sessions cannot run in a Convex function. A Node action runs for 10 min at most [S] |
| Remote runner and setup terminal websockets | `server/src/index.ts:970-971` | Long-lived bidirectional sockets with per-run state |
| Orchestration loops | `server/src/index.ts:1194, 1212, 1226` | They control processes. They move their **state** to Convex: claims and status writes become mutations, and Convex scheduled functions can replace a timer only where no process control is needed |
| Plugin workers and jobs | `server/src/app.ts:849` | Plugins run code from outside the repository |
| MCP endpoints, runtime tools, `/llms/*` | `server/src/routes/connection-intents.ts:90` | Contract surfaces (section 6) |
| File storage | `server/src/storage/` | Private files with an auth check on each read (section 4.7) |
| REST façade | `server/src/routes/` | Section 6.1 |

How the Node tier reads and writes Convex:

- One Convex client module, behind the existing module ports (`server/src/modules/README.md:16-23`). A port gets a second adapter, `adapters/convex.ts`, next to `adapters/postgres.ts`. The store router (section 7.6) chooses one per domain and company.
- Per request, a fresh `ConvexHttpClient` with the acting actor's service JWT, because the client is stateful [S]. Long-lived subscriptions (the outbox drain of section 7.4, the run board) use one `ConvexClient` per purpose.
- Every write from Node carries an idempotency key, so that a retry after a network error does not apply twice (`@vllnt/convex-idempotency`).
- Latency matters. Today one heartbeat step can run several SQL statements against a Postgres on the same host. Each Convex call costs one network round trip. C0 measures the round trip from the server to each hosting option, and the heartbeat design batches one logical step into one mutation.

### 4.5 Auth

- **better-auth stays in the Node tier as the identity provider.** Sessions, the cookie names and the board API keys work as today (`server/src/auth/better-auth.ts:312`).
- **Convex trusts the Node tier through a custom JWT provider** (`auth.config.ts`: issuer, JWKS URL, ES256 [S]). The Node tier signs short-lived tokens and serves its JWKS. Two kinds of token:
  - a **user token** for the browser's Convex client, from an authenticated REST endpoint, with `sub` equal to the user id and a lifetime of a few minutes;
  - a **service token** for the Node tier's own calls, with the acting actor (board user, agent, run) and the company in custom claims.
- **Agent API keys stay hashed and are checked in Node.** The hash lookup moves with the access domain (`packages/db/src/schema/agent_api_keys.ts:21` becomes a Convex index on `keyHash`). Agents never call Convex directly; they call REST (section 6).
- **Every public Convex function checks identity.** A public function can be reached by anyone who knows the deployment URL. So each one goes through a builder that rejects a call without a valid token, and functions that only the Node tier may call are internal or check the service claim.
- **Why not `@convex-dev/better-auth` now:** it needs `better-auth <1.7.0` and the server runs 1.7.2, and its supported plugin list does not name the organization or API key plugins [S]. Revisit when the component supports 1.7 (user decision U5).

### 4.6 Company scoping and multi-tenancy

- Every Convex table of a company domain has `companyId`, and every index starts with it.
- A custom query builder and a custom mutation builder (from `@vllnt/convex-helpers`) resolve the actor from the token, load its membership and grants, and give the handler a company-checked context. They replace `assertCompanyAccess` (`server/src/routes/authz.ts:75`) for that domain.
- Board-only actions, approval gates and company boundaries apply exactly as today (`AGENTS.md:144`).
- The activity entry of a mutation is written in the same mutation, so the rule "activity logging for mutating actions" holds inside one transaction (`server/src/services/activity-log.ts:217` today).
- Instance-wide records (instance settings, announcement dismissals) live in tables without `companyId`, and their builders check instance roles instead.

### 4.7 Files and storage

- File **bytes** stay in today's storage providers (`server/src/storage/provider-registry.ts:6`). Reads stay behind the REST auth check.
- File **metadata** moves to Convex with its domain.
- Convex file storage is not used for private attachments: a file URL lets anyone with it read the file, and only deleting the file revokes it [S]. Convex storage is acceptable for public assets such as company logos.

### 4.8 Search

- Today: trigram GIN indexes and a rubric that accepts loose ID forms (`packages/db/src/schema/cases.ts:51-53`, `doc/SEARCH.md:1-12`).
- Convex text search ranks by BM25, matches only the last term by prefix, has no typo tolerance and scans at most 1,024 results [S]. A substring such as `pap42` does not match `PAP-42` by itself.
- Plan:
  - identifiers get a normalized key field and an index (an exact or prefix range read);
  - text gets one search index per searchable kind, over a denormalized `searchText` field with `companyId` as a filter field;
  - the `doc/SEARCH.md` rubric becomes a golden test suite that the issues domain must pass before its flip;
  - until it passes, search keeps reading the Postgres mirror (section 7.4), which keeps its trigram indexes.

### 4.9 Realtime

- Today one in-process `EventEmitter` fans out live events (`server/src/services/live-events.ts:7`). It cannot cross processes.
- For a migrated domain, the browser reads through Convex reactive queries in `packages/client` hooks. The live-events socket no longer carries that domain's change events.
- Writes keep going through REST during the transition. The REST path also runs the domain's guards and its activity log, and it keeps the CLI and agents on one write path.
- The live-events socket stays for domains that are still on Postgres, and for high-rate streams (run log tails) until the runs domain is decided.
- The runner and terminal sockets stay in the Node tier for good.

### 4.10 Hosting: self-hosted Convex or Convex Cloud

| Factor | Self-hosted, next to the server [S] | Convex Cloud [S] |
|---|---|---|
| Latency from the Node tier | Same host: no WAN round trip | One WAN round trip to the region per call; the production host's region is not in this repository |
| Operations | One more stateful service. Upgrades by export and import. No documented HA or scheduled backup; the plan adds nightly exports (section 7.9) | Managed. Periodic backups on Pro |
| Memory on the host | Adds the backend's resident memory to a container budget that is already at about 71 % [O]. Measured in C0 | None on the host |
| Storage engine | SQLite by default, or Postgres 17, the version that already runs in the compose file (`deploy/compose.yaml:60`) | Managed |
| Cost | Host resources only | Pro: 25 M function calls included, then a price per extra million. Agent traffic per month is unknown and C0 estimates it |
| Data residency | On the operator's host | A chosen region, fixed at creation; 1.3x outside the US |
| License | FSL-1.1: no competing hosted product. Paperclip is not one, but the maintainer confirms (U8) | Cloud terms |
| Feature set | "All the free-tier features" of Cloud | All plan features |
| Installs (`npx paperclipai onboard`, `README.md:355`) | The CLI would start a local backend next to the server. Local deployments are beta and "not recommended for production use", so a production install runs the self-hosted backend binary or image | Each install needs a Cloud account |

**Recommendation (U2):** self-hosted, on the same host, for production, if C0 shows the backend fits the memory budget. Its own database lives in the existing Postgres 17 service during the transition, and SQLite is the alternative. Cloud stays available for engineers' preview deployments. G1 decides with numbers.

### 4.11 Development and tests

- `pnpm dev` starts a local Convex deployment next to the server. No account is needed [S].
- Unit tests of Convex functions use `convex-test` (0.0.63, pre-1.0) with an in-memory backend. Integration tests run against a local backend started by the test runner, as embedded Postgres is today.
- CI adds one job: Convex code generation and typecheck of `packages/backend`, and its tests. The job joins the image-build check only once the image contains the backend (C1).

## 5. Decision records

### 5.1 Turborepo

- **Decision:** add Turborepo as the task runner of the existing pnpm workspace, in three slices (T0 to T2, section 8.0).
- **Alternatives:**
  - keep `pnpm -r`: no cache, and every CI lane rebuilds everything;
  - Nx: more features, but a larger tool and its own project model;
  - Lage or moon: smaller communities, no match with the maintainer's other repositories (`create-vllnt-app` uses Turborepo).
- **Costs and risks:**
  - one dev dependency with a native binary, installed under the disk floor and the 7-day install cooldown;
  - wrong `inputs` or `outputs` give stale cache hits, so side-effect builds start uncached;
  - no remote cache in T0. A remote cache needs a token and a server, which is a user decision (U10).
- **Removed:** `pnpm -r` in root scripts (T0). The hand-ordered filtered builds in the `Dockerfile` (T2, only if the image build check stays green and the image is byte-equivalent in content).

### 5.2 Convex as the system of record

- **Decision (requested by the maintainer):** move the data of every domain to Convex, one domain at a time, gated by C0 and G1.
- **Alternatives:**
  - **stay on Postgres**, with the Effect plan for reliability. The lowest risk and no new runtime. It does not give reactive queries or the maintainer's Convex stack;
  - **Postgres plus a sync engine** for realtime (for example ElectricSQL or Zero). It keeps SQL, but it is a second system to run;
  - **Convex** (chosen): reactive queries, serializable transactions, typed functions, the maintainer's components. The cost is a rewrite of the data layer, and of every SQL-specific behavior.
- **Costs and risks:** sections 7 and 9. The largest: the heartbeat's lock-based claims (section 7.2), the plugin SQL contract (section 6.6), search (section 4.8), install size (section 4.10), and the end of upstream syncs (section 5.7).
- **Removed at the end:** drizzle and the migration journal, embedded Postgres in dev, the in-process live-events fan-out for data changes, the 68 advisory-lock sites and the 478 row-lock lines (as SQL; their semantics move to section 7.2).

### 5.3 Next.js

- **Decision (already taken in the Next.js plan):** migrate `ui/` to the App Router, route by route. This plan changes nothing in M0 to MF, apart from the two M0b rules of section 1.
- **After M0b:** a page reads through `packages/client` hooks. For a migrated domain, a client component subscribes with Convex. A server component keeps the REST read for the first paint, until Convex's Next.js server rendering leaves beta and a slice measures it.
- **No Server Actions** stays the rule. Convex mutations, called through REST during the transition, are the write path.

### 5.4 The `@vllnt/*` packages

- **Decision:** the adopt, evaluate and skip list in section 3.
- **Alternatives:** the general-purpose `convex-helpers` (0.1.128) and the `@convex-dev/*` components. They stay in use where no `@vllnt/*` package covers the need (migrations, workpool, aggregate, rate limiter).
- **Risks:** pre-1.0 packages with one maintainer. Pin exact versions. Each adoption has a small spike test in the slice that adopts it.
- **Removed:** nothing today. Paperclip uses no published `@vllnt/*` package yet; its three in-repo plugins only carry the scope name (`packages/plugins/plugin-convex/package.json:2`).

### 5.5 The auth bridge

- **Decision:** better-auth in Node, custom JWT to Convex (section 4.5).
- **Alternatives:** `@convex-dev/better-auth` (blocked by the version range); Convex Auth (beta, and no CLI setup on self-hosted [S]); a hosted IdP (a new vendor and a data path).
- **Costs:** a JWKS endpoint and key rotation in the Node tier.
- **Removed:** nothing until the access domain moves. Then better-auth's tables need a store: either keep them in a small Postgres, or move them when the component supports better-auth 1.7 (U5).

### 5.6 The Effect lane

- **Decision:** stop E0b and every later slice. Keep #319, E0a and the retry predicate fix in plain TypeScript.
- **Why:** Convex replaces the service layer that Effect would sit under (`doc/plans/2026-10-10-backend-effect.md:10-14`).
- **Reopens:** if G1 or a later gate kills Convex, the Effect plan resumes as written. If Convex goes ahead, Effect may come back for the Node tier's process control only, after G1.

### 5.7 The relationship with upstream

- **Fact:** the fork merges upstream `master` (`VLLNT.md:3-8`), and #275 is the open sync.
- **Effect of this plan:** upstream changes to a migrated domain's services or schema can no longer merge mechanically. Each one becomes a manual port into Convex. After the runs domain moves, upstream merges reach only code that does not touch data: adapters, the adapter utilities, skills, and parts of the UI.
- **Decision for the maintainer (U4):** settle #275 (merge or close) before C1, then treat upstream as a source for cherry-picks, not a merge target.

## 6. Contract preservation

### 6.1 REST and OpenAPI: a façade

- The Express routes stay. A route of a migrated domain calls its module's use case, and the use case calls the Convex adapter instead of drizzle. Paths, status codes, JSON shapes and the OpenAPI document do not change.
- The façade **stays after the migration**. Reasons:
  - one origin and the same cookie and key auth;
  - the CLI, the bridge allowlist, the skills and the rate limiters stay on the same paths;
  - Convex HTTP actions would need a rewrite of 952 route handlers, would run in 64 MiB, and would answer on `convex.site` unless the plan pays for a custom domain on Pro [S].
- New capabilities still ship on the web UI, REST with OpenAPI, and the CLI in one pull request (`AGENTS.md:141`).

### 6.2 The CLI

Unchanged. It calls REST through `cli/src/client/http.ts:53`.

### 6.3 The runner API, websockets and MCP

Unchanged, in the Node tier: `/api/runner/v1/connect/*` (`server/src/realtime/runner-prp-ws.ts:16`), the setup terminal, the MCP routes (`server/src/routes/connection-intents.ts:90`) and the runtime tools.

### 6.4 The bridge allowlist and the skills

- The allowlist matches REST paths (`packages/adapter-utils/src/sandbox-callback-bridge.ts:170`). The paths do not change, so the list does not change.
- The skill calls the same paths (`skills/paperclip/SKILL.md:96`).

### 6.5 Control-plane invariants

| Invariant | How it holds on Convex |
|---|---|
| Single assignee | The assignee is one field. The assign mutation reads and writes the issue in one transaction |
| Atomic checkout | The checkout mutation reads the issue and its active run and writes the claim. Two concurrent checkouts conflict, and Convex retries the loser, which then sees the claim (section 7.2) |
| Approval gates | The gated mutation reads the approval in the same transaction |
| Budget hard stop and auto-pause | The cost write and the budget check run in one mutation. The pause is a write in the same mutation |
| Activity log for mutations | Written in the same mutation (section 4.6) |

### 6.6 The plugin SDK

- Plugins get raw SQL on a Postgres namespace (`packages/plugins/sdk/src/types.ts:629-637`). Convex cannot serve that.
- Options (U6):
  - **keep a Postgres for plugin namespaces only**, with read-only mirrors of the core tables that plugins may join today. This is the recommendation for the transition: no plugin breaks;
  - a new document-store API in the SDK, with SQL deprecated over a release window;
  - both: the new API for new plugins, Postgres for old ones.
- The plugin state, entity and job tables (`plugin_state`, `plugin_entities`, `plugin_jobs`) move like any other domain, behind the same SDK calls.

### 6.7 Contract tests

- A **golden suite** per domain: recorded REST requests and responses (status, shape, ordering, pagination cursors) taken from the Postgres path. The Convex path must give the same answers. It runs in CI and against production for the test company (section 8.7).
- The OpenAPI document (`server/src/routes/openapi.ts`) stays as it is. A diff check fails if a migration slice changes it.

## 7. Data migration: Postgres to Convex

### 7.1 Model translation rules (also the rules for new Postgres tables now)

| Postgres | Convex |
|---|---|
| `uuid` primary key | Keep it as an indexed field (`uuid`). It stays the REST and CLI id. Convex's `_id` is internal |
| Foreign keys and `onDelete` cascades | Id fields, checked in the write path. A cascade becomes a paginated deletion through the migrations component, started by the delete mutation |
| Unique index | An index and a read-before-insert in the same mutation (serializable, so safe [S]) |
| `nullsNotDistinct` unique | A normalized key field (null as a fixed token) with an index |
| `jsonb` column | A typed nested value with a validator, below 1 MiB per document and 8,192 array elements |
| `timestamptz` | Milliseconds since the epoch |
| Counter column (`companies.issue_counter`) | A field on one parent document, raised in the same mutation. Expect contention only when many creates hit one company at once |
| Keyset pagination | Convex `paginate` on an index |
| Trigram search | Section 4.8 |
| Triggers, sequences, advisory locks | Not allowed in new tables now. Section 7.2 maps the old ones |

### 7.2 The transaction model: locks and optimistic concurrency

| Pattern today [R] | Convex equivalent |
|---|---|
| `SELECT … FOR UPDATE` on a row, then a write (478 lines, for example the run dispatch claim at `server/src/modules/run-dispatch/adapters/postgres.ts:219, 231`) | Read the document in the mutation, then write it. The read set makes a concurrent writer conflict. Convex retries it, and the retry sees the new state |
| `FOR UPDATE SKIP LOCKED` queue claims | A mutation picks the first unclaimed item by index and claims it. Under contention, several workers would retry on the same item, so claims spread across index ranges (for example by run id), or the workpool component runs them. C0 measures the conflict rate |
| `pg_advisory_xact_lock(key)` (68 lines, for example `server/src/routes/cases.ts:75`) | Usually unnecessary, because the mutation itself is serializable. Where code must serialize across several mutations, a lock document per key, written in each one |
| A long transaction with process control inside it | Split it: a mutation claims the step, the Node tier does the I/O, a second mutation records the result. Each call has an idempotency key |
| Retries of transient database errors (`server/src/database-retry.ts:39-52`) | Convex retries write conflicts itself. The Node tier retries network errors with the idempotency key |

### 7.3 The lifecycle of one domain

```
   Postgres is the system of record                 Convex is the system of record
 ┌──────────────┐   ┌──────────────┐   ┌───────────────────────────┐   ┌──────────────┐
 │ S: Shadow    │──>│ V: Verify    │──>│ F: Flip, company by       │──>│ R: Retire    │
 │ capture +    │   │ diff = 0 for │   │ company (test company     │   │ drop capture │
 │ backfill to  │   │ 48 h; golden │   │ first); reverse mirror    │   │ and mirror   │
 │ Convex       │   │ suite passes │   │ keeps Postgres current    │   │ after 7 days │
 └──────────────┘   └──────────────┘   └───────────────────────────┘   └──────────────┘
        rollback: drop the shadow            rollback: flip the company back,
                                             with no data loss inside the window
```

### 7.4 Capture and backfill

- **Capture during Shadow.** A temporary trigger on each table of the domain writes the changed row as JSON into one capture table. A Node worker drains it in order and upserts into Convex by `uuid`, applying a change only when its sequence is newer than the one the document holds. Deletes are captured as tombstones.
  - Why triggers, although new tables must not use them: the server has 1,607 raw SQL fragments and 634 transactions, so capture inside the application would miss write paths. The triggers are migration tooling. They are dropped in Retire, and they pass the migration safety checks of `doc/DATABASE.md:215-226` or the slice stops.
  - Logical replication would avoid triggers, but it needs `wal_level=logical` on the database service, which is a deploy change (U7).
- **Backfill.** Batches of at most 500 rows by keyset order, through the same idempotent upsert. A table above about 1 GB uses `npx convex import` with JSONL into an empty table, before capture starts, then capture catches up [S].
- **Reverse mirror after Flip.** Each Convex mutation of the domain writes an outbox document in the same transaction. The Node tier subscribes to the outbox and writes the rows back to Postgres. So:
  - Postgres tables of domains not yet moved keep their joins and foreign keys;
  - search and reports can keep reading Postgres until their own slices move;
  - the activity rows of migrated domains reach today's `activity_log` too, so the activity feed stays complete until the activity reads move;
  - a rollback finds Postgres current.
- **No loop.** The mirror writes with a session setting that the capture triggers check, so a mirrored row is never captured again. A test proves it in C1.4.

### 7.4a Writes that cross two domains

- Today one SQL transaction can write the tables of two domains. For example, an issue insert raises the company's counter in the same statement (`server/src/services/issues.ts:10321`). When one of the two domains is on Convex, that write spans two stores and has no single transaction.
- **Rule 1: the write-coupling graph decides the waves.** C0 builds the graph: for each `db.transaction` block and each multi-table statement, the tables it writes. Its sources are a static scan of the 634 transaction blocks and the statement census of the backend harness (`tests/perf/backend/lib/census.mjs:2-5`). Tables that one transaction writes together move in the same wave, or the write is split first, in a plain refactor slice on Postgres.
- **Rule 2: a split write is a saga with an idempotency key.** The use case writes the Convex side first, then the Postgres side. A failure on the second step retries with the same key, or runs the compensating mutation. The reverse mirror makes the reads converge.
- **Rule 3: live updates keep working for pages not yet on Convex.** The REST write path publishes today's live event after the Convex mutation succeeds.
- **Company removal** (`server/src/services/companies.ts:629`) deletes in both stores. For migrated domains it starts a paginated Convex deletion and waits for it, so a removed company leaves no rows in either store.
- **Instance-wide tables** (no `companyId`) flip once for the whole instance, after every company's flip of the same domain.

### 7.5 Verification

- A **diff checker** in the Node tier compares each company's rows by `uuid`: counts and a hash of the normalized row. It reports mismatches with their age.
- **Gate V:** 0 mismatches older than 60 s, for 48 hours, on production. The domain's golden suite passes against both stores.
- **Dual read** on the façade for a sample of GET requests in Verify: the answer comes from Postgres, the Convex answer is compared and logged.

### 7.6 Cutover, company by company

- A **store router** in the Node tier holds, per domain, the store of each company (`postgres` or `convex`).
- The test company flips first. The live companies flip only after the test company has run for at least 48 hours with the gates of section 8.7 green, and only on the maintainers' go.
- The flip of one company:
  1. stop capture for that company;
  2. drain capture to zero;
  3. check that the diff is zero;
  4. switch the router;
  5. start the reverse mirror.

  Writes for that company wait for the switch. The wait is seconds [A], shorter than the release drain of about 61 s [O].
- **Instance-wide reads** (lists across companies, instance admin pages) read both stores during the transition, through the façade.

### 7.7 Rollback

| When | How | Data loss |
|---|---|---|
| During Shadow or Verify | Stop capture and drop the Convex tables of the domain | None. Postgres stayed the system of record |
| After Flip, inside the window (7 days) | Switch the company back in the router. The reverse mirror kept Postgres current | None, apart from writes that are still in flight in the mirror at the switch. The switch waits until the mirror outbox is drained |
| After Retire | Restore from the Convex export into Postgres with a one-off script | Up to the last export. That is why Retire waits 7 days and needs the maintainers' go |

### 7.8 The last domains and the end of Postgres

- The runs domain (`heartbeat_runs`, `heartbeat_run_events`, run usage) moves last. Its write volume decides whether the run log goes to Convex or stays in an append-only store in the Node tier (C0 measures it; U9).
- Postgres can end only when the plugin SQL question (section 6.6), the auth tables (section 5.5) and the run log are settled. Until then Postgres shrinks to those parts.
- At the end, `doc/SPEC-implementation.md` (the store, `:62, 107-110`) and `doc/DATABASE.md` get additive updates in the same slice, as `AGENTS.md` rule 4 asks.

### 7.9 Backups

- Until Retire of the last domain: today's Postgres dumps continue.
- From the first Flip: a nightly `npx convex export` with file storage, kept with the same retention as the database dumps. A monthly restore drill into a throwaway deployment proves it.

## 8. Phased plan

### 8.0 Phase 0: now (no data moves)

| Slice | What | Lane | Size | Acceptance | Verify in production |
|---|---|---|---|---|---|
| T0 | Root `turbo.json` with `build`, `typecheck`, `test` and `dev` (`^build`, local cache), root scripts on `turbo run`, `.turbo` in `.gitignore`. No Dockerfile or deploy change | remote | S | `turbo ls` equals the pnpm package list. `turbo run build` gives the same `dist` contents as `pnpm -r build`. A second run is a full cache hit. The image build check is green | Health shows the merge commit. Nothing else changes at run time |
| T1 | CI: `turbo run typecheck test --affected` with an `actions/cache` of `.turbo` in the lanes that build | remote | S | CI time per lane before and after, at least 5 runs each. No lane skips a package that changed | none (CI only) |
| T2 | The Dockerfile build chain becomes `turbo run build --filter=@paperclipai/server...`, optionally on `turbo prune --docker` | remote, risky | M | The same files in the production image (a content diff). Image build time before and after | Standard release checks |
| R0 | The rules of section 7.1 go into `doc/DATABASE.md` as "Convex-ready tables", so that every feature session sees them | remote | S | Docs only | none |
| — | The Next.js lane: H, M0, M0b, M0c, M1, then M2 to M10 and MF, as its plan says, with the two M0b rules of section 1 | as planned | — | as planned | as planned |

### 8.1 Phase 1: the spike (C0) and gate G1

C0 runs on a throwaway branch and is never merged. Its report becomes one docs pull request.

- Port one read-and-write domain end to end (policies, `company_policies` on #346), with the auth bridge, the company builder and the golden suite.
- **Measure:**
  - (a) the round trip of a trivial mutation from the server, p50 and p95, for a self-hosted backend on the same host and for Cloud in the nearest region;
  - (b) the conflict and retry rate of a claim mutation with 20 concurrent claimers;
  - (c) the backend's resident memory at idle and under (b);
  - (d) the run log write volume on a production-shaped fixture, in bytes per second at the peak;
  - (e) function calls per day, extrapolated from the request counts of a production-shaped fixture, for the Cloud cost estimate;
  - (f) the dev and install path: `pnpm dev` and the CLI onboarding with a local backend, on a clean machine;
  - (g) the write-coupling graph of section 7.4a, and the wave order of section 8.3 checked against it.
- **G1 passes when all of these hold:**

| Check | Pass |
|---|---|
| Mutation round trip, self-hosted on the same host | p95 ≤ 10 ms [A] |
| Claim conflicts | ≤ 1 % of claims fail after Convex's own retries |
| Memory | The backend adds ≤ 512 MiB resident at the peak, or the operator approves a larger host |
| Run log volume | The peak is below half of the deployment class's write throughput, or the run log stays in Node (U9) |
| Golden suite | 100 % equal for the policies domain |
| Install path | `pnpm dev` works with no Convex account. An install script can start the backend |
| Coupling | The write-coupling graph exists. No wave of section 8.3 needs more than 3 split writes; any wave that does is reordered or merged first |

- If G1 fails, the maintainers decide with the numbers. The recommendation is then to stop (section 9).

### 8.2 Phase 2: the foundation (C1)

| Slice | What | Size |
|---|---|---|
| C1.1 | `packages/backend` (schema skeleton, `auth.config.ts`, components config), `packages/client` (hook entry, the rule "pages import only this package" as a lint rule) | M |
| C1.2 | Node tier: JWT signing, JWKS, the user token endpoint (with OpenAPI and a CLI command for parity), the service token | M |
| C1.3 | Node tier: the Convex client module, the store router, the idempotency keys | M |
| C1.4 | Capture tooling: the capture table and trigger generator, the drain worker, the backfill runner | M |
| C1.5 | The diff checker and the golden suite runner | M |
| C1.6 | Dev and CI: a local backend in `pnpm dev` and in the integration tests, `convex-test`, the CI job | M |
| C1.7 | Deploy: the backend service and its backups. A deploy-file change goes to the deploy operator as a decision (U7). This slice stops until that decision | S plus the operator's change |

Acceptance for each: unit tests, the module boundary check, and no behavior change for any domain (every company routes to Postgres).

### 8.3 Phase 3: domain waves

Each domain ships as S, V, F and R slices (section 7.3), plus one UI slice that moves its hooks to Convex reactive reads. Order, from low to high coupling:

| Wave | Domains (schema files) | Why this order |
|---|---|---|
| 3a | Policies (#346); Databases and datasets (#347) | New, few readers. Built now with the rules of section 7.1. The datasets filter compiler needs bounded pages (section 1 and its plan's 4 MiB page rule) |
| 3b | Preferences and dismissals (`*_sidebar_preferences`, `inbox_dismissals`, `announcement_dismissals`), feedback, status cards | Per-user data with little coupling |
| 3c | Documents and annotations, labels, folders, goals, routines and routine documents | Content with clear owners |
| 3d | Decisions, approvals, cases and pipelines, work assessments | Governance objects. Approval gates move with them (section 6.5) |
| 3e | Projects, workspaces, environments, skills, plugins' state, entities and jobs, connections and chat channels | Configuration. Plugins keep their SQL namespaces (section 6.6) |
| 3f | Companies, memberships, invites, join requests, grants, API keys, secrets (with a security review), instance settings | Access. The JWT claims and the builders switch to the Convex membership tables here |

### 8.4 Phase 4: issues

- The `issues` table and every `issue_*` table, comments, attachments' metadata, relations, read states and the activity feed's issue rows.
- Prerequisites: the search golden suite (section 4.8), the per-company counter under load, checkout semantics (section 6.5).
- Split into several S, V and F slices by sub-domain (core issue, comments, relations, read states), all flipped together per company.

### 8.5 Phase 5: agents, heartbeat and runs

- **First, carve the heartbeat into modules** behind ports, without a store change: the run dispatch and the wake queue are already modules (`server/src/modules/`). The 34,886-line service splits into claims, run lifecycle, recovery, the run log and cost recording, each with a Postgres adapter. This is 20 to 40 pull requests [A]. It also helps if Convex is stopped.
- Then the agents domain (agents, runtime state, task sessions, wakeup requests, config revisions), then runs and costs, with the Convex adapters.
- The run log follows U9.
- Each risky slice ships alone in its release window, with the release drain.

### 8.6 Phase 6: retire Postgres

- Drop the capture triggers and the reverse mirrors.
- Remove drizzle and embedded Postgres from the paths that no longer need them.
- Keep Postgres only for what section 10 decides to keep (plugin namespaces, auth tables, run log).
- Update `doc/SPEC-implementation.md` and `doc/DATABASE.md` additively.

### 8.7 Checks every slice passes

1. CI green at the head that merges, including the image build check.
2. An independent review at that head with no open blocker or major.
3. The module boundary check and the golden suite of the domain.
4. For UI changes: a real browser at 1440 and 390 px with zero console errors, on a local instance with a throwaway data directory.
5. Parity: a slice that adds a capability adds it to the web UI, REST with OpenAPI, and the CLI.
6. **Verify in production**, after the release, in the test company only, with `[qa-test]` data:
   - **S:** create and change `[qa-test]` rows through REST and the CLI; the diff checker reports them in Convex within 60 s;
   - **V:** the 48-hour diff gate holds; the dual-read log has no mismatch for the domain;
   - **F:** after the test company's flip, the golden suite passes against production for that company; the pages of the domain load at 1440 and 390 px with zero console errors; activity entries appear; the domain's REST error rate and p95 stay within 10 % of the week before for 48 hours;
   - **R:** the capture and mirror are gone; health is ok; the export of that night contains the domain.

   Clean-up: cancel test issues and pause test routines; never delete.
7. Rollback is the router switch (after F) or a revert pull request (before F), through the same checks.

### 8.8 Who does what

| Who | Work |
|---|---|
| **The remote lane** (the agent company that builds this repository: three engineer seats, about 3 to 4 PRs a day in total [O]), the main executors | **Seat 1, platform:** T0 to T2, C1.1 to C1.3, C1.6. **Seat 2, migration tooling:** C1.4, C1.5, then the S and V slices of each wave. **Seat 3, domains:** the module refactors, the F slices, the UI hook slices, then the heartbeat carve-up |
| **Local sessions** | Signing and merges under the merge lock, until signing works in the remote lane. Production checks that need a board session. The independent reviews of risky slices. C0 can run locally if the remote lane cannot reach a production-shaped fixture |
| **The deploy operator** | C1.7 and every deploy-file change, the host memory decision, backups of the new service |
| **The maintainers** | The decisions of section 10, the go for each live-company flip and each Retire |

Waves 3a to 3c can run in parallel across seats 2 and 3, because each domain has its own tables and module. Only one F slice for a live company runs at a time.

### 8.9 Effort

| Phase | Pull requests [A] | Calendar time [A] |
|---|---|---|
| 0 (T0 to T2, R0) | 4 | 1 week, alongside the Next.js lane |
| 1 (C0, report) | 1 (docs) | 1 to 2 weeks |
| 2 (C1) | 8 to 12 | 2 to 3 weeks |
| 3 (about 20 domains × S, V, F, UI, R) | 100 to 130 | 6 to 10 weeks, with the 48-hour gates overlapping |
| 4 (issues) | 15 to 25 | 3 to 5 weeks |
| 5 (heartbeat carve-up, agents, runs) | 40 to 70 | 5 to 8 weeks |
| 6 (retire) | 5 to 10 | 1 to 2 weeks |
| **Total** | **about 175 to 250** | **about 3 to 6 months** at 3 to 4 merged PRs a day, plus the soak windows |

## 9. Risks, rollback and kill criteria

| Phase | Risk | Mitigation | Kill or stop criterion |
|---|---|---|---|
| 0 | Stale Turborepo cache hits | Side-effect builds uncached; `dist` content check in T0 | Revert T0 if any build differs from `pnpm -r build` |
| 1 | Latency, contention or memory worse than the gate | G1 numbers | **Kill** if G1 fails and no hosting option passes; the Effect plan reopens |
| 1 | Install path not viable for self-hosted installs | Local backend in `pnpm dev`; a backend image for production | **Kill** for installs if no supported production path exists; the maintainers then choose Cloud-only (U3) |
| 2 | The JWT bridge weakens auth | Security review; tests with forged and expired tokens and a wrong issuer | Stop C1 until the review passes |
| 2 | Deploy-file change refused or delayed | U7 early | Phase 3 waits; nothing is lost |
| 3 | Capture triggers slow writes | Measure statement latency per domain in S | Stop the domain if the p95 of its writes rises by more than 20 % |
| 3 | Diff mismatches that do not converge | Diff checker with ages; capture sequence numbers | Roll the domain back; stop the wave if two domains fail Verify |
| 3 | A plugin breaks | Plugins keep their SQL namespaces (section 6.6) | Revert the domain flip |
| 3 | A write that crosses two stores leaves them inconsistent | Coupling graph; sagas with idempotency keys; the diff checker (section 7.4a) | Roll the domain back if a split write leaves a mismatch older than 60 s more than once a day |
| 4 | Search quality drops | Golden rubric suite; Postgres mirror search until it passes | Issues do not flip until the suite passes |
| 4 | The per-company counter conflicts under bursts of creates | Measured in C0 | Use a per-company counter document with a reservation step if conflicts exceed 1 % |
| 5 | Claim conflicts slow dispatch; the run log exceeds write throughput | C0 numbers; claims spread by index; run log in Node (U9) | **Stop** the runs domain and keep it on Postgres if dispatch latency rises by more than 20 % for the test company |
| all | Two stores for months: operations cost, reports across stores | The reverse mirror keeps Postgres complete for reports; the store router has a dashboard | **Program kill** if, after phase 3, the remote lane spends more than half its pull requests on migration fixes for 2 weeks in a row |
| all | Upstream drift | U4 | — |
| all | Production memory | Measured in C0; Next.js runs in its own process with its own limit | Stop and ask the operator before any change that raises the container limit |

## 10. User decisions

| # | Decision | Recommendation |
|---|---|---|
| U1 | Go for C0 now, and for the full program only after G1 | **Yes to C0 now. Decide the program at G1 with the numbers** |
| U2 | Convex hosting for production | **Self-hosted on the same host**, if C0's memory and latency pass. Cloud for engineers' preview deployments only |
| U3 | Installs: a local backend started by the CLI, Cloud only, or a Postgres edition kept for installs | **A self-hosted backend started by the CLI.** The fork publishes no npm release today (`VLLNT.md:8`), so this affects the maintainers' own instances first |
| U4 | Upstream | **Settle #275 before C1, then cherry-pick only.** Accept that upstream merges end |
| U5 | Auth | **better-auth in Node with a custom JWT to Convex.** Revisit `@convex-dev/better-auth` when it supports better-auth 1.7 |
| U6 | The plugin SQL contract | **Keep a Postgres for plugin namespaces during the transition.** Decide on a document API for SDK v2 after phase 3 |
| U7 | Deploy changes: the backend service, its backups, logical replication | **Approve the backend service and nightly exports at C1.7. No logical replication; triggers instead** |
| U8 | The FSL-1.1 license of the self-hosted backend | **Accept.** Paperclip is not a competing hosted database product. The maintainer confirms |
| U9 | The run log store | **Decide at G1** from the measured write volume. Default: keep it in an append-only store in the Node tier |
| U10 | Turborepo remote cache | **No remote cache in T0.** Local and CI caches first. Add a self-hosted remote cache only if CI numbers justify it |
| U11 | The Effect lane | **Stop E0b onward.** Keep #319, E0a and the predicate fix |
| U12 | Live-company flips | **Test company first, 48 hours, then the live companies on the maintainers' go, one domain at a time** |

## 11. Plans in flight, reconciled

| Plan | Effect of this plan |
|---|---|
| Next.js (`doc/plans/2026-10-10-web-app-nextjs-migration.md`) | Unchanged order and gates. Two M0b rules (section 1). Pages move to `packages/client` hooks when C1 lands |
| Backend on Effect (`doc/plans/2026-10-10-backend-effect.md`) | Stopped at E0a (section 5.6). It reopens if Convex is killed |
| Upstream sync (#275) | U4 |
| Policies (#346), Databases and datasets (#347), goals, routine steps, the Inbox and Decisions merge | Keep shipping on Postgres with section 7.1's rules. Policies and datasets are wave 3a |
| Earlier work items of the remote lane: a repository move, a Next.js plan, a Convex helpers spec, a Gantt component | The repository move is not part of this plan; if it happens, this plan moves with the code. The Next.js work lives in this repository's Next.js plan. The Convex helpers spec is now a published package (`@vllnt/convex-helpers` 0.1.0, section 3). The Gantt component is in `@vllnt/ui`'s source and can serve the goals and projects pages under the token rule |

## Appendix A. Sources outside the repository

Fetched on 2026-10-21. Convex docs pages carry no version; the versions are from the npm registry on the same day.

- Convex limits: https://docs.convex.dev/production/state/limits
- Convex optimistic concurrency control: https://docs.convex.dev/database/advanced/occ ; errors: https://docs.convex.dev/error
- Convex mutations: https://docs.convex.dev/functions/mutation-functions ; actions: https://docs.convex.dev/functions/actions ; runtimes: https://docs.convex.dev/functions/runtimes
- Convex scheduled functions: https://docs.convex.dev/scheduling/scheduled-functions
- Convex HTTP actions: https://docs.convex.dev/functions/http-actions ; custom domains: https://docs.convex.dev/production/custom-domains
- Convex Node clients: https://docs.convex.dev/client/javascript/node ; https://docs.convex.dev/api/classes/browser.ConvexHttpClient ; https://docs.convex.dev/api/classes/browser.ConvexClient
- Convex auth: https://docs.convex.dev/auth ; custom JWT: https://docs.convex.dev/auth/advanced/custom-jwt ; custom OIDC: https://docs.convex.dev/auth/advanced/custom-auth ; Convex Auth: https://docs.convex.dev/auth/convex-auth
- Convex with Better Auth: https://www.better-auth.com/docs/integrations/convex ; supported plugins: https://labs.convex.dev/better-auth/supported-plugins ; component changelog: https://github.com/get-convex/better-auth/blob/main/CHANGELOG.md
- Convex text search: https://docs.convex.dev/search/text-search ; vector search: https://docs.convex.dev/search/vector-search
- Convex file storage: https://docs.convex.dev/file-storage ; uploads: https://docs.convex.dev/file-storage/upload-files ; R2 component: https://www.convex.dev/components/cloudflare-r2
- Convex self-hosting: https://docs.convex.dev/self-hosting ; backend repository and license: https://github.com/get-convex/convex-backend (`LICENSE.md`, `self-hosted/README.md`, `self-hosted/advanced/postgres_or_mysql.md`, `self-hosted/advanced/upgrading.md`), release `precompiled-2026-10-10-72ce13c`
- Convex local deployments: https://docs.convex.dev/cli/local-deployments
- Convex import and export: https://docs.convex.dev/database/import-export/import ; https://docs.convex.dev/database/import-export/export ; streaming: https://docs.convex.dev/production/integrations/streaming-import-export ; backups: https://docs.convex.dev/database/backup-restore
- Convex regions: https://docs.convex.dev/production/regions
- Convex components: https://docs.convex.dev/components ; https://docs.convex.dev/components/understanding ; migrations, workpool, workflow, aggregate: https://www.convex.dev/components
- Convex with Next.js: https://docs.convex.dev/client/nextjs/app-router/server-rendering
- Turborepo (docs updated 2026-10-20): https://turborepo.dev/docs/getting-started/add-to-existing-repository ; https://turborepo.dev/docs/crafting-your-repository/structuring-a-repository ; https://turborepo.dev/docs/reference/configuration ; https://turborepo.dev/docs/core-concepts/remote-caching ; https://turborepo.dev/docs/reference/run ; https://turborepo.dev/docs/reference/prune
- Next.js 16.4: https://nextjs.org/docs/app/getting-started/installation ; https://nextjs.org/docs/app/api-reference/config/next-config-js/output ; https://nextjs.org/docs/app/api-reference/file-conventions/proxy ; https://nextjs.org/docs/app/guides/custom-server ; https://nextjs.org/docs/app/guides/self-hosting
- better-auth: https://www.better-auth.com/docs/plugins/api-key ; https://www.better-auth.com/docs/plugins/organization
- npm registry (`npm view <package>`): `convex`, `convex-test`, `convex-helpers`, `turbo`, `next`, `better-auth`, `@better-auth/api-key`, `@convex-dev/*`, `@vllnt/*`
- `@vllnt/*` repositories: https://github.com/vllnt (for example `convex-api-keys` README, `create-vllnt-app` templates, `ui` source)
