#!/usr/bin/env bash
# Print the base image reference the production build should use.
#
# The Dockerfile pins its base image by digest from a public registry that
# rate-limits anonymous pulls. This script copies that exact digest to GHCR
# once (authenticated), then prints the GHCR reference, which carries the same
# digest. If the copy is unavailable it prints the original pinned reference,
# so the build still works, just through the public registry.
#
# Env: MIRROR_PUSH=true to create the GHCR copy when missing (needs a prior
#      `docker login ghcr.io` with packages:write). Default: read-only.
#      MIRROR_REPO overrides the destination repository.
set -euo pipefail

dockerfile="${DOCKERFILE:-Dockerfile}"
mirror_repo="${MIRROR_REPO:-ghcr.io/vllnt/paperclip-node-base}"
attempts=4

source_ref=$(sed -n 's/^ARG BASE_IMAGE=//p' "$dockerfile" | head -n1)
digest="${source_ref##*@}"
if [[ -z "$source_ref" || "$digest" != sha256:* ]]; then
  echo "resolve-base-image: no digest-pinned ARG BASE_IMAGE in $dockerfile" >&2
  exit 1
fi
mirror_ref="${mirror_repo}@${digest}"

retry() {
  local n=1 delay=5
  until "$@"; do
    if ((n >= attempts)); then return 1; fi
    echo "resolve-base-image: attempt $n failed, retrying in ${delay}s" >&2
    sleep "$delay"
    n=$((n + 1))
    delay=$((delay * 2))
  done
}

if docker buildx imagetools inspect "$mirror_ref" >/dev/null 2>&1; then
  echo "$mirror_ref"
  exit 0
fi

if [[ "${MIRROR_PUSH:-false}" == "true" ]] &&
  retry docker buildx imagetools create --tag "${mirror_repo}:${digest#sha256:}" "$source_ref" >&2 &&
  docker buildx imagetools inspect "$mirror_ref" >/dev/null 2>&1; then
  echo "$mirror_ref"
  exit 0
fi

echo "resolve-base-image: mirror unavailable, using pinned public reference" >&2
echo "$source_ref"
