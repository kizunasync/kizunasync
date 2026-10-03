#!/usr/bin/env bash
# Prints the iOS and macOS deployment floors that Package.swift.tmpl declares. build-xcframework.sh and
# rn-uniffi's ubrn:ios read them here, so no engine build targets a newer OS than the Swift package admits.
# With `ios` or `macos` as the argument, prints that floor alone.
set -euo pipefail

TMPL="$(cd "$(dirname "$0")" && pwd)/Package.swift.tmpl"
IOS_MAJOR=$(sed -n 's/.*\.iOS(\.v\([0-9][0-9]*\)).*/\1/p' "$TMPL" | head -n 1)
MACOS_MAJOR=$(sed -n 's/.*\.macOS(\.v\([0-9][0-9]*\)).*/\1/p' "$TMPL" | head -n 1)

if [[ -z "$IOS_MAJOR" || -z "$MACOS_MAJOR" ]]; then
  echo "error: could not parse .iOS/.macOS floors from $TMPL" >&2
  exit 1
fi

case "${1:-}" in
  ios)
    echo "${IOS_MAJOR}.0"
    ;;
  macos)
    echo "${MACOS_MAJOR}.0"
    ;;
  "")
    echo "IPHONEOS_DEPLOYMENT_TARGET=${IOS_MAJOR}.0"
    echo "MACOSX_DEPLOYMENT_TARGET=${MACOS_MAJOR}.0"
    ;;
  *)
    echo "usage: ios-floor.sh [ios|macos]" >&2
    exit 1
    ;;
esac
