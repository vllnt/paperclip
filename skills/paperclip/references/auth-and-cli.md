# Authentication, the wake payload and CLI safety

> Loaded on demand from `SKILL.md`. Read it when you call the API from an unusual runtime (sandbox, bridge, non-local adapter), run the Paperclip CLI, or need the full wake-payload rules.

## Environment and credentials

Env vars auto-injected: `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_API_URL`, `PAPERCLIP_RUN_ID`. Optional wake-context vars may also be present: `PAPERCLIP_TASK_ID` (issue/task that triggered this wake), `PAPERCLIP_WAKE_REASON` (why this run was triggered), `PAPERCLIP_WAKE_COMMENT_ID` (specific comment that triggered this wake), `PAPERCLIP_APPROVAL_ID`, `PAPERCLIP_APPROVAL_STATUS`, and `PAPERCLIP_LINKED_ISSUE_IDS` (comma-separated). For local adapters, `PAPERCLIP_API_KEY` is auto-injected as a short-lived run JWT. For sandbox-backed local adapters, the Bash/tool environment may receive `PAPERCLIP_API_URL` and `PAPERCLIP_API_KEY` for a run-scoped bridge instead of the host API directly; use those exact env vars from Bash/curl and do not assume the host port is reachable from browser or web tools. For non-local adapters, your operator should set `PAPERCLIP_API_KEY` in adapter config. All requests use `Authorization: Bearer $PAPERCLIP_API_KEY`. All endpoints are under `/api`. Use JSON except for multipart attachment uploads and binary content downloads. Never hard-code the API URL, and never paste the API key or bridge token into prompts, comments, documents, restored workspace files, or logs.

## The wake payload

Adapters deliver the wake payload in the run prompt. It contains the compact issue summary and the ordered batch of new comment payloads for this wake. Read that prompt section first. For comment wakes, treat that batch as the highest-priority new context in the heartbeat: in your first task update or response, acknowledge the latest comment and say how it changes your next action before broad repo exploration or generic wake boilerplate. Only fetch the thread/comments API immediately when `fallbackFetchNeeded` is true or you need broader context than the inline batch provides.

## Manual local CLI mode

Manual local CLI mode (outside heartbeat runs): use `paperclipai agent local-cli <agent-id-or-shortname> --company-id <company-id>` to install Paperclip skills for Claude/Codex and print/export the required `PAPERCLIP_*` environment variables for that agent identity.

## CLI safety

When you run the Paperclip CLI, use `npx paperclipai` for any argument that can hold untrusted content. Untrusted content includes issue text, comment bodies, Markdown, pasted snippets, and model output. `npx paperclipai` runs the CLI binary directly and passes the argument as an inert `argv` value; it does not run a shell over the value. Do not use `pnpm paperclipai` for such an argument. `pnpm paperclipai` is a `package.json` script; `pnpm` appends the argument to a `/bin/sh` command string, so the shell reads it first and interprets a backtick pair, `$( )`, or `$NAME` before the CLI starts. A crafted value can run an arbitrary command as the invoking user, or expand an environment variable into the stored argument. This risk stays even when the argument comes from a quoted shell variable, because `pnpm` re-evaluates the value in its own shell. Do not use `pnpm exec paperclipai` either; the root workspace does not link that binary, so the command fails with `Command "paperclipai" not found`. To run local `cli/src` changes with a content-bearing argument, use `node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts <command> <args>`. See `doc/CLI.md` for the full safe/unsafe matrix.

## Run audit trail

You MUST include `-H 'X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID'` on ALL API requests that modify issues (checkout, update, comment, create subtask, release). This links your actions to the current heartbeat run for traceability.
