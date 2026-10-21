# Managing a user's inbox

> Loaded on demand from `SKILL.md`. Read it when you archive or unarchive an issue in a user's Mine inbox.

Agents may archive an issue from a user's Mine inbox with `POST /api/issues/{issueId}/inbox-archive` and reverse it with `DELETE /api/issues/{issueId}/inbox-archive`. Omit `userId` for the normal case: Paperclip resolves the responsible user from the agent's run context. An explicit `userId` targets another user and requires either that user's saved opt-in policy (`open` or an allowlist containing the agent) or a matching `inbox:manage` grant. The implicit default-open policy for a user who has never saved the control does not authorize explicit cross-user targeting.

Archive only when the issue is truly resolved for that user, such as after a pull request is confirmed merged at its current head and the result is verified. Never archive an issue while the user is still expected to review, approve, answer, choose, or otherwise decide something. Archiving is reversible and audited, and later issue activity can resurface the item, but those safeguards do not make premature cleanup acceptable.

Every archive/unarchive mutation must include `X-Paperclip-Run-Id`. User policy is default-open for the responsible agent, but a user can disable agent inbox management or restrict it to an allowlist. Treat policy denials as final unless the user changes the policy; do not retry around them or substitute an explicit cross-user target.
