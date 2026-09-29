#!/usr/bin/env bash
# Shared xcframework freshness stamp: hashes the tracked and uncommitted state
# of the Rust source that feeds the compiled library (each crate's `src/`,
# `Cargo.toml`, `build.rs`, and any `.udl` file, only the ones that exist) plus
# `Cargo.lock`, so a stale local build can be caught before it silently links
# mismatched Rust into a Swift test run. `crates/kizunasync-ffi/bindings/**` (the
# Swift and Kotlin binding sources, READMEs) and other prose are out of scope:
# they do not change what a rebuild would produce, so editing them must not
# flip the stamp stale. Sourced by build-xcframework.sh and
# check-xcframework-fresh.sh after each has already `cd`ed to the repository
# root.

XCFRAMEWORK_STAMP_CRATES=(
  kizunasync-ffi
  kizunasync-engine
  kizunasync-store
  kizunasync-query
  kizunasync-protocol
  kizunasync-transfer
  kizunasync-remote-http
)

XCFRAMEWORK_STAMP_FILE="crates/kizunasync-ffi/bindings/swift/KizunaSyncFfi.xcframework.stamp"

# Prints each crate's src/, Cargo.toml, build.rs, and *.udl paths that exist,
# one per line, plus Cargo.lock.
xcframework_stamp_paths() {
  local crate dir udl
  for crate in "${XCFRAMEWORK_STAMP_CRATES[@]}"; do
    dir="crates/$crate"
    [[ -d "$dir/src" ]] && echo "$dir/src"
    [[ -f "$dir/Cargo.toml" ]] && echo "$dir/Cargo.toml"
    [[ -f "$dir/build.rs" ]] && echo "$dir/build.rs"
    for udl in "$dir"/*.udl; do
      [[ -f "$udl" ]] && echo "$udl"
    done
  done
  echo "Cargo.lock"
}

# Prints the sha256 of the tracked file list plus the working-tree diff over
# xcframework_stamp_paths, so an uncommitted edit changes the stamp too.
compute_xcframework_stamp() {
  local paths=()
  while IFS= read -r path; do
    paths+=("$path")
  done < <(xcframework_stamp_paths)
  {
    git ls-files -s -- "${paths[@]}"
    git diff -- "${paths[@]}"
  } | shasum -a 256 | cut -d ' ' -f1
}
