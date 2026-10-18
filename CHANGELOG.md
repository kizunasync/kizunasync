# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The npm, Swift, and Kotlin packages version in lockstep.

## [Unreleased]

### Added

- Ran `kizunasync deprovision` and `kizunasync jobs` over the Management API with `--project-ref`, and made a purge take `kizunasync` off the Data API exposed schemas before it drops the schema
- Added the FAQ, the comparison with alternatives, and the client library comparison to the docs
- Added the `/compare` capability matrix, the home FAQ, and a share image, canonical URL, and title for every website page

### Changed

- Replaced the shared native and browser SQLite backends with Turso 0.8.3, with native migration snapshots, integrity checks, and imports from the previous browser OPFS/IndexedDB layouts.
- Upgraded the Expo integration and example to SDK 58 and added a native Expo Modules API 2.0 host for the Rust engine. Native database paths remain compatible with existing installations.
- Added the typed `KizunaSyncFfi` Swift product used by the Expo host and native Expo build gates.
- Added Android APK checks for the freshly built engine and 16 KB alignment; local Maven overrides now cover app runtime dependencies too.
- Updated rustls to 0.23.46 to address RUSTSEC-2026-0346 through RUSTSEC-2026-0349.
- Updated the Expo example to Uniwind 1.12.2 to fix circular web component imports.

- Showed the bare `npx kizunasync` command in the website hero and wrote the wordmark as Kizuna Sync
- Narrowed the React Native and Expo peer ranges of `kizunasync` to the tested versions: `react-native` `>=0.86.0 <0.88.0`, and `expo`, `expo-asset`, and `expo-file-system` `~57.0.0`

### Fixed

- Stopped the demo and the examples from stalling when the visitor's session is replaced, and reaped only idle demo visitors

## [0.2.6-alpha.3] - 2026-10-07

### Added

- Imported the project from Inksquad
