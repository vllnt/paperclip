# Production base image mirror

CI builds from `ghcr.io/vllnt/paperclip-node-base@<digest>`, a copy of the
digest pinned in the Dockerfile `ARG BASE_IMAGE`. `scripts/ci/resolve-base-image.sh`
only verifies that copy exists. It never pulls the public registry and never
creates the copy, so a missing mirror fails the build with a clear message.

## Mirror the base image (maintainer, one time and on every digest bump)

Needs a login with `write:packages`. Run locally, not from CI:

```sh
digest=$(sed -n 's/^ARG BASE_IMAGE=.*@//p' Dockerfile)
docker login ghcr.io
docker buildx imagetools create \
  --tag "ghcr.io/vllnt/paperclip-node-base:${digest#sha256:}" \
  "docker.io/library/node:24-trixie-slim@${digest}"
docker buildx imagetools inspect "ghcr.io/vllnt/paperclip-node-base@${digest}"
```

The source is Docker Hub with the maintainer's own authenticated login, so the
digest matches the pin.

## Make the package public (maintainer, one time)

GHCR packages default to private. In the organization's package settings for
`paperclip-node-base`, set visibility to **Public**. This is not done from CI.
Public visibility lets pull-request workflows, including fork PRs (whose
`GITHUB_TOKEN` is read-only), pull the base image anonymously from GHCR.

Check: `docker buildx imagetools inspect ghcr.io/vllnt/paperclip-node-base@<digest>`
succeeds while logged out.
