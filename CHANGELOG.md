# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until the first package release, changes are tracked under `[Unreleased]`; protocol-coupled packages version in lockstep once published.

## [Unreleased]

### Added

- Imported the project from Inksquad
- Rewrite in Rust

### Changed

- Switched the npm release workflow to GitHub Actions trusted publishing.
- Pinned GitHub Actions to current major versions and named Ubuntu images instead of ubuntu-latest.
- Kept going when an npm version was already on the registry.
- Shrunk the CLI wizard lockup so it fits an 80-column terminal.
- Redrew the wizard 絆 with two square pixels per cell so the character reads.
- Shrunk that 絆 to 28 pixels on a side.
- Drew the wizard 絆 with quadrant blocks.
- Enlarged the Kizuna and Sync wordmark beside the mark.
- Showed the wizard keys under each question, and made Backspace return to the previous one.
- Matched those keys to the question on screen, and drew the rule across the terminal.
- Drew wizard status on the left bar, and cleared the steps Backspace leaves.
- Closed the gap after the wizard's database line and before the next question.
- Cleared a table's questions once it was configured, and marked finished tables with a square.
- Skipped soft-delete, conflict, and the journal when a table is pull-only.
- Named each table rule and linked the name to its docs page.
- Rewrote the customize explanations and the notes beside each choice.
- Colored phase dots gray, and drew finished steps as a red filled diamond.
- Asked which solution to use before connection discovery, offering Supabase.
- Asked whether to retry when a push, a connection, or the pg_cron check failed.
- Drew Server maintenance as a phase dot.
- Suggested an owner column from a foreign key to auth.users when RLS did not name one.
- Showed which table the wizard is configuring, and let each table question go back.
