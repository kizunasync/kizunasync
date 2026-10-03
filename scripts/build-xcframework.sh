#!/usr/bin/env bash
# Builds KizunaSyncFfi.xcframework for iOS device, iOS Simulator (arm64 + x86_64),
# and macOS (arm64 + x86_64), staging the generated Swift headers for each slice.
# With --zip, also archives the xcframework and writes its SwiftPM checksum,
# the artifact Package.swift's binaryTarget(url:checksum:) release references.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: build-xcframework.sh requires macOS (xcodebuild)" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# shellcheck source=./xcframework-stamp.sh
source "$ROOT/scripts/xcframework-stamp.sh"

OUT="crates/kizunasync-ffi/bindings/swift/KizunaSyncFfi.xcframework"
ZIP=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)
      OUT="$2"
      shift 2
      ;;
    --zip)
      ZIP="$2"
      shift 2
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

HEADER_SRC="crates/kizunasync-ffi/bindings/swift/Generated/kizunasync_ffiFFI.h"
STAGING="$(mktemp -d "${TMPDIR:-/tmp}/kizunasync-xcframework.XXXXXX")"
trap 'rm -rf "$STAGING"' EXIT

if [[ ! -f "$HEADER_SRC" ]]; then
  echo "error: missing $HEADER_SRC, run bun run cargo:bindgen first" >&2
  exit 1
fi

rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios aarch64-apple-darwin x86_64-apple-darwin

# Deployment floors come from the Swift package template so a bump there cannot
# leave the XCFramework built for a newer OS than Package.swift admits.
IPHONEOS_DEPLOYMENT_TARGET="$(bash "$ROOT/scripts/swift-package/ios-floor.sh" ios)"
MACOSX_DEPLOYMENT_TARGET="$(bash "$ROOT/scripts/swift-package/ios-floor.sh" macos)"
export IPHONEOS_DEPLOYMENT_TARGET MACOSX_DEPLOYMENT_TARGET

# Staticlib is in crate-type; release-size is smaller but release is enough for local/CI.
cargo build -p kizunasync-ffi --release --features http --target aarch64-apple-ios
cargo build -p kizunasync-ffi --release --features http --target aarch64-apple-ios-sim
cargo build -p kizunasync-ffi --release --features http --target x86_64-apple-ios
cargo build -p kizunasync-ffi --release --features http --target aarch64-apple-darwin
cargo build -p kizunasync-ffi --release --features http --target x86_64-apple-darwin

IOS_A="target/aarch64-apple-ios/release/libkizunasync_ffi.a"
SIM_ARM_A="target/aarch64-apple-ios-sim/release/libkizunasync_ffi.a"
SIM_X86_A="target/x86_64-apple-ios/release/libkizunasync_ffi.a"
MAC_ARM_A="target/aarch64-apple-darwin/release/libkizunasync_ffi.a"
MAC_X86_A="target/x86_64-apple-darwin/release/libkizunasync_ffi.a"
test -f "$IOS_A"
test -f "$SIM_ARM_A"
test -f "$SIM_X86_A"
test -f "$MAC_ARM_A"
test -f "$MAC_X86_A"

SIM_A="$STAGING/libkizunasync_ffi_sim.a"
MACOS_A="$STAGING/libkizunasync_ffi_macos.a"
lipo -create "$SIM_ARM_A" "$SIM_X86_A" -output "$SIM_A"
lipo -create "$MAC_ARM_A" "$MAC_X86_A" -output "$MACOS_A"

INCLUDE="$STAGING/include"
mkdir -p "$INCLUDE"
cp "$HEADER_SRC" "$INCLUDE/kizunasync_ffiFFI.h"
cat > "$INCLUDE/module.modulemap" <<'EOF'
module kizunasync_ffiFFI {
    header "kizunasync_ffiFFI.h"
    export *
}
EOF

rm -rf "$OUT"
xcodebuild -create-xcframework \
  -library "$IOS_A" -headers "$INCLUDE" \
  -library "$SIM_A" -headers "$INCLUDE" \
  -library "$MACOS_A" -headers "$INCLUDE" \
  -output "$OUT"

test -d "$OUT"
echo "xcframework OK: $OUT"
find "$OUT" -maxdepth 3 -type f | sort

compute_xcframework_stamp > "$XCFRAMEWORK_STAMP_FILE"
echo "stamp: $XCFRAMEWORK_STAMP_FILE"

if [[ -n "$ZIP" ]]; then
  mkdir -p "$(dirname "$ZIP")"
  rm -f "$ZIP"
  ditto -c -k --sequesterRsrc --keepParent "$OUT" "$ZIP"
  CHECKSUM="$(swift package compute-checksum "$ZIP")"
  echo "$CHECKSUM" > "$ZIP.checksum"
  echo "zip: $ZIP"
  echo "checksum: $CHECKSUM"
fi
