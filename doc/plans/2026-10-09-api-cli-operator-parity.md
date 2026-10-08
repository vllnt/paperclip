# API / CLI operator parity

Goal (bntvllnt, 2026-10-08): everything a human does in the board UI can be done
with an API key (no browser session), a `paperclipai` CLI command, and the
OpenAPI document, so that one Paperclip instance can drive another. The work is
generic; anthm is only the first company to use it.

The per-operation matrix is generated: [`doc/api-coverage-matrix.md`](../api-coverage-matrix.md).
Regenerate it with `pnpm --filter @paperclipai/server api:coverage`.

## Where things stand (generated 2026-10-09)

| Measure | Count |
|---|---|
| Operations in the OpenAPI document | 895 |
| Usable with a board API key (per the document) | 867 |
| Called by the board UI | 702 |
| Called by a CLI command | 367 |
| **Called by the UI but with no CLI command** | **400** |

These are a snapshot; the matrix's own summary is authoritative after regeneration.

Coverage guards:
- `server/src/__tests__/openapi-routes.test.ts` fails when a mounted route is missing from the document.
  It now also sees routes registered in a `for (const method of [...]) router[method](...)` loop.
  That loop hid `GET`/`POST /api/companies/{companyId}/chats/{agentRef}`, which are now documented.
- `server/src/__tests__/api-coverage-matrix.test.ts` fails when the UI client or the CLI calls a route that
  isn't in the document. Calls the scanner can't resolve statically (22 today) are pinned in the test, so a new
  one fails until it uses a literal path or is reviewed into the list.

## How API keys work today

- **Board API keys** (`pcp_board_…`, from `paperclipai auth login` or `POST /api/board-api-keys`) authenticate as
  the key's user: `actor.type = "board"`, `source = "board_key"`. Company memberships and instance-admin status
  are read live on every request, so a key can never do more than its user. Board keys have **no scopes** today:
  a key carries all of its user's access.
- **Agent API keys** carry `keyScope` (`standard`, `task_bridge`, `skill_test`) and act as the agent.
- `assertInstanceAdmin` accepts board-key actors whose user is an instance admin.

Runtime exceptions to the matrix's "API key" column:

| Route | Document says | Runtime |
|---|---|---|
| `POST /api/plugins/{pluginId}/actions/{key}` and `/bridge/action` | board | Any authenticated actor reaches the plugin. Each plugin decides; the GitHub plugin's `boardScope` rejects agents and requires `companyId`. |
| `/api/cli-auth/*`, `/api/auth/*` | board | Session or login-flow specific by design. |
| Cloud-tenant deployments | — | Board keys never carry instance admin (rows are purged on each trusted-header login). The vllnt deployment uses `authenticated` mode, so this does not apply there. |

## Operator gaps, ranked by pain

"Today" is what an operator must do now; "PR" is the planned fix. Each PR is one theme, red→green tested,
with docs in `docs/api` and `docs/cli` and spec entries.

| Rank | Gap | Today | PR |
|---|---|---|---|
| 1 | **Agent config round trip.** `agent get` redacts env values and `agent update` refuses redacted placeholders, so changing one field means resending secrets. `runtimeConfig` is replaced wholesale; `adapterConfig` merges only at the top level, so a partial `env` drops the other keys. | Resend the whole config, including secrets. | **(a)** merge-PATCH for `adapterConfig`/`runtimeConfig` (only given keys change; secrets untouched; `null` deletes) + `agent config set <id> runtimeConfig.heartbeat.maxDailyRuns=64`. Agent self-config deny (PR #20) stays intact. |
| 2 | **Agents can't attach evidence of 2.3 MB or more from a sandbox run** (production report, 2026-10-08: a 33 MB archive of Lighthouse JSON, traces and CI logs). See [Large evidence uploads](#large-evidence-uploads). | Upload fails with "Invalid bridge request payload"; evidence stays in the workspace. | **(i)** bridge reads request envelopes back in chunks below the provider's output cap and fails loudly on truncation. **(j)** chunked, resumable attachment uploads for evidence above the 10 MiB server limit. |
| 3 | **Runs and health.** `GET /companies/{id}/heartbeat-runs` filters only by `agentId` and `limit`; no status, error code or time filter; no stats; runs today vs cap needs SQL. | SQL. | **(b)** run filters (agent, status, error code, since) + stats endpoint (failed/terminal per company over a window; runs today vs `maxDailyRuns` per agent) + `paperclipai run list` filters and `run stats`. |
| 4 | **Plugin actions.** The operator hit "needs a board browser session" for GitHub `write-identity.*`, `user-authorization.*`, `repositories.list`, `sync.*`. Code reading shows board keys already reach plugins as a `user` actor, plugin keys resolve as IDs, and `paperclipai plugin action <plugin> <key> -C <company> --params-json` exists. Unverified end to end. | Browser session. | **(c)** end-to-end test with a real board key (and an agent key, which must stay rejected), fix whatever breaks, CLI defaults the company from context, docs. Instance-admin checks unchanged. |
| 5 | **Config revisions.** List/get/rollback exist with CLI; no diff view. | Read raw before/after JSON. | **(d)** `agent config-revision:diff` (changed keys, before → after, secrets redacted). |
| 6 | **Skill versions.** List/get/create routes exist; no CLI, no diff. | Raw HTTP. | **(d)** `skill versions`, `skill version:get`, `skill version:diff`. |
| 7 | **Recovery actions.** Per-issue list/resolve exist with CLI (`issue recovery-actions`, `recovery:resolve`); no company-wide list. | Raw HTTP per issue. | **(d)** company-wide recovery list (API + CLI); `recovery:resolve` gains the missing reconciliation flag. |
| 8 | **Issue tree.** `GET /issues/{id}/diagnostics/subtree` exists but has no CLI and no last-run field. | Raw HTTP. | **(d)** `issue tree <id>`: status, assignee, last run per node. |
| 9 | **Reassignment.** `issue update --assignee-agent-id` returns 422 "Issue can only have one assignee" when a user is assigned; the API accepts `assigneeUserId: null` but the CLI has no flag for it. | Raw HTTP. | **(g)** `--assignee-user-id`, `--unassign-user`/`--unassign-agent`, and a clear error that names the fix. |
| 10 | **Invalid UUID path params return 500** (Postgres `22P02`), e.g. `PATCH /api/routines/<bad id>`. Only `/heartbeat-runs/{runId}` validates. | Confusing 500s. | **(e)** map `22P02` to 400 centrally, plus route-level checks where an ID is used before a query. |
| 11 | **Activity.** `activity list` has no `--limit`; the API has no `since`/`action` filters. The richer audit endpoint (`/audit/agent-actions`) has no CLI. | SQL. | **(g)** `--limit`, `--since`, `--action` on `activity list`; `activity audit`. |
| 12 | **Routines declaratively.** CRUD exists with `--payload-json`; no idempotent apply. | Hand-written payloads. | **(f)** `routine apply -f spec.json [--dry-run]`: sync title, owner, cadence, variables and status with a diff. |
| 13 | **Leases.** `GET /environments/{id}/leases` exists (CLI `environment leases`) but has no status filter in the CLI and no company-wide view. | SQL. | **(d)** `--status` filter and a company-wide lease list (active / pending cleanup). |
| 14 | **The other ~400 UI operations without a CLI command.** | Raw HTTP. | **(h)** generic `paperclipai api <METHOD> <path>` (auth, company context, path params, JSON body) and `paperclipai api ops [--tag]` listing operations from `/api/openapi.json`. This makes every documented operation reachable from the CLI. |
| 15 | **Board API keys have no scopes.** A key is as powerful as its user, so handing one to another instance hands over the user. | Use a dedicated low-privilege user. | Proposal only (needs a decision): optional company and read-only scopes on board keys, enforced in `authz.ts`. Not started. |

## Large evidence uploads

Agents attach evidence (test reports, traces, CI logs) for the review and QA gates. Two separate limits stop
large files:

1. **The run bridge corrupts request bodies above about 2.3 MB** on the CreateOS sandbox provider.
   - Agents in a remote run reach the API through the sandbox callback bridge
     (`packages/adapter-utils/src/sandbox-callback-bridge.ts`). Its default transport (`queue_v1`) writes each
     request into a JSON envelope file in the sandbox, with the multipart body base64-encoded (`:2537-2544`).
   - The host then reads the file back with one command, `head -c N file | base64` (`:717-725`), and parses
     its stdout. The file content is base64-encoded twice, about 1.8× the raw size.
   - CreateOS keeps only the **last** 4 MiB of command stdout (`MAX_CAPTURE_CHARS = 4_194_304`,
     `packages/plugins/sandbox-providers/createos/src/execute.ts:8, 72-78`) and only sets a `truncated` flag
     that nothing reads. The cut-off base64 fails to parse and the agent gets 400 "Invalid bridge request
     payload" (`sandbox-callback-bridge.ts:1117-1129`).
   - 4,194,304 × 76/77 × 3/4 × 3/4 ≈ **2.33 MB** of raw file, which matches the symptom. SSH targets have a
     1 MiB command buffer (`execution-target.ts:680`), so they would fail from about 0.58 MB.
   - Not verified: which execution environment production uses. That is not recorded in the repo, and I
     have not touched production.
2. **The server accepts at most 10 MiB per attachment** (`PAPERCLIP_ATTACHMENT_MAX_BYTES`, default
   `10 * 1024 * 1024`, `server/src/attachment-types.ts:164`). The bridge allows the same plus 64 KiB of
   multipart framing. Any file type is accepted on issue attachments. The 33 MB archive fails here even
   once (1) is fixed.

Related unknown: the production nginx gateway config is mounted from the host (`deploy/compose.yaml:86`), so
its `client_max_body_size` (nginx default 1 MB) is not in the repo. The bridge talks to the server's local
address and skips nginx, but another instance uploading through the public URL would hit it. The operator
should check it.

Options:

| Option | What it fixes | Effort | Notes |
|---|---|---|---|
| **(i) Chunked envelope read-back** in the bridge: read the file in slices well below every provider's output cap, check the length, and fail with a clear error if a provider reports truncation. | The 2.3 MB cliff (and the SSH 0.58 MB cliff), up to the 10 MiB server limit. | S–M, contained in `adapter-utils`. | Bug fix; red→green test with a fake provider that caps stdout. **Recommended first.** |
| Raise `PAPERCLIP_ATTACHMENT_MAX_BYTES` | Files between 10 MiB and the new limit, once (i) lands. | Config only. | Uploads are buffered in server memory (multer memory storage), and each bridge command has a 30 s timeout. |
| **(j) Chunked, resumable attachment uploads**: create an upload, `PUT` numbered parts, complete; stored through the storage provider (S3 when configured). Reuses the company-import transfer pattern (`/import/transfers`, 64 MiB parts). | Evidence of any size, through the bridge in small requests, and for instance-to-instance transfers. | M–L. | Needs a decision on per-company size and retention limits. |
| Interim, no code: link the archive as a work product `url`, or point at it with a `workspace_file` `resourceRef` | Reviewers can find the evidence. | None. | Not durable: an external host, or a workspace that can be cleaned up. |

## PR order

One theme per PR, each against `main`, reviewed and merged by the operator one at a time:

0. This coverage matrix and its tests.
1. (a) agent config merge-PATCH + `agent config set`.
2. (i) bridge: chunked envelope read-back, loud truncation errors.
3. (b) runs list filters, stats, caps usage + `run list|stats`.
4. (c) plugin actions with a board key, end to end + CLI.
5. (d) read views: config-revision diff, skill versions, company-wide recovery, issue tree, lease filters.
6. (e) 400 on invalid UUID path params.
7. (f) `routine apply`.
8. (j) chunked, resumable attachment uploads (after a decision on size and retention limits).
9. (g) reassignment flags and activity filters.
10. (h) generic `paperclipai api` command.

## Security rules for every PR

- API keys keep their scopes; board and instance-admin checks still apply.
- No secret is returned unredacted. Merge-PATCH never needs a secret to be resent.
- Agent actors get no new powers. PR #20 (agents may not change their own run limits, budget, model, role or
  permissions) must stay intact.
- Mutations write activity log entries.
