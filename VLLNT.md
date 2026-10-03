# VLLNT Paperclip fork

Based on upstream `v2026.1001.0` (`8f8a0ab7effbd6a0584107d8038736c134ee5047`).
`main` owns VLLNT changes; `upstream/master` remains the upstream reference.
Upstream publishing workflows are not enabled on this fork's main branch.

## Customization

The new-agent wizard explicitly selects the CLI engine for Claude Code and Codex
when the chosen environment uses SSH. Other environment drivers retain upstream
engine selection. Provider endpoints and saved credentials use Paperclip's native
environment and company-secret APIs. This repository contains none of that private
configuration.

## Push deployment

A source push to `main` builds the complete production Dockerfile on a hosted CI
worker and publishes an immutable image. Only after a successful build, CI records
its digest in `deploy/compose.yaml` and source revision in `deploy/release.json`,
then pushes those two files to `main`. Coolify watches `deploy/compose.yaml` on
`main` through its GitHub App and deploys the finished image without building it on
the runtime host. A newer source commit prevents an older build from publishing a
deployment record. Generated-only paths are excluded from CI to avoid a build loop.

CI uses only the job-scoped GitHub token for this repository and its image package.
It has no production, Tailnet, proxy, database or Coolify access credentials.
The public image package must allow anonymous pulls. Coolify must have automatic
deployments enabled, previews disabled, `/deploy/compose.yaml` as its Compose path,
and `/deploy/compose.yaml` as its watch path. The operator configures runtime values
privately, including `PAPERCLIP_DATA_ROOT`, `PAPERCLIP_PUBLIC_URL`, database and auth
secrets. Existing private ingress and certificates remain operator-managed.

The Compose manifest expects an existing operator-managed persistent directory,
TLS gateway configuration, secret key file and private loopback ingress. It creates
no public route and requests no certificate. Do not put private endpoints, hostnames,
server identities, SSH material or credentials in this public repository.

Rollback uses a previously verified image digest and the private backup/restore
procedure. Database-changing upgrades require a compatible restore plan; an image
rollback alone does not undo database migrations.

## Verification

The SSH wizard regression was reproduced without the fix (two failures), then the
three focused setup suites passed (11 tests). UI typecheck, production build and
token gates passed. The full monorepo suite has not yet been run for this fork.
Live deployment and fresh-agent execution acceptance are tracked privately.
