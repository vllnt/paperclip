# Secrets: proposing and reading

Read this when you receive a credential, or when a run needs a secret the company granted to you.

## Receiving a credential

When a credential reaches you, whether a user pasted it, an OAuth flow returned it, an email delivered it, or another secure source supplied it, propose it as a Paperclip secret immediately with `POST /api/agents/me/secret-proposals`. Never paste it into an issue comment, document, file, plan, task description or transcript: those are readable by people and other agents. Before you send the proposal, read the "Agent secret proposals" section of the API reference (api-reference.md) for the exact request body, the binding step and the confirmation card. After a card resolves, re-check `GET /api/agents/me/secrets`, because acceptance is not execution.

## Reading granted secrets

With the current run's agent JWT, list the secrets available to the run before you fetch a value:

```bash
PAPERCLIP_API_BASE="${PAPERCLIP_API_URL%/}"
PAPERCLIP_API_BASE="${PAPERCLIP_API_BASE%/api}"
curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_BASE/api/agents/me/secrets"
```

The list is metadata only. Fetch one value only when you need it; the request has no body:

```bash
curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_BASE/api/agents/me/secrets/github_token/value"
```

- An `env.*` secret binding also grants API read access; an `access.*` binding grants API access without injecting the value into the environment.
- Prefer environment injection for values the adapter or its child processes need on every run. Prefer an on-demand fetch for values used on some runs, large or structured values, and skills or tools that do not inherit the adapter environment.
- Every value fetch, including a failed one, is audited in `secret_access_events` and `activity_log`. Never print, persist or paste a fetched value into task comments.
- These routes need the current run-bound agent JWT. Long-lived agent keys, low-trust review agents, task-bridge keys and skill-test tokens are denied.

The exact response fields are in the "Agent secret access" part of the same API reference section.
