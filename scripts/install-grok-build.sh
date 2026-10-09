#!/bin/sh
# Installs the pinned Grok Build CLI (@xai-official/grok, Apache-2.0) for every
# user on the machine, from tarballs whose sha512 matches the values below.
#
# Used by the Dockerfile (INSTALL_LOCAL_CLIS) and by operators preparing a
# worker. See doc/workers/grok-build.md. To upgrade, change the version and all
# hashes together:
#   npm view @xai-official/grok@<version> dist.integrity   (and the platform packages)
#
# The tarballs are fetched with `npm pack`, hashed here, and only then installed
# with --offline, so npm cannot pull a package this script did not verify.
#
# Environment:
#   GROK_INSTALL_PREFIX  npm global prefix (default /usr/local)
#   GROK_INSTALL_HOME    where the native binary lands (default $GROK_INSTALL_PREFIX/lib/grok).
#                        It must not be a user's home: agents run with their own GROK_HOME.
set -eu

GROK_VERSION="1.0.49"
TOML_VERSION="3.0.0"

MAIN_SRI="sha512-vvrgCWsAPlDwl5MdkbC8fjwOOPje32wdbvV10tclIByYqHmvR0iPweNcd3/jCJBhi+BftL7N8fBeC2WfpoV8uA=="
TOML_SRI="sha512-td6ZUkz2oS3VeleBcN+m//Q6HlCFCPrnI0FZhrt/h4XqLEdOyYp2u21nd8MdsR+WJy5r9PTDaHTDDfhf4H4l6Q=="

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    PLATFORM="linux-x64"
    PLATFORM_SRI="sha512-49I9NutgxQpME8bSeEWXuLP3cr5A5oCxch4PfQaXV6sO+N9Tc0QtI5aU5Y3zV2m2XMOvmIwW9/D4YgEtPksnqw=="
    ;;
  Linux-aarch64 | Linux-arm64)
    PLATFORM="linux-arm64"
    PLATFORM_SRI="sha512-HbX2fliGwr5y40Yug/zmOHO8qK0q9QSQqIyINmLzGWuR+UHnILue38ExMJDz5SqHsoDT7ECKMUE5GVUc8vsSiA=="
    ;;
  Darwin-arm64)
    PLATFORM="darwin-arm64"
    PLATFORM_SRI="sha512-6Ng+mNhbEBHYgK3phrIUT3+Myr9Lu9oEHWNvBb579N2tw9VGxKStPhV8uA0J4CPU1qZ/1ctsAvU7M73Gk1DrKw=="
    ;;
  *)
    echo "install-grok-build: no pinned Grok Build package for $(uname -s) $(uname -m)" >&2
    exit 1
    ;;
esac

PREFIX="${GROK_INSTALL_PREFIX:-/usr/local}"
NATIVE_HOME="${GROK_INSTALL_HOME:-$PREFIX/lib/grok}"

sri_of() {
  node -e 'const c=require("node:crypto"),fs=require("node:fs");process.stdout.write("sha512-"+c.createHash("sha512").update(fs.readFileSync(process.argv[1])).digest("base64"))' "$1"
}

verify() {
  actual="$(sri_of "$1")"
  if [ "$actual" != "$2" ]; then
    echo "install-grok-build: checksum mismatch for $1" >&2
    echo "  expected $2" >&2
    echo "  actual   $actual" >&2
    exit 1
  fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

MAIN_TGZ="xai-official-grok-$GROK_VERSION.tgz"
PLATFORM_TGZ="xai-official-grok-$PLATFORM-$GROK_VERSION.tgz"
TOML_TGZ="iarna-toml-$TOML_VERSION.tgz"

npm pack --silent \
  "@xai-official/grok@$GROK_VERSION" \
  "@xai-official/grok-$PLATFORM@$GROK_VERSION" \
  "@iarna/toml@$TOML_VERSION" >/dev/null

verify "$MAIN_TGZ" "$MAIN_SRI"
verify "$PLATFORM_TGZ" "$PLATFORM_SRI"
verify "$TOML_TGZ" "$TOML_SRI"

# The package's postinstall unpacks the native binary into $GROK_HOME/bin and
# points the `grok` entry at it, so the build-time GROK_HOME is a shared,
# world-readable location rather than the installing user's home.
mkdir -p "$NATIVE_HOME"
GROK_HOME="$NATIVE_HOME" npm install --global --offline --omit=dev --foreground-scripts \
  --no-audit --no-fund --prefix "$PREFIX" \
  "./$MAIN_TGZ" "./$PLATFORM_TGZ" "./$TOML_TGZ"
chmod -R a+rX "$NATIVE_HOME"

# Without the postinstall (an npm that skips scripts) `grok` would still start,
# but would unpack its own ~150 MB copy into every agent's GROK_HOME.
if [ ! -x "$NATIVE_HOME/bin/grok-$GROK_VERSION" ]; then
  echo "install-grok-build: postinstall did not place $NATIVE_HOME/bin/grok-$GROK_VERSION; run npm with scripts enabled" >&2
  exit 1
fi

# A different GROK_HOME at run time must still find the binary.
INSTALLED="$(env -u GROK_HOME HOME="$WORK" "$PREFIX/bin/grok" --version)"
case "$INSTALLED" in
  "grok $GROK_VERSION"*) echo "install-grok-build: $INSTALLED" ;;
  *)
    echo "install-grok-build: expected grok $GROK_VERSION, got: $INSTALLED" >&2
    exit 1
    ;;
esac
