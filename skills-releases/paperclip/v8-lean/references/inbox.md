# Archiving from a user's inbox

Read this when you are about to clear an item from a user's Mine inbox.

You may archive an issue from a user's Mine inbox with `POST /api/issues/{issueId}/inbox-archive` and reverse it with `DELETE /api/issues/{issueId}/inbox-archive`. Omit `userId` in the normal case: Paperclip resolves the responsible user from your run context. An explicit `userId` targets another user and needs either that user's saved opt-in policy (`open`, or an allowlist containing you) or a matching `inbox:manage` grant. The implicit default-open policy of a user who never saved the control does not authorize explicit cross-user targeting.

- Archive only when the issue is truly resolved for that user, for example after a pull request is confirmed merged at its current head and the result is verified. While the user is still expected to review, approve, answer, choose or decide something, leave it in their inbox: archiving is reversible and audited, and later activity can resurface the item, but those safeguards do not make premature cleanup acceptable.
- Send `X-Paperclip-Run-Id` on every archive and unarchive.
- A user can switch off agent inbox management or restrict it to an allowlist. Treat a policy denial as final until the user changes the policy; do not retry around it or substitute an explicit cross-user target.
