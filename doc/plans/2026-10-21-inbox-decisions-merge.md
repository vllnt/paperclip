# One Inbox: merge the Decisions page into the Inbox

## Outcome

Everything that needs the board lives in one module, the Inbox. The board finds
decisions, approvals, decision queues, mentions and unread tasks, blocked work,
alerts, and archived items as tabs of one page. The Decisions page, its sidebar
item, and its separate badge are gone. Old Decisions links still work: they
redirect to the matching Inbox tab.

Items that are resolved, done, or moot leave the "needs me" tabs (Decide, Alerts,
Mine) by themselves. They stay findable in the Archived tab.

Guiding rule from the board request: no new pages. Merge, and make it simpler.

## Shell

The streamlined shell (`enableStreamlinedUi` on) is the default, so the work
lands in `Sidebar.tsx` and `MobileBottomNav.tsx` first. The legacy shell
(`Sidebar.production.tsx`, `LegacyInbox.tsx`) gets the same nav and tab changes so
both shells stay consistent. `InboxPage` owns the tab bar for both shells and
hands it to the tab it renders.

## Tab map

`enableDecisions` keeps its meaning: it shows the attention-feed tabs (Decide and
Alerts) and the attention sections of Archived. With it off, the Inbox is the
issue Inbox it was, plus Archived.

| Tab | Route | What lands there | Source |
| --- | --- | --- | --- |
| Decide | `/inbox/decide` | Open attention items of the *review* kind: decisions, approvals, join requests, thread interactions (questions, confirmations, suggested tasks), stalled reviews. Queue rail on top; `?queue=<key>` scopes the tab to one decision queue, with its seed-rules card and per-item Exclude. Idle items keep their Aging curtain. | Attention feed |
| Mine | `/inbox/mine` | Unchanged list of my tasks, actionable approvals, join requests and failed runs, minus auto-archived items (below). | Issue inbox queries |
| Recent | `/inbox/recent` | Unchanged. | Issue inbox queries |
| Unread | `/inbox/unread` | Unchanged: mentions and unread tasks. | Issue inbox queries |
| Blocked | `/inbox/blocked` | Unchanged blocked-task view. | `attention=blocked` issue list |
| Alerts | `/inbox/alerts` | Open attention items of the *blocking* kind: failed runs, agent errors, budget alerts, recovery actions, blocked dependencies (including a board-owned unblock descriptor). | Attention feed |
| All | `/inbox/all` | Unchanged. | Issue inbox queries |
| Archived | `/inbox/archived` | Snoozed and dismissed attention items (Restore), decided and expired decisions, and archived tasks: tasks I archived plus tasks auto-archived as done (Move to inbox). | Attention feed with dismissed, decisions API, touched-issue list |

The *review* and *blocking* split is the existing `attentionKind` vocabulary
(DESIGN.md "two kinds"), moved to `packages/shared` so the UI and the CLI use one
map.

With `enableCombinedInboxTasks` on, the issue tabs are views inside Tasks, so the
Inbox keeps only Decide, Alerts and Archived, and its sidebar row replaces the
old Decisions row.

## Every existing action stays

| From | Action | Where it lives now |
| --- | --- | --- |
| Decisions | Resolve inline (decision, approval, join request, interaction, stalled review) | Decide tab, same row component |
| Decisions | Dismiss, snooze, undo | Decide and Alerts tabs |
| Decisions | Restore a dismissed or snoozed item | Archived tab |
| Decisions | Keep an aging item on the desk | Aging curtain on Decide and Alerts |
| Decisions | Filter, group, sort, date chips, keyboard j/k/e/x, `?decisionId=` deep link, bundles | Decide and Alerts tabs |
| Decisions | Decided and Expired history | Archived tab |
| Queue page | Open a queue, seed-rules toggle, Exclude with reason | Decide tab with `?queue=<key>` |
| Inbox | Every row action, archive, undo archive, mark read, bulk mark all read, filters, grouping, columns, search | Unchanged tabs |
| Inbox | Unarchive an archived task | Archived tab ("Move to inbox") |

## Auto-archive

The rules reuse existing state. No new table, column or endpoint.

- **Attention items** (Decide, Alerts): the server already drops an item when its
  exit rule fires (decision decided or expired, approval resolved, join request
  handled, interaction answered, issue unblocked, run recovered). Dismissed and
  snoozed items leave the tabs and show in Archived.
- **Mine tasks**: a task that is `done` and has nothing unread for me leaves Mine
  and shows in Archived. A done task with an unread update stays until I read it.
- **Mine approvals**: Mine shows only actionable approvals (pending, revision
  requested). Resolved approvals stay in All and in the approval pages.
- **Failed runs**: unchanged. A failure leaves once the agent's latest run is not
  failed, or when dismissed.

## Redirects

| Old URL | New URL |
| --- | --- |
| `/:prefix/decisions` | `/:prefix/inbox/decide` |
| `/:prefix/decisions?decisionId=<id>` | `/:prefix/inbox/decide?decisionId=<id>` |
| `/:prefix/decisions/queues/:key` | `/:prefix/inbox/decide?queue=<key>` |
| `/decisions`, `/decisions/queues/:key` (no prefix) | Prefixed, then as above |

Query strings and hashes carry over. The server's decision `href` moves to
`/:prefix/inbox/decide?decisionId=<id>`, so new links skip the redirect.

## Badge rule

One badge on the Inbox nav item (sidebar and mobile). It counts items that need an
action from me:

```
badge = actionable approvals + pending join requests + failed runs in Mine + unread Mine tasks   (the Inbox count, unchanged)
      + open decisions + open thread interactions + open stalled reviews                        (Decide items the Inbox count misses)
```

The second line uses the attention feed's `countsBySourceKind`, which the server
counts before pagination over open, not dismissed, not snoozed and not archived
items. The badge query asks for one row only. Approvals and join requests are
counted once, from the Inbox side. The badge turns red when a failed run is
counted, as before. The old "new today" Decisions badge goes away.

## Parity (AGENTS.md rule 8)

- REST: unchanged. `GET /api/companies/{companyId}/attention` (OpenAPI tag
  `inbox`) already serves Decide, Alerts and the attention part of Archived.
- CLI: new `paperclipai inbox attention -C <companyId> [--tab decide|alerts]
  [--queue <key>] [--include-dismissed] [--archived]`, which reads the same feed
  and applies the same shared kind split.
- Skill: the paperclip skill API reference names the merged Inbox tabs and the
  CLI command.
- Allowed visual exception, named in the PR: the nav merge, tab layout and badge
  composition.

## Code to delete

- `ui/src/pages/WhatNeedsMe.tsx` and `ui/src/pages/DecisionQueuePage.tsx`: their
  shared logic becomes one `InboxAttentionTab` component; the queue view becomes
  a mode of it.
- The Decisions nav item and its separate attention badge query in `Sidebar.tsx`
  and `Sidebar.production.tsx`; `attentionBadgeCount` and its `deskBadgeCount`
  client use.
- The `/decisions` and `/decisions/queues/:key` page routes (they become
  redirects).
- `WhatNeedsMe.test.tsx` moves to the new component's test.

## Tests

- Unit: tab parsing and redirects, kind split, auto-archive filters, badge rule,
  sidebar shows one Inbox item and no Decisions item, mobile nav badge.
- Update `Sidebar.test.tsx` (it asserts the Decisions item), `App.test.tsx`,
  `inbox.test.ts`, `attention.test.ts`.
- CLI: command registration and kind filtering.
- Browser: 1440 and 390 px on a local instance with embedded PGlite and a
  throwaway data dir, zero console errors, before and after screenshots.

## Slices

One PR. It stays reviewable because the tabs reuse the existing row, toolbar and
shelf components; the new code is the module shell, the merged attention tab, the
archived tab, redirects, the badge hook and the CLI command.

## Coordination

- The routine-step send-back cap creates a `blocker_attention` item with a
  board-owned unblock descriptor. It lands in Alerts and counts in the Alerts
  tab; its blocked task also stays in Blocked. The item shape and the feed query
  do not change.
- `SKILL.md` and `openapi.ts` are shared with other sessions: this PR does not
  edit `openapi.ts`, and edits only the skill's API reference.

## Verify in production

In a test company only, with `[qa-test]` data: create a decision or approval,
see it in Decide and in the badge, resolve it, see it leave Decide and appear in
Archived, and open `/decisions` to see the redirect. Then resolve or cancel the
test item. Never delete it.
