# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The npm, Swift, and Kotlin packages version in lockstep.

## [Unreleased]

### Added

- Ran `kizunasync deprovision` and `kizunasync jobs` over the Management API with `--project-ref`, and made a purge take `kizunasync` off the Data API exposed schemas before it drops the schema
- Added the FAQ, the comparison with alternatives, and the client library comparison to the docs

### Changed

- Showed the bare `npx kizunasync` command in the website hero and wrote the wordmark as Kizuna Sync
- Narrowed the React Native and Expo peer ranges of `kizunasync` to the tested versions: `react-native` `>=0.86.0 <0.88.0`, and `expo`, `expo-asset`, and `expo-file-system` `~57.0.0`

### Fixed

- Stopped the demo and the examples from stalling when the visitor's session is replaced, and reaped only idle demo visitors

## [0.2.6-alpha.3] - 2026-10-07

### Added

- Imported the project from Inksquad
