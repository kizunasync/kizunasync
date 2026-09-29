#!/usr/bin/env bash
# Generate UniFFI Swift/Kotlin into crates/kizunasync-ffi/bindings/*/Generated
# and sync the SPM C header module. Use --check to only verify artifacts.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CHECK_ONLY=0
if [[ "${1:-}" == "--check" ]]; then
  CHECK_ONLY=1
fi

SWIFT_OUT="crates/kizunasync-ffi/bindings/swift/Generated"
KT_OUT="crates/kizunasync-ffi/bindings/kotlin/Generated"
SWIFT_GEN="${SWIFT_OUT}/kizunasync_ffi.swift"
KT_GEN="${KT_OUT}/uniffi/kizunasync_ffi/kizunasync_ffi.kt"
SPM_INCLUDE="crates/kizunasync-ffi/bindings/swift/Sources/kizunasync_ffiFFI/include"
SPM_HEADER="${SPM_INCLUDE}/kizunasync_ffiFFI.h"
FFI_HEADER="kizunasync_ffiFFI.h"

# The marker READMEs are ours, not the generator's, so the drift comparison
# skips them: they are the one thing in these trees a regeneration never writes.
MARKER_README="README.md"

# The library the generator reads its metadata from, set by build_library.
LIB=""

# Where check_drift regenerates, removed on exit.
BINDGEN_TMP=""

resolve_lib() {
  if [[ -f target/debug/libkizunasync_ffi.dylib ]]; then
    echo "target/debug/libkizunasync_ffi.dylib"
  elif [[ -f target/debug/libkizunasync_ffi.so ]]; then
    echo "target/debug/libkizunasync_ffi.so"
  else
    echo ""
  fi
}

# Both paths rebuild before generating: UniFFI reads the surface out of the
# compiled library, and a rustdoc edit changes that metadata as much as a
# signature does.
build_library() {
  cargo build -p kizunasync-ffi
  LIB="$(resolve_lib)"
  if [[ -z "$LIB" ]]; then
    echo "error: libkizunasync_ffi not found under target/debug after build" >&2
    exit 1
  fi
}

# The one generator invocation both paths use, so --check cannot disagree with
# what a regeneration would write.
generate_into() {
  local swift_dir="$1"
  local kt_dir="$2"
  mkdir -p "$swift_dir" "$kt_dir"

  cargo run -p kizunasync-bindgen -- generate \
    --library "$LIB" \
    --language swift \
    --out-dir "$swift_dir"

  cargo run -p kizunasync-bindgen -- generate \
    --library "$LIB" \
    --language kotlin \
    --out-dir "$kt_dir"
}

cleanup_tmp() {
  if [[ -n "$BINDGEN_TMP" && -d "$BINDGEN_TMP" ]]; then
    rm -rf "$BINDGEN_TMP"
  fi
}

sync_spm_header() {
  mkdir -p "$SPM_INCLUDE"
  if [[ -f "${SWIFT_OUT}/${FFI_HEADER}" ]]; then
    cp "${SWIFT_OUT}/${FFI_HEADER}" "$SPM_HEADER"
  fi
  if [[ ! -f "${SPM_INCLUDE}/module.modulemap" ]]; then
    cat > "${SPM_INCLUDE}/module.modulemap" <<'EOF'
module kizunasync_ffiFFI {
    header "kizunasync_ffiFFI.h"
    export *
}
EOF
  fi
}

check_generated() {
  local missing=0
  local f
  for f in "$SWIFT_GEN" "$KT_GEN"; do
    if [[ ! -f "$f" ]]; then
      echo "error: missing Generated binding: $f" >&2
      missing=1
      continue
    fi
    if [[ ! -s "$f" ]]; then
      echo "error: empty Generated binding: $f" >&2
      missing=1
      continue
    fi
    # Reject placeholder-only trees (README alone is not enough).
    if ! grep -q "KizunaSyncEngine" "$f"; then
      echo "error: Generated binding lacks KizunaSyncEngine: $f" >&2
      missing=1
    fi
  done
  if [[ ! -f "${SWIFT_OUT}/${FFI_HEADER}" ]]; then
    echo "error: missing Swift FFI header: ${SWIFT_OUT}/${FFI_HEADER}" >&2
    missing=1
  fi
  if [[ ! -f "$SPM_HEADER" ]]; then
    echo "error: missing SPM-synced header: ${SPM_HEADER} (run cargo:bindgen)" >&2
    missing=1
  fi
  if [[ "$missing" -ne 0 ]]; then
    echo "cargo:bindgen:check FAILED" >&2
    exit 1
  fi
}

# Regenerates into a temporary tree and compares it to the checked-in bindings.
# Presence alone cannot catch a surface that moved: UniFFI carries each item's
# rustdoc into the metadata and into its method checksum, so an edited doc
# comment leaves bindings that assert a checksum the rebuilt library no longer
# reports, and the mismatch surfaces as a fatal error in a Swift or Kotlin run
# rather than here.
check_drift() {
  BINDGEN_TMP="$(mktemp -d)"
  trap cleanup_tmp EXIT
  generate_into "${BINDGEN_TMP}/swift" "${BINDGEN_TMP}/kotlin"

  local report
  report="$(
    diff -r -q -x "$MARKER_README" "$SWIFT_OUT" "${BINDGEN_TMP}/swift" || true
    diff -r -q -x "$MARKER_README" "$KT_OUT" "${BINDGEN_TMP}/kotlin" || true
    diff -q "$SPM_HEADER" "${BINDGEN_TMP}/swift/${FFI_HEADER}" || true
  )"
  if [[ -n "$report" ]]; then
    echo "error: Generated bindings do not match the current Rust surface: run bun run cargo:bindgen" >&2
    echo "$report" >&2
    echo "cargo:bindgen:check FAILED" >&2
    exit 1
  fi
}

print_check_ok() {
  echo "cargo:bindgen:check OK"
  echo "  swift: $SWIFT_GEN"
  echo "  kotlin: $KT_GEN"
  echo "  spm header: ${SPM_HEADER}"
}

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  check_generated
  build_library
  check_drift
  print_check_ok
  exit 0
fi

build_library
generate_into "$SWIFT_OUT" "$KT_OUT"

# Preserve marker READMEs if bindgen wiped the tree layout
if [[ ! -f "${SWIFT_OUT}/${MARKER_README}" ]]; then
  echo "# Generated Swift UniFFI sources" > "${SWIFT_OUT}/${MARKER_README}"
fi
if [[ ! -f "${KT_OUT}/${MARKER_README}" ]]; then
  echo "# Generated Kotlin UniFFI source" > "${KT_OUT}/${MARKER_README}"
fi

sync_spm_header
check_generated
print_check_ok
