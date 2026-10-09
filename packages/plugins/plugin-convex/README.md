# Convex for Paperclip

Fork-bundled plugin (`packages/plugins/plugin-convex`, plugin id `vllnt.paperclip-convex`) that lets a company's agents inspect and
trim its Convex deployments, with access decided per environment class (production, staging, preview, dev, custom) and per agent.

Design, the full tool catalog, the permission model and the slice plan are in [docs/plugins/convex.md](../../../docs/plugins/convex.md).
This package implements slice 1: connection, classification, grants, inventory and health reads, preview lifecycle and the reaper.

## Operate

1. Store a Convex team token (and optionally a GitHub read-only token) as company secrets.
2. Write the company's plugin config (instance administrator): `teamId`, `teamToken`, `projects`, `github.token`, `grants`, `guards`, `reaper`.
   Every token is a `secret_ref`; a plaintext token is rejected. The example is in the design doc, section 5.
3. `paperclipai convex connect -C <company>` verifies each mapped project and reserves it for that company only.
4. `paperclipai convex deployments reap --dry-run -C <company>`, read the plan (previews and dev deployments), then set `reaper.enabled`.
5. Optional: `reaper.dev.enabled` deletes dev deployments unused for `reaper.dev.maxAgeDays` (default 7); `reaper.pullRequestPattern` deletes superseded CI previews of open pull requests.
   Both are plan only until enabled. Dev deployments need a Team Access Token, not a preview deploy key.

Agents use the `convex_*` tools. Every tool re-derives the company from the host run context, re-fetches the deployment from Convex,
classifies it (anything unknown is production), checks the agent's grant for that class, and audits the call.

## Test

```sh
pnpm --filter @vllnt/paperclip-convex test
pnpm --filter @vllnt/paperclip-convex typecheck
```

The tests use in-memory Convex and GitHub fakes; nothing calls a real service.
