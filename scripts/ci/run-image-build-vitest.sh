#!/bin/sh
# Runs the tests that gate the production image build.
#
# The list lives in a manifest (default scripts/ci/image-build-vitest-files.txt),
# one repo-relative path per line. Blank lines, "#" comment lines and CRLF line
# endings are ignored, so a stray line left by a merge cannot fail an 8-minute
# build. An absent or empty list, or a listed path that is not a file, fails the
# build before vitest starts: vitest treats its arguments as filters, so a
# deleted path would otherwise be skipped silently.
#
# Paths are collected into "$@", not word-split from the file, so a path with a
# space stays one argument. Run from the repository root.
set -eu

manifest="${1:-scripts/ci/image-build-vitest-files.txt}"
cr=$(printf '\r')

[ -f "$manifest" ] || { echo "$manifest: not found" >&2; exit 1; }

set --
# "|| [ -n "$f" ]" keeps a last line that has no trailing newline.
while IFS= read -r f || [ -n "$f" ]; do
  f=${f%"$cr"}
  case "$f" in
    "" | "#"*) continue ;;
  esac
  [ -f "$f" ] || { echo "$manifest: missing $f" >&2; exit 1; }
  set -- "$@" "$f"
done < "$manifest"

[ "$#" -gt 0 ] || { echo "$manifest: no test files listed" >&2; exit 1; }

exec pnpm exec vitest run "$@"
