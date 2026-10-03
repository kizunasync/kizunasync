#!/usr/bin/env bash
# Run TLC on one TLA+ module under properties/tla/.
# Usage: tools/run-tlc.sh <module-basename>   (e.g. prop-001-cursor-monotonic)
set -euo pipefail

base="${1:?usage: run-tlc.sh <module-basename>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # packages/protocol
jar="$here/tools/tla2tools.jar"
tla="$here/properties/tla/$base.tla"
cfg="$here/properties/tla/$base.cfg"

# ── download-on-demand ────────────────────────────────────────────────────────
EXPECTED_SHA="8836549e83db7f0b3f9fdde679ab56270d18e06198366d217d960738c02b9dbe"
TLA_JAR_URL="https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar"

# shasum is available on macOS and most Linux distros.
sha_of() { shasum -a 256 "$1" | awk '{print $1}'; }

# Atomic download: fetch to a temp file and mv into place only on success, so an
# interrupted/failed curl never leaves a corrupt jar behind to wedge future runs.
download_jar() {
  local tmp="$jar.tmp.$$" rc=0
  echo "run-tlc: downloading tla2tools.jar v1.8.0 ..." >&2
  curl -fsSL -o "$tmp" "$TLA_JAR_URL" || rc=$?
  if [ "$rc" -ne 0 ]; then
    rm -f "$tmp"
    echo "run-tlc: download failed (curl exit $rc)" >&2
    exit 4
  fi
  mv "$tmp" "$jar"
}

[ -f "$jar" ] || download_jar

# Verify checksum; on mismatch drop the cached jar and re-download once, so a
# stale/corrupt cached jar cannot permanently wedge every future run.
if [ "$(sha_of "$jar")" != "$EXPECTED_SHA" ]; then
  echo "run-tlc: cached tla2tools.jar checksum mismatch; re-downloading ..." >&2
  rm -f "$jar"
  download_jar
  actual_sha="$(sha_of "$jar")"
  if [ "$actual_sha" != "$EXPECTED_SHA" ]; then
    echo "run-tlc: checksum mismatch after re-download for tla2tools.jar" >&2
    echo "  expected: $EXPECTED_SHA" >&2
    echo "  actual:   $actual_sha" >&2
    exit 5
  fi
fi
# ── end download-on-demand ───────────────────────────────────────────────────

for f in "$tla" "$cfg"; do
  [ -f "$f" ] || { echo "run-tlc: missing $f" >&2; exit 2; }
done

command -v java >/dev/null 2>&1 || { echo "run-tlc: java not on PATH (need JRE 17+)" >&2; exit 3; }

# -workers 1 keeps output deterministic for CI logs; TLC runs in the module dir
# so it finds the .cfg by relative name and writes scratch there (gitignored).
cd "$here/properties/tla"
exec java -XX:+UseParallelGC -jar "$jar" -workers 1 -config "$base.cfg" "$base.tla"
