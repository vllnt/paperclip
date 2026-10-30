# Asking a person: questions, confirmations and their answers

> Loaded on demand from `SKILL.md`. Read it when you need a person to answer a question or decide, or a person answered a pending card in a message.

<a id="asking-for-human-input"></a>

## Human input questions

For an open answer, use a text field. Use a confirmation for a concrete yes/no decision, not to ask someone to write a comment and then confirm they wrote it. POST `/api/issues/{issueId}/interactions` with the following complete payload (replace `detail`, the prompt, and the idempotency key for your question). Put every text and choice question in one complete `questionSet`. Paperclip generates the compatibility `questions` entries. Legacy choice-only payloads remain supported; if you send both representations, they must describe the same complete form.

Omit `addresseeUserId` for ordinary questions.
In Agent Chat, Paperclip addresses the question to the conversation owner automatically. On a task, leave the recipient open unless a particular person must answer. For that case, explicitly address their exact Paperclip user ID, including any prefix. The server rejects unknown or unauthorized recipients. Do not guess IDs or infer authority from a title. Agent-directed questions use `addresseeAgentId` and omit `resolverPolicy`.

```json
{
  "kind": "ask_user_questions",
  "idempotencyKey": "question:{issueId}:detail:v1",
  "resolverPolicy": "human_only",
  "continuationPolicy": "wake_assignee",
  "payload": {
    "version": 1,
    "questionSet": {
      "schema": "paperclip.question_set.v1",
      "questions": [{ "id": "detail", "prompt": "What should I know?", "answerMode": "text", "required": true }]
    }
  }
}
```

Verify the interaction was saved and is pending, then PATCH the same task to `in_review` without changing its assignee. An omitted `resolverPolicy` defaults to `anyone`, so omission does not establish a human-only wait. See [the API reference](api-reference.md#questions-and-waiting-for-human-input) for choice questions and response handling. Include the normal Authorization and X-Paperclip-Run-Id headers.

When a saved interaction is answered or rejected, read its result and resolver
identity. An authorized requester's clear response can narrow or replace the
original scope. Act on that direction and finish the resulting work; do not ask
the same requester to confirm again merely because their answer changes the
original request. Ask again only if a material ambiguity or missing authority
remains. A saved answer never bypasses authorization for downstream actions.

## Conversational confirmation answers

When the user answers a pending confirmation in a message, record the answer before acting. Read current cards and comments, then POST `/api/issues/{issueId}/interactions/{interactionId}/resolve-from-comment` with `commentId`, `decision: "accept" | "reject"`, and explicit `selectedOptionIds` for checkbox acceptance (native runners use `call_api`). Ambiguous replies among proposals require clarification. Revisions are not acceptance. Retry the same request after a lost response instead of leaving a pending card. Resolver permissions remain enforced; question forms and governed approvals use their existing controls. See the API reference for scope and retry rules.

In Agent Chat, a question is optional: if the user moves on to another topic, answer that message without requiring them to answer or resolve the earlier question. Leave its card unanswered so they can reopen it later. When a historical answer arrives, use its attached original question as context and continue from the current conversation. Unrelated messages are never approval.
