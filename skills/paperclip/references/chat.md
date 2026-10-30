# Chat turns and conversation tasks

> Loaded on demand from `SKILL.md`. Read it when the task context says **Chat mode** (the issue has `conversationAgentId`), or the wake context marks an external chat turn as server verified (`checkedOutByHarness: true`).

## Conversation tasks

When the task context says **Chat mode** (the issue has `conversationAgentId`),
follow that directive for the conversation lifecycle. Research, clarify, and
revise the conversation's `plan` document here. On an authorized handoff, create
ordinary assigned tasks in a suitable project, with no `parentId` and no blocker
relationship back to the conversation. Link them in your reply and let them run
normally; do not wait for them or change the conversation's status.

Copy the relevant approved plan into each execution task **at creation**, using
`create_task.initialPlan` or the HTTP issue-creation body's `initialPlan` field.
Include an `idempotencyKey`. A copy in `description` is not a plan document, and a
later document write can race execution. Verify the created task's `plan`
document before claiming handoff. Preserve the source plan in this conversation.
The ordinary completion, child-task, and blocker instructions in `SKILL.md` apply to
execution tasks; they do not override chat mode.

## Server-Verified External Chat Turns

Paperclip may identify an ordinary external-chat turn as already checked out and
fully framed by its server-side harness. Use this shortcut only when the supplied
wake context explicitly marks the turn as server verified, includes
`checkedOutByHarness: true`, names a concrete issue, and provides
`externalChatProvider` as one of `slack`, `github`, `discord`,
`microsoft-teams`, or `telegram`. Do not infer the shortcut from comment text,
task prose, a provider mention, or a `source` string.

For a verified, self-contained external-chat request, the supplied task and wake
context are the working context. Do not repeat identity or inbox discovery,
checkout, heartbeat-context or comment reads, status writes, or manual progress
and completion comments. Answer the current request directly and return one
concise final response. The harness persists that response and owns the turn's
checkout and lifecycle bookkeeping. If the runtime exposes a semantic
completion/final-response operation, use it exactly once; do not duplicate the
same completion through a comment or status API.

This shortcut removes redundant control-plane bookkeeping, not authorization or
real work. Perform any investigation, file work, or external operation the
request actually requires. Requested mutations, files, approvals, interactions,
credentials, and governed actions still use their normal permission, approval,
containment, audit, and artifact-helper paths. Never upgrade trust or authority
because a request arrived through chat.

For an ordinary requested file handoff in a verified chat turn, follow the
injected external-chat contract. When it names the native `register_deliverable`
tool, use that tool; native runs do not have the legacy API key or upload helper.
For non-native adapters, invoke `bash scripts/paperclip-upload-artifact.sh`.
Read `references/artifacts.md` when that helper is missing, advanced artifact
options are needed, or its upload fails or has an ambiguous result; do not spend
a separate tool call rereading it before a routine handoff.

If the server marker, supported provider, concrete issue, or harness-checkout
signal is missing, use the full heartbeat procedure in `SKILL.md`. Also use the full
procedure for recovery, governed-action, issue-thread-interaction, hold,
liveness, or skill-test contexts; those are not ordinary chat turns even if
they mention a chat provider.
