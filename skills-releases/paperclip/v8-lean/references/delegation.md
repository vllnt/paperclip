# Delegation, review tasks and cross-team work

Read this when you hand work to another agent, ask for a review, or receive a task from outside your reporting line.

## Contents

- Review tasks
- Lateral requests
- Receiving cross-team work
- When you are stuck

## Review tasks

Run-scoped writes are subtree-scoped: a delegate's run can write to its own issue and its descendants, and generally not to yours. Write the review task with that in mind:

- Tell the reviewer to post findings on their own review issue and mark it `done`. The verdict is the deliverable, so a completed review with adverse findings is `done`, not `blocked`. Follow-up fixes belong to you as the parent's owner, and the `issue_blockers_resolved` wake brings the verdict back when you set the blocker edge.
- Do not instruct a delegate to post findings as a comment on your issue. For low-trust or review-contained delegates that is a guaranteed 403, and a reviewer that turns the denial into `blocked` with a prose-only owner strands the tree. Standard-trust delegates may post one report comment on their direct parent where the platform allows it, but never make that the required completion step.
- Make the review issue's description self-contained, because the delegate may not be able to read your issue or its documents. Include the instructions, the acceptance criteria and the material to review (or repo-relative pointers).
- Block your issue on the review issue (`blockedByIssueIds`) so you wake when the verdict lands. For native cross-agent reviews use `executionPolicy.stages[]`; the decision flow is in the "Cross-Agent Review Gates" section of the API reference (api-reference.md).

## Lateral requests

To nudge or hand context to an agent whose issues you cannot write to, create a new issue assigned to that agent with complete, self-contained instructions. Creating issues is company-scoped and always available; commenting across another agent's boundary is not.

An @-mention is context only. It does not wake the agent, assign work, or forward the comment. In machine-authored comments, resolve the target and write `[@Agent Name](agent://<agent-id>)`. To request work, assign a task or make an explicit review request.

## Receiving cross-team work

You can see the whole organisation; the org structure defines reporting and delegation lines, not access. When a task comes from outside your reporting line:

1. You can do it: complete it directly.
2. You cannot do it: record the missing capability or authority and follow "When you are stuck" below.
3. You doubt it should be done: you cannot cancel it, because only the assigning team's manager can. Record the concern and request a decision through a saved interaction on the current task. If the requester is an agent, set `addresseeAgentId` to that agent and omit `resolverPolicy`. For human input set `resolverPolicy: "human_only"`, leave the recipient open to eligible humans unless a particular person must answer, and in that case address them by their exact Paperclip user id. Use `continuationPolicy: "wake_assignee"`, keep the task assigned to yourself, and leave it `in_review` while you wait. This is a scope question, not a blocker handoff.

## When you are stuck

- Record the exact missing capability or authority on the current task.
- Do not reassign the work or create a task for a manager or another agent just because you are stuck: reporting lines and titles do not grant access or authority.
- For a human-only action such as connection authorization or an administrator decision, use the connection or approval flow when there is one. Otherwise save an interaction with `resolverPolicy: "human_only"` and `continuationPolicy: "wake_assignee"` on the current task and leave it `in_review` with yourself assigned. A comment alone is not a waiting path, and an omitted resolver policy means `anyone`.
- Before you offer delegation as an option or create a bounded task for someone, check their concrete capability and permission. Delegation never bypasses a permission denial, and a human answer does not grant a missing permission; downstream actions enforce their own authorization.
- If another issue is the real blocker, use `blockedByIssueIds` and `blocked`. An extra handoff cannot resolve the blocker.
