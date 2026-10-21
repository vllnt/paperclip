<!-- GENERATED FILE — DO NOT EDIT. Run pnpm generate:capability-inventory. -->

# Capability Capability Contract

This generated contract is a self-contained derivative of the Paperclip skill, its seven references, the Paperclip Evals corpus, and the legacy MCP tool surface. It does not import or contact the Paperclip control plane.

The skill/reference inventory and eval cases are the only normative behavior sources. Paperclip does not use the legacy MCP calls as a production capability surface; all MCP names below are traceability aliases folded into normative eval rows. Their disposition, grants, assertions, and evidence contract are inherited from the target row rather than classified independently.

## Baseline Counts

- Skill/reference headings: 195
- Eval cases: 106 across 16 groups
- Total normative rows: 301
- Legacy MCP aliases folded into normative rows: 42

| Eval group | Cases |
| --- | ---: |
| hb | 5 |
| co | 6 |
| st | 8 |
| cm | 6 |
| se | 4 |
| su | 4 |
| bl | 5 |
| dp | 3 |
| ix | 9 |
| ap | 6 |
| ar | 4 |
| er | 9 |
| rf | 22 |
| mh | 4 |
| rs | 3 |
| wk | 8 |

## Regeneration

- `pnpm --dir packages/paperclip-runner generate:capability-inventory` imports the canonical baselines and rewrites every generated file.
- `pnpm --dir packages/paperclip-runner check:capability-inventory` validates counts, uniqueness, normative dispositions, one-to-one MCP folds, required fields, and generated-file drift without requiring the external eval repository.

## Skill / Reference Rows

| Capability | Primary disposition | Source anchor |
| --- | --- | --- |
| skill:skills/paperclip/SKILL.md:paperclip-skill:10 | optional_agent_tool | skills/paperclip/SKILL.md:10 |
| skill:skills/paperclip/SKILL.md:authentication:16 | control_plane_owned | skills/paperclip/SKILL.md:16 |
| skill:skills/paperclip/SKILL.md:reference-index:24 | optional_agent_tool | skills/paperclip/SKILL.md:24 |
| skill:skills/paperclip/SKILL.md:the-heartbeat-procedure:51 | optional_agent_tool | skills/paperclip/SKILL.md:51 |
| skill:skills/paperclip/SKILL.md:generated-artifacts-and-work-products:71 | always_agent_tool | skills/paperclip/SKILL.md:71 |
| skill:skills/paperclip/SKILL.md:status-quick-guide:75 | control_plane_owned | skills/paperclip/SKILL.md:75 |
| skill:skills/paperclip/SKILL.md:waiting-say-only-what-you-actually-scheduled:81 | optional_agent_tool | skills/paperclip/SKILL.md:81 |
| skill:skills/paperclip/SKILL.md:issue-dependencies-blockers:85 | control_plane_owned | skills/paperclip/SKILL.md:85 |
| skill:skills/paperclip/SKILL.md:key-endpoints-hot-routes:89 | optional_agent_tool | skills/paperclip/SKILL.md:89 |
| skill:skills/paperclip/SKILL.md:critical-rules:106 | optional_agent_tool | skills/paperclip/SKILL.md:106 |
| skill:skills/paperclip/SKILL.md:comment-style-required:125 | always_agent_tool | skills/paperclip/SKILL.md:125 |
| skill:skills/paperclip/references/api-reference.md:paperclip-api-reference:1 | optional_agent_tool | skills/paperclip/references/api-reference.md:1 |
| skill:skills/paperclip/references/api-reference.md:response-schemas:9 | optional_agent_tool | skills/paperclip/references/api-reference.md:9 |
| skill:skills/paperclip/references/api-reference.md:agent-record-get-api-agents-me-or-get-api-agents-agentid:11 | optional_agent_tool | skills/paperclip/references/api-reference.md:11 |
| skill:skills/paperclip/references/api-reference.md:company-portability:44 | optional_agent_tool | skills/paperclip/references/api-reference.md:44 |
| skill:skills/paperclip/references/api-reference.md:issue-with-ancestors-get-api-issues-issueid:110 | optional_agent_tool | skills/paperclip/references/api-reference.md:110 |
| skill:skills/paperclip/references/api-reference.md:issue-update-response-patch-api-issues-issueid:196 | optional_agent_tool | skills/paperclip/references/api-reference.md:196 |
| skill:skills/paperclip/references/api-reference.md:blocker-diagnostics-get-api-issues-issueid-diagnostics-blockers:238 | control_plane_owned | skills/paperclip/references/api-reference.md:238 |
| skill:skills/paperclip/references/api-reference.md:wake-diagnostics-get-api-issues-issueid-diagnostics-wakes:277 | control_plane_owned | skills/paperclip/references/api-reference.md:277 |
| skill:skills/paperclip/references/api-reference.md:subtree-diagnostics-get-api-issues-issueid-diagnostics-subtree:321 | optional_agent_tool | skills/paperclip/references/api-reference.md:321 |
| skill:skills/paperclip/references/api-reference.md:execution-policy-fields-on-an-issue:369 | optional_agent_tool | skills/paperclip/references/api-reference.md:369 |
| skill:skills/paperclip/references/api-reference.md:cross-agent-review-gates:421 | always_agent_tool | skills/paperclip/references/api-reference.md:421 |
| skill:skills/paperclip/references/api-reference.md:worked-example-ic-heartbeat:454 | optional_agent_tool | skills/paperclip/references/api-reference.md:454 |
| skill:skills/paperclip/references/api-reference.md:1-identity-skip-if-already-in-context:459 | control_plane_owned | skills/paperclip/references/api-reference.md:459 |
| skill:skills/paperclip/references/api-reference.md:2-check-inbox:463 | control_plane_owned | skills/paperclip/references/api-reference.md:463 |
| skill:skills/paperclip/references/api-reference.md:3-already-have-issue-101-inprogress-highest-priority-continue-it:470 | optional_agent_tool | skills/paperclip/references/api-reference.md:470 |
| skill:skills/paperclip/references/api-reference.md:4-do-the-actual-work-write-code-run-tests:477 | optional_agent_tool | skills/paperclip/references/api-reference.md:477 |
| skill:skills/paperclip/references/api-reference.md:5-work-is-done-update-status-and-comment-in-one-call:479 | always_agent_tool | skills/paperclip/references/api-reference.md:479 |
| skill:skills/paperclip/references/api-reference.md:6-still-have-time-checkout-the-next-task:483 | control_plane_owned | skills/paperclip/references/api-reference.md:483 |
| skill:skills/paperclip/references/api-reference.md:7-made-partial-progress-not-done-yet-comment-and-exit:490 | always_agent_tool | skills/paperclip/references/api-reference.md:490 |
| skill:skills/paperclip/references/api-reference.md:worked-example-report-a-board-user-s-mine-inbox:495 | control_plane_owned | skills/paperclip/references/api-reference.md:495 |
| skill:skills/paperclip/references/api-reference.md:board-user-created-the-requesting-issue:500 | optional_agent_tool | skills/paperclip/references/api-reference.md:500 |
| skill:skills/paperclip/references/api-reference.md:fetch-the-board-user-s-mine-inbox-issues:504 | control_plane_owned | skills/paperclip/references/api-reference.md:504 |
| skill:skills/paperclip/references/api-reference.md:summarize-it-back-to-the-board-in-a-comment-or-document:518 | always_agent_tool | skills/paperclip/references/api-reference.md:518 |
| skill:skills/paperclip/references/api-reference.md:worked-example-archive-a-resolved-inbox-item:523 | control_plane_owned | skills/paperclip/references/api-reference.md:523 |
| skill:skills/paperclip/references/api-reference.md:the-responsible-user-s-id-is-resolved-from-the-authenticated-agent-run:528 | optional_agent_tool | skills/paperclip/references/api-reference.md:528 |
| skill:skills/paperclip/references/api-reference.md:reverse-the-archive-if-it-was-premature-or-no-longer-desired:537 | optional_agent_tool | skills/paperclip/references/api-reference.md:537 |
| skill:skills/paperclip/references/api-reference.md:worked-example-reviewer-approver-heartbeat:547 | always_agent_tool | skills/paperclip/references/api-reference.md:547 |
| skill:skills/paperclip/references/api-reference.md:worked-example-manager-heartbeat:586 | optional_agent_tool | skills/paperclip/references/api-reference.md:586 |
| skill:skills/paperclip/references/api-reference.md:1-identity-skip-if-already-in-context:589 | control_plane_owned | skills/paperclip/references/api-reference.md:589 |
| skill:skills/paperclip/references/api-reference.md:2-check-team-status:593 | optional_agent_tool | skills/paperclip/references/api-reference.md:593 |
| skill:skills/paperclip/references/api-reference.md:3-agent-42-is-blocked-read-comments:600 | control_plane_owned | skills/paperclip/references/api-reference.md:600 |
| skill:skills/paperclip/references/api-reference.md:4-unblock-reassign-and-comment:604 | control_plane_owned | skills/paperclip/references/api-reference.md:604 |
| skill:skills/paperclip/references/api-reference.md:5-check-own-assignments:608 | optional_agent_tool | skills/paperclip/references/api-reference.md:608 |
| skill:skills/paperclip/references/api-reference.md:6-create-subtasks-and-delegate:615 | optional_agent_tool | skills/paperclip/references/api-reference.md:615 |
| skill:skills/paperclip/references/api-reference.md:load-tests-depend-on-caching-layer-being-done-first-paperclip-will-auto-wake-agent-55-when-the-blocker-resolves:621 | control_plane_owned | skills/paperclip/references/api-reference.md:621 |
| skill:skills/paperclip/references/api-reference.md:7-dashboard-for-health-check:626 | optional_agent_tool | skills/paperclip/references/api-reference.md:626 |
| skill:skills/paperclip/references/api-reference.md:comments-and-mentions:632 | always_agent_tool | skills/paperclip/references/api-reference.md:632 |
| skill:skills/paperclip/references/api-reference.md:update:639 | optional_agent_tool | skills/paperclip/references/api-reference.md:639 |
| skill:skills/paperclip/references/api-reference.md:cross-team-work-and-delegation:661 | optional_agent_tool | skills/paperclip/references/api-reference.md:661 |
| skill:skills/paperclip/references/api-reference.md:receiving-cross-team-work:665 | optional_agent_tool | skills/paperclip/references/api-reference.md:665 |
| skill:skills/paperclip/references/api-reference.md:questions-and-dependencies:675 | always_agent_tool | skills/paperclip/references/api-reference.md:675 |
| skill:skills/paperclip/references/api-reference.md:company-context:687 | optional_agent_tool | skills/paperclip/references/api-reference.md:687 |
| skill:skills/paperclip/references/api-reference.md:company-branding-ceo-board:699 | optional_agent_tool | skills/paperclip/references/api-reference.md:699 |
| skill:skills/paperclip/references/api-reference.md:transient-retry-policy-layered:713 | control_plane_owned | skills/paperclip/references/api-reference.md:713 |
| skill:skills/paperclip/references/api-reference.md:openclaw-invite-prompt-ceo:733 | optional_agent_tool | skills/paperclip/references/api-reference.md:733 |
| skill:skills/paperclip/references/api-reference.md:setting-agent-instructions-path:752 | optional_agent_tool | skills/paperclip/references/api-reference.md:752 |
| skill:skills/paperclip/references/api-reference.md:project-setup-create-workspace:785 | optional_agent_tool | skills/paperclip/references/api-reference.md:785 |
| skill:skills/paperclip/references/api-reference.md:option-a-one-call-create-with-workspace:809 | optional_agent_tool | skills/paperclip/references/api-reference.md:809 |
| skill:skills/paperclip/references/api-reference.md:option-b-two-calls-project-first-then-workspace:828 | optional_agent_tool | skills/paperclip/references/api-reference.md:828 |
| skill:skills/paperclip/references/api-reference.md:governance-and-approvals:857 | optional_agent_tool | skills/paperclip/references/api-reference.md:857 |
| skill:skills/paperclip/references/api-reference.md:requesting-a-hire-management-only:861 | optional_agent_tool | skills/paperclip/references/api-reference.md:861 |
| skill:skills/paperclip/references/api-reference.md:ceo-strategy-approval:926 | optional_agent_tool | skills/paperclip/references/api-reference.md:926 |
| skill:skills/paperclip/references/api-reference.md:questions-and-waiting-for-human-input:935 | always_agent_tool | skills/paperclip/references/api-reference.md:935 |
| skill:skills/paperclip/references/api-reference.md:issue-thread-confirmations:1039 | always_agent_tool | skills/paperclip/references/api-reference.md:1039 |
| skill:skills/paperclip/references/api-reference.md:conversational-confirmation-answers:1097 | always_agent_tool | skills/paperclip/references/api-reference.md:1097 |
| skill:skills/paperclip/references/api-reference.md:checkbox-confirmations:1103 | always_agent_tool | skills/paperclip/references/api-reference.md:1103 |
| skill:skills/paperclip/references/api-reference.md:item-verdict-requests:1218 | optional_agent_tool | skills/paperclip/references/api-reference.md:1218 |
| skill:skills/paperclip/references/api-reference.md:checking-approval-status:1328 | optional_agent_tool | skills/paperclip/references/api-reference.md:1328 |
| skill:skills/paperclip/references/api-reference.md:approval-follow-up-requesting-agent:1334 | always_agent_tool | skills/paperclip/references/api-reference.md:1334 |
| skill:skills/paperclip/references/api-reference.md:issue-lifecycle:1352 | always_agent_tool | skills/paperclip/references/api-reference.md:1352 |
| skill:skills/paperclip/references/api-reference.md:error-handling:1382 | control_plane_owned | skills/paperclip/references/api-reference.md:1382 |
| skill:skills/paperclip/references/api-reference.md:full-api-reference:1396 | optional_agent_tool | skills/paperclip/references/api-reference.md:1396 |
| skill:skills/paperclip/references/api-reference.md:agents:1398 | optional_agent_tool | skills/paperclip/references/api-reference.md:1398 |
| skill:skills/paperclip/references/api-reference.md:issues-tasks:1419 | optional_agent_tool | skills/paperclip/references/api-reference.md:1419 |
| skill:skills/paperclip/references/api-reference.md:companies-projects-goals:1460 | optional_agent_tool | skills/paperclip/references/api-reference.md:1460 |
| skill:skills/paperclip/references/api-reference.md:routines:1484 | optional_agent_tool | skills/paperclip/references/api-reference.md:1484 |
| skill:skills/paperclip/references/api-reference.md:event-sources:1501 | optional_agent_tool | skills/paperclip/references/api-reference.md:1501 |
| skill:skills/paperclip/references/api-reference.md:approvals-costs-activity-dashboard:1517 | optional_agent_tool | skills/paperclip/references/api-reference.md:1517 |
| skill:skills/paperclip/references/api-reference.md:server-health:1539 | optional_agent_tool | skills/paperclip/references/api-reference.md:1539 |
| skill:skills/paperclip/references/api-reference.md:secrets:1545 | optional_agent_tool | skills/paperclip/references/api-reference.md:1545 |
| skill:skills/paperclip/references/api-reference.md:agent-secret-proposals:1558 | optional_agent_tool | skills/paperclip/references/api-reference.md:1558 |
| skill:skills/paperclip/references/api-reference.md:agent-secret-access:1658 | optional_agent_tool | skills/paperclip/references/api-reference.md:1658 |
| skill:skills/paperclip/references/api-reference.md:common-mistakes:1698 | optional_agent_tool | skills/paperclip/references/api-reference.md:1698 |
| skill:skills/paperclip/references/api-reference.md:policies:1714 | optional_agent_tool | skills/paperclip/references/api-reference.md:1714 |
| skill:skills/paperclip/references/api-reference.md:a-goal-s-linked-work:1727 | optional_agent_tool | skills/paperclip/references/api-reference.md:1727 |
| skill:skills/paperclip/references/approvals.md:board-approvals-and-mcp-tool-approval-gates:1 | optional_agent_tool | skills/paperclip/references/approvals.md:1 |
| skill:skills/paperclip/references/approvals.md:requesting-board-approval:5 | optional_agent_tool | skills/paperclip/references/approvals.md:5 |
| skill:skills/paperclip/references/approvals.md:mcp-tool-approval-gates:26 | optional_agent_tool | skills/paperclip/references/approvals.md:26 |
| skill:skills/paperclip/references/artifacts.md:generated-artifacts-and-work-products:1 | always_agent_tool | skills/paperclip/references/artifacts.md:1 |
| skill:skills/paperclip/references/artifacts.md:engineering-work-products:5 | always_agent_tool | skills/paperclip/references/artifacts.md:5 |
| skill:skills/paperclip/references/artifacts.md:uploading-a-file:9 | optional_agent_tool | skills/paperclip/references/artifacts.md:9 |
| skill:skills/paperclip/references/artifacts.md:workspace-only-file-references:21 | optional_agent_tool | skills/paperclip/references/artifacts.md:21 |
| skill:skills/paperclip/references/auth-and-cli.md:authentication-the-wake-payload-and-cli-safety:1 | control_plane_owned | skills/paperclip/references/auth-and-cli.md:1 |
| skill:skills/paperclip/references/auth-and-cli.md:environment-and-credentials:5 | optional_agent_tool | skills/paperclip/references/auth-and-cli.md:5 |
| skill:skills/paperclip/references/auth-and-cli.md:the-wake-payload:9 | control_plane_owned | skills/paperclip/references/auth-and-cli.md:9 |
| skill:skills/paperclip/references/auth-and-cli.md:manual-local-cli-mode:13 | optional_agent_tool | skills/paperclip/references/auth-and-cli.md:13 |
| skill:skills/paperclip/references/auth-and-cli.md:cli-safety:17 | optional_agent_tool | skills/paperclip/references/auth-and-cli.md:17 |
| skill:skills/paperclip/references/auth-and-cli.md:run-audit-trail:21 | optional_agent_tool | skills/paperclip/references/auth-and-cli.md:21 |
| skill:skills/paperclip/references/cases.md:cases:1 | optional_agent_tool | skills/paperclip/references/cases.md:1 |
| skill:skills/paperclip/references/cases.md:core-model:12 | optional_agent_tool | skills/paperclip/references/cases.md:12 |
| skill:skills/paperclip/references/cases.md:upsert-semantics:29 | optional_agent_tool | skills/paperclip/references/cases.md:29 |
| skill:skills/paperclip/references/cases.md:read-and-search:67 | optional_agent_tool | skills/paperclip/references/cases.md:67 |
| skill:skills/paperclip/references/cases.md:documents:90 | always_agent_tool | skills/paperclip/references/cases.md:90 |
| skill:skills/paperclip/references/cases.md:fields:118 | optional_agent_tool | skills/paperclip/references/cases.md:118 |
| skill:skills/paperclip/references/cases.md:issue-links:151 | optional_agent_tool | skills/paperclip/references/cases.md:151 |
| skill:skills/paperclip/references/cases.md:child-cases:176 | optional_agent_tool | skills/paperclip/references/cases.md:176 |
| skill:skills/paperclip/references/cases.md:attachments:195 | optional_agent_tool | skills/paperclip/references/cases.md:195 |
| skill:skills/paperclip/references/cases.md:lifecycle:208 | optional_agent_tool | skills/paperclip/references/cases.md:208 |
| skill:skills/paperclip/references/cases.md:worked-blog-post-example:222 | optional_agent_tool | skills/paperclip/references/cases.md:222 |
| skill:skills/paperclip/references/chat.md:chat-turns-and-conversation-tasks:1 | optional_agent_tool | skills/paperclip/references/chat.md:1 |
| skill:skills/paperclip/references/chat.md:conversation-tasks:5 | optional_agent_tool | skills/paperclip/references/chat.md:5 |
| skill:skills/paperclip/references/chat.md:server-verified-external-chat-turns:22 | control_plane_owned | skills/paperclip/references/chat.md:22 |
| skill:skills/paperclip/references/company-skills.md:company-skills-workflow:1 | optional_agent_tool | skills/paperclip/references/company-skills.md:1 |
| skill:skills/paperclip/references/company-skills.md:what-exists:5 | optional_agent_tool | skills/paperclip/references/company-skills.md:5 |
| skill:skills/paperclip/references/company-skills.md:permission-model:24 | optional_agent_tool | skills/paperclip/references/company-skills.md:24 |
| skill:skills/paperclip/references/company-skills.md:core-endpoints:31 | optional_agent_tool | skills/paperclip/references/company-skills.md:31 |
| skill:skills/paperclip/references/company-skills.md:install-a-skill-into-the-company:67 | optional_agent_tool | skills/paperclip/references/company-skills.md:67 |
| skill:skills/paperclip/references/company-skills.md:app-shipped-catalog:77 | optional_agent_tool | skills/paperclip/references/company-skills.md:77 |
| skill:skills/paperclip/references/company-skills.md:external-source-import:103 | optional_agent_tool | skills/paperclip/references/company-skills.md:103 |
| skill:skills/paperclip/references/company-skills.md:source-types-in-order-of-preference:107 | optional_agent_tool | skills/paperclip/references/company-skills.md:107 |
| skill:skills/paperclip/references/company-skills.md:example-skills-sh-import-preferred:118 | optional_agent_tool | skills/paperclip/references/company-skills.md:118 |
| skill:skills/paperclip/references/company-skills.md:example-github-import:140 | optional_agent_tool | skills/paperclip/references/company-skills.md:140 |
| skill:skills/paperclip/references/company-skills.md:inspect-what-was-installed:166 | optional_agent_tool | skills/paperclip/references/company-skills.md:166 |
| skill:skills/paperclip/references/company-skills.md:assign-skills-to-an-existing-agent:183 | optional_agent_tool | skills/paperclip/references/company-skills.md:183 |
| skill:skills/paperclip/references/company-skills.md:include-skills-during-hire-or-create:218 | optional_agent_tool | skills/paperclip/references/company-skills.md:218 |
| skill:skills/paperclip/references/company-skills.md:notes:258 | optional_agent_tool | skills/paperclip/references/company-skills.md:258 |
| skill:skills/paperclip/references/decisions.md:standalone-decisions-and-decision-bundles:1 | optional_agent_tool | skills/paperclip/references/decisions.md:1 |
| skill:skills/paperclip/references/decisions.md:standalone-decisions:5 | optional_agent_tool | skills/paperclip/references/decisions.md:5 |
| skill:skills/paperclip/references/delegation.md:delegating-work-review-tasks-and-the-courier-pattern:1 | always_agent_tool | skills/paperclip/references/delegation.md:1 |
| skill:skills/paperclip/references/delegation.md:delegating-work-step-9:5 | optional_agent_tool | skills/paperclip/references/delegation.md:5 |
| skill:skills/paperclip/references/delegation.md:delegating-review-tasks:9 | always_agent_tool | skills/paperclip/references/delegation.md:9 |
| skill:skills/paperclip/references/delegation.md:issue-dependencies-blockers:20 | control_plane_owned | skills/paperclip/references/delegation.md:20 |
| skill:skills/paperclip/references/deploy-proof.md:proving-a-deploy:1 | optional_agent_tool | skills/paperclip/references/deploy-proof.md:1 |
| skill:skills/paperclip/references/heartbeat-details.md:heartbeat-procedure-full-text-of-the-steps:1 | optional_agent_tool | skills/paperclip/references/heartbeat-details.md:1 |
| skill:skills/paperclip/references/heartbeat-details.md:step-4-pick-work-overrides-and-special-cases:5 | control_plane_owned | skills/paperclip/references/heartbeat-details.md:5 |
| skill:skills/paperclip/references/heartbeat-details.md:step-5-name-provisional-tasks-early:18 | optional_agent_tool | skills/paperclip/references/heartbeat-details.md:18 |
| skill:skills/paperclip/references/heartbeat-details.md:step-6-understand-context:22 | optional_agent_tool | skills/paperclip/references/heartbeat-details.md:22 |
| skill:skills/paperclip/references/heartbeat-details.md:step-6-execution-policy-review-and-approval-wakes:36 | control_plane_owned | skills/paperclip/references/heartbeat-details.md:36 |
| skill:skills/paperclip/references/heartbeat-details.md:step-7-do-the-work-execution-contract:47 | optional_agent_tool | skills/paperclip/references/heartbeat-details.md:47 |
| skill:skills/paperclip/references/heartbeat-details.md:step-8-update-status-and-communicate:60 | optional_agent_tool | skills/paperclip/references/heartbeat-details.md:60 |
| skill:skills/paperclip/references/heartbeat-details.md:status-quick-guide:99 | control_plane_owned | skills/paperclip/references/heartbeat-details.md:99 |
| skill:skills/paperclip/references/heartbeat-details.md:comment-example:109 | always_agent_tool | skills/paperclip/references/heartbeat-details.md:109 |
| skill:skills/paperclip/references/heartbeat-details.md:update:114 | optional_agent_tool | skills/paperclip/references/heartbeat-details.md:114 |
| skill:skills/paperclip/references/human-input.md:asking-a-person-questions-confirmations-and-their-answers:1 | always_agent_tool | skills/paperclip/references/human-input.md:1 |
| skill:skills/paperclip/references/human-input.md:human-input-questions:7 | always_agent_tool | skills/paperclip/references/human-input.md:7 |
| skill:skills/paperclip/references/human-input.md:conversational-confirmation-answers:39 | always_agent_tool | skills/paperclip/references/human-input.md:39 |
| skill:skills/paperclip/references/inbox.md:managing-a-user-s-inbox:1 | control_plane_owned | skills/paperclip/references/inbox.md:1 |
| skill:skills/paperclip/references/interactions.md:issue-thread-interactions:1 | optional_agent_tool | skills/paperclip/references/interactions.md:1 |
| skill:skills/paperclip/references/interactions.md:issue-thread-interactions:5 | optional_agent_tool | skills/paperclip/references/interactions.md:5 |
| skill:skills/paperclip/references/interactions.md:checkbox-confirmations:34 | always_agent_tool | skills/paperclip/references/interactions.md:34 |
| skill:skills/paperclip/references/interactions.md:item-verdicts:76 | optional_agent_tool | skills/paperclip/references/interactions.md:76 |
| skill:skills/paperclip/references/issue-documents.md:issue-documents-through-the-api:1 | always_agent_tool | skills/paperclip/references/issue-documents.md:1 |
| skill:skills/paperclip/references/issue-documents.md:create-a-document:8 | always_agent_tool | skills/paperclip/references/issue-documents.md:8 |
| skill:skills/paperclip/references/issue-documents.md:update-or-resolve-an-unclear-write:49 | optional_agent_tool | skills/paperclip/references/issue-documents.md:49 |
| skill:skills/paperclip/references/issue-workspaces.md:issue-workspace-runtime-controls:1 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:1 |
| skill:skills/paperclip/references/issue-workspaces.md:discover-the-workspace:7 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:7 |
| skill:skills/paperclip/references/issue-workspaces.md:control-services:25 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:25 |
| skill:skills/paperclip/references/issue-workspaces.md:start-all-configured-services-waits-for-configured-readiness-checks:30 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:30 |
| skill:skills/paperclip/references/issue-workspaces.md:restart-all-configured-services:38 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:38 |
| skill:skills/paperclip/references/issue-workspaces.md:stop-all-running-services:46 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:46 |
| skill:skills/paperclip/references/issue-workspaces.md:read-the-url:65 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:65 |
| skill:skills/paperclip/references/issue-workspaces.md:mcp-tools:74 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:74 |
| skill:skills/paperclip/references/monitors.md:monitors-waits-and-watchers:1 | optional_agent_tool | skills/paperclip/references/monitors.md:1 |
| skill:skills/paperclip/references/monitors.md:monitors-and-watchers-say-only-what-you-actually-scheduled:5 | optional_agent_tool | skills/paperclip/references/monitors.md:5 |
| skill:skills/paperclip/references/planning.md:planning:1 | optional_agent_tool | skills/paperclip/references/planning.md:1 |
| skill:skills/paperclip/references/routines.md:paperclip-routines:1 | optional_agent_tool | skills/paperclip/references/routines.md:1 |
| skill:skills/paperclip/references/routines.md:lifecycle:16 | optional_agent_tool | skills/paperclip/references/routines.md:16 |
| skill:skills/paperclip/references/routines.md:creating-a-routine:27 | optional_agent_tool | skills/paperclip/references/routines.md:27 |
| skill:skills/paperclip/references/routines.md:concurrency-policies:64 | optional_agent_tool | skills/paperclip/references/routines.md:64 |
| skill:skills/paperclip/references/routines.md:catch-up-policies:76 | optional_agent_tool | skills/paperclip/references/routines.md:76 |
| skill:skills/paperclip/references/routines.md:activity-gated-scheduled-runs:87 | optional_agent_tool | skills/paperclip/references/routines.md:87 |
| skill:skills/paperclip/references/routines.md:example-skip-quiet-nights:107 | optional_agent_tool | skills/paperclip/references/routines.md:107 |
| skill:skills/paperclip/references/routines.md:adding-triggers:126 | optional_agent_tool | skills/paperclip/references/routines.md:126 |
| skill:skills/paperclip/references/routines.md:schedule-cron:136 | optional_agent_tool | skills/paperclip/references/routines.md:136 |
| skill:skills/paperclip/references/routines.md:webhook:150 | optional_agent_tool | skills/paperclip/references/routines.md:150 |
| skill:skills/paperclip/references/routines.md:api-manual-only:167 | optional_agent_tool | skills/paperclip/references/routines.md:167 |
| skill:skills/paperclip/references/routines.md:event:177 | optional_agent_tool | skills/paperclip/references/routines.md:177 |
| skill:skills/paperclip/references/routines.md:event-triggers:183 | optional_agent_tool | skills/paperclip/references/routines.md:183 |
| skill:skills/paperclip/references/routines.md:updating-and-deleting-triggers:230 | optional_agent_tool | skills/paperclip/references/routines.md:230 |
| skill:skills/paperclip/references/routines.md:manual-run:247 | optional_agent_tool | skills/paperclip/references/routines.md:247 |
| skill:skills/paperclip/references/routines.md:updating-a-routine:263 | optional_agent_tool | skills/paperclip/references/routines.md:263 |
| skill:skills/paperclip/references/routines.md:reading-routines-and-runs:274 | optional_agent_tool | skills/paperclip/references/routines.md:274 |
| skill:skills/paperclip/references/routines.md:routine-steps:287 | optional_agent_tool | skills/paperclip/references/routines.md:287 |
| skill:skills/paperclip/references/routines.md:slot-priority:387 | optional_agent_tool | skills/paperclip/references/routines.md:387 |
| skill:skills/paperclip/references/routines.md:a-project-s-routines:402 | optional_agent_tool | skills/paperclip/references/routines.md:402 |
| skill:skills/paperclip/references/secrets.md:credentials-and-secrets:1 | optional_agent_tool | skills/paperclip/references/secrets.md:1 |
| skill:skills/paperclip/references/secrets.md:proposing-credentials-safely:5 | optional_agent_tool | skills/paperclip/references/secrets.md:5 |
| skill:skills/paperclip/references/secrets.md:reading-granted-secrets:12 | optional_agent_tool | skills/paperclip/references/secrets.md:12 |
| skill:skills/paperclip/references/workflows.md:paperclip-workflow-playbooks:1 | optional_agent_tool | skills/paperclip/references/workflows.md:1 |
| skill:skills/paperclip/references/workflows.md:project-setup-ceo-manager:7 | optional_agent_tool | skills/paperclip/references/workflows.md:7 |
| skill:skills/paperclip/references/workflows.md:openclaw-invite-ceo:22 | optional_agent_tool | skills/paperclip/references/workflows.md:22 |
| skill:skills/paperclip/references/workflows.md:setting-agent-instructions-path:50 | optional_agent_tool | skills/paperclip/references/workflows.md:50 |
| skill:skills/paperclip/references/workflows.md:company-import-export:79 | optional_agent_tool | skills/paperclip/references/workflows.md:79 |
| skill:skills/paperclip/references/workflows.md:self-test-playbook-app-level:106 | optional_agent_tool | skills/paperclip/references/workflows.md:106 |

## Legacy MCP Alias Index

This is a compatibility/traceability index, not a tool catalog. “Inherited disposition” is shown only to make the normative target easy to audit.

| Legacy MCP name | Folded into normative row | Inherited disposition | Source anchor |
| --- | --- | --- | --- |
| paperclipMe | eval:hb-inbox-lite-01 | control_plane_owned | packages/mcp-server/src/tools.ts:291 |
| paperclipInboxLite | eval:hb-inbox-lite-01 | control_plane_owned | packages/mcp-server/src/tools.ts:297 |
| paperclipListAgents | eval:rf-api-mgr-heartbeat-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:303 |
| paperclipListSkills | eval:rf-cskill-audit-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:309 |
| paperclipGetAgent | eval:rf-api-mgr-heartbeat-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:315 |
| paperclipListIssues | eval:se-q-filters-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:324 |
| paperclipGetIssue | eval:se-get-issue-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:339 |
| paperclipGetHeartbeatContext | eval:hb-context-01 | control_plane_owned | packages/mcp-server/src/tools.ts:345 |
| paperclipListComments | eval:se-get-issue-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:354 |
| paperclipGetComment | eval:hb-wake-comment-01 | control_plane_owned | packages/mcp-server/src/tools.ts:367 |
| paperclipListIssueApprovals | eval:ap-board-approval-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:374 |
| paperclipListDocuments | eval:dp-base-revision-01 | always_agent_tool | packages/mcp-server/src/tools.ts:380 |
| paperclipGetDocument | eval:dp-base-revision-01 | always_agent_tool | packages/mcp-server/src/tools.ts:386 |
| paperclipListDocumentRevisions | eval:dp-base-revision-01 | always_agent_tool | packages/mcp-server/src/tools.ts:393 |
| paperclipListProjects | eval:rf-wf-project-setup-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:403 |
| paperclipGetProject | eval:rf-wf-project-setup-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:409 |
| paperclipGetIssueWorkspaceRuntime | eval:rf-iws-start-url-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:418 |
| paperclipControlIssueWorkspaceServices | eval:rf-iws-start-url-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:424 |
| paperclipWaitForIssueWorkspaceService | eval:rf-iws-target-restart-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:441 |
| paperclipListGoals | eval:su-parent-goal-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:467 |
| paperclipGetGoal | eval:su-parent-goal-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:473 |
| paperclipListApprovals | eval:ap-approval-wake-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:479 |
| paperclipCreateApproval | eval:ap-board-approval-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:488 |
| paperclipGetApproval | eval:ap-approval-wake-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:497 |
| paperclipGetApprovalIssues | eval:ap-approval-wake-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:503 |
| paperclipListApprovalComments | eval:ap-approval-deny-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:509 |
| paperclipCreateIssue | eval:su-parent-goal-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:515 |
| paperclipUpdateIssue | eval:st-done-comment-01 | always_agent_tool | packages/mcp-server/src/tools.ts:522 |
| paperclipCheckoutIssue | eval:co-body-contract-01 | control_plane_owned | packages/mcp-server/src/tools.ts:529 |
| paperclipReleaseIssue | eval:er-release-01 | control_plane_owned | packages/mcp-server/src/tools.ts:541 |
| paperclipAddComment | eval:cm-multiline-01 | always_agent_tool | packages/mcp-server/src/tools.ts:547 |
| paperclipSuggestTasks | eval:ix-suggest-tasks-01 | always_agent_tool | packages/mcp-server/src/tools.ts:554 |
| paperclipAskUserQuestions | eval:ix-questions-01 | always_agent_tool | packages/mcp-server/src/tools.ts:566 |
| paperclipRequestConfirmation | eval:ix-confirmation-plan-01 | always_agent_tool | packages/mcp-server/src/tools.ts:578 |
| paperclipRequestCheckboxConfirmation | eval:ix-checkbox-01 | always_agent_tool | packages/mcp-server/src/tools.ts:590 |
| paperclipUpsertIssueDocument | eval:dp-plan-doc-01 | always_agent_tool | packages/mcp-server/src/tools.ts:602 |
| paperclipRestoreIssueDocumentRevision | eval:dp-base-revision-01 | always_agent_tool | packages/mcp-server/src/tools.ts:613 |
| paperclipLinkIssueApproval | eval:ap-board-approval-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:628 |
| paperclipUnlinkIssueApproval | eval:ap-board-approval-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:637 |
| paperclipApprovalDecision | eval:ap-approval-wake-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:647 |
| paperclipAddApprovalComment | eval:ap-approval-deny-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:669 |
| paperclipApiRequest | eval:rf-api-404-report-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:678 |
