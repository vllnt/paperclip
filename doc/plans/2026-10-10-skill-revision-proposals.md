# Skill revision proposals with an approval policy

Status: plan only, no code. Security gate: this changes who can alter the text every agent follows.
Base: `main` at `38819d350`. Every `file:line` below is on that commit. A bare `company-skills.ts:N` is
`server/src/routes/company-skills.ts`; `svc :N` is `server/src/services/company-skills.ts`. All API paths in this plan
are relative to `/api/companies/:companyId`.
Related: #13 (agents read and edit skill files from a sandbox run, `7056769b0`), #59 (agents create skills from a
sandbox run, `338936dca`), the open follow-up on skill import (fetch policy and key-conflict authorization).
Decisions: the manager answered Q1 to Q12 on 2026-10-10 at 17:09 UTC (section 8). An independent review of the first
draft found one P0, seven P1s and a list of P2s. This revision folds them in; the review trail is in the pull request.

## 1. Summary

An agent that wants to change an existing company skill does not write it. It files a **proposal**: the full new
`SKILL.md` plus the id of the version it was written against. An **approver** reads a server-built diff and decides.
When the approver approves, the server applies exactly the stored bytes, in one transaction, only if the skill still
holds the bytes the proposal was written against. It reads the result back, keeps the previous version as the
before-image, and writes an activity entry for every step. The board can revert an applied proposal while nothing has
changed since. A company can also **protect** skills: on a protected skill the server refuses every direct text, head or
source change by an agent on the routes that carry the skill's id, so a proposal is the only way in. It also refuses an agent's overwrite of a protected skill through the by-key import paths (section 4.9).

```
 author (agent)            server                         approver (board, later an agent)
 ---------------           ------------------------       ---------------------------------
 POST proposal  ---------> validate, cap, store
 (markdown, base id)       status = pending  ----------->  GET proposal (diff, metadata)
                                                           POST decision {approve}
                           lock name, proposal, skill <--
                           check: pending, approver allowed, base bytes unchanged
                           updateFile(expectedVersionId, expectedPreviousSha256)
                           read back disk + version, compare sha256, keep before-image
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
  `:162-164`). So a same-company agent can edit any editable skill today, and proposals add nothing until the company
  denies those actions or protects its skills.
- Two exceptions exist and do not change the picture: a low-trust agent is denied `skill_config:update`
  (`server/src/services/authorization.ts:1033-1054`), and a viewer as the run's responsible user blocks writes
  (`server/src/routes/authz.ts:93-102`).

So this plan has two halves, and the second is what makes the first worth anything:

1. A proposal path: propose, decide, apply, revert.
2. A **protected-skills invariant** enforced by the server (section 4.9), because a policy that the board must
   hand-write correctly is not a guarantee. The plan does not silently rewrite the company's policy.

### 2.1 Every route that can change an existing skill

| Route (under `/api/companies/:companyId`) | Policy action | Source |
| --- | --- | --- |
| `PATCH /skills/:skillId/files` | `skills.edit` | `company-skills.ts:1227-1234`; compare-and-set only when the caller sends `expectedVersionId` (`:1234`, svc `:4691`) |
| `DELETE /skills/:skillId/files` | `skills.edit` | `:1317-1323` |
| `PATCH /skills/:skillId` | `skills.edit` | `:1196-1202` |
| `POST /skills/:skillId/rename` | `skills.edit` | `:985-994` |
| `POST /skills/:skillId/versions` | `skills.create` | `:879-885`; moves `currentVersionId` with no text change (svc `:3670-3675`) |
| `POST /skills/:skillId/fork` | `skills.create` | `:950-962`; reassigns agents from the source key to the fork key (svc `:3995`, `:4066`) |
| `POST /skills/:skillId/install-update` | `skills.update` | `:1542-1548`; replaces text from the upstream source |
| `POST /skills/:skillId/reset` | `skills.reset` | `:1592-1598` |
| `DELETE /skills/:skillId` | `skills.remove` | `:1476-1479` |
| `POST /skill-sources/...` (create, patch, refresh, delete) | `skills.update`, `skills.edit` or `skills.import` | `:377-394`; managed-source updates carry the skill id and key (`server/src/services/skill-sources.ts:56-58`, `:65`) |
| `POST /skills/import` | `skills.import` | `:1348-1354`; `upsertImportedSkills` updates the row that has the same key in place (svc `:6259`) |
| `POST /skills/scan-projects` | `skills.import` | `:1440-1446`; builds an `updated` list (svc `:5123`; the full update path is not traced here) |
| `POST /skills/install-catalog` | `skills.install` | `:1393-1398` |
| `POST /skills` (create) | `skills.create` | `:1142-1147`; a slug that already has a skill returns 409 (svc `:4518`) |

Three consequences for the design:

- A rule that selects a skill by `skillIds` or `skillKeys` cannot stop **import**, **scan-projects** or **catalog
  install**, because their policy resource carries a source and no skill id (`company-skills.ts:198-207`,
  `:1398-1401`). An import whose frontmatter key matches an existing skill overwrites it, and it re-points the row's
  `sourceLocator` at the importer's directory (svc `:6300`). Local import is allowed from project workspace roots
  (svc `:2968-2981`), and those roots are the places where agents work. The live bytes of a `local_path` skill are then read from
  that directory (svc `:4370-4376`), so later edits need no API call at all. The #59 review found the same pattern.
  S1 guards the agent case for protected skills (section 4.9); the general weakness stays a dependency (section 8.1).
- **The version id does not identify the bytes.** Only file update, file delete, create, fork, release seeding and the
  test-run auto version call `createVersion` (svc `:3095`, `:4059`, `:4625`, `:4746`, `:4815`, `:6601`). Rename
  rewrites the `name:` line of the on-disk `SKILL.md` without one (svc `:4175`), and so do install-update, reset and an
  import overwrite. For a `local_path` skill the live bytes are the file on disk (`readLoadedSkillFile`, svc
  `:4353-4378`). A base check on the version id alone can pass while the bytes underneath have changed (section 4.8).
- **Skill ids are compared as raw strings.** `skillPolicyResource` copies `req.params.skillId` into the policy resource
  (`company-skills.ts:189`), nothing in the file normalizes it, and `resourceMatches` tests `skillIds.includes(...)`
  (`company-skill-policy.ts:57`). Postgres's `uuid` type also accepts upper-case and hyphenless input (not run here), so
  `getById` (svc `:3384-3391`) can find the row for an id written differently from the one a rule lists. That weakens
  `skillIds` rules today, and it would defeat the invariant of section 4.9 if the invariant compared the raw string, so the
  invariant compares the stored id. The existing weakness is listed in section 8.1.
- Only a skill whose source type is `local_path` is editable (svc `:4695-4698`). Catalog and git skills are not, so a
  proposal against one is refused at submit.

### 2.2 What a skill policy can express today

- Actions: `skills.create|import|install|edit|update|test|reset|remove`
  (`packages/shared/src/validators/skill-policy.ts:3-12`).
- A rule has a priority, an effect (`allow` or `deny`), a subject (`all_agents`, `agents`, `roles`), actions and
  optional resource selectors (`skillIds`, `skillKeys`, `sourceTypes`, `sourceLocators`) (same file, `:76-105`).
- `all_agents` and `agents` match only an agent principal. The board principal is `{type: "board", role: "board"}`
  (`company-skills.ts:174`) and matches neither. A `roles` rule compares the role string for **both** principal types
  (`company-skill-policy.ts:45-52`). An agent's role is a plain text column (`packages/db/src/schema/agents.ts:22`), and
  three creation paths accept any string (`validators/company-portability.ts:78`, `validators/onboarding-seed.ts:25`,
  `validators/plugin.ts:242`), so a `roles` rule written for people could match an agent. `skills.approve` therefore
  accepts only `agents` subjects (section 4.5).
- With `defaultEffect: "deny"`, a principal that has no matching rule is allowed if it holds the legacy grant
  `skills:create` or `skills:suggest-changes`, **for any action** (`company-skill-policy.ts:139-153`, `:180-186`), and
  that holds for agents and for people. A new action added to the enum is therefore allowed to every legacy-grant
  holder in a default-deny company. The plan's rule for `skills.approve` bypasses that fallback (section 4.5).
- The policy is replaced as a whole with `expectedRevision` compare-and-set and an activity entry
  (`company-skill-policy.ts:189-262`). **Who may replace it:** the board with `users:manage_permissions`, or an
  **agent** that holds `users:manage_permissions` (`server/src/routes/company-skill-policy.ts:43-59`, agent branch
  `:48-52`). An agent with that grant can already grant itself anything. The proposal settings stay out of that check
  (section 4.6).

## 3. What else exists, and why it does not host this

| Candidate | Why it does not fit | Source |
| --- | --- | --- |
| `approvals` | The only decider column is a user id, and approve, reject and request-revision are `assertBoard`. An agent cannot decide. Its apply hooks run after the resolve and are type-specific (`hire_agent`), so there is no compare-and-set apply, and no immutable bytes with a hash. S1 does not need an agent decider, but S2 does, and the table would change twice | `packages/db/src/schema/approvals.ts:16`; `server/src/routes/approvals.ts:287`, `:403`, `:441`; `server/src/services/approvals.ts:154` |
| `decisions` | Every row needs an origin agent, issue **and run** (`NOT NULL`), only a user decides, and a decision executes a signed spec. A board-authored proposal or an agent approver does not fit | `packages/db/src/schema/decisions.ts:43-45`, `:55`, `:59`; `server/src/routes/decisions.ts:181` |
| `skills:suggest-changes` plus "consent" | The platform has a suggest-then-consent model for protected changes (`server/src/services/authorization.ts:1791-1796`, deny reason at `:1644`). The skill gate ignores its denials by design (`company-skills.ts:227-233`), and the key now means "broad mutation" in the legacy fallback. Reusing it would change what existing grants mean | `packages/shared/src/constants.ts:1007-1008` |
| Agent instruction "candidates" | A working-copy conflict flow for one agent's own instructions, with no approver | `server/src/routes/agents.ts:5525-5539` |

Two precedents are worth copying:

- **An agent can be an approver with an explicit grant, and only for what it could change itself.** `joins:approve`:
  "An agent approver may not create an agent with settings it could not set itself"
  (`server/src/routes/access.ts:4330-4345`).
- **An agent can decide a review stage.** `issue_execution_decisions` records `actorAgentId` or `actorUserId`
  (`packages/db/src/schema/issue_execution_decisions.ts:15-16`).

So: a dedicated table with its own state machine, the existing skill policy for who may propose and approve, and the
existing attention surface only to show the board what waits.

### 3.1 Overlap with other work

This plan reuses what exists and defines nothing that another plan or pull request already owns.

| Work | What it is | Overlap | Rule |
| --- | --- | --- | --- |
| #13, #59 (merged) | Agents edit skill files and create skills from a sandbox run | They are the reason direct writes are open (section 2) | This plan sits on top of them and removes neither |
| #114 (open plan) | Software factory plan, `doc/plans/2026-10-10-software-factory.md` | Its "Retrospective and improvement loop" row (`:15` of the file on the #114 branch at `d80fe041d`) names this plan (#107) and reuses "proposal, eval, revision, and activity endpoints" | #114 points at #107 and defines no second flow. A skill-change approval step in a workflow calls the proposal routes of section 4.14. This plan defines no workflow or project concept |
| #109 (open fix) and #92 (open plan) | Decisions: how a dismissed decision is recorded; reusable decisions that agents call as tools | A skill proposal is **not** a decision row. A decision needs an origin agent, issue and run (`NOT NULL`, `packages/db/src/schema/decisions.ts:43-45`), only a user decides (`:55`, `server/src/routes/decisions.ts:181`), and it carries a signed spec (`:59`). A board-authored proposal or an agent approver does not fit | #109 changes only `services/decisions.ts`, `services/decision-wakeup.ts` and the decision card, so these anchors hold. #92 touches skills only through Skill Studio test runs, which Q2 may reuse later. Neither defines a skill-change flow |
| #89 (open) | Board skill, `paperclip-create-agent` links, and a skill-writing checklist | #89 adds nested bullets under the existing `## Notes` heading of `skills/paperclip/references/company-skills.md`. This plan edits no file that #89 edits | S1 adds no line to `skills/paperclip/SKILL.md` and nothing above a heading in `skills/paperclip/references/**`. Both are anchored by line in the runner capability contract, and a shifted heading fails the image build. If S1 must touch one, it extends an existing line and runs `node scripts/generate-capability-contract.mjs --check` and `node scripts/check-capability-inventory.mjs` in `packages/paperclip-runner`. When S1 lands, the checklist from #89 gets one bullet that says an agent changes an existing skill by proposing |
| Launcher (#86 merged, #95 open) | The keyboard-first action catalog | The catalog is `packages/shared/src/command-actions.ts:66-92` on `main` at `d9804ac4f` (added in `d47df97f0`, after this plan's base) | New entry points are actions in `COMMAND_ACTIONS`, not new sidebar buttons (section 4.14) |

## 4. Design

### 4.1 Principles

1. **Immutable proposal.** Content never changes after submit. A change is a new proposal.
2. **Bytes, not ids.** Apply passes `expectedVersionId` to the existing `updateFile`, **and** a hash of the bytes that
   are on disk right now. A moved head, or a changed file under an unchanged head, makes the proposal stale. It never
   merges.
3. **Check at decision time.** Settings and policy are read when the decision is made, not when the proposal was
   filed, so a revoked approver or a tightened rule takes effect on pending proposals.
4. **Fail closed.** Unknown model family, missing run context, disabled settings and unreadable policy all refuse.
5. **No new bypass.** The approver is never the author, and the proposal path never writes more than the approver
   could write directly.
6. **No skill text in logs.** Not in the activity log (stored and published to subscribers,
   `server/src/services/activity-log.ts:151`, `:160`, `:217`), and not in the HTTP failure log, which records the request
   body of every response with status 400 or above (`server/src/middleware/logger.ts:163-198`). Section 4.14 closes
   the second one.
7. **The gate is only as strong as the board's credentials.** Where an agent can act as the board, no review holds.
   Section 4.15 says where, and what the server reports.
8. **The protection is API-level.** The live bytes of a `local_path` skill are files on disk, and an agent with file access
   can edit them without any API call. Section 4.9 says what the plan does about that and what it cannot.

### 4.2 Data model

Two tables. Numbers are assigned just in time, when the implementation PR is rebased onto `main` (`main` is at
`0298`); this plan reserves none. S2 adds its columns in its own migration.

`company_skill_proposals`

| Column | Notes |
| --- | --- |
| `id` uuid pk, `company_id` uuid not null | Company-scoped; every query filters on `company_id`, including lookups by proposal id. |
| `skill_id` uuid not null, `skill_key` text | `skill_id` cascades with the skill. `skill_key` is a snapshot for the log and the list. |
| `base_version_id` uuid null, `base_sha256` char(64) | The version the text was written against and the SHA-256 of that version's `SKILL.md` snapshot. Null version only when the skill has no current version, mirroring `updateFile`'s null compare (svc `:4691`). |
| `proposed_markdown` text not null, `proposed_sha256` char(64) not null, `proposed_bytes` int | Full `SKILL.md`. Cap in section 4.7. The body is nulled by the retention job (Q9). |
| `title` text, `summary` text | `summary` is untrusted author text. |
| `author_agent_id` uuid not null | S1 authors are agents (Q13). Set null on agent delete. |
| `author_run_id`, `author_issue_id` | From the task-bound run (`projectToolContext`, section 4.5). |
| `status` text | `pending`, `applied`, `rejected`, `withdrawn`, `expired`, `stale`. |
| `decided_by_user_id` / `decided_by_agent_id`, `decided_at`, `decision_note`, `decided_run_id`, `decided_issue_id` | The agent columns are used from S2. |
| `before_version_id`, `before_sha256` | The version that was the head at apply, and the SHA-256 of the bytes that were actually on disk. |
| `applied_version_id`, `applied_at`, `applied_sha256` | |
| `reverted_at`, `reverted_by_user_id`, `revert_version_id` | An attribute of an applied row, not a status (section 4.11). |
| `idempotency_key` text | Unique per `(company_id, author_agent_id, key)` where not null. |
| `expires_at`, `created_at`, `updated_at` | |

Foreign keys: `skill_id` cascade; the version columns set null; agent columns set null. Deleting a skill therefore
deletes its proposals, applied ones included. The activity entries keep ids and hashes, and pending authors are not
woken. S1 accepts this: a delete is itself a gated, logged action.

Indexes: `(company_id, status, created_at)`; `(company_id, skill_id, status)`; `(company_id, author_agent_id,
created_at)` for the caps; a partial unique index on `(skill_id, author_agent_id)` where status is `pending`, so one
author has at most one open proposal per skill; a partial unique index on `(skill_id, proposed_sha256)` where status is
`pending`, so the same bytes are never open twice.

`company_skill_proposal_settings`: one row per company: `company_id` pk, `revision` int, `settings` jsonb,
`created_at`, `updated_at`. A separate table, not columns on `company_skill_policies`, because
`DELETE /skill-policy` removes that whole row (`company-skill-policy.ts:266-290`) and would silently switch the
approval rules off at the moment direct writes reopen.

**Company deletion.** Removal is by table name in a fixed order (`server/src/services/companies.ts`:
`decisions` `:653`, `heartbeatRuns` `:655`, `approvals` `:665`, `companySkills` `:673`, `issues` `:688`, `agents`
`:695`). Both new tables are removed before `heartbeatRuns`, `issues` and `agents` because they reference runs, issues
and agents, and before `companySkills`. Each new foreign key is also added to `CROSS_COMPANY_REFERENCES`
(`server/src/services/company-removal-cross-company.ts`), which `company-removal-coverage.test.ts` checks against the live
foreign keys.

### 4.3 State machine

| From | Event | To | Who |
| --- | --- | --- | --- |
| (none) | submit | `pending` | author agent |
| `pending` | approve and apply succeeds | `applied` | approver |
| `pending` | reject | `rejected` | approver |
| `pending` | withdraw | `withdrawn` | author or a human approver |
| `pending` | base bytes changed, found at a decision | `stale` | system |
| `pending` | `expires_at` passed, found at a write | `expired` | system |

A read never writes. A list or detail response computes `effectiveStatus` (`stale` when the head or the bytes moved,
`expired` after `expires_at`) and the attention item is derived from it. The status is persisted only by a write that
touches the row (a decision, a withdraw) or, in S3, by a sweeper. S1 has no scheduler.

All transitions are `UPDATE ... WHERE status = 'pending'`. A second concurrent decision gets 409
`skill_proposal_not_pending`. A retry of a decision that already succeeded, by the same approver, returns 200 with the
stored result (section 4.8). Terminal states are final; a new attempt is a new proposal.

### 4.4 Who may do what

| Action | Human approver | Author agent | Other agent |
| --- | --- | --- | --- |
| Submit | no (Q13) | yes, if `skills.propose` allows and the run is task-bound | same as author |
| Read a proposal and its diff | any member with company access, viewers included | yes, own proposals | only an approver-eligible agent (S2) |
| Decide (S1) | a member whose human role is in `humanApprovers.roles`, not the author | no | no |
| Decide (S2) | as S1 | no | an agent with an explicit `skills.approve` allow rule, not the author, subject to 4.5 and 4.6 |
| Withdraw | as decide | yes, own | no |
| Revert | as decide | no | no |
| Change settings | a **person** with `users:manage_permissions`, or an instance admin | no | no |

"Human approver" means a board actor with access to the company. Viewers are already refused on every non-GET request
that carries a membership: `assertCompanyAccess` rejects `membershipRole === "viewer"` (`server/src/routes/authz.ts:104-119`),
so the decision, withdraw and revert routes need no separate viewer check. They do need to check the role list
themselves. That function skips instance admins, and it skips the company check entirely for the `local_implicit`
actor (`:104`); section 4.15 covers the second. GET is not restricted by role, so "any member may read" is the existing
behavior and the author and approver-agent read rules are explicit code.

There are two bars, not four: the **decide bar** (decide, withdraw, revert) is `humanApprovers.roles`, and the
**settings bar** is a person with `users:manage_permissions`. A board tightens the decide bar by editing the list (Q12).

### 4.5 Policy and authorization

- **New policy action `skills.propose`.** Evaluated by the existing engine with `skillPolicyResource` for the skill.
  When no policy is stored, agents are allowed (proposing is the safe path). A default-deny policy denies it unless a
  rule allows it, or the agent holds a legacy grant, which is acceptable because that agent could write directly.
- **New policy action `skills.approve` (S2), closed for agents by default.** For an agent it is allowed only by an
  explicit `allow` rule. This is a special case in `evaluate` that bypasses **three** defaults: the unmaterialized
  policy that allows everything, `defaultEffect: "allow"`, and the `legacy_compatibility` fallback. It has its own test
  for each. Policy validation rejects a `skills.approve` rule whose subject is `all_agents` or `roles`, or that has no
  `resources.skillIds` or `resources.skillKeys` selector. Only `agents` subjects with a skill selector are accepted
  (this also closes the `roles` match described in section 2.2).
- **The board's authority to decide does not come from the policy.** A stored default-deny policy would otherwise
  lock out any person who holds neither legacy grant, because the board principal matches no subject except a
  `roles` rule (`company-skill-policy.ts:45-52`, `:180-186`). The human check is company membership and
  `humanApprovers.roles`, as in 4.4.
- **Run context.** Submit and decide by an agent call `projectToolContext(db, actor, true, "Skill")`
  (`server/src/services/project-tool-context.ts:8-24`) and refuse on failure. It accepts only a JWT run, requires a
  task-bound issue, and refuses Ask and Plan mode. This is **stricter than skill create today**: create builds its run
  context only when the actor is a JWT agent with a run id (`company-skills.ts:1152-1153`), so an agent key with no run
  writes without one. A proposal never accepts that actor.
- **Least privilege for an agent approver** (the `joins:approve` rule): the approver's allow rule must select the
  skill. An approver cannot approve a skill outside its selector.

### 4.6 Settings document

```json
{
  "enabled": false,
  "humanApprovers": { "roles": ["owner", "admin", "operator"] },
  "protectedSkills": { "all": false, "skillIds": [] },
  "agentApproval": { "enabled": false, "requireDifferentModelFamily": true },
  "caps": { "submittedPerAuthorPer24h": 20, "appliedPerSkillPer24h": 5, "openPerAuthor": 5, "openPerCompany": 50 },
  "expiresAfterHours": 336
}
```

- `enabled: false` is the default and changes nothing. While it is false, submit returns 409
  `skill_proposals_disabled`, the protected-skills invariant is off, and existing rows stay readable.
- **Human approvers** are the active members whose role is in `humanApprovers.roles`. The values are the human roles of
  `packages/shared/src/constants.ts:973-978` (`owner`, `admin`, `operator`, `viewer`). `viewer` is never accepted in the
  list. The default is the other three, which is the S1 bar of section 4.4. A membership with the company role `member`
  exists (`server/src/services/access.ts:1019`), so the check maps `member` to `operator` and **nothing else**. It does not
  call `normalizeHumanRole` with its usual fallback: every existing caller passes `"operator"` as the fallback
  (`server/src/routes/access.ts:1216`, `:1269`, `:1296`, `:1321`; `server/src/services/authorization.ts:709`), which turns
  any unknown or null role into `operator`, and cloud-tenant memberships can carry other roles or none
  (`server/src/middleware/auth.ts:584-600`). A role outside owner, admin, operator and member, and a null role, are
  refused. To require owner or admin, a person sets `["owner", "admin"]`. The check runs at decision time, so it applies to
  pending proposals. An instance admin always counts. An actor whose membership data is missing is refused (fail closed),
  because `assertCompanyAccess` checks memberships only when the array is present (`server/src/routes/authz.ts:111`).
- **Protected skills** are stored **by id**, in canonical lower-case form. A request that names a key or writes the id in another form is resolved
  to the stored id when the settings are written, because keys are derived from the slug and change on rename (svc `:4105`, `:4184`). `all: true` protects
  every existing and future skill. Renaming a protected skill keeps it protected (same id). A fork is a new,
  unprotected skill unless `all` is on. The invariant is in section 4.9.
- **Agent approval needs both** `agentApproval.enabled` **and** an explicit `skills.approve` allow rule. One without
  the other is a refusal. A protected skill is never decided by an agent. `requireDifferentModelFamily` applies only to
  agent approvals (S2).
- **Caps** are rolling 24 hours, counted from rows, under a per-author advisory lock (and, for `openPerCompany`, a company-level one) so a
  burst cannot step over the cap. `null` turns a cap off. `openPerCompany` stops many authors from flooding the approver. `appliedPerSkillPer24h`
  is checked at decision time under the skill lock; when it is exceeded the proposal stays pending and the caller gets
  409 `skill_proposal_cap_reached`. A revert does not count.
- Changing settings uses `expectedRevision` compare-and-set and writes `company.skill_proposal_settings_updated`.
  Only a person may change them (4.4), because the policy route also lets an agent holding
  `users:manage_permissions` rewrite the gate (`server/src/routes/company-skill-policy.ts:48-52`). That route is a
  named dependency (section 8.1).

### 4.7 Submit

`POST /skills/:skillId/proposals` with `{ markdown, baseVersionId, title?, summary?, idempotencyKey? }`.

Order and status codes (AGENTS.md lists the codes in use): the size and text checks run first, on the request body,
before any query, lock or write. Validation failures return **422**. State conflicts return **409**. A denied actor
gets **403**, and an unknown skill gets **404**. Every refusal carries a stable `code`.

Refused when:

1. the markdown exceeds **256 KiB** (422 `skill_proposal_too_large`, with the limit and the received size in the
   message), is not valid UTF-8, or contains a character from any of these Unicode general categories: `Cc` other than tab
   and line feed (this covers NUL, carriage return and U+0085), `Cf` (BOM, bidirectional controls, zero-width and joiner
   characters, soft hyphen, word joiner, the Tags block U+E0000-E007F), `Cs` (lone surrogates), `Co`, `Cn`, `Zl`, `Zp`, and
   `Zs` other than the plain space; or a variation selector (U+FE00-FE0F, U+E0100-E01EF) (422). Emoji sequences that need
   a zero-width joiner are refused; that cost is accepted;
2. the file has no frontmatter, or the lines between the frontmatter fences differ from the base in count, or in any line
   other than a `name:` or `description:` line, or a changed position does not hold the same key (`name` or `description`) in the base and in the proposal, or a changed
   `name:` or `description:` line (or the base line it replaces) is not a single-line plain scalar (422 `skill_proposal_frontmatter_changed`). The **grammar applies to changed lines
   only**. A single-line plain scalar is `key: value` where the value starts with a letter or digit, does not start or end
   with a quote character, and contains no `: ` and no ` #`. A quoted scalar can span lines in a real YAML reader, and a
   `: ` or ` #` inside a plain scalar changes how it parses, so those are refused rather than interpreted. Every unchanged
   line, including a folded or block-style `description:` line (`>` or `|`) and its continuation lines, passes when it is
   byte-equal to the base. A proposal therefore cannot edit a block-style description in v1 (it can still change the body),
   and it can still be made against a skill that has one. This matters: a scan of the 56 `SKILL.md` files in the repository
   that have a description found 26 with a block-style description, 1 quoted and 1 containing `: `, so a grammar applied
   to unchanged lines would have made about half of them impossible to propose against.
   This is a **byte rule, not a parse**: the repository's frontmatter reader is hand-written and lenient
   (`packages/shared/src/frontmatter.ts`; it splits on `\n` only and cannot see quoted keys, anchors or tags), and a parser
   mismatch is exactly where a smuggled key would hide. Frontmatter keys such as `iconUrl`, `homepage`, `author`, `tagline`
   and `categories` are copied into board-visible skill metadata on every write (`readSkillStoreMetadata`, svc
   `:1874-1888`, called at svc `:4733`), and other keys may carry behavior for a runtime that reads the file; whether any
   runtime honors them is outside the server and not verified here. The board can still edit those keys directly;
3. the text is byte-identical to the **current file on disk** (the live bytes, section 2.1) (422), or the base
   `SKILL.md` itself contains a carriage return or a BOM, so that no proposal could match it line by line (422
   `skill_proposal_base_not_canonical`; the board normalizes the file first);
4. the skill is not editable (`sourceType` is not `local_path`) (422);
5. settings are disabled (409), the actor lacks `skills.propose` (403), or the run context fails (403, from
   `projectToolContext`);
6. `baseVersionId` is not the skill's current version (409 `skill_proposal_base_stale`, returns the current id), or the
   disk bytes differ from the base snapshot (409 `skill_proposal_base_changed`);
7. a cap is exceeded, the author already has an open proposal for this skill, or the same bytes are already open (409);
8. the idempotency key was used with different input (409). A replay with the same key and input returns the stored
   proposal with 200.

v1 changes `SKILL.md` only. Reference files and scripts are out of scope (Q5). A proposal cannot set an executable
bit, add a script or change a file other than `SKILL.md`.

### 4.8 Decide and apply (one transaction)

`POST /skill-proposals/:proposalId/decision` with `{ decision, reviewedSha256?, note?, idempotencyKey? }`.
`reviewedSha256` is optional for a human and required for an agent approver (S2). Proposal rows are immutable, so the
id already fixes the bytes; the hash proves only what the approver's client displayed. If it is present and differs
from `proposed_sha256`, the decision is refused.

For `approve`, in one outer transaction (the same shape the idempotent file-update route already uses with a
transaction-scoped service, `company-skills.ts:1242-1258`):

1. Take the skill's **name advisory lock first** (the key `withSkillFileMutation` uses, svc `:4639-4664`; advisory
   locks are re-entrant in a session), then lock the proposal row, then the skill row. `deleteSkill` takes the advisory
   lock and then deletes the skill row, which cascades to proposal rows (svc `:7150-7206`); locking the proposal row
   before the advisory lock could deadlock against it. Re-read the slug after the lock. If a rename moved it, the transaction ends and the whole decision starts
   again once, because transaction-scoped advisory locks cannot be released early. A deadlock against a rename (it locks
   its slugs in sorted order, svc `:4639-4664`) is covered by the same one retry (`40P01`).
2. Refuse unless `status = pending` and not expired. Re-read settings and evaluate the approver now (4.4 to 4.6). The
   approver is not the author. If `reviewedSha256` is present, it must match.
3. Check `appliedPerSkillPer24h`.
4. Call the existing `updateFile(companyId, skillId, "SKILL.md", proposed_markdown, author, { expectedVersionId:
   base_version_id, expectedPreviousSha256: base_sha256, versionLabel, afterUpdate })`. `expectedPreviousSha256` is the first of
   **two new optional parameters**: `updateFile` already reads the file on disk under the lock before it writes (svc `:4709`),
   and with the parameter it throws a conflict if the SHA-256 of the raw bytes it read differs. The check goes right after
   that read, before the `onRollback` hand-off (svc `:4718`) and the `try` (svc `:4720`). `SKILL.md` is always UTF-8 (`updateFile`
   refuses base64 for it, svc `:4704`), so the hash is of the raw bytes read from disk. That makes the check atomic with the write, and
   it fails closed when a rename, an import overwrite, an install-update, a reset or an out-of-band edit changed the file
   without a new version. A moved head throws the existing 409 (svc `:4691-4693`). The version's author is the
   **proposal author**, so history blames the right party; the approver is on the proposal row, in the version label and
   in the log. The label (`versionLabel`, "Proposal <id> approved by <approver>") is the second new parameter: `updateFile`
   passes `{}` to `createVersion` today (svc `:4746`), so it needs a way to carry a label.
5. Do the rest **inside `afterUpdate`** (it runs before commit and inside `updateFile`'s own `try`, svc `:4754`), so any
   failure there goes through `updateFile`'s catch, which restores the file on disk (svc `:4711-4718`, `:4756-4759`):
   1. read the result back from two independent places, the file on disk (`readLoadedSkillFile`, svc `:4353-4378`) and
      the new version row's `SKILL.md` snapshot, and require both SHA-256 values to equal `proposed_sha256`. The
      `skills.markdown` column proves nothing, because it holds the same string that was passed in (svc `:4730-4732`);
   2. record `before_version_id`, `before_sha256` (the hash `updateFile` verified), `applied_version_id`, `applied_at`,
      `applied_sha256`, and status `applied`;
   3. write `company.skill_proposal_approved` and `company.skill_proposal_applied` in the same transaction.

   If the new bytes equal the old bytes, `updateFile` creates no version (svc `:4745`); that case is refused at submit
   (item 3 of 4.7) and, if it still arises, the decision fails with 409 `skill_proposal_base_changed`.
6. **Compensate a failure after `updateFile` returned** (a failed commit, for example). `updateFile` writes the file on
   disk before the database commit, so a rolled-back outer transaction would leave the approved bytes on disk with the
   old version as head. The existing file-update route already handles this: it passes `onRollback` the restore function
   and the version id the head had **before** the write (svc `:4718`), and in a `.catch` after the outer transaction
   fails it locks the skill row and calls `restore()` only if the head still equals that id
   (`company-skills.ts:1271-1282`). Apply copies that wrapper exactly. If the head moved, nothing is restored.
7. After commit: publish the activity and wake the author with `skill_proposal_decided`.

**Stale and error mapping.** A moved head or changed bytes returns 409 `skill_proposal_base_stale` or
`skill_proposal_base_changed`. The proposal becomes `stale` in its own small transaction that starts **after** the outer
transaction has rolled back (inside the catch it would wait on the proposal row lock the outer transaction still holds).
Other apply failures keep distinct codes and leave the proposal pending: 409 `skill_renamed_retry` (svc `:4661`), 422
`skill_not_editable` (the source type changed by an import), 404 `skill_file_missing`, and one retry on a deadlock
(`40P01`).

**Two approvals racing on one skill.** Two different proposals can share a base (the unique index limits one author, not
two). They serialize on the name lock and the skill row lock. The loser fails the version compare or the disk-hash
compare, before any write to disk, and its proposal becomes `stale`. The disk-hash compare also covers one case the
version compare cannot: the winner rolled back after writing and its restore has not run yet, so the loser would
otherwise read the winner's uncommitted bytes as the "previous" file.

**Decision retry.** A repeat of a successful decision by the same approver with the same bytes returns 200 and the
stored result. Any other repeat gets 409 `skill_proposal_not_pending`.

`reject` records the decision, status `rejected`, one activity entry, and the same wake. It needs no hash.

**Windows this design leaves open, stated rather than hidden.** The file is on disk before the commit, so a runtime that
materializes the skill (svc `:5868-5886`) in that short window can read bytes that then roll back, and a server crash
between the write and the commit leaves new bytes on disk with the old head; reconciliation refreshes inventory only
(svc `:3138-3188`). The PATCH route has both windows today. This plan does not widen them and does not close them.
`withSkillFileMutation` also runs `ensureSkillInventoryCurrent` first (svc `:4645`), which can delete skills and remove
directories (svc `:3205-3208`); inside an outer transaction it runs on the transaction handle, and a module-level promise
map (svc `:415`) shares it across requests. The idempotent PATCH has the same exposure. A test covers it (section 7).

**Why approve and apply are one step.** A separate apply leaves approved bytes waiting while the base can move, and it
adds a state whose only job is to be stale. If an approval cannot be applied, nothing is approved. Q3 decided: no manual
apply.

**A version snapshot with no text change.** `POST /versions` moves `currentVersionId` without changing text (svc
`:3670-3675`). v1 compares version ids exactly, as `updateFile` does (Q4 decided), so such a snapshot makes a pending
proposal stale and the author resubmits. S3 may relax it to "the base `SKILL.md` bytes are unchanged" if the noise
justifies it.

### 4.9 Protected skills, and the direct-write gate

The policy engine cannot give the guarantee "only a reviewed proposal changes this skill": a rule that selects a skill
does not cover the by-key paths (section 2.1), and a company must hand-write the right deny rules. So the server
enforces it.

**The invariant.** While `enabled` is true and a skill is protected, the server refuses an **agent** actor's change to
that skill's text, head or source with 403 `skill_protected_use_proposal`, before it asks the policy. The check lives in
`assertCanMutateCompanySkills` (`company-skills.ts:209-251`), the one choke point, but it is keyed on neither the action
string nor the raw URL id:

- *Scope.* The routes that change text, head or source pass an explicit flag to that function: file update and delete,
  skill patch, rename, versions, fork, install-update, reset, remove and managed-source updates (the routes of section 2.1
  that carry a skill id; `skill-sources.ts:56-58`, `:65`). Test inputs, test runs, templates and audit use `skills.edit` or
  `skills.test` too (`company-skills.ts:510`, `:536`, `:563`, `:698`, `:802`, `:845`, `:1511`) but change no skill text, so
  they are not flagged, with one exception handled below: a test-run start can cut a head version. The proposal routes (`skills.propose`, `skills.approve`) are never flagged.
- *Canonical id.* The check resolves the row with `getById` and compares the stored `id` to the protected set. It does not
  compare `req.params.skillId`: upper-case or hyphenless forms of the same uuid reach the same row (section 2.1), so a
  raw-string comparison would let an agent step around it. Section 7 has a test for both forms.

A person is not affected: the board edits directly, as today (in `local_trusted` the implicit board is that person, section
4.15). A proposal is the only agent path on these routes.

**By-key paths: guards where the overwrite happens.** Five routes can overwrite a skill's row by key without naming its id:
import, scan-projects, install-update, catalog install and the shipped-team install. They end in two places:

- `upsertImportedSkills`, which looks the row up by key (svc `:6259`). Its callers are bundled seeding (svc `:3018`,
  `:3020`), fork (`:4021`), create (`:4582`), install-update (`:4944`), scan-projects (`:5297`, `:5398`, `:5455`),
  `importPackageFiles` (`:6232`) and `importFromSource` (`:6377`). Install-update can reach *another* skill's row: it
  re-imports from the skill's source and takes the entry whose key matches **or the first entry** (`matching = ... ??
  result.skills[0]`, svc `:4940`), so an upstream document that carries a different `key:` rewrites that other skill.
- `installFromCatalog` (svc `:5714-5866`), which does **not** go through `upsertImportedSkills`. It finds the existing row
  by key (svc `:5728`) and overwrites it when the same catalog entry has a changed hash, or when `force` is set
  (svc `:5734` onward). An agent could therefore move a protected catalog skill to newer shipped bytes.

S1 gives each of the two an optional `guard` argument: a callback invoked with the existing row before anything is
written. When the row is protected and the actor is an agent, the guard throws 403 `skill_protected_use_proposal`. The
routes pass a guard built from `req.actor`: import, scan-projects, install-update, catalog install, and the shipped-team
install (`server/src/services/teams-catalog.ts:880`, `:892` call `installFromCatalog` and `importFromSource` with no actor;
its route requires `agents:create`, `server/src/routes/teams-catalog.ts:36-60`, so an agent can reach it). Internal callers
pass none: bundled seeding, fork and create make new rows or already conflict on an existing slug. An import that creates
a new key still works. Managed-source create and refresh are not by-key: they write rows directly under new unique keys and
are covered by id (`skill-sources.ts:56-58`, `:65`). Company import never overwrites an existing row outside the board's
full mode (it skips or renames, `server/src/services/company-portability.ts:259-262`). The guards do not replace the import follow-up of section 8.1, which everyone else still needs. The
bridge does not admit import for sandbox runs today (#13 kept it human-only).

**Test runs.** A test-run start cuts a head version labelled "Auto version for test run" whenever the files on disk differ
from the head snapshot (`ensureRunSkillVersion`, svc `:6589-6604`, called by `createTestRun`, svc `:6710`). On a protected
skill an agent's test-run start is refused with 409 `skill_protected_disk_drift` when the files on disk differ from the head
snapshot, and it never cuts a version. Otherwise an agent could edit the file with its ordinary tools, start a test run, and
make the edit the official head with no review.

**The filesystem limit.** The invariant is API-level. The live bytes of a `local_path` skill are the files on disk (svc
`:4370-4376`). The runtime does not even copy them: `resolveRuntimeSkillSource` returns the live source directory itself
when it exists (svc `:6033-6034`), and `materializeRuntimeSkillFiles` (svc `:5868-5886`, called at `:6069`) is only the
fallback when the directory is missing. A skill that lives in a project workspace, or under the managed root, is writable
by an agent with file access, and a disk edit is live at the next run. Such an agent can change a protected skill's text
without any API call, and S1 cannot stop that. What S1 does: the refusals above; `PUT /skill-proposal-settings` reports each
protected skill's location (managed, or inside a project workspace) with a warning for the second; an edit to `SKILL.md`
makes pending proposals stale (`skill_proposal_base_changed`, because the base hash covers `SKILL.md` only), which is a
visible symptom only when a proposal is pending and only for that file; and T20 names the limit. S3 can close it by
serving protected skills from the head version snapshot (Q15).

With `all: true`, a skill an agent creates (#59) is protected from that moment, so the create-then-edit loop becomes
create, then propose.

**Agent skill assignment is out of scope.** Which skills an agent runs is governed by agent-config permissions
(`POST /agents/:id/skills/sync` is admitted by the bridge, `sandbox-callback-bridge.ts:160`). A protected skill's text
cannot be changed by an agent, but an agent with agent-config rights can still point another agent at a different skill.
The plan names this as a non-goal (T18).

**The gate status** stays as a diagnostic for companies that do not protect everything. `GET /skill-proposal-settings`
returns `directWriteGate`: for each active agent it evaluates (with no resource, and once more for each protected skill id with that skill as the resource, so rules with selectors match) `skills.edit`, `skills.update`, `skills.reset`,
`skills.remove`, `skills.install`, `skills.import` and `skills.create` (the last on a skill id, for `POST /versions`)
against the policy read once, and reports the agents that still have each action open, with the matching rule ids. It
reports `open`, `partly_open` or `closed`. It is a diagnostic. It is not what protects a skill. The web panel and the CLI
show it with the text: "Agents can still change unprotected skills directly."

**The recommended policy snippet.** To close direct writes on **specific** skills, protect them and do nothing else. To
close them on every skill, set `all: true`. The plan does not recommend denying `skills.create` to all agents, because
that also stops agents from creating new skills (#59). A deny scoped with `resources.skillIds` covers `POST /versions`
and fork for those skills.

### 4.10 Model family (S2)

There is no model-family notion for agents on `main`. The nearby `normalizeProviderFamily`
(`packages/adapter-utils/src/acpx-engine/startup-timing.ts:39`) classifies sandbox providers for telemetry and is a
different thing. The plan defines one, and labels it **advisory**:

- Input: the adapter type (15 values, `packages/shared/src/constants.ts:27-43`) and the model that the **run**
  resolved, snapshotted at submit and at decide. Reading `adapterConfig.model` (`server/src/services/heartbeat.ts:7164-7166`)
  would let an agent that can edit its own config change its family, so the run's resolved model is the input.
- A server table maps **single-vendor adapters** to a family (for example `claude_local` to `anthropic`, `codex_local`
  to `openai`, `gemini_local` to `google`, `grok_local` to `xai`, `kimi_local` to `moonshot`). For **multi-vendor
  adapters** (`paperclip_runner`, `opencode_local`, `pi_local`, `cursor`, `cursor_cloud`, `hermes_*`,
  `openclaw_gateway`, `process`, `http`) it matches the model id against a prefix table, and otherwise returns
  `unknown`.
- `unknown` never satisfies "different family". If either side is `unknown` and the rule is on, the decision is
  refused with `skill_proposal_family_unknown`.
- The family of both sides is snapshotted on the row (S2 columns), so a later model change cannot rewrite the record.

A shared family between two agents is a signal, not a proof of independence. The rule lowers the chance that one
model's blind spot passes its own change. It does not replace the board for protected skills, which agents never decide.

### 4.11 Revert

`POST /skill-proposals/:proposalId/revert` with `{ expectedVersionId }`, decide bar. It requires
`applied_version_id == current head == expectedVersionId` **and** the SHA-256 of the file on disk to equal
`applied_sha256`. It writes the before-image `SKILL.md` through `updateFile` with `expectedPreviousSha256 =
applied_sha256`, and records `revert_version_id`. If anything changed since, it returns 409 `skill_head_moved` and
nothing is written. A version row stores a full snapshot of every file with its content (svc `:1900-1909`,
`:3636-3666`), so the before-image is already complete. Revert never rewrites history.

Skill Studio's restore is **not** the fallback to promise. It writes each file back with one `PATCH /files` call and no
`expectedVersionId`, then cuts a version with `POST /versions` (`ui/src/pages/SkillStudio.tsx:3446-3459`). That is not
atomic, has no compare-and-set, and both calls are policy-gated (`skills.edit`, `skills.create`), so in a strict
company it can refuse the board. The plan treats it as a manual tool for companies that left the policy open and ships
the revert route as the supported path.

### 4.12 Notifications

- **Author:** wake `skill_proposal_decided` (applied, rejected, or stale found at a decision), the same way an approval
  wakes its requester (`server/src/routes/approvals.ts:325-342`). The wake carries the proposal's `author_issue_id`. The
  reason joins the wake-reason sets in `server/src/services/heartbeat.ts` next to `approval_approved` (`:1327`, `:1345`)
  only if the implementation's test shows the issue-bound sets require it. An expiry sends no wake.
- **Board:** a pending proposal appears as a derived attention item, new source kind `skill_proposal` in
  `packages/shared/src/types/attention.ts:8-21`, plus a count in the existing sidebar-badges payload
  (`server/src/routes/sidebar-badges.ts`). Derived on read from `effectiveStatus`; no stored alert.
- **Approver agents (S2):** pull. `GET /skill-proposals?awaitingMyDecision=true` lists what an agent may decide. A
  push wake of approvers is deferred (Q10).

### 4.13 Activity log

Every mutation writes one entry in the same transaction. Details never contain skill text.

| Action | When | Details |
| --- | --- | --- |
| `company.skill_proposal_submitted` | submit | proposalId, skillId, baseVersionId, sha256, bytes, sourceIssueId |
| `company.skill_proposal_approved` | approve | proposalId, decidedBy, actorSource, sha256, note length |
| `company.skill_proposal_applied` | apply | proposalId, beforeVersionId, appliedVersionId, sha256, beforeSha256, appliedSha256, actorSource |
| `company.skill_proposal_rejected` | reject | proposalId, decidedBy, note length |
| `company.skill_proposal_withdrawn` | withdraw | proposalId |
| `company.skill_proposal_stale` / `_expired` | persisted at a write | proposalId, currentVersionId or expiresAt |
| `company.skill_proposal_reverted` | revert | proposalId, revertVersionId, restoredSha256 |
| `company.skill_proposal_settings_updated` | settings | previous and new revision, changed keys |

Refusals that leave data unchanged (wrong hash, not the approver) write no row; they return a coded error.

### 4.14 Surfaces and parity

Web, API (OpenAPI) and CLI ship together, per the parity rule. Parity of surfaces is not parity of permissions.

**API** (all paths under `/api/companies/:companyId`; a lookup by proposal id always filters on the company id; each
must be in `server/src/routes/openapi.ts`, because `server/src/__tests__/openapi-routes.test.ts:716` fails on an
undocumented mounted route):

| Method and path | Notes |
| --- | --- |
| `POST /skills/:skillId/proposals` | 201; 200 on an idempotent replay |
| `GET /skill-proposals` | filters `status`, `skillId`, `authorAgentId`, `awaitingMyDecision`; cursor paging |
| `GET /skill-proposals/:proposalId` | adds `diff`, `diffStats`, `frontmatterChanges`, `head`, `effectiveStatus` |
| `POST /skill-proposals/:proposalId/decision` | approve applies |
| `POST /skill-proposals/:proposalId/withdraw` | |
| `POST /skill-proposals/:proposalId/revert` | decide bar; not reachable from a sandbox |
| `GET`/`PUT /skill-proposal-settings` | `PUT` takes `expectedRevision`; `GET` includes `directWriteGate` and `gateEffective` (section 4.15) |

**Logs.** Two controls, because the request body is only one way text reaches a log. The proposal and decision routes join
the routes whose request body the failure log replaces with `"[REDACTED]"`, as the runtime GitHub routes already do
(`server/src/middleware/logger.ts:166-169`). They are also added to `SECRET_SENSITIVE_HTTP_PATHS`
(`server/src/middleware/http-log-policy.ts:40-43`, applied to POST, PUT and PATCH at `:80-89`), which makes the error
handler and the logger keep only a type marker for an error instead of its message, stack and details
(`server/src/middleware/error-handler.ts:69`, `:81`, `:170`, `:184`, `:281`; `logger.ts:180-194`). A database error can
quote what it was given. A unique-index violation (SQLSTATE 23505) from two identical racing submits is mapped to 409
instead of reaching the handler as a 500. Error `details` and list responses carry ids, hashes and sizes only. The test
exercises a database-error path and asserts that no failure log line contains proposal text.

**Bridge** (`sandbox-callback-bridge.ts`): add `POST …/skills/:skillId/proposals`, `GET …/skill-proposals`,
`GET …/skill-proposals/:id`, `POST …/skill-proposals/:id/withdraw`, and in S2 `POST …/skill-proposals/:id/decision`,
all with the hardened id slot `[^/?#%.\\]+` and with denied-path tests. Settings and revert stay unreachable from a
sandbox.

**CLI** (`paperclipai skills proposal …`; today `skills file` is read-only, and `skills update` installs an upstream
update, so no CLI command edits the text of an existing skill by hand: `cli/src/commands/client/skills.ts:231-258`,
`:374`, `:290`): `propose <skillRef> --file <path> [--base-version <id>] [--summary]`, `list`, `show`, `diff`,
`approve`, `reject`, `withdraw`, `revert`, `settings get|set`. `approve` prints the hash and reads the file back to show
the new head.

**Web:** Skill Studio gets a Proposals tab (list, side-by-side diff using the existing version compare, base and head
ids, the protected and gate status, approve and reject with a note). The diff renders invisible and non-ASCII
characters visibly (escaped), so a homoglyph or a zero-width character in `name` or `description` cannot hide. Settings
live with the skill policy. A pending proposal shows as an attention item in the inbox and as a count on the existing
badge payload; S1 adds **no new sidebar item**. The way in is a launcher action: S1 adds `nav.skill-proposals` ("Skill
proposals") to `COMMAND_ACTIONS` in `packages/shared/src/command-actions.ts:66-92`, built with the existing `navigate`
helper (`:31-46`). The path is company-relative and points at the Proposals tab. It has no chord: the catalog test
requires unique shortcuts, and the `g` letters d, i, t, p, o, a, r, v, e, m, k, s, c and f are already taken. The
keywords include "review", "approve" and "skill change". The UI uses the token layer only (`DESIGN.md`).

**Runner tools.** The runner's `create_skill` and `update_skill` actions (`packages/paperclip-runner/src/protocol-actions/create-skill.ts`,
`update-skill.ts`) call the same routes, so on a protected skill `update_skill` returns the 403 above, and its message
names the proposal route. The runner capability contract is anchored, so the implementation PR decides whether a
`propose` action is added there; this plan changes no skill file.

**Agent guidance:** in the OpenAPI operation descriptions and, if needed, one small separate skill. A new bundled skill
adds a key to `PAPERCLIP_CORE_SKILL_KEYS` (svc `:642`), the list the library imports from the repo-root `skills/` bundle, so that is a choice for the implementation PR. **Not** new lines in
`skills/paperclip/SKILL.md` or new headings in `skills/paperclip/references/**` (section 3.1).

### 4.15 Deployment limits

The review is meaningful only where an agent cannot act as the board.

- In `local_trusted` deployments a request with no credentials is the instance-admin board user `local-board`, source
  `local_implicit` (`server/src/middleware/auth.ts:227-240`). That source skips company checks (`authz.ts:104`). An agent
  on the same host that talks to the server directly, with no bridge, can call the decision route as that user, and it is
  not the author, so every check in 4.8 passes.
- In any deployment, a board API key left in a workspace is a person.

What the server does:

1. `GET /skill-proposal-settings` reports `gateEffective: false` with a `reasons` list (`local_trusted`) when the
   deployment is `local_trusted`. The web panel and the CLI show it as a banner.
2. `PUT … enabled: true` in a `local_trusted` deployment returns 409 `skill_proposals_unsafe_deployment` unless the body
   carries `acknowledgeLocalTrusted: true`. The acknowledgement is stored, shown, and logged. It is **consent, not a
   control**: in this mode the implicit board and an agent that talks to the server directly are the same actor to the
   server, so an agent can send the acknowledgement or call the decision route, and nothing in this plan stops it. The plan
   does not claim otherwise, and it adds no check that the same actor can satisfy (Q14).
3. The approved and applied activity entries carry `actorSource`. For the implicit board a person and an impersonating
   agent are both `local-board` with source `local_implicit`, so the entry cannot tell them apart; the run id appears only
   when the caller sends the run header. After the fact, the log helps in `authenticated` deployments and does not in this
   one.

`local_trusted` is the normal development mode. The CLI and the web UI keep working there, because both are the implicit
board. The deployment guidance says to keep board keys out of agent workspaces. `companySkillRoutes(db)` is mounted without
options (`server/src/app.ts:666-667`), so the implementation passes `deploymentMode` the way `boardChatRoutes(db,
{ deploymentMode })` receives it (`server/src/routes/board-chat.ts:65-68`).

## 5. Threat model

| # | Threat | Control |
| --- | --- | --- |
| T0 | An agent acts as the board (implicit local board, a board key in a workspace) and approves its own change | **Accepted and advisory in `local_trusted`; reported.** Section 4.15: `gateEffective: false`, a banner, consent at enable, `actorSource` in the log. In `authenticated` deployments the author is never the approver and the log names the decider |
| T1 | Agent writes a protected skill directly and skips the gate | The server invariant at the choke point, keyed on the stored id and on a per-route flag (4.9), not the policy; guards in `upsertImportedSkills` and `installFromCatalog` cover the by-key paths, install-update and the shipped-team install included. Unprotected skills: the gate diagnostic |
| T2 | Author approves itself | Approver is never the author; agent approval needs an explicit allow rule that selects the skill |
| T3 | Two agents agree to pass each other's changes | Protected skills are decided by people only; `requireDifferentModelFamily` for the rest; caps; both families are logged |
| T4 | Content swapped between review and apply | Immutable row; the id fixes the bytes; the optional `reviewedSha256`; read-back from disk and the version row |
| T5 | Apply on a skill whose bytes moved without a new version (rename, import overwrite, install-update, reset, out-of-band edit) | Version compare **and** the disk-hash compare inside `updateFile` under the lock (4.8) |
| T6 | A stale policy lets a revoked approver through | Policy and settings read at decision time (4.1) |
| T7 | Prompt injection into an approving agent through the proposal text | Server-built diff in a fenced, labelled block; summary marked untrusted; the decision is structured, not free text; the approver cannot edit content; protected skills never go to an agent |
| T8 | Frontmatter smuggles a key or metadata | Byte rule: only the `name:` and `description:` lines may differ, and control and invisible characters are refused (4.7) |
| T9 | Script or executable bit smuggled in | v1 changes `SKILL.md` only |
| T10 | Skill text leaks through logs | Activity: hashes and sizes only. HTTP failure log: request body redacted and error text reduced to a type marker on the proposal routes (4.14) |
| T11 | Pending text read by every agent | Reads limited to people, the author and approver-eligible agents |
| T12 | Spam or storage growth | 256 KiB limit; per-author, per-skill and per-company caps; one open proposal per author per skill; no duplicate bytes; expiry; retention (Q9) |
| T13 | Replay or double submit | Unique idempotency key; `status = pending` compare-and-set; decision retry returns the stored result |
| T14 | Cross-company access | Company id on every query and index, including lookups by proposal id; agent key boundary check as in `company-skills.ts:218-221` |
| T15 | Settings turned off to flush pending work | Only a person changes settings; the change is logged; pending rows stay readable and expire |
| T16 | A partial apply leaves disk and database apart | Outer transaction; work inside `afterUpdate`; route-style compensation after a failed commit; fault-injection tests. Crash window named in 4.8 |
| T17 | The gate is rewritten by an agent holding `users:manage_permissions` | Settings are person-only; the policy route is a named dependency (section 8.1) |
| T18 | An agent changes what agents follow without editing an existing skill: creates a new skill (#59), re-points agents with skill sync, or forks a protected skill and reassigns | The invariant also covers fork (it carries the skill id). New-skill creation and agent skill assignment are **non-goals** of this plan and are governed by their own permissions |
| T19 | The diff hides an invisible character or a homoglyph | Invisible and control characters are refused in the text (4.7). Homoglyphs are not refused; the rendered diff escapes non-ASCII characters (4.14) |
| T20 | An agent with file access edits a protected skill's files directly, or edits them and starts a test run so the edit becomes the head | **Partly accepted in S1.** The test-run start is refused on drift (4.9); an edit to `SKILL.md` makes pending proposals stale; settings report where each protected skill lives. The edit itself is not preventable at the API; S3 can serve protected skills from the head snapshot (Q15) |

## 6. Slices

Each slice ships web, API, CLI and tests, and lands single after review (security gate). The feature is off for every
company until `enabled` is set, so each slice can ship without behavior change.

- **S1: propose, humans decide and apply, revert, protected skills.** Tables and migration; `skills.propose`; settings
  (without agent approval), including `humanApprovers` and `protectedSkills`; the invariant at
  `assertCanMutateCompanySkills` the guards in `upsertImportedSkills` and `installFromCatalog` with the actor passed from the five routes that call them; the test-run drift refusal; the location report in the settings; the `expectedPreviousSha256` and `versionLabel` parameters of `updateFile`; submit, list, show, decision
  (human), withdraw, revert; caps; effective status computed on read; author wake; attention item; bridge rules;
  OpenAPI; CLI; Studio tab; launcher action; log redaction; deployment reporting (4.15).
- **S2: agent approvers.** `skills.approve` (closed by default, `agents` subjects only); `agentApproval` settings; the
  model family table and rule; decision by agent; awaiting-my-decision listing; the agent and family columns.
- **S3: hardening.** Serving protected skills from the head snapshot (Q15); retention job; sweeper to persist stale and expired rows; optional "require a passing skill test
  run" (Q2); relaxed staleness if wanted (Q4); multi-file proposals if wanted (Q5).

Rollback: set `enabled: false`; pending rows become unusable but readable, and the invariant switches off. The tables
are additive. Applied changes stay as ordinary versions.

## 7. Tests (each fails before the change)

- Submit refuses: disabled; no `skills.propose`; no task-bound run; an agent key with no run; non-editable skill; stale
  base version; disk bytes differing from the base; identical text; oversize (422, before any query); control, bidi,
  zero-width and CR characters; a changed frontmatter line other than `name` and `description`; a `description:` written over a base `allowed-tools:` line; a cap hit; a second
  open proposal; the same bytes open; a bad idempotency replay.
- Decision: wrong hash; author as approver; viewer; a role outside `humanApprovers.roles`; stale base (row becomes
  `stale`, skill unchanged); **rename then approve**; **import overwrite then approve**; **out-of-band edit then
  approve**; two concurrent approvals of different proposals on one base (one wins, the loser leaves the disk
  untouched); apply writes one version authored by the proposal author; before-image equals the previous head and
  `before_sha256` equals the hash of the prior disk bytes; decision retry returns the stored result.
- Fault injection: `afterUpdate` throws; the proposal-row update fails; the commit fails; each asserts the file on disk
  is restored and the head is unchanged. A deadlock against `deleteSkill` retries once.
- Policy: `skills.approve` denied for an agent with no rule under an unmaterialized policy, under `defaultEffect: allow`,
  and under default-deny plus an agent holding `skills:create`; a `skills.approve` rule with an `all_agents` or `roles`
  subject, or with no selector, is rejected; a stored default-deny policy does not lock out a person who may decide;
  policy and settings changes apply to pending rows.
- Protected skills: an agent's edit, rename, versions, fork, reset, remove and managed-source update on a protected skill
  are refused with 403 `skill_protected_use_proposal`; a person's edit still works; `all: true` covers a skill created
  later; renaming a protected skill keeps it protected; **the same refused edit written with an upper-case and with a
  hyphenless skill id is refused too**; an agent's proposal on a protected skill succeeds; test inputs and test runs on a
  protected skill still work for an agent; an agent's import, scan-projects, catalog install or
  install-update that would overwrite a protected skill by key (install-update with an upstream `key:` pointing at it,
  a protected catalog skill, and the shipped-team install included) is refused and writes nothing, while one that creates a new key still works; an agent's test-run start on a
  protected skill whose files drifted from the head is refused with 409 and cuts no version.
- Frontmatter: a proposal against the repository's own folded-description `SKILL.md` (for example
  `skills/paperclip-converting-plans-to-tasks/SKILL.md`) that changes only the body is accepted; one that changes the
  folded description is refused.
- Human approvers: a membership with role `member` counts as `operator`; a missing membership array, a null role and an
  unknown role such as the cloud-tenant `support` are refused.
- Revert: succeeds only on an unmoved head and unchanged bytes; 409 otherwise; never edits history.
- Deployment: `gateEffective` is false in `local_trusted`; enabling without the acknowledgement returns 409; the approved
  and applied entries carry `actorSource`.
- Parity: every route in OpenAPI (the existing coverage test); CLI commands call the same routes; the bridge allows the
  new paths and denies settings, revert and look-alike paths (`?`, `#`, `%2e`, `..`, backslash).
- Logs and storage: no failure log line contains proposal text, including on a database-error path (two identical
  racing submits give 409, not 500); activity details contain none; company delete removes
  both tables and `company-removal-coverage.test.ts` passes; the company boundary holds on every route, including
  by-id lookups with another company's id.
- `ensureSkillInventoryCurrent` inside the outer transaction (4.8) does not delete or change a skill other than the
  target.
- S2: unknown family refuses; same family refuses when required; a protected skill cannot be decided by an agent.

## 8. Questions and decisions

The manager answered Q1 to Q12 on 2026-10-10 at 17:09 UTC. Every recommendation of the first draft stood. The notes
below say what each answer means for the build. Q13 to Q15 are new, raised by the independent review.

- **Q1. Meaning of "protected skills".** **Decided:** a skill on the list is decided by the board only. Agent approval
  never applies to it. *Design note:* the first draft made this a rule about approvers only. The review showed that it
  then protects nothing, because an agent could still write directly. S1 therefore enforces it on the server (4.9).
- **Q2. Require a passing skill test run before approval.** **Decided:** defer to S3 as an optional setting. It needs a
  defined "passing", and test runs spend money.
- **Q3. Manual apply after approval.** **Decided:** no. Approve applies, atomically.
- **Q4. Staleness rule.** **Decided:** a strict version id in v1, as `updateFile` does. The apply also compares the bytes
  on disk (4.8), which is stricter, not looser.
- **Q5. Multi-file proposals.** **Decided:** not in v1. A protected skill's reference files stay board-edit-only.
- **Q6. One-click "require proposals" preset.** **Decided:** not in S1. S1 shows the gate status, and protecting skills
  needs no policy edit (4.9).
- **Q7. The policy route.** **Decided:** the plan leaves it as it is and names it as a dependency (section 8.1), not as
  a fix. The follow-up "make skill-policy replacement person-only" is recorded in the manager's follow-ups list.
- **Q8. Import and install can overwrite a skill by key.** **Decided:** agreed. Until the import follow-up lands, a
  company that uses protected skills denies `skills.import` and `skills.install` to agents. This plan does not
  change import. *Design note:* S1 also puts a guard where the overwrite happens, so an agent cannot overwrite a protected skill by key (4.9), so the manual
  deny is belt and braces for a protected company. The import follow-up is recorded in the follow-ups list.
- **Q9. Retention of proposal text.** **Decided:** keep the hash and metadata, and null `proposed_markdown` on terminal
  rows after 90 days (S3).
- **Q10. Push wake for approver agents.** **Decided:** defer.
- **Q11. Size limit.** **Decided:** 256 KiB for `SKILL.md`. A proposal over the limit is refused with **422** and a
  clear message, and the check runs before any database write (section 4.7).
- **Q12. Human approver bar.** **Decided:** any active non-viewer member in S1. Turning the feature on and every approver
  setting are person-only. A board tightens the bar to owner or admin by editing `humanApprovers.roles` (section 4.6).
- **Q13. Who may author a proposal in S1.** *New.* Recommendation: agents only. A person can already edit directly, and a
  person's proposal in a one-person company cannot be approved by anyone else (the approver is never the author). Revisit
  if a company wants a person's change reviewed by a second person.
- **Q14. `local_trusted` deployments.** *New.* Recommendation: report `gateEffective: false`, require an explicit
  acknowledgement when enabling (as consent, not as a control), record `actorSource`, and say in the docs that the review is
  advisory there (4.15). Do not add controls that the same actor can satisfy. The alternative is to refuse `enabled: true`
  in `local_trusted` outright; it is simpler but removes the feature from single-operator setups where agents run in
  sandboxes behind the bridge and the review does hold.

- **Q15. Serve protected skills from the head snapshot.** *New.* Recommendation: yes, in S3. It makes a disk edit under a
  protected skill inert, which is the only way to close the filesystem limit of section 4.9. It needs two
  changes: the runtime source resolution, which today returns the live directory when it exists (svc `:6005-6034`), and the
  `readLoadedSkillFile` branch (svc `:4361-4367`), which is keyed on `metadata.skillSourceId` and a snapshot hash that
  `local_path` skills do not have. It is not in S1.

### 8.1 Dependencies named, not fixed

These exist on `main`. This plan does not change them, and its guarantees are weaker until they are fixed.

1. **Policy replacement is not person-only.** An agent that holds `users:manage_permissions` can replace the skill
   policy (`server/src/routes/company-skill-policy.ts:48-52`) and so reopen direct writes on unprotected skills. The
   proposal settings are person-only (section 4.6) so an agent cannot switch the approval rules or the protected list off.
   Follow-up: make policy replacement person-only.
2. **Import, scan-projects and catalog install overwrite by key.** A rule that selects a skill cannot stop them, and the
   protected-skills invariant cannot see them (section 2.1). Follow-up: key-conflict authorization on import, plus a
   destination policy, a redirect policy, a timeout and a size cap on the fetch path. S1 puts a guard where the overwrite
   happens, so an agent cannot overwrite a protected skill by key; companies without protected skills still need the
   follow-up.
3. **Skill ids in `skillIds` policy rules are compared as raw strings** (section 2.1). A differently written uuid for the
   same skill matches no rule. The invariant avoids it by comparing the stored id; the existing rules keep the weakness.
4. **Agent skill assignment and new-skill creation** are governed by their own permissions (T18). A company that needs
   them gated has to gate them there.

## Appendix A. Code anchors checked on `main` at `38819d350`

- Bridge skill rules: `packages/adapter-utils/src/sandbox-callback-bridge.ts:176-184`; skill sync `:160`
- Skill gate: `server/src/routes/company-skills.ts:209-251` (tolerated denials `:227-233`); principal `:169-177`
- Skill routes: `:879-885`, `:950-962`, `:985-994`, `:1142-1147`, `:1196-1202`, `:1227-1234`, `:1271-1282`, `:1317-1323`,
  `:1348-1354`, `:1393-1398`, `:1440-1446`, `:1476-1479`, `:1542-1548`, `:1592-1598`; skill sources `:317-394`
- Service: `updateFile` `server/src/services/company-skills.ts:4679-4761`, compare-and-set `:4691-4693`, disk read
  `:4709`, version write `:4745-4749`; `createVersion` `:3626-3681` and its call sites `:3095`, `:4059`, `:4625`, `:4746`,
  `:4815`, `:6601`; `withSkillFileMutation` `:4639-4664`; create conflict `:4518`; `upsertImportedSkills` `:6250`,
  existing-row lookup `:6259`; `readSkillStoreMetadata` `:1874-1888`; `readLoadedSkillFile` `:4353-4378`; rename `:4078`
  (disk rewrite `:4175`); `deleteSkill` `:7150-7206`; `ensureSkillInventoryCurrent` call `:4645`, reconcile `:3205-3208`
- Policy: `packages/shared/src/validators/skill-policy.ts:3-12`, `:76-116`;
  `server/src/services/company-skill-policy.ts:24-30`, `:45-52`, `:139-153`, `:155-187`, `:189-262`, `:266-290`;
  routes `server/src/routes/company-skill-policy.ts:43-59`, `:71-112`
- Authorization: `server/src/services/authorization.ts:532-550` (responsible-user predicate for agent-granted skill
  changes), `:1033-1054` (low-trust agents), `:1644` (missing consent), `:1791-1796` (`skill_config:update`)
- Request actor and access: `server/src/middleware/auth.ts:227-240` (implicit board); `server/src/routes/authz.ts:93-102`,
  `:104-119`; `server/src/services/project-tool-context.ts:8-24`
- Logging: `server/src/middleware/logger.ts:163-198` (precedent `:166-169`, error marker `:180-194`);
  `server/src/middleware/http-log-policy.ts:40-43`, `:80-89`; `server/src/middleware/error-handler.ts:69`, `:81`, `:170`,
  `:184`, `:281`
- Approvals and decisions: `server/src/routes/approvals.ts:287`, `:325-342`, `:403`, `:441`;
  `server/src/services/approvals.ts:154`; `packages/db/src/schema/approvals.ts:16`;
  `packages/db/src/schema/decisions.ts:43-45`, `:55`, `:59`; `server/src/routes/decisions.ts:181`
- Precedents: `server/src/routes/access.ts:4330-4345`; `packages/db/src/schema/issue_execution_decisions.ts:15-16`
- Permissions, roles and adapters: `packages/shared/src/constants.ts:27-43`, `:964-970`, `:973-978` (human roles), `:1003-1025`; agent role
  column `packages/db/src/schema/agents.ts:22`; role validators `validators/company-portability.ts:78`,
  `validators/onboarding-seed.ts:25`, `validators/plugin.ts:242`
- Activity: `server/src/services/activity-log.ts:75-91`, `:151`, `:160`, `:217`
- Attention and badges: `packages/shared/src/types/attention.ts:8-21`; `server/src/routes/sidebar-badges.ts:30-50`
- Company delete: `server/src/services/companies.ts:653`, `:655`, `:665`, `:673`, `:688`, `:695`;
  `server/src/services/company-removal-cross-company.ts`; `server/src/__tests__/company-removal-coverage.test.ts`
- Frontmatter reader: `packages/shared/src/frontmatter.ts`
- CLI and UI: `cli/src/commands/client/skills.ts:97-545` (`file` is read-only, `:231-258`; `update` `:374`);
  `ui/src/pages/SkillStudio.tsx:3446-3459`; `ui/src/api/companySkills.ts:195`
- Launcher catalog, on `main` at `d9804ac4f` and absent on the base: `packages/shared/src/command-actions.ts:31-46`,
  `:66-92`; the #114 plan row `doc/plans/2026-10-10-software-factory.md:15` on the #114 branch at `d80fe041d`
- Runner skill actions: `packages/paperclip-runner/src/protocol-actions/create-skill.ts`, `update-skill.ts`
- Skill id handling: `server/src/routes/company-skills.ts:189`, `server/src/services/company-skill-policy.ts:57`,
  `server/src/services/company-skills.ts:3384-3391`; `installUpdate` key fallback svc `:4940-4946`; `installFromCatalog` svc `:5714-5866` (existing-row branch `:5734`);
  `upsertImportedSkills` callers svc `:3018`, `:3020`, `:4021`, `:4582`, `:4944`, `:5297`, `:5398`, `:5455`, `:6232`, `:6377`;
  runtime source resolution svc `:6033-6034`, materialize fallback `:6069`; `normalizeHumanRole` callers
  `server/src/routes/access.ts:1216`, `:1269`, `:1296`, `:1321`, `server/src/services/authorization.ts:709`; cloud-tenant
  roles `server/src/middleware/auth.ts:584-600`; shipped-team install `server/src/services/teams-catalog.ts:880`, `:892`,
  `server/src/routes/teams-catalog.ts:36-60`; test-run auto version svc
  `:6589-6604`, `:6710`; snapshot-served skills svc `:4361-4367`; human role normalization
  `server/src/services/company-member-roles.ts:11-19`, member memberships `server/src/services/access.ts:1019`; test-input and test-run policy calls `company-skills.ts:510`, `:536`,
  `:563`, `:698`, `:802`, `:845`, `:1511`
- OpenAPI coverage test: `server/src/__tests__/openapi-routes.test.ts:716`
- Mounting: `server/src/app.ts:666-667`; model read `server/src/services/heartbeat.ts:7164-7166`; wake reasons
  `server/src/services/heartbeat.ts:1327`, `:1345`

### Re-check on a newer `main`

`main` moved from `38819d350` to `d9804ac4f` while this plan was in review. I compared every cited file that exists on the base (`command-actions.ts` was added later, in `d47df97f0`, and the #114
plan lives on its own branch). Only
`server/src/services/heartbeat.ts` and `server/src/routes/openapi.ts` changed. In `heartbeat.ts` the wake-reason sets
moved down by one line (`approval_approved` is now at `:1328` and `:1346`) and `readConfiguredModelFromAdapterConfig`
moved to `:7204-7207`. Nothing the plan relies on changed in behavior. The latest migration is still `0298`. The line
numbers in the body stay on `38819d350`.
