#!/usr/bin/env bash
# Renders the public kizunasync/kizunasync-swift package tree into a destination
# checkout from this monorepo's Swift sources, generated UniFFI bindings, and
# templates in scripts/swift-package/.
set -euo pipefail

usage() {
  echo "usage: sync-swift-package.sh <dest-dir> --version <X.Y.Z> --checksum <sha256> [--local-xcframework <dir>]" >&2
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

DEST="$1"
shift

VERSION=""
CHECKSUM=""
LOCAL_XCFRAMEWORK=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      VERSION="$2"
      shift 2
      ;;
    --checksum)
      CHECKSUM="$2"
      shift 2
      ;;
    --local-xcframework)
      LOCAL_XCFRAMEWORK="$2"
      shift 2
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ ! -d "$DEST" ]]; then
  echo "error: dest-dir does not exist or is not a directory: $DEST" >&2
  exit 1
fi

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "error: --version must match X.Y.Z with an optional prerelease identifier, got: $VERSION" >&2
  exit 1
fi

if [[ -n "$CHECKSUM" && ! "$CHECKSUM" =~ ^[0-9a-f]{64}$ ]]; then
  echo "error: --checksum must be 64 lowercase hex characters, got: $CHECKSUM" >&2
  exit 1
fi

if [[ -z "$CHECKSUM" && -z "$LOCAL_XCFRAMEWORK" ]]; then
  echo "error: --checksum is required unless --local-xcframework is given" >&2
  exit 1
fi

if [[ -n "$LOCAL_XCFRAMEWORK" && ! -d "$LOCAL_XCFRAMEWORK" ]]; then
  echo "error: --local-xcframework does not exist or is not a directory: $LOCAL_XCFRAMEWORK" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$(cd "$DEST" && pwd)"

SWIFT_BINDINGS="$ROOT/crates/kizunasync-ffi/bindings/swift"
TEMPLATES="$ROOT/scripts/swift-package"

# Managed paths only: never touch .git or anything else already in dest.
rm -rf \
  "$DEST/Package.swift" \
  "$DEST/Sources" \
  "$DEST/README.md" \
  "$DEST/LICENSE" \
  "$DEST/.gitignore" \
  "$DEST/KizunaSyncFfi.xcframework"

mkdir -p "$DEST/Sources/KizunaSync" "$DEST/Sources/KizunaSyncFfi"
cp "$SWIFT_BINDINGS/Sources/KizunaSync/"*.swift "$DEST/Sources/KizunaSync/"
cp "$SWIFT_BINDINGS/Generated/kizunasync_ffi.swift" "$DEST/Sources/KizunaSyncFfi/kizunasync_ffi.swift"
cp "$ROOT/LICENSE" "$DEST/LICENSE"
cp "$TEMPLATES/gitignore" "$DEST/.gitignore"

if [[ -n "$LOCAL_XCFRAMEWORK" ]]; then
  cp -R "$LOCAL_XCFRAMEWORK" "$DEST/KizunaSyncFfi.xcframework"
  BINARY_TARGET='.binaryTarget(name: "KizunaSyncFfiRust", path: "KizunaSyncFfi.xcframework")'
else
  BINARY_TARGET=".binaryTarget(
      name: \"KizunaSyncFfiRust\",
      url: \"https://github.com/kizunasync/kizunasync/releases/download/v${VERSION}/KizunaSyncFfi.xcframework.zip\",
      checksum: \"${CHECKSUM}\"
    )"
fi

export TMPL_VERSION="$VERSION"
export TMPL_BINARY_TARGET="$BINARY_TARGET"

perl -0777 -pe 's/\{\{VERSION\}\}/$ENV{TMPL_VERSION}/g' \
  "$TEMPLATES/README.md.tmpl" > "$DEST/README.md"

perl -0777 -pe 's/\{\{BINARY_TARGET\}\}/$ENV{TMPL_BINARY_TARGET}/g' \
  "$TEMPLATES/Package.swift.tmpl" > "$DEST/Package.swift"

echo "Rendered files:"
( cd "$DEST" && find Package.swift Sources README.md LICENSE .gitignore -type f | sort )
if [[ -n "$LOCAL_XCFRAMEWORK" ]]; then
  echo "KizunaSyncFfi.xcframework"
fi

if [[ -n "$LOCAL_XCFRAMEWORK" ]]; then
  echo "mode: local-xcframework (verification only; do not push this tree)"
else
  echo "mode: release v${VERSION}"
fi
