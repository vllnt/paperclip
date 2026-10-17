#!/usr/bin/env bash
# Print the GHCR base image reference the production build must use.
#
# The Dockerfile pins its base image by digest from a public registry that
# rate-limits anonymous pulls. CI never pulls that registry: it builds from a
# GHCR copy that carries the same digest. This script verifies the copy exists
# and prints its reference; if it is missing it fails, it never falls back to
# the public registry and never creates the copy.
#
# The copy is a one-time maintainer step, repeated whenever the pinned digest
# changes (see "Mirror the base image" in .github/BASE-IMAGE.md).
#
# Env: MIRROR_REPO overrides the destination repository.
#      DOCKERFILE overrides the Dockerfile to read.
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

for ((n = 1; n <= attempts; n++)); do
  if docker buildx imagetools inspect "$mirror_ref" >/dev/null 2>&1; then
    echo "$mirror_ref"
    exit 0
  fi
  if ((n < attempts)); then
    echo "resolve-base-image: attempt $n failed, retrying in $((5 * n))s" >&2
    sleep $((5 * n))
  fi
done

cat >&2 <<MSG
resolve-base-image: ${mirror_ref} is not readable.
CI does not fall back to the public registry. A maintainer must mirror this
digest to GHCR and make the package public (see .github/BASE-IMAGE.md).
MSG
exit 1
