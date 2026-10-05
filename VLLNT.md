# VLLNT Paperclip fork

Based on upstream `master` at `1c07b5903b1b11139b1e1ce052a3cd4885865d90` (after
`canary/v2026.1004.0-canary.2`), merged in `7501843e9`. The publication guard scans only commits
added after this upstream base; update the base in `scripts/check-public-config.py`,
`.github/workflows/security.yml` and `.githooks/pre-push` with each upstream merge.
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
privately, including `PAPERCLIP_PUBLIC_URL`, database and auth
secrets, and the private AI gateway host mapping (`PAPERCLIP_AI_GATEWAY_HOST` and
`PAPERCLIP_AI_GATEWAY_HOST_IP`, rendered into `extra_hosts`). Compose refuses to
start without them. Existing private ingress and certificates remain operator-managed.

The Compose manifest uses `/var/lib/paperclip` as its generic persistent root.
The operator can map existing data there with a host-side symlink. Coolify validates
bind sources before environment substitution and rejects variable-based paths.
The manifest expects an existing operator-managed persistent directory,
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

## Publication safeguards

GitHub secret scanning and push protection are enabled. `main` requires verified
cryptographic commit signatures and rejects force pushes and deletion. CI signs
its generated deployment commit through GitHub's commit API without a persistent
signing key. Deployment waits for the reusable security check, focused regression
tests, UI typechecking and the complete production image build.

The security check runs Gitleaks with full redaction against all commits added
since the upstream base and rejects private network literals and runtime env files.
`PUBLISHED_EXCEPTIONS` in `scripts/check-public-config.py` lists commits that were
already pushed to `main` with such literals. History cannot be rewritten, so each
exception must be removed from the current tree by a later commit.
It runs on main pushes and pull requests. CI runs after publication; it cannot erase
a secret already pushed. GitHub push protection catches supported secret formats,
not every possible confidential value. Before your first push from each checkout,
install Gitleaks and run `git config core.hooksPath .githooks` for the local guard.
Do not bypass these checks or put runtime configuration in this repository.

The Codex API-key connection test now uses the same custom-provider configuration
serializer as real executions. Previously its disposable home omitted that routing.

## Remote-worker image

The deployment workflow builds with `INSTALL_LOCAL_CLIS=false`: global inference
CLI installations and their download cache are omitted from the control-plane
image. Workers provide their own harnesses. The upstream Dockerfile default still
includes the CLIs for installations that execute agents locally. All application,
adapter and server source continues to be built; this is not a UI-only image.

CI cache transfer is bounded and best-effort; cache unavailability cannot hold a
completed image build indefinitely or block publication of its deployment record.

Runtime dependencies and application files use separate image layers. Normal
source updates can reuse the dependency layer; dependency updates still require
capacity for both the previous and replacement dependency trees.

Custom Codex providers also apply to Paperclip-managed per-agent and connection
homes during execution. An explicitly user-managed external home remains untouched.
Remote-execution regressions verify the staged routing and cleanup for all three
cases without invoking an external provider.

The dependency layer comes from the install-only stage. Test caches are excluded
from that layer so source-only builds do not invalidate its content.
