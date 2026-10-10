# Skill revision proposals with an approval policy

Status: plan only, no code. Security gate: this changes who can alter the text every agent follows.
Base: `main` at `38819d350`. Every `file:line` below is on that commit. A bare `company-skills.ts:N` is
`server/src/routes/company-skills.ts`; `svc :N` is `server/src/services/company-skills.ts`.
Related: #13 (agents read and edit skill files from a sandbox run, `7056769b0`), #59 (agents create skills from a
sandbox run, `338936dca`), the open follow-up on skill import (fetch policy and key-conflict authorization).

## 1. Summary

An agent that wants to change an existing company skill does not write it. It files a **proposal**: the full new
`SKILL.md` plus the id of the version it was written against. An **approver** reads a server-built diff and decides.
When the approver approves, the server applies exactly the reviewed bytes, in one transaction, only if the skill is
still on the base version. It reads the result back, keeps the previous version as the before-image, and writes an
activity entry for every step. The board can revert an applied proposal while nothing has changed since.

```
 author (agent)            server                         approver (board, later an agent)
 ---------------           ------------------------       ---------------------------------
 POST proposal  ---------> validate, cap, store
 (markdown, base id)       status = pending  ----------->  GET proposal (diff, metadata)
                                                           POST decision {approve, reviewedSha256}
                           lock proposal, lock skill  <--
                           check: pending, not stale, approver allowed, hash equal
                           updateFile(expectedVersionId = base)  -> new version
                           read back, compare sha256, keep before-image
                           status = applied, activity x2
 wake: decided   <-------
                                                           board: POST revert (only if head unchanged)
```

## 2. The premise in the brief is not true on `main`

The brief says "agents still can't write skills directly". On `main` they can, unless the company has closed it.

- #13 admitted `PATCH /api/companies/:id/skills/:skillId/files` for sandbox runs, and #59 admitted
  `POST /api/companies/:id/skills` (`packages/adapter-utils/src/sandbox-callback-bridge.ts:176-184`). The bridge is
  only a first filter. The decision is the server's.
- The server decision is `assertCanMutateCompanySkills` (`server/src/routes/company-skills.ts:209-251`). It checks
  authentication, the company boundary and one platform decision, and it **ignores** the legacy missing-grant and
  missing-consent denials on purpose (`:227-233`). Then it asks the company skill policy.
- With no stored policy the answer is **allow** (`server/src/services/company-skill-policy.ts:24-30`,
  `:162-164`). So a same-company agent can edit any editable skill today, and the plan has no effect until the
  company denies those actions.

So this plan has two halves, and the second is what makes the first worth anything:

1. A proposal path: propose, decide, apply, revert.
2. A **closed direct-write gate**, shown to the board as a status, because proposals add no protection while agents
   can still write directly. The plan does not silently rewrite the company's policy; section 4.9 explains why.

### 2.1 Every route that can change an existing skill's text or head version

| Route (all under `/api/companies/:companyId`) | Policy action | Source |
| --- | --- | --- |
| `PATCH /skills/:skillId/files` | `skills.edit` | `company-skills.ts:1227-1234`; compare-and-set only when the caller sends `expectedVersionId` (`:1234`, svc `:4691`) |
| `DELETE /skills/:skillId/files` | `skills.edit` | `:1317-1323` |
| `PATCH /skills/:skillId` | `skills.edit` | `:1196-1202` |
| `POST /skills/:skillId/rename` | `skills.edit` | `:985-994` |
| `POST /skills/:skillId/versions` | `skills.create` | `:879-885`; moves `currentVersionId` with no text change (svc `:3670-3675`) |
| `POST /skills/:skillId/install-update` | `skills.update` | `:1542-1548`; replaces text from the upstream source |
| `POST /skills/:skillId/reset` | `skills.reset` | `:1592-1598` |
| `DELETE /skills/:skillId` | `skills.remove` | `:1476-1479` |
| `POST /skills/import` | `skills.import` | `:1348-1354`; `upsertImportedSkills` updates the row that has the same key in place (svc `:6259`) |
| `POST /skills/install-catalog` | `skills.install` | `:1393-1398` |
| `POST /skills` (create) | `skills.create` | `:1142-1147`; a slug that already has a skill returns 409 (svc `:4518`) |

Two consequences for the design:

- A rule that selects a protected skill by `skillIds` or `skillKeys` cannot stop **import** or **catalog install**,
  because their policy resource carries a source and no skill id (`company-skills.ts:198-207`, `:1398-1401`). An
  import whose frontmatter key matches a protected skill overwrites it. The #59 review found the same pattern. The
  plan lists it as a dependency (section 8, Q8), not as something it fixes.
- Only a skill whose source type is `local_path` is editable (svc `:4695-4698`). Catalog and git skills are not, so a
  proposal against one is refused at submit.

### 2.2 What a skill policy can express today

- Actions: `skills.create|import|install|edit|update|test|reset|remove`
  (`packages/shared/src/validators/skill-policy.ts:3-12`).
- A rule has a priority, an effect (`allow` or `deny`), a subject (`all_agents`, `agents`, `roles`), actions and
  optional resource selectors (`skillIds`, `skillKeys`, `sourceTypes`, `sourceLocators`) (same file, `:76-105`).
- A subject matches an agent principal. The board principal never matches `all_agents` or `agents`. A `roles` rule
  does not check the principal type, so a rule with role `board` can match a board user
  (`company-skill-policy.ts:45-52`).
- With `defaultEffect: "deny"`, a principal that has no matching rule is allowed only if it holds the legacy grant
  `skills:create` or `skills:suggest-changes` (`company-skill-policy.ts:139-153`, `:180-186`). Adding a new action to the enum therefore
  makes a stored default-deny policy deny it for everyone without a rule. That is the safe direction for an agent
  action. It must not apply to the board's authority to decide (section 4.5).
- The policy is replaced as a whole with `expectedRevision` compare-and-set and an activity entry
  (`company-skill-policy.ts:189-262`). **Who may replace it:** the board with `users:manage_permissions`, or an
  **agent** that holds `users:manage_permissions` (`server/src/routes/company-skill-policy.ts:43-59`, agent branch
  `:48-52`). An agent with that grant can already grant itself anything. The plan keeps the proposal settings out of
  that check (section 4.6).

## 3. What else exists, and why it does not host this

| Candidate | Why it does not fit | Source |
| --- | --- | --- |
| `approvals` | The only decider column is a user id, and approve, reject and request-revision are `assertBoard`. An agent cannot decide. | `packages/db/src/schema/approvals.ts:16`; `server/src/routes/approvals.ts:287`, `:403`, `:441` |
| `decisions` | Every row needs an origin agent, issue **and run** (`NOT NULL`), only a user decides, and a decision executes a signed spec. A board-authored proposal or an agent approver does not fit. | `packages/db/src/schema/decisions.ts:43-45`, `:55`, `:59`; `server/src/routes/decisions.ts:181` |
| `skills:suggest-changes` plus "consent" | The platform has a suggest-then-consent model for protected changes (`server/src/services/authorization.ts:1791-1796`, deny reason at `:1644`). The skill gate ignores its denials by design (`company-skills.ts:227-233`), and the key now means "broad mutation" in the legacy fallback. Reusing it would change what existing grants mean. | `packages/shared/src/constants.ts:1006-1008` |
| Agent instruction "candidates" | A working-copy conflict flow for one agent's own instructions, with no approver. | `server/src/routes/agents.ts:5525-5539` |

Two precedents are worth copying:

- **An agent can be an approver with an explicit grant, and only for what it could change itself.** `joins:approve`:
  "An agent approver may not create an agent with settings it could not set itself"
  (`server/src/routes/access.ts:4330-4345`).
- **An agent can decide a review stage.** `issue_execution_decisions` records `actorAgentId` or `actorUserId`
  (`packages/db/src/schema/issue_execution_decisions.ts:15-16`).

So: a dedicated table with its own state machine, the existing skill policy for who may propose and approve, and the
existing attention surface only to show the board what waits.

## 4. Design

### 4.1 Principles

1. **Immutable proposal.** Content never changes after submit. A change is a new proposal.
2. **A decision binds to bytes.** The approver sends the SHA-256 of what it reviewed. The server refuses if it differs
   from the stored hash.
3. **Compare-and-set on the base.** Apply passes `expectedVersionId = baseVersionId` to the existing
   `updateFile`. A moved head makes the proposal stale. It never merges.
4. **Check at decision time.** Settings and policy are read when the decision is made, not when the proposal was
   filed, so a revoked approver or a tightened rule takes effect on pending proposals.
5. **Fail closed.** Unknown model family, missing run context, disabled settings and unreadable policy all refuse.
6. **No new bypass.** The proposal path never lets an actor write what the direct path would deny to a board user,
   and the approver is never the author.
7. **No skill text in the activity log.** Activity is stored and published to subscribers
   (`server/src/services/activity-log.ts:151`, `:160`, `:217`). Details carry hashes, sizes and ids only.

### 4.2 Data model

Two tables. Numbers are assigned just in time, when the implementation PR is rebased onto `main`
(`main` is at `0298`); this plan reserves none.

`company_skill_proposals`

| Column | Notes |
| --- | --- |
| `id` uuid pk, `company_id` uuid not null | Company-scoped; every query filters on `company_id`. |
| `skill_id` uuid not null, `skill_key` text | Cascade with the skill. `skill_key` is a snapshot for the log and the list. |
| `base_version_id` uuid null | The version the text was written against. Null only when the skill has no current version, mirroring `updateFile`'s null compare (svc `:4691`). |
| `proposed_markdown` text not null, `proposed_sha256` char(64) not null, `proposed_bytes` int | Full `SKILL.md`. Cap in section 4.7. Body is nulled by the retention job (Q9). |
| `title` text, `summary` text | `summary` is untrusted author text. |
| `author_agent_id` / `author_user_id` | Exactly one is set (check constraint). |
| `author_run_id`, `author_issue_id` | From the task-bound run, as skill create does (`company-skills.ts:1152-1153`). |
| `author_model_family` text, `author_adapter_type` text, `author_model` text | Snapshot at submit (section 4.10). |
| `status` text | `pending`, `applied`, `rejected`, `withdrawn`, `expired`, `stale`. |
| `required_approver` text | `board` or `board_or_agent`, resolved at submit for display; re-resolved at decision. |
| `settings_revision` int, `policy_revision` int | For the audit trail only; never trusted at decision time. |
| `decided_by_user_id` / `decided_by_agent_id`, `decided_at`, `decision_note`, `decided_run_id`, `decided_issue_id` | S2 adds the agent columns. |
| `decided_model_family` text | Snapshot of the approving agent's family (S2). |
| `before_version_id`, `applied_version_id`, `applied_at`, `applied_sha256` | The before-image is the version row that was the head at apply. |
| `reverted_at`, `reverted_by_user_id`, `revert_version_id` | Revert, section 4.9. |
| `idempotency_key` text | Unique per `(company_id, author principal, key)` where not null. |
| `expires_at`, `created_at`, `updated_at` | |

Indexes: `(company_id, status, created_at)`; `(company_id, skill_id, status)`; `(company_id, author_agent_id,
created_at)` for the caps; a partial unique index on `(skill_id, author principal)` where status is `pending`, so one
author has at most one open proposal per skill.

`company_skill_proposal_settings`: one row per company: `company_id` pk, `revision` int, `settings` jsonb,
`created_at`, `updated_at`. A separate table, not columns on `company_skill_policies`, because
`DELETE /skill-policy` removes that whole row (`company-skill-policy.ts:266-290`) and would silently switch the
approval rules off at the moment direct writes reopen.

Company deletion removes owned tables by name (`server/src/services/companies.ts:673` lists `companySkills`). Both
tables join that list, proposals first. Proposals do not outlive their skill.

### 4.3 State machine

| From | Event | To | Who |
| --- | --- | --- | --- |
| (none) | submit | `pending` | author |
| `pending` | approve and apply succeeds | `applied` | approver |
| `pending` | reject | `rejected` | approver |
| `pending` | withdraw | `withdrawn` | author or board |
| `pending` | head moved (checked on read, decision and by the sweeper) | `stale` | system |
| `pending` | `expires_at` passed | `expired` | system |
| `applied` | revert | `applied` with `reverted_at` set | board |

All transitions are `UPDATE ... WHERE status = 'pending'`. A second concurrent decision gets 409
`skill_proposal_not_pending`. Terminal states are final; a new attempt is a new proposal.

### 4.4 Who may do what

| Action | Board | Author agent | Other agent |
| --- | --- | --- | --- |
| Submit | yes, if policy `skills.propose` allows | yes, if `skills.propose` allows | same as author |
| Read a pending proposal and its diff | any active non-viewer member | yes | only an approver-eligible agent (S2) |
| Decide (S1) | any active non-viewer member who is not the author | no | no |
| Decide (S2) | as S1 | no | an agent with an explicit `skills.approve` allow, not the author, subject to 4.6 |
| Withdraw | yes | yes, own | no |
| Revert | yes (owner, admin, or `users:manage_permissions` as a person) | no | no |
| Change settings | a **person** with `users:manage_permissions`, or instance admin | no | no |

"Active non-viewer member" means a board actor with access to the company (as approvals require,
`approvals.ts:287`) whose membership role is not `viewer`. The viewer exclusion is how issue and decision-queue
actions are already authorized for people (`server/src/services/authorization.ts:1737-1745`). The S1 implementation
adds the viewer check to the decision route, because `assertBoard` alone does not make it.

### 4.5 Policy and authorization

- **New policy action `skills.propose`.** Evaluated by the existing engine with `skillPolicyResource` for the skill.
  Default for agents when the policy is not materialized: allow (proposing is the safe path). A default-deny policy
  denies it unless a rule allows it.
- **New policy action `skills.approve` (S2).** For agents it is **closed by default**: allowed only when an explicit
  `allow` rule matches, even if `defaultEffect` is `allow` and even if no policy is stored. This is a special case in
  `evaluate` and has its own test.
- **The board's authority to decide does not come from the policy.** A stored default-deny policy would otherwise
  lock every person out of a new action, because the board principal matches no subject except a `roles: ["board"]`
  rule (`company-skill-policy.ts:45-52`, `:180-186`). The board's check is company membership, as in 4.4.
- **Run context.** An agent that submits or decides must be in a task-bound run in Standard or Skill-test mode, the
  same requirement skill create has (`company-skills.ts:1152-1153`). That gives every proposal and decision an
  issue to point at.
- **Least privilege for an agent approver** (the `joins:approve` rule): the approver's allow rule must select the
  skill. An approver cannot approve a skill outside its selector.

### 4.6 Settings document

```json
{
  "enabled": false,
  "agentApproval": { "enabled": false, "requireDifferentModelFamily": true },
  "protectedSkills": { "skillIds": [], "skillKeys": [] },
  "caps": { "submittedPerAuthorPer24h": 20, "appliedPerSkillPer24h": 5, "openPerAuthor": 5 },
  "expiresAfterHours": 336
}
```

- `enabled: false` is the default and changes nothing. While it is false, submit returns 409
  `skill_proposals_disabled`, and existing rows stay readable.
- **Agent approval needs both** `agentApproval.enabled` **and** an explicit `skills.approve` allow rule. One without
  the other is a refusal. A single switch guards a rule someone may add without thinking of this feature.
- **Protected skills** (by id or key) are decided by the board only, whatever the rest says. They are also exempt
  from `requireDifferentModelFamily`, which only applies to agent approvals.
- **Caps** are rolling 24 hours, counted from rows, under a per-author advisory lock so a burst cannot step over the
  cap. `null` turns a cap off.
- Changing settings uses `expectedRevision` compare-and-set and writes `company.skill_proposal_settings_updated`.
  Only a person may change them (4.4), because the policy route also lets an agent holding
  `users:manage_permissions` rewrite the gate (`company-skill-policy.ts` routes `:48-52`). Whether the policy route
  itself should be tightened is Q7.

### 4.7 Submit

`POST /skills/:skillId/proposals` with `{ markdown, baseVersionId, title?, summary?, idempotencyKey? }`.

Refused with a stable code when:

1. settings are disabled; the actor lacks `skills.propose`; an agent is not in a task-bound run;
2. the skill is not editable (`sourceType` is not `local_path`);
3. `baseVersionId` is not the skill's current version (409 `skill_proposal_base_stale`, returns the current id);
4. the markdown is not valid UTF-8, has a NUL byte, exceeds **256 KiB**, has no parseable frontmatter, lacks `name`
   or `description`, or is byte-identical to the current `SKILL.md`;
5. the frontmatter **adds, removes or changes any key other than `name` and `description`**. `SKILL.md` frontmatter
   keys such as `iconUrl`, `homepage`, `author`, `tagline` and `categories` are copied into board-visible skill
   metadata on every write (`readSkillStoreMetadata`, svc `:1874-1888`, called at svc `:4733`). Other keys
   may carry behavior for a runtime that reads the file; whether any runtime honors them is outside the server and
   not verified here. The board can still edit those keys directly;
6. a cap is exceeded, the author already has an open proposal for this skill, or the idempotency key was used with
   different input (409);
7. the content is a duplicate of an open proposal by the same author (replay with the same key returns the stored
   proposal with 200).

v1 changes `SKILL.md` only. Reference files and scripts are out of scope (Q5). A proposal cannot set an executable
bit, add a script or change a file other than `SKILL.md`.

### 4.8 Decide and apply (one transaction)

`POST /skill-proposals/:proposalId/decision` with `{ decision, reviewedSha256, note?, idempotencyKey? }`.

For `approve`, in one outer transaction (the same shape the idempotent file-update route already uses with a
transaction-scoped service, `company-skills.ts:1242-1258`):

1. Lock the proposal row. Refuse unless `status = pending` and not expired.
2. Re-read settings and evaluate the approver now (4.4, 4.5, 4.6). The approver is not the author.
3. Refuse unless `reviewedSha256` equals `proposed_sha256`.
4. Lock order is **proposal row, then skill** (`withSkillFileMutation` takes the name advisory lock and the skill row
   lock, svc `:4639-4657`). Never the reverse.
5. Call the existing `updateFile(companyId, skillId, "SKILL.md", proposed_markdown, author, { expectedVersionId:
   base_version_id, afterUpdate })`. A moved head throws the existing 409 (svc `:4691-4693`). The proposal becomes
   `stale` in its own small transaction, and the caller gets 409 `skill_proposal_base_stale`. The version's author
   is the **proposal author**, so history blames the right party. The approver is on the proposal row and in the log.
6. In `afterUpdate` (it runs before commit, svc `:4754`): read the stored `SKILL.md` back, compute its SHA-256, and
   require equality with `proposed_sha256`. A mismatch throws, and `updateFile`'s `onRollback` restores the file
   on disk (svc `:4711-4718`, `:4756-4759`).
7. Record `before_version_id` (the version that was the head), `applied_version_id`, `applied_at`,
   `applied_sha256`, status `applied`.
8. Write `company.skill_proposal_approved` and `company.skill_proposal_applied` in the same transaction.
9. After commit: publish the activity, wake the author with `skill_proposal_decided`.

`reject` records the decision, status `rejected`, one activity entry, and the same wake. It needs no hash.

**Why approve and apply are one step.** A separate apply leaves approved bytes waiting while the base can move, and
it adds a state whose only job is to be stale. If an approval cannot be applied, nothing is approved. Q3 asks
whether the board wants a manual apply later.

**A version snapshot with no text change makes a proposal stale.** `POST /versions` moves `currentVersionId`
without changing text (svc `:3670-3675`). v1 compares version ids exactly, as `updateFile` does. Q4
asks whether to relax it to "the base `SKILL.md` bytes are unchanged".

### 4.9 The direct-write gate

The server cannot know which routes a company wants closed, and rewriting a stored policy behind the board's back
would surprise people. So:

- `GET /skill-proposal-settings` returns a computed `directWriteGate`: for a synthetic same-company agent principal
  it evaluates `skills.edit`, `skills.update`, `skills.reset`, `skills.remove`, `skills.install`, `skills.import`
  and `skills.create` (the last on a skill id, for `POST /versions`) and reports `closed`, `partly_open` or `open`
  with the list of open actions.
- The web panel and the CLI show it at the top, with text: "Agents can still change skills directly. Proposals add
  no protection until these actions are denied."
- The plan documents a recommended policy snippet (deny the actions above for `all_agents`, allow `skills.propose`)
  and the board applies it through the existing policy route. A one-click preset is a follow-up if the board wants
  it (Q6).
- The snippet cannot close **import and install by skill**, because those resources carry no skill id (2.1). A
  company that wants protected skills must deny `skills.import` and `skills.install` to agents outright, until the
  import follow-up adds key-conflict authorization.

### 4.10 Model family (S2)

There is no model-family notion for agents on `main`. The nearby `normalizeProviderFamily`
(`packages/adapter-utils/src/acpx-engine/startup-timing.ts:39`) classifies sandbox providers for telemetry and is a
different thing. The plan defines one:

- Input: the agent's adapter type (15 values, `packages/shared/src/constants.ts:27-43`) and its configured model
  string (`adapterConfig.model`, read at `server/src/services/heartbeat.ts:7164-7166`).
- A server table maps **single-vendor adapters** to a family (for example `claude_local` to `anthropic`,
  `codex_local` to `openai`, `gemini_local` to `google`, `grok_local` to `xai`, `kimi_local` to `moonshot`). For
  **multi-vendor adapters** (`paperclip_runner`, `opencode_local`, `pi_local`, `cursor`, `cursor_cloud`,
  `hermes_*`, `openclaw_gateway`, `process`, `http`) it matches the model id against a prefix table, and otherwise
  returns `unknown`.
- `unknown` never satisfies "different family". If either side is `unknown` and the rule is on, the decision is
  refused with `skill_proposal_family_unknown`.
- The family of both sides is snapshotted on the row, so a later model change cannot rewrite the record.

A shared family between two agents is a signal, not a proof of independence. The rule lowers the chance that one
model's blind spot passes its own change. It does not replace the board for protected skills.

### 4.11 Revert

`POST /skill-proposals/:proposalId/revert` with `{ expectedVersionId }`, board only. It requires
`applied_version_id == current head == expectedVersionId`. It writes the before-image `SKILL.md` through
`updateFile` with the same compare-and-set and records `revert_version_id`. If anything changed since, it returns 409
`skill_head_moved` and the board uses Skill Studio's restore, which already writes a chosen version back as a new
head (`ui/src/pages/SkillStudio.tsx:3446-3459`). A version row stores a full snapshot of every file with its
content (svc `:1900-1909`, `:3636-3666`), so the before-image is already complete. Revert never
rewrites history.

### 4.12 Notifications

- **Author:** wake `skill_proposal_decided` (applied, rejected, stale, expired), the same way an approval wakes its
  requester (`server/src/routes/approvals.ts:325-342`). The reason joins the wake-reason sets in
  `server/src/services/heartbeat.ts` next to `approval_approved` (`:1327`, `:1345`).
- **Board:** a pending proposal appears as a derived attention item, new source kind `skill_proposal` in
  `packages/shared/src/types/attention.ts:8-21`, plus a count on the sidebar badges
  (`server/src/routes/sidebar-badges.ts`). Derived on read; no stored alert.
- **Approver agents (S2):** pull. `GET /skill-proposals?awaitingMyDecision=true` lists what an agent may decide. A
  push wake of approvers is deferred (Q10).

### 4.13 Activity log

Every mutation writes one entry in the same transaction. Details never contain skill text.

| Action | When | Details |
| --- | --- | --- |
| `company.skill_proposal_submitted` | submit | proposalId, skillId, baseVersionId, sha256, bytes, authorModelFamily, requiredApprover, sourceIssueId |
| `company.skill_proposal_approved` | approve | proposalId, decidedBy, decidedModelFamily, sha256, note length |
| `company.skill_proposal_applied` | apply | proposalId, beforeVersionId, appliedVersionId, sha256, appliedSha256 |
| `company.skill_proposal_rejected` | reject | proposalId, decidedBy, note length |
| `company.skill_proposal_withdrawn` | withdraw | proposalId |
| `company.skill_proposal_stale` / `_expired` | system | proposalId, currentVersionId or expiresAt |
| `company.skill_proposal_reverted` | revert | proposalId, revertVersionId, restoredSha256 |
| `company.skill_proposal_settings_updated` | settings | previous and new revision, changed keys |

Refusals that leave data unchanged (wrong hash, not the approver) write no row; they return a coded error.

### 4.14 Surfaces and parity

Web, API (OpenAPI) and CLI ship together, per the parity rule. Parity of surfaces is not parity of permissions.

**API** (all company-scoped; each must be in `server/src/routes/openapi.ts`, because
`server/src/__tests__/openapi-routes.test.ts:716` fails on an undocumented mounted route):

| Method and path | Notes |
| --- | --- |
| `POST /skills/:skillId/proposals` | 201; 200 on an idempotent replay |
| `GET /skill-proposals` | filters `status`, `skillId`, `authorAgentId`, `awaitingMyDecision`; cursor paging |
| `GET /skill-proposals/:proposalId` | adds `diff`, `diffStats`, `frontmatterChanges`, `head`, `isStale` |
| `POST /skill-proposals/:proposalId/decision` | approve applies |
| `POST /skill-proposals/:proposalId/withdraw` | |
| `POST /skill-proposals/:proposalId/revert` | board only |
| `GET`/`PUT /skill-proposal-settings` | `PUT` takes `expectedRevision`; `GET` includes `directWriteGate` |

**Bridge** (`sandbox-callback-bridge.ts`): add `POST …/skills/:skillId/proposals`, `GET …/skill-proposals`,
`GET …/skill-proposals/:id`, `POST …/skill-proposals/:id/withdraw`, and in S2 `POST …/skill-proposals/:id/decision`,
all with the hardened id slot `[^/?#%.\\]+` and with denied-path tests. Settings and revert stay unreachable from a
sandbox.

**CLI** (`paperclipai skills proposal …`; today `skills file` is read-only, and no CLI command edits the text of an
existing skill: `skills create` makes a new one, `cli/src/commands/client/skills.ts:231-258`, `:290`): `propose <skillRef> --file <path> [--base-version <id>]
[--summary]`, `list`, `show`, `diff`, `approve`, `reject`, `withdraw`, `revert`, `settings get|set`. `approve` prints
the hash it sends and reads the file back to show the new head.

**Web:** Skill Studio gets a Proposals tab (list, side-by-side diff using the existing version compare, base and head
ids, gate status banner, approve and reject with a note). Settings live with the skill policy. Pending proposals show
in the inbox and the sidebar badge. The UI uses the token layer only (`DESIGN.md`).

**Agent guidance:** in the OpenAPI operation descriptions and, if needed, one small separate skill. **Not** new
lines in `skills/paperclip/SKILL.md` or new headings in `skills/paperclip/references/**`: both are anchored by line
in the runner capability contract, and a shifted heading fails the image build.

## 5. Threat model

| # | Threat | Control |
| --- | --- | --- |
| T1 | Agent writes the skill directly and skips the gate | Gate status shown (4.9); recommended deny list; section 2.1 table; Q6, Q8 |
| T2 | Author approves itself | Approver is never the author; agent approval needs an explicit allow rule |
| T3 | Two agents agree to pass each other's changes | `requireDifferentModelFamily`; protected skills are board-only; caps; every approval logged with both families |
| T4 | Content swapped between review and apply | Immutable row; `reviewedSha256` must match; read-back hash |
| T5 | Apply on a skill that moved | Compare-and-set on `base_version_id`; stale, never merged |
| T6 | A stale policy lets a revoked approver through | Policy and settings read at decision time (4.1) |
| T7 | Prompt injection into an approving agent through the proposal text | Server-built diff in a fenced, labelled block; summary marked untrusted; the decision is structured, not free text; the approver cannot edit content; protected skills never go to an agent |
| T8 | Frontmatter changes board-visible metadata or runtime behavior | v1 allows only `name` and `description` to change (4.7) |
| T9 | Script or executable bit smuggled in | v1 changes `SKILL.md` only |
| T10 | Skill text leaks through the activity feed | Hashes and sizes only (4.1, 4.13) |
| T11 | Pending text read by every agent | Reads limited to the board, the author and approver-eligible agents |
| T12 | Spam or storage growth | 256 KiB limit; caps; one open proposal per author per skill; expiry; retention (Q9) |
| T13 | Replay or double submit | Unique idempotency key; `status = pending` compare-and-set |
| T14 | Cross-company access | Company id on every query and index; agent key boundary check as in `company-skills.ts:218-221` |
| T15 | Settings turned off to flush pending work | Only a person changes settings; the change is logged; pending rows stay readable and expire |
| T16 | A partial apply leaves disk and database apart | Outer transaction; `onRollback` restores the file; read-back hash |
| T17 | The gate is rewritten by an agent holding `users:manage_permissions` | Settings are person-only; the policy route is a known gap (Q7) |

## 6. Slices

Each slice ships web, API, CLI and tests, and lands single after review (security gate). The feature is off for every
company until `enabled` is set, so each slice can ship without behavior change.

- **S1: propose, board decides and applies, revert.** Tables and migration; `skills.propose`; settings (without
  agent approval); submit, list, show, decision (board), withdraw, revert; caps; expiry (lazy plus a sweeper);
  author wake; attention item; bridge rules; OpenAPI; CLI; Studio tab; gate status.
- **S2: agent approvers and protected skills.** `skills.approve` (closed by default); `agentApproval` settings;
  model family table and rule; protected list; decision by agent; awaiting-my-decision listing; agent columns.
- **S3: hardening.** Retention job; optional "require a passing skill test run" (Q2); manual apply if wanted (Q3);
  relaxed staleness if wanted (Q4); multi-file proposals if wanted (Q5).

Rollback: set `enabled: false`; pending rows become unusable but readable. The tables are additive. Applied
changes stay as ordinary versions.

## 7. Tests (each fails before the change)

- Submit refuses: disabled; no `skills.propose`; no task-bound run; non-editable skill; stale base; identical text;
  oversize; invalid frontmatter; changed frontmatter key; cap hit; second open proposal; bad idempotency replay.
- Decision: wrong hash; author as approver; viewer; stale base (row becomes `stale`, skill unchanged); two concurrent
  approvals (one wins); read-back mismatch restores the file on disk; apply writes one version authored by the
  proposal author; before-image equals the previous head.
- Policy: `skills.approve` denied for an agent with no rule even under `defaultEffect: allow` and with no stored
  policy; a stored default-deny policy does not lock the board out of deciding; policy and settings changes apply to
  pending rows.
- Revert: succeeds only on an unmoved head; 409 otherwise; never edits history.
- Parity: every route in OpenAPI (existing coverage test); CLI commands call the same routes; bridge allows the new
  paths and denies settings, revert and look-alike paths (`?`, `#`, `%2e`, `..`, backslash).
- Company delete removes both tables; company boundary on every route; activity details contain no skill text.
- S2: unknown family refuses; same family refuses when required; protected skill cannot be decided by an agent.

## 8. Open questions, each with a recommendation

- **Q1. Meaning of "protected skills".** Recommendation: a skill on the list is decided by the board only. Agent
  approval never applies to it. (The brief lists it as optional next to model family and a cap.)
- **Q2. Require a passing skill test run before approval.** Skill Studio already runs tests (`skills.test`).
  Recommendation: defer to S3 as an optional setting. It needs a defined "passing", and test runs spend money.
- **Q3. Manual apply after approval.** Recommendation: no. Approve applies, atomically. Revisit if a company wants
  scheduled changes.
- **Q4. Staleness rule.** Recommendation: strict version id in v1 (same as `updateFile`). A label-only snapshot makes
  a proposal stale; the author resubmits. Relax to "base `SKILL.md` bytes unchanged" in S3 if it proves noisy.
- **Q5. Multi-file proposals.** Recommendation: not in v1. A protected skill's reference files then stay
  board-edit-only, which is the safe direction. Add a file list in S3, with executable bits and scripts still refused
  unless the board decides.
- **Q6. One-click "require proposals" preset.** Recommendation: not in S1. Show the gate status and the snippet; add
  the preset once the board has used it.
- **Q7. Tighten the policy route.** An agent holding `users:manage_permissions` can replace the policy
  (`company-skill-policy.ts` routes `:48-52`). Recommendation: leave it as is in this plan (it is root-equivalent
  already) and file a separate issue to make policy replacement person-only.
- **Q8. Import and install can overwrite a skill by key.** Recommendation: block on the import follow-up for any
  company that wants protected skills, and until then tell the board to deny `skills.import` and `skills.install`
  to agents. This plan does not change import.
- **Q9. Retention of proposal text.** Recommendation: keep the hash and metadata, null `proposed_markdown` on
  terminal rows after 90 days (S3). Worst case before that is 20 proposals a day at 256 KiB per author.
- **Q10. Push wake for approver agents.** Recommendation: defer. Pull through the listing is enough for S2 and
  adds no new wake reason beyond `skill_proposal_decided`.
- **Q11. Size limit.** Recommendation: 256 KiB for `SKILL.md`. The default JSON body limit is 10 MB
  (`server/src/http/body-limits.ts:1`), far above a skill. This is a judgment, so please confirm.
- **Q12. Human approver bar.** Recommendation: any active non-viewer member in S1 (the bar skill mutations use), with
  settings person-only. Tighten to owner or admin if the board wants fewer deciders.

## Appendix A. Code anchors checked on `main` at `38819d350`

- Bridge skill rules: `packages/adapter-utils/src/sandbox-callback-bridge.ts:176-184`
- Skill gate: `server/src/routes/company-skills.ts:209-251` (tolerated denials `:227-233`)
- Skill routes: `:879-885`, `:985-994`, `:1142-1147`, `:1196-1202`, `:1227-1234`, `:1317-1323`, `:1348-1354`,
  `:1393-1398`, `:1476-1479`, `:1542-1548`, `:1592-1598`
- Service: `updateFile` `server/src/services/company-skills.ts:4679-4761`, compare-and-set `:4691-4693`, version
  write `:4745-4749`; `createVersion` `:3626-3681`; `withSkillFileMutation` `:4639-4657`; create conflict `:4518`;
  `upsertImportedSkills` `:6250`, existing-row lookup `:6259`; `readSkillStoreMetadata` `:1874-1888`
- Policy: `packages/shared/src/validators/skill-policy.ts:3-12`, `:76-116`;
  `server/src/services/company-skill-policy.ts:24-30`, `:45-52`, `:139-153`, `:155-187`, `:189-262`, `:266-290`;
  routes `server/src/routes/company-skill-policy.ts:43-59`, `:71-112`
- Authorization: `server/src/services/authorization.ts:532-550` (the responsible-user predicate for agent-granted skill changes), `:1737-1745` (viewer exclusion), `:1791-1796` (`skill_config:update`), `:1644` (missing consent)
- Approvals and decisions: `server/src/routes/approvals.ts:287`, `:325-342`, `:403`, `:441`;
  `packages/db/src/schema/approvals.ts:16`; `packages/db/src/schema/decisions.ts:43-45`, `:55`;
  `server/src/routes/decisions.ts:181`
- Precedents: `server/src/routes/access.ts:4330-4345`; `packages/db/src/schema/issue_execution_decisions.ts:15-16`
- Permissions and adapters: `packages/shared/src/constants.ts:27-43`, `:1003-1025`
- Activity: `server/src/services/activity-log.ts:75-91`, `:151`, `:160`, `:217`
- Attention and badges: `packages/shared/src/types/attention.ts:8-21`; `server/src/routes/sidebar-badges.ts:30-50`
- Company delete: `server/src/services/companies.ts:673`
- CLI and UI: `cli/src/commands/client/skills.ts:97-545` (`file` is read-only, `:231-258`);
  `ui/src/pages/SkillStudio.tsx:3446-3459`; `ui/src/api/companySkills.ts:195`
- OpenAPI coverage test: `server/src/__tests__/openapi-routes.test.ts:716`
- Mounting: `server/src/app.ts:666-667`; model read `server/src/services/heartbeat.ts:7164-7166`
