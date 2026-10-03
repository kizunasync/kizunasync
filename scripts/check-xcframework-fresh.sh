#!/usr/bin/env bash
# Fails loud when KizunaSyncFfi.xcframework does not match the current Rust
# source, instead of letting a stale local framework link silently into a
# Swift test run. Both test:swift and test:todo-ios run this first.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# shellcheck source=./xcframework-stamp.sh
source "$ROOT/scripts/xcframework-stamp.sh"

FRAMEWORK_DIR="crates/kizunasync-ffi/bindings/swift/KizunaSyncFfi.xcframework"

if [[ ! -d "$FRAMEWORK_DIR" || ! -f "$XCFRAMEWORK_STAMP_FILE" ]]; then
  echo "KizunaSyncFfi.xcframework is stale: run bun run cargo:xcframework" >&2
  exit 1
fi

if [[ "$(compute_xcframework_stamp)" != "$(cat "$XCFRAMEWORK_STAMP_FILE")" ]]; then
  echo "KizunaSyncFfi.xcframework is stale: run bun run cargo:xcframework" >&2
  exit 1
fi

echo "KizunaSyncFfi.xcframework is fresh"
