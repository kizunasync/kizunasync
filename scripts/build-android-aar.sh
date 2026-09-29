#!/usr/bin/env bash
# Builds kizunasync-ffi natively for arm64-v8a, armeabi-v7a, and x86_64 into the
# :engine module, then assembles the two AARs that the Maven Central release
# publishes: :engine carries the native library and :android the Kotlin client.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

KT="crates/kizunasync-ffi/bindings/kotlin"
JNI="$KT/engine/src/main/jniLibs"
ENGINE_AAR="$KT/engine/build/outputs/aar/engine-release.aar"
AAR="$KT/android/build/outputs/aar/android-release.aar"

if [[ -z "${ANDROID_NDK_HOME:-}${ANDROID_NDK_ROOT:-}" ]]; then
  if [[ -d "${ANDROID_HOME:-$HOME/Library/Android/sdk}/ndk" ]]; then
    # Newest installed NDK; cargo-ndk reads ANDROID_NDK_HOME.
    ANDROID_NDK_HOME="$(ls -d "${ANDROID_HOME:-$HOME/Library/Android/sdk}/ndk/"* 2>/dev/null | sort -V | tail -1 || true)"
    export ANDROID_NDK_HOME
  fi
fi

if [[ -z "${ANDROID_NDK_HOME:-}" || ! -d "${ANDROID_NDK_HOME}" ]]; then
  echo "error: ANDROID_NDK_HOME is not set (needed by cargo-ndk)" >&2
  exit 1
fi

if ! command -v cargo-ndk >/dev/null 2>&1; then
  echo "error: cargo-ndk not on PATH, cargo install cargo-ndk" >&2
  exit 1
fi

rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android

mkdir -p "$JNI"
cargo ndk -t arm64-v8a -t armeabi-v7a -t x86_64 -o "$JNI" build -p kizunasync-ffi --release --features http

test -f "$JNI/arm64-v8a/libkizunasync_ffi.so"
test -f "$JNI/armeabi-v7a/libkizunasync_ffi.so"
test -f "$JNI/x86_64/libkizunasync_ffi.so"

if [[ -x "$KT/gradlew" ]]; then
  (cd "$KT" && ./gradlew :engine:assembleRelease :android:assembleRelease --no-daemon)
elif command -v gradle >/dev/null 2>&1; then
  (cd "$KT" && gradle :engine:assembleRelease :android:assembleRelease --no-daemon)
else
  echo "error: no gradlew and gradle not on PATH (CI installs 8.7)" >&2
  exit 1
fi

# AGP names each AAR after its module (`engine-release.aar`, `android-release.aar`).
for aar in "$ENGINE_AAR" "$AAR"; do
  if [[ ! -f "$aar" ]]; then
    echo "error: expected $aar" >&2
    ls -la "$(dirname "$aar")" >&2 || true
    exit 1
  fi
  echo "aar OK: $aar"
done
unzip -l "$ENGINE_AAR" | grep -E 'jni/.*/libkizunasync_ffi.so'
