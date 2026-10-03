---
title: CLI
description: Complete reference for the kizunasync command-line tool: init, sync, status, doctor, lint, upgrade, deprovision, and mock.
status: alpha
docType: reference
audience: app-developer
---

# CLI

The `kizunasync` CLI provisions Kizuna into an existing Supabase project, manages the synced-table set and the pack version over that project's lifetime, and checks migrations against the sync contract. It reads and writes the project's own [configuration record](./configuration.md), `kizunasync._config` and `kizunasync._settings`, and emits the [SQL pack](../reference/sql-pack.md). It sits beside the [Supabase CLI](https://supabase.com/docs/reference/cli/introduction) rather than replacing it: Supabase owns the project, the stack, and `db push`, and `kizunasync` owns the Kizuna schema inside it.

This page has four groups of sections. [Commands](#commands), [Global options](#global-options), and [Exit codes](#exit-codes) are the lookup tables that cover every invocation. [Interactive mode, colors, and output streams](#interactive-mode-colors-and-output-streams), [Project root](#project-root), and [Database connection](#database-connection) describe the behavior every command shares. [`kizunasync init`](#kizunasync-init) through [`kizunasync jobs`](#kizunasync-jobs) document one command each, with its flags, its output, and its refusals. [`kizunasync mock`](#kizunasync-mock-test-tooling) is the test tooling that seeds and churns rows.

:::tabs{group=pm}
```bash tab=npm
npx kizunasync --help
```

```bash tab=pnpm
pnpm dlx kizunasync --help
```

```bash tab=yarn
yarn dlx kizunasync --help
```

```bash tab=bun
bunx kizunasync --help
```
:::

A typical flow, end to end:

```bash
kizunasync init --yes        # detect project, propose tables from RLS, emit + apply the SQL pack
kizunasync doctor --ci       # gate CI on project shape (JSONL output)
kizunasync lint              # fail the PR if a migration breaks the sync contract
kizunasync status            # confirm what the project has provisioned
```

Every command in this reference is present in the current binary. Each one resolves an app project from the working directory or `--workdir`.

## Commands

| Command | What it does |
|---|---|
| [`kizunasync init`](#kizunasync-init) | Detects the project, proposes synced tables from [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security#what-a-policy-does) policies, emits the SQL pack and the migration that fills `kizunasync._config`, and exposes `kizunasync` in `[api].schemas`. `--project-ref` provisions a hosted project over the Management API instead. The task guide is [Install](./install.md). |
| [`kizunasync sync`](#kizunasync-sync) | Adds and removes synced tables, and changes the global push policy, in an already-provisioned project by emitting one delta migration. The task guide is [Manage synced tables](./manage-synced-tables.md). |
| [`kizunasync status`](#kizunasync-status) | Reports the pack, the synced tables and their live columns, clients, settings, and exposed-schema state. Read-only, and it never prompts. |
| [`kizunasync doctor`](#kizunasync-doctor) | Runs twenty-one project checks with a warning level for a job that has never run and for a column-level privilege restriction, plus one live Data API probe when a URL and key are available. |
| [`kizunasync lint`](#kizunasync-lint) | Classifies the migrations in `supabase/migrations/` as additive or breaking against the sync contract. |
| [`kizunasync upgrade`](#kizunasync-upgrade) | Reconciles an already-provisioned project's ledger against the shipped pack: refuses a pre-ledger install outright, or applies pending additive pack files inside one transaction. The task guide is [Upgrade](./upgrading.md). |
| [`kizunasync deprovision`](#kizunasync-deprovision) | Ledger-driven teardown. It prints the plan first and applies only with `--yes` or `KSYNC_ALLOW_DEPROVISION=1`; `--purge` also drops the `kizunasync` schema itself, behind a typed `--confirm`. The task guide is [Remove](./removing.md). |
| [`kizunasync jobs`](#kizunasync-jobs) | Lists, runs by hand, and reschedules the pack's three background retention jobs against `kizunasync._settings`. |
| [`kizunasync mock seed`](#mock-seed) | Writes a deterministic dataset into a synced table. |
| [`kizunasync mock churn`](#mock-churn) | Runs deterministic, marker-scoped write churn against rows `mock seed` created, which [Test offline behavior](../operations/test-offline-behavior.md) uses as a load source. |
| `kizunasync version` | Prints the version and exits. |

[What Kizuna installs](./whats-installed.md) is the inventory those commands create, remove, and reconcile.

## Global options

These are accepted on every command.

| Name | Type | Required | Description |
|---|---|---|---|
| `--workdir` | `<path>` | No | The project root, used exactly as given and never walked. Default: `SUPABASE_WORKDIR`, else the walk-up described in [Project root](#project-root). |
| `--no-color` | boolean | No | Never emit ANSI color. `NO_COLOR` in the environment has the same effect. Default: color when stdout is a TTY. |
| `-v`, `--version` | boolean | No | Print the version and exit `0`. Prints the bare version string, the same bytes `kizunasync version` writes. |

## Exit codes

Every command follows the same convention so CI can branch on it.

- `0`: success, or a no-op where there was nothing to do and every check passed.
- `1`: the command ran and reported a real failure. [`lint`](#kizunasync-lint) found a breaking migration, [`doctor`](#kizunasync-doctor) failed a check, [`upgrade`](#kizunasync-upgrade) found a breaking pending file or genuine drift, or an apply step failed after a write had already happened.
- `2`: the command could not run at all. An unreadable [`kizunasync._config`](./configuration.md), no migrations directory, no resolvable [database connection](#database-connection), invalid or contradictory flags, or a refused confirmation in a non-interactive session. [`init`](#kizunasync-init), [`sync`](#kizunasync-sync), [`upgrade`](#kizunasync-upgrade), and [`deprovision`](#kizunasync-deprovision) also exit `2` and name `update kizunasync` when a `pack-file` [`_provisions`](../reference/sql-pack.md#kizunasync_provisions) row names a pack newer than this binary ships, or one it does not recognize at all; [`status`](#kizunasync-status) and [`doctor`](#kizunasync-doctor) report the same row instead of refusing. A write over an installed pack that differs from this binary's exits `2` too when nobody can be asked: under `--yes`, or off a terminal, `init` and `sync` stop before they write anything and print the differing pack files with `kizunasync upgrade --reapply --yes` over the same connection.
- `130`: `Ctrl+C` stopped the command outside a prompt, while a write or a network call was running. On a direct Postgres connection the command first asks the server to cancel the running statement, then prints that the transaction in progress was not applied, because a cancelled statement never commits and Postgres rolls back a transaction that never committed. During `supabase db push` it stops the push and removes each migration file it wrote that the migration history does not record. `Ctrl+C` at a prompt cancels it instead and exits `0`.

[CI and CD](../operations/ci-cd.md#documentation-gates) shows the jobs that branch on these codes.

## Interactive mode, colors, and output streams

Scripted invocations produce deterministic output and never prompt. A real terminal adds guided flows for bare `kizunasync`, `kizunasync init`, and `kizunasync sync`, plus a formatted read-only view for `kizunasync status`. In a terminal the CLI asks before it writes; off one it never asks, so anything that changes your project needs either your answer at the prompt or `--yes` on the command line.

Run `kizunasync` with no command on a real terminal and it opens a guided flow instead of printing usage. It draws a vermilion faded ASCII lockup, settles one connection, and reads whether the database carries the Kizuna provisioning ledger. A database whose ledger records the pack opens the control panel described in [Interactive mode](#interactive-mode), whether or not [`kizunasync._config`](./configuration.md) declares a synced table yet. A database without the ledger, or with a ledger that records nothing, offers to install, which runs `init` rather than provisioning a third way, and declining exits `0`. Off a real terminal, in CI or with stdin redirected, it prints usage to stderr and exits `0`.

The `kizunasync init` wizard runs when you call `kizunasync init` in a terminal without `--yes`, `--local-only`, or `--dry-run`. It walks you through setup in a Clack-style session with an intro, spinners, boxed notes, and an outro. When `--db-url` or one of the connection-string variables listed under [Database connection](#database-connection) in the process environment already resolves a connection, it uses that without asking, exactly as the scripted path does. Otherwise it titles the step **Supabase connection discovery** and shows a picker.

The picker is built from what this machine already knows. It offers the linked project, whose ref comes from `SUPABASE_PROJECT_ID` in the process environment or the `.env` files, else from the `supabase/.temp/project-ref` file [`supabase link`](https://supabase.com/docs/reference/cli/supabase-link) writes, and the picker names which of the two it read. It offers each connection string the `.env` files declare, redacted. It offers the [local Supabase stack](./local-supabase.md), probed over TCP and marked reachable or not. Last, whatever else it found, it offers "Choose a project from your Supabase account". An `.env` candidate and the linked project each ask one further yes/no confirmation naming what they are. The local stack, a hand-typed connection string, and the account candidate do not.

Pick a project rather than a database, and the rest of the run goes through the [Management API](https://supabase.com/docs/reference/api/introduction). [Remote provisioning](#remote-provisioning---project-ref) describes that path. Only then does the wizard run the token ladder. Its first three rungs are the `--access-token` flag, `SUPABASE_ACCESS_TOKEN` in the process environment, and the same key in the `.env` files. The next is the operating system keyring the Supabase CLI writes under the "Supabase CLI" service, read first under the current profile's account and then under the legacy `access-token` account. The profile is `SUPABASE_PROFILE`, else the name in the `profile` file of the Supabase home directory, else `supabase`. The last rung is the `access-token` file in that home directory, which is `SUPABASE_HOME` when set and `~/.supabase` otherwise. A token must match the Supabase CLI's own shape, `sbp_`, `sbp_oauth_`, or the dashboard's `sbp_v0_` followed by 40 lowercase hex characters, and the wizard prints only which rung and keyring account answered. If none of the rungs resolve, the wizard runs [`supabase login`](https://supabase.com/docs/reference/cli/supabase-login) so the browser can create a Personal Access Token and store it. A missing CLI or a cancelled login falls back to a masked paste that Kizuna keeps in memory only.

Supabase defines that credential in [Management API authentication](https://supabase.com/docs/reference/api/introduction#authentication), and Kizuna only reads a token you already have rather than minting one. A run that never picks a project never touches the keychain. A rung that is malformed or errors, as a locked keychain does, degrades silently to the next one.

`kizunasync init` and `kizunasync sync` share one wizard once a connection is settled, and there is no schema question in it: the pack addresses every synced table as `public.<table>`, so `--schema` accepts `public` alone. The wizard shows a filterable checkbox of every table in `public`, all pre-checked, with a hint for the inferred owner and sync mode, then one mode question: **Recommended**, which accepts every inferred and pack-default value and asks nothing further, or **Customize**, which walks every step with the recommended value preselected. Above each question the rule's name is a link to the page that defines it, then one sentence.

Customize walks each table in name order. It asks the [sync mode](./configuration.md#kizunasync_config) first. It then asks who can see a row: by owner, by another column, or everyone, which decides the [bucket](../resources/glossary.md#bucket). When the mode is `read-write`, the next three are the soft-delete column, the [conflict mode](../sync/conflict-resolution.md), and whether to record overwritten values in the conflict journal. A `pull-only` table refuses every client write, so those three are not asked and stay at their defaults: no soft-delete column, `arrival`, journal off. Either mode then asks whether to register the table's clients, the lowest client schema version it accepts, and its tombstone retention in days. An empty retention answer inherits the project default.

It then asks the server maintenance section. That section carries the three UTC crontab schedules for the tombstone reaper, the changelog compactor, and the client pruner. Each schedule shows a `crontab.guru` link, rendered as a clickable hyperlink where the terminal supports it. Client retention in days, the HLC skew ceiling in milliseconds, the project tombstone retention in days, and the pull scan cap follow. The pull scan cap is how many candidates one pull page examines before it stops and the next page continues.

The push policy comes next. It asks for the largest push the server accepts in a field that opens holding the current cap, and an emptied field saves no cap. It also asks whether to reject a push that is not all-or-nothing. On `kizunasync init` alone, a final question covers what to do when `pg_cron` is absent. You either stop the install and print how to enable it, or install anyway and run retention by hand through [`kizunasync jobs`](#kizunasync-jobs).

The wizard then shows the plan: the migration files it emits, how many synced tables the config migration provisions, the [`[api].schemas`](https://supabase.com/docs/guides/local-development/cli/config#api.schemas) patch outcome, and every server knob this run is about to write. A knob the run declared nothing for is marked "pack default, left alone". The last question is one yes/no confirmation, "Write the migrations and run supabase db push `<flag>` now?", where `<flag>` is `--local`, `--db-url`, or `--linked` for whichever connection the wizard settled on, defaulting to no, and declining cancels cleanly and writes nothing. The wizard tests a connection as soon as it settles on one: a spinner reports "Connected: PostgreSQL `<version>`, database `<name>` as `<user>`", and a failed test offers "Pick another connection?" to try again before the plan is even built. A ledger that differs from this CLI's pack, through a changed hash or a pack file it does not record, is offered a re-apply before anything else runs: the wizard lists each differing file with the ledger's hash and the pack's, and asks "Re-apply the pack now?", defaulting to no. Yes writes the pack again as a new migration, which the confirmed plan pushes with the rest. No writes nothing, names `kizunasync upgrade --reapply --yes`, and takes you back to the connection question; when the `--db-url` flag or the environment chose the connection, there is no such question and the run ends. Before the plan renders, the wizard also compares the database's migration history against `supabase/migrations/`. A match is reported and the run continues. A recorded version with no local file offers to mark it reverted with `supabase migration repair --status reverted`, only on your explicit yes, and only when every one of those recorded versions carries a name this CLI writes; declining names the same command and `supabase db pull` to run by hand instead. When one of them was not written by this CLI, the wizard makes no offer: it stops and prints `supabase migration list` plus the exact `supabase migration repair --status reverted` command for every remote-only version, marking which ones this CLI wrote. A local file older than the newest recorded version stops the run naming `supabase db push --include-all` and `supabase migration repair --status applied` as the two ways out. After the migrations are written, a failed `supabase db push` re-reads the history: drift goes through the same repair, and a retry is offered only once the history agrees with `supabase/migrations/` again, the one case where the failure can be transient. A failed `pg_cron` check still asks whether to retry.

Backspace moves one step back from any question of the wizard, and the step it reopens keeps the answer it last gave. From the plan confirmation it reopens the step right before it (the pg_cron policy on `init`, otherwise the push policy), and each step in turn reopens the one before it, back to the table checkbox. A table reopens on its last question, the tombstone retention, so that is where Backspace lands from the next table's first question and from the maintenance select. The maintenance and the push-policy sections ask a select first, **Keep** the recommended or current values, or **Customize** them through further questions. Each custom question is a step of its own: Backspace on its empty field, or the word `back`, reopens the question before it, and on the first one it reopens the section's select on the custom option. In a typed field, Backspace deletes the last character until the field is empty. A typed question that reopens shows the answer it gave, and Enter on the empty field keeps that answer. From the step after a customized section, Backspace reopens that section's last custom question. Backspace on the table checkbox reopens the connection question right before it on the answer it settled: the typed connection string, which an empty answer keeps, the `.env` confirmation, the linked project confirmation, the account's project list, or the picker when the local stack asked nothing more. When the `--db-url` flag or the process environment chose the connection, no question comes before the checkbox, so both `init` and `sync` ask the checkbox again. A scripted run driven entirely by flags never reaches a step with an earlier one behind it, so it has nothing to go back to.

The key line under each question lists the keys that question takes and ends with `ctrl+c quit`. The solution question has no question before it, so Backspace does nothing there and its key line leaves Backspace out.

Attachment columns stay on the app's [`defineConfig`](../reference/javascript/define-config.md), and the CLI does not write them. Passing `--yes`, `--local-only`, or `--dry-run`, or running from a non-TTY session, skips the wizard entirely and keeps the scripted behavior documented under [`kizunasync init`](#kizunasync-init).

`kizunasync sync` walks the identical checkbox, the identical per-table ladder, and the identical two server sections. It runs over the Management API when `--project-ref` names a hosted project, exactly as the scripted path does. What differs is what it writes rather than what it asks. Every step opens on the value the project already carries, and the run emits only an answer that changes something. Accepting every step therefore writes nothing at all. Over a pack that differs from this CLI's, `sync` asks the same re-apply question before the checkbox, and a yes runs the re-apply at once over the connection, the way `kizunasync upgrade --reapply --yes` does.

When `kizunasync sync` asks for a connection in a terminal, it offers only the candidates that reach Postgres directly: the linked project, the `.env` connection strings, a reachable local stack, and a hand-typed string. When it finds none of the first three, it draws no picker: the connection string follows the solution question directly, and Backspace on its empty field reopens the solution question, also when the table checkbox reopened the field. Picking the linked project reads the access token through the ladder above, without the browser login or the masked paste. Kizuna then connects as `postgres` with `SUPABASE_DB_PASSWORD` when the process environment or the `.env` files set it, and otherwise asks the Management API for the temporary read-only Postgres login the Supabase CLI also uses. It tries `db.<ref>.supabase.co:5432` first. When that host does not answer within five seconds, it uses the session pooler on port `5432`, taken from the `supabase/.temp/pooler-url` file `supabase link` writes or else from the project's pooler settings, with `sslmode=require`, and it makes up to three connect attempts while a new login reaches the pooler. The login only reads the catalog and `kizunasync._config`, because the delta is still written as a migration and applied with `supabase db push --local`, `supabase db push --db-url`, or `supabase db push --linked` for the linked login, whichever matches the connection this run settled on. That login is tested the same way any other connection is, before the run continues. When the login cannot be opened, one line names the reason and the picker comes back without the linked project. The control panel's Synced tables item hands the linked project to `sync` the same way, reusing the token that already reached the project.

The table checkbox shows the tables `kizunasync._config` already declares pre-checked, along with every table in `public`. A newly checked table takes catalog-inferred proposals by default. It then goes through the same per-table ladder as an `--add`.

Pass `--add` or `--remove`, or run non-interactively, to take the scripted path under [`kizunasync sync`](#kizunasync-sync). The connection candidates for a direct connection are the same as `init`'s [Database connection](#database-connection) ladder. Over `--project-ref` the run reads and applies through the Management API instead, and it writes no local migration file. The confirm then reads "Apply this delta to the hosted project now?".

`kizunasync status` on a TTY draws the same Clack chrome as a read-only report, with an intro, boxed notes for pack, tables, clients, settings, jobs, retention, journal, attachments, and api schemas, and an outro, and it never asks a question. Piped and CI runs stay compact labelled text on stderr, or the machine payloads below.

Authorization is command-specific: the `init` and `sync` wizards ask before writing, and their scripted paths require `--yes`, while `upgrade`, `deprovision`, `mock seed`, and `mock churn` never prompt, including on a TTY, so an apply requires `--yes`, with `KSYNC_ALLOW_DEPROVISION=1` and `KSYNC_ALLOW_MOCK_SEED=1` as the documented alternatives. A refused apply exits `2`, and `--dry-run` stays read-only.

Colors and spinners follow the terminal: the process enables themed human status when stdout is a TTY, unless `--no-color` or `NO_COLOR` turns it off, and structured stdout is never themed. The `init` and `sync` prompt backend animates its own long-running steps; no other command gains prompts or spinners merely because a TTY is present, and `FORCE_COLOR` is not read.

The command intro and each later step title are OSC 8 hyperlinks to the matching documentation page in terminals that support them, such as iTerm2, VS Code, Windows Terminal, and Ghostty. The title is the link, and the URL itself is never printed.

Pressing `Ctrl+C` at a prompt cancels the question, also while the question is still being drawn. The wizard closes its chrome with "Nothing written.", writes nothing, and exits `0`, because a cancelled wizard is not a failure. A prompt the CLI cannot ask at all, on a session that turned out not to be interactive, exits `2` instead. Outside a prompt, while a write or a network call runs, `Ctrl+C` stops the command with exit `130`. When a statement is running on a direct Postgres connection, the command sends the server a cancel request for it, giving the request five seconds to reach the server and the statement five more to end. A cancelled statement never commits, and Postgres rolls back a transaction that never committed, so the command then prints that the transaction in progress was not applied. If the server does not confirm that the statement stopped (it finished before the cancel request reached it, the connection failed, or the server did not answer in time), the command says instead that the transaction may have committed and points to `kizunasync status`. With no statement running on a direct connection, it prints the not-applied line without sending a cancel request. When `Ctrl+C` lands while `supabase db push` runs, the command sends the push `SIGINT`, then `SIGTERM` if it is still running three seconds later, and waits for it to exit. It then reads the migration history again with the same read the history check uses, and gives that read ten seconds to answer. It removes each migration file this run wrote that the history does not record, because the push never applied it, and prints which written files the history records as applied and which it removed. A later run therefore never meets a file this run left unapplied. When the history cannot be read, or does not answer within those ten seconds, the summary says the migration history could not be read, every written file stays, and the command lists those files along with `supabase migration list` to check which of them were applied. While it reports, the command ignores any further `Ctrl+C`, and because the read gets ten seconds at most, the report always ends. In every case the command leaves the cursor visible and the terminal out of raw mode.

Human-readable status, warnings, and errors go to stderr. Machine payloads go to stdout: `doctor --ci` JSONL, `status --json` JSON, the `status --quiet` state line, generated SQL from `init --dry-run` and `sync --dry-run`, and the statement listings from the deprovision and mock plans. A deprovision listing carries a ledger-kind prefix and is a review artifact, not a directly executable SQL file. Redirected stdout is uncolored, and a session whose stdin is not a terminal never prompts.

### Interactive mode

Pick a database that has Kizuna installed in the bare `kizunasync` flow and the CLI opens a control panel: a header that sums up the project, and one menu that reaches `sync`, `upgrade`, `doctor`, `status`, `jobs`, `lint`, and `deprovision`. Each item runs the code its command runs, over the connection you already picked, so it applies the same checks and refusals. When an item has run, whether it applied a change, only read the project, or was refused by the server, the panel prints the matching one-shot command under "Equivalent command:", reads the project again, and draws the menu under a fresh header. An item you cancel or back out of ran nothing, so the panel prints no command for it.

The header has four lines. Pack gives the version the ledger records and whether it matches the pack this CLI ships. Tables lists every synced table with its sync mode. Jobs counts the [background jobs](#kizunasync-jobs) `pg_cron` holds and says when the most recent one ran. Clients counts the registered devices and how many of them were seen in the last hour.

A ledger whose pack differs from the one this CLI ships, through a changed hash or a pack file it does not record, opens every menu on Update the pack. Synced tables, Project settings, and Reschedule from settings offer the re-apply before they change anything. A note lists the differing files and says what a re-apply resets, the `kizunasync` schema's grants, its policies, and its two change-stamp triggers, `kizunasync_arm_stamp` and `kizunasync_stamp_transaction`, and "Re-apply the pack now?" defaults to no. No takes you back to the panel with nothing written. Yes runs what `kizunasync upgrade --reapply --yes` runs, prints that command, and then opens the item. A breaking statement refuses the re-apply before the question, as it does in `upgrade`. When the database refuses the re-apply with `42703` or `42P01`, from Update the pack or from the offer before an item, an earlier build of the pack created the `kizunasync` tables and a re-apply does not reshape them: nothing is applied, the panel names `kizunasync deprovision --purge` and `kizunasync init` over its connection, and every later menu opens on Remove Kizuna. Over the Management API, which cannot run `deprovision`, the panel names both commands with `--db-url` and a placeholder for the project's direct connection string, and the menu keeps opening on Update the pack.

| Item | What it runs | Equivalent command |
|---|---|---|
| Synced tables | The [`sync`](#kizunasync-sync) wizard over the panel's connection. While no table is synced, the `init` proposal built from your RLS policies runs instead. | `kizunasync sync`, or `kizunasync init` |
| Project settings | The wizard's server maintenance, push policy, and `pg_cron` steps, opened on the values in `kizunasync._settings`, then the delta `kizunasync sync` writes for what you changed. | `kizunasync sync --yes` with one flag per changed setting |
| Update the pack | [`upgrade`](#kizunasync-upgrade). The panel prints the plan and its classification, then asks once. Pending files apply, and the pack is re-applied over an up-to-date ledger or one whose hash differs. A breaking statement refuses before the question. | `kizunasync upgrade --yes`, or `kizunasync upgrade --reapply --yes` |
| Health check | [`doctor`](#kizunasync-doctor) and its full report. | `kizunasync doctor` |
| Status | The full [`status`](#kizunasync-status) report. | `kizunasync status` |
| Background jobs | A submenu that lists the three jobs, runs one of them now, or reschedules them from `kizunasync._settings`. Running and rescheduling each ask first. | `kizunasync jobs list`, `kizunasync jobs run <job>`, or `kizunasync jobs schedule` |
| Pending migrations | [`lint`](#kizunasync-lint). The item appears only when `supabase/migrations/` exists. | `kizunasync lint` |
| Remove Kizuna | [`deprovision`](#kizunasync-deprovision). It prints the dry-run plan, asks you to type the target, then asks separately whether to purge. | `kizunasync deprovision --yes`, plus `--purge --confirm <target>` after a purge |
| Exit | Closes the panel with exit `0`. | — |

Remove Kizuna asks for the typed target before it drops anything: `local` for a connection that names no hosted project, or the project ref for one that does, the same word `--confirm` takes. Any other text removes nothing. The purge question that follows defaults to no, and a yes drops the `kizunasync` schema the way `--purge` does. A removal that leaves the ledger empty closes the panel, and the flow carries on down the install path for that database, as it does for a database with nothing installed.

The `pg_cron` step of Project settings asks about the installed project rather than an install. A line above it says how many of the three retention jobs `pg_cron` schedules, or that `pg_cron` is not installed. The two answers are "Keep the retention jobs scheduled" and "Run retention myself (the allow-no-cron path)", which adds `--allow-no-cron` to the write, and the question opens on the answer that matches the current schedule. The custom push value reads "Largest push the server accepts (an emptied field saves no cap)" and opens holding the current cap as text you can edit. Deleting that text and pressing Enter saves no cap.

Every equivalent command ends with the connection the panel used. A direct connection appears as `--db-url` with the password removed from the URL and `PGPASSWORD=…` in front of the command. A project picked through the Management API appears as `--project-ref <ref>` with `SUPABASE_ACCESS_TOKEN=…` in front. The panel never prints the password or the token. The project tombstone retention has no `sync` flag, so when Project settings changes it, the panel says the printed command leaves that value out.

Over the Management API, Background jobs and Remove Kizuna stay in the menu with the reason they cannot run in place of their hint, because [`jobs`](#kizunasync-jobs) and [`deprovision`](#kizunasync-deprovision) take a direct connection. Synced tables reaches the linked project over a direct login or offers the direct connections, since the `sync` wizard writes a migration that `supabase db push` applies. Project settings applies its delta through the Management API, as `kizunasync sync --project-ref` does.

When a newer `kizunasync` recorded the pack, the header says to update this CLI and the menu keeps Status, Health check, and Exit, since every command that writes refuses that ledger.

After an item, the menu reopens with that item selected, unless the pack still differs from this CLI's, which keeps it on Update the pack, or, over a direct connection, on Remove Kizuna once a re-apply failed that way. Backspace on an item's first question returns to the menu, and inside an item it reopens the question before: the job picker reopens Background jobs on Run a job now, the run and reschedule confirmations reopen the question that led to them, and the purge question reopens the typed target on the text you typed, which an empty answer keeps. Until an item applies a change, Backspace on the menu reopens the connection question before it on the answer it settled. When the process environment chose the connection and no picker was shown, there is no such question: Backspace on the menu does nothing from the start, and the menu's key line leaves it out. Once an item applies one (a synced-tables write, a settings write, a pack update, a job run or reschedule, or a removal), no step before the panel reopens: Backspace on the menu does nothing, the menu's key line leaves Backspace out, and Exit or `Ctrl+C` closes the panel. `Ctrl+C` at any question closes the panel with exit `0`, including a question inside the `sync` or `init` wizard.

## Project root

Every command resolves its project root before anything else. It reads the global `--workdir <path>` flag first, then the `SUPABASE_WORKDIR` environment variable. It uses both exactly as given and never walks them, so a relative path resolves against your working directory. Failing both, the root is the first ancestor of your working directory that holds a `supabase/config.toml`, starting with the working directory itself. Failing that too, it is your working directory unchanged. A command logs the resolved root whenever it differs from where you ran it, so a walk-up or an override is never silent. Everything below reads relative to that resolved root rather than your shell's working directory. That includes the local [`supabase/config.toml`](https://supabase.com/docs/guides/local-development/cli/config) fallback and the `.env` file rungs. Kizuna reads that file rather than writing it, apart from the one `[api].schemas` line [`kizunasync init`](#kizunasync-init) appends.

## Database connection

[`init`](#kizunasync-init) opens a direct Postgres connection for policy and schema introspection, unless `--local-only` or `--project-ref` selects a different path. The interactive [`sync`](#kizunasync-sync) picker also introspects through Postgres. Flag-driven `sync --add` reads only the primary key of each table it names, the key it records for that table, and it gives additions the documented pull-only defaults; `sync --remove` reads no catalog. `sync`, like `init`, also accepts `--project-ref` for the same Management API path. [`status`](#kizunasync-status), [`doctor`](#kizunasync-doctor), [`lint`](#kizunasync-lint), and [`upgrade`](#kizunasync-upgrade) accept either a direct connection or `--project-ref` for the Supabase [Management API](https://supabase.com/docs/reference/api/introduction). [`deprovision`](#kizunasync-deprovision), [`jobs`](#kizunasync-jobs), and applied [mock](#kizunasync-mock-test-tooling) commands require a direct connection, because they run against a service or superuser role the Management API does not expose. None of these paths uses a service-role key.

Local `init` and `sync` apply their generated migration files with [`supabase db push`](https://supabase.com/docs/reference/cli/supabase-db-push), so Kizuna's SQL joins your own migration history and Supabase's [migration tracking](https://supabase.com/docs/guides/deployment/database-migrations#how-migration-tracking-works) records it like any other file. `--local-only` stops after writing the files. `init --project-ref` and `sync --project-ref` apply pack and config SQL through the Management API instead and write no local files.

Whichever connection resolves also decides the [`supabase db push`](https://supabase.com/docs/reference/cli/supabase-db-push) flag that applies it: the local stack pushes with `--local`, a `--db-url` flag, environment variable, or `.env` connection string pushes with `--db-url`, and the linked project's temporary login pushes with `--linked`. Before `init` or `sync` writes a migration file on any of these paths, it compares the database's migration history against `supabase/migrations/` and, where they disagree, offers [`supabase migration repair`](https://supabase.com/docs/reference/cli/supabase-migration-repair) rather than leaving a file on disk that `supabase db push` would then refuse.

The connection is resolved in this order, and each command logs which rung it used with the password redacted:

1. The `--db-url <url>` flag.
2. The first of `KSYNC_DB_URL`, `DIRECT_URL`, `POSTGRES_URL_NON_POOLING`, `DATABASE_URL`, and `POSTGRES_URL` set in your shell's process environment, tried in that order. `DIRECT_URL` and `DATABASE_URL` are the names Prisma uses, and `POSTGRES_URL_NON_POOLING` and `POSTGRES_URL` are the ones the Vercel Supabase integration writes, so a direct URL is always tried before a pooled one.
3. The same keys, in the same order, declared in the `.env` files at the resolved [project root](#project-root). Kizuna reads `.env`, `.env.development`, `.env.local`, and `.env.development.local`, a later file wins for the same key, and the process environment always outranks every file.
4. A local fallback. The CLI reads the [`[db] port`](https://supabase.com/docs/guides/local-development/cli/config#db.port) key in the resolved root's `supabase/config.toml`, falls back to Supabase's documented `54322` when the key is absent, and assembles `postgresql://postgres:postgres@127.0.0.1:<port>/postgres` with Supabase's fixed local-development credentials. That is a plain file read, never a CLI spawn, so a stack that is configured but not running resolves a URL anyway and then fails to connect.

The `.env` reader is deliberately small rather than a full dotenv implementation. It understands `KEY=value` lines, an optional leading `export `, `#` comments, and one pair of surrounding quotes, with no interpolation, no multi-line values, and no escapes. A line it does not understand is skipped rather than guessed at. It keeps only the keys `kizunasync` itself reads, the five connection-string keys above plus `SUPABASE_DB_PASSWORD`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_ID`, and the project URL and key names [`doctor`](#kizunasync-doctor)'s live probe reads, so nothing else in your `.env` files is ever held in memory.

A connection string without a password takes the one `PGPASSWORD` holds, the way libpq reads it, and a password in the URL wins over `PGPASSWORD`. Every command the CLI prints for a direct connection relies on this: the control panel and the next-step messages print `PGPASSWORD=… kizunasync … --db-url <url>` with the password taken out of the URL, and the command connects as printed once `PGPASSWORD` holds it. The CLI never prints the password.

A connection string that points at the Supabase transaction pooler, a `*.pooler.supabase.com` host on port `6543`, is moved to the same pooler's session mode on port `5432` before Kizuna connects, keeping the host, user, password, database, and query. Transaction mode does not support the prepared statements that catalog reads and DDL rely on, and the command logs one line naming the key it rewrote. Supabase describes both modes in [Connecting to Postgres](https://supabase.com/docs/guides/database/connecting-to-postgres).

Kizuna decides TLS before the connection opens, because the Rust driver does not honor `sslmode` on its own. A connection to any host that is not loopback always uses TLS and verifies the certificate and the hostname, whether the URL leaves `sslmode` out (as the Supabase dashboard's Connect strings do) or sets `prefer`, `require`, `verify-ca`, or `verify-full`. Kizuna refuses `sslmode=disable` and `sslmode=allow` on such a host with "hosted Postgres refuses sslmode=disable or sslmode=allow: remove it or set sslmode=require". It refuses a URL that lists `sslmode` more than once as well, so a trailing `disable` cannot downgrade a passing guard. On loopback TCP, `disable`, `allow`, `prefer`, and an omitted `sslmode` connect in cleartext, and `require`, `verify-ca`, and `verify-full` use TLS. A Unix socket connects without TLS. Supabase covers the parameter itself in [Connecting with SSL](https://supabase.com/docs/guides/database/connecting-to-postgres#connecting-with-ssl). Kizuna adds one rule on top: a remote connection never downgrades to cleartext. Take the connection string from your project's Supabase settings rather than deriving a hostname from this page, because pooler endpoints are project-specific. Supabase documents the local stack and the wider tooling in [Local development](https://supabase.com/docs/guides/local-development#cli) and the [CLI reference](https://supabase.com/docs/reference/cli/introduction). [Local Supabase](./local-supabase.md) covers the stack this repository runs.

The CLI checks the certificate chain against Mozilla's root certificates plus a built-in copy of Supabase Root 2021 CA, the root of Supabase's database certificates. Hosted Supabase databases present chains that end at that root, on the pooler and on the direct host alike, and Mozilla's roots do not include it. Your project's dashboard offers the same certificate for download under Database Settings, SSL configuration.

To trust another certificate authority, such as the private CA of a self-hosted Postgres server, add libpq's `sslrootcert=<path>` parameter to the connection URL. The CLI then trusts every certificate in that PEM file on top of the built-in roots and still checks the hostname. It percent-decodes the path the way libpq does, so `%20` is a space and `+` stays a plus sign. On a loopback host the file applies only when `sslmode` is `require`, `verify-ca`, or `verify-full`, because loopback otherwise connects without TLS. A file the CLI cannot read, or one without a certificate it can parse, fails the connection with an error that names the path. The CLI also refuses a URL that lists `sslrootcert` more than once, or whose value holds an invalid percent-escape. [A database connection fails with `UnknownIssuer`](../operations/troubleshooting.md#a-database-connection-fails-with-unknownissuer) covers the handshake failure an untrusted chain produces.

If none of the direct-connection sources resolve, a non-interactive database-backed command exits `2`. Interactive `init` and `sync` offer the candidates described above and accept a masked connection string.

```bash
kizunasync deprovision --dry-run --db-url postgresql://postgres:postgres@127.0.0.1:54322/postgres
KSYNC_DB_URL=postgres://postgres.myproj:pw@aws-1-eu-west-1.pooler.supabase.com:5432/postgres?sslmode=require kizunasync mock seed --yes
kizunasync status --workdir ../apps/api   # run from anywhere; resolves and reports on that project's root
```

## `kizunasync init`

Provisions Kizuna into your project.

Run it in a terminal without `--yes`, `--local-only`, or `--dry-run` and you get the wizard described in [Interactive mode, colors, and output streams](#interactive-mode-colors-and-output-streams). Every other invocation takes the scripted path described here.

`init` opens by reporting the project: a linked Supabase project, a generated `Database` types file, and every Kizuna integration it uses (React, Vue, Expo, React Native, vanilla JavaScript, Swift, and Kotlin) with the installed versions. It also lists the build tools beside them ([Next](https://nextjs.org), [Nuxt](https://nuxt.com), [Vite](https://vite.dev), [Capacitor](https://capacitorjs.com), and [Expo Router](https://docs.expo.dev/router/introduction/)) and reports whether the Kizuna package those integrations need is installed. Every JavaScript integration expects exactly `kizunasync`, and Swift and Kotlin expect `kizunasync-swift` and `com.kizunasync:kizunasync`. It reads the package manager (bun, pnpm, yarn, or npm) from the `packageManager` field of `package.json`, else from the nearest lockfile up to the repository root. It then reads `pg_policies` over a direct Postgres connection, never a service-role key. From those policies it proposes synced tables with auto-detected owner [buckets](../resources/glossary.md#bucket), marked by `[auto]` provenance comments. A table provisioned with a bucket column must be pulled with a bucket naming that column; a client that omits it fails with `KZL01`. Supabase explains what those policies express in [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security#what-a-policy-does). Kizuna reads them to guess a bucket column, and never writes or edits one. It then emits the [SQL pack](../reference/sql-pack.md) into `supabase/migrations/` under timestamped filenames. Each timestamp is the current UTC second, or one second past the latest version already in `supabase/migrations/` or in the migration history the run read, whichever is later, so two runs in the same second never write the same version. It applies that pack with [`supabase db push`](https://supabase.com/docs/reference/cli/supabase-db-push), addressing whichever database this run resolved: `--local` for the local stack, `--db-url` for a `--db-url` flag, environment variable, or `.env` connection string, or `--linked` for the linked project. Those migrations are the whole declaration, and `kizunasync._config` is what they provision, so `init` writes no configuration file.

After the pack, `init` emits `<timestamp>_kizunasync_config.sql`. For every table you kept, it upserts a [`_config`](../reference/sql-pack.md#kizunasync_config) row. That row carries the answered [sync mode](./configuration.md), bucket column, soft-delete column, [conflict mode](../sync/conflict-resolution.md), and [conflict journal](../sync/conflict-resolution.md#conflict-history). It also carries client registration, the minimum schema version, and [tombstone](../resources/glossary.md#tombstone) retention, and it records the table's primary-key columns as `key_columns`, read from the catalog rather than from a flag. The first five answers come from the `--sync`, `--bucket-column`, `--soft-delete`, `--conflict`, and `--conflict-journal` flags [`kizunasync sync`](#kizunasync-sync) takes. A scripted `--yes` run therefore declares the identical eight `_config` columns the wizard's Customize ladder walks. `--tombstone-ttl-days` on `init` keeps its own meaning, the project-wide default rather than a per-table override. It is the one flag whose meaning differs by command.

`init` then attaches the [`kizunasync_track_change`](../reference/sql-pack.md#kizunasynctrack_change) and [`kizunasync_track_delete`](../reference/sql-pack.md#kizunasynctrack_delete) triggers. Those are ordinary [Postgres row triggers](https://supabase.com/docs/guides/database/postgres/triggers#trigger-after-changes-are-made) that fire after a change, and Kizuna adds only what they write. It writes every [`_settings`](../reference/sql-pack.md#kizunasync_settings) knob its flags or its wizard's Customize path answered. It then adds a `select kizunasync._schedule_jobs();` call, so a declared schedule reaches `pg_cron` at once. A `Recommended` run, or a scripted run naming no policy flag, declares nothing. The migration then carries no `_settings` statement at all, and the pack's own defaults stand. Once the pack applies, `init` checks for `pg_cron` and refuses to finish without a way to run the three retention jobs. `--allow-no-cron` accepts an install with nothing scheduled. The config migration itself carries the same check: applying it by hand, outside `init`, still stops with `kizunasync: pg_cron is not enabled on this database` unless the run that generated it passed `--allow-no-cron`. [What Kizuna installs](./whats-installed.md#the-per-table-hooks) lists every object this step creates.

Once the migrations apply, `init` reads the database back before it reports success. The ledger must record every pack file under this build's hash, and `kizunasync._config` must hold every table of the run with the planned key, sync mode, and bucket column. Anything missing ends the run with exit `1` and a list naming each gap, so a push that applied nothing never ends in a success line. `--project-ref` makes the same check after it applies.

`init` also reads each table's row level security while it introspects, in the wizard and on the scripted path, and refuses a table whose row level security is disabled, exit `2`, naming the table and the `alter table public.<table> enable row level security;` statement. A pull reads every row under the caller's policies, so such a table would hand every row to any signed-in user. `--allow-no-rls` provisions it anyway and names it in a warning. `--local-only` reads nothing from the database, so it checks no table's row level security and says so.

`init` reads each table's primary key at the same time, and the `_config` row records its columns in index order as `key_columns`, the key every change is recorded under and every device holds the table's rows by. [Row keys](../sync/sync-rules-and-buckets.md#row-keys) explains what a device does with it. A key column is `uuid`, `text`, `character varying`, `smallint`, `integer`, or `bigint`, and a domain counts as its base type. `init` refuses three kinds of table, exit `2`, before anything is written. It refuses a table without a primary key, and one whose key has a column of any other type, which the refusal names with its type, because the text form of such a value is not identical on the device and on the server. It also refuses a read-write table whose key column is `generated always as identity`, because devices cannot supply its value, and the refusal suggests `generated by default as identity`, a uuid key, or pull-only. The wizard lists a table without a usable key as unavailable, with the reason beside it. A read-write table whose key has any other database default, such as an identity by default or a `serial` column, is provisioned with a note in the wizard summary and on stderr that offline inserts must provide those columns, because the default runs only on the server. A `gen_random_uuid()` default gets no note. An `init` re-run records a changed key only when the `min_schema_version` it resolves is above the recorded one, the rule [`sync`](#kizunasync-sync) applies.

| Name | Type | Required | Description |
|---|---|---|---|
| `--dry-run` | boolean | No | Print the SQL pack and the generated config migration, and change nothing. |
| `--yes` | boolean | No | Accept every proposal and write. Required to mutate on the scripted path. |
| `--local-only` | boolean | No | Skip every database check and write the migrations only. It does not run `supabase db push`. Mutually exclusive with `--project-ref`. |
| `--db-url` | `<url>` | No | Use this connection for introspection. Default: the ladder in [Database connection](#database-connection). |
| `--schema` | `<name>` | No | Schema the synced tables live in. The pack addresses `public.<table>` everywhere, so only `public` is accepted; anything else exits `2` naming the fixed addressing. Default: `public`. |
| `--project-ref` | `<ref>` | No | Provision the hosted project over the Management API instead of writing local files. See [Remote provisioning](#remote-provisioning---project-ref). Passing it with `--local-only` or `--db-url` exits `2`. |
| `--access-token` | `<token>` | No | Supabase Personal Access Token for `--project-ref`, never a service-role key, and never printed. Default: `SUPABASE_ACCESS_TOKEN`. |
| `--max-batch-size` | `<n>` | No | The largest push the server accepts, written into [`_settings`](../reference/sql-pack.md#kizunasync_settings). At least `1`, which is what the pack's own check constraint accepts, and `1` means single-mutation pushes only. A smaller value exits `2` before the run reports anything. Default: `500`. |
| `--no-max-batch-size` | boolean | No | Accept a push of any size, declared explicitly. Default: `500`. |
| `--require-atomic` | boolean | No | Not supported in this release. The client sends ordinary writes as non-atomic; enabling this would dead-letter them (`KZP03`). The flag exits `2`. Default: off. |
| `--no-require-atomic` | boolean | No | Accept a non-atomic push, declared explicitly. Default: off. |
| `--sync` | `pull-only` or `read-write` | No | The sync mode applied to every table this run provisions. Default: `pull-only`. |
| `--bucket-column` | `<column>` | No | The column every table this run provisions is scoped by, applied as a runtime-parameterized bucket. Default: none, so every permitted row is pulled. |
| `--soft-delete` | `<column>` | No | The soft-delete column for every table this run provisions. Default: none, so hard deletes are allowed. |
| `--conflict` | `arrival` or `hlc` | No | The [conflict mode](../sync/conflict-resolution.md) for every table this run provisions. Default: `arrival`. |
| `--conflict-journal` | boolean | No | Record overwritten same-column values server-side for every table this run provisions. Default: off. |
| `--register-clients` | boolean | No | Record one client row per device that syncs a table. Default: off. |
| `--no-register-clients` | boolean | No | Do not record client rows, declared explicitly. Default: off. |
| `--min-schema-version` | `<n>` | No | Lowest client schema version every table accepts. Default: `1`. |
| `--tombstone-ttl-days` | `<days>` | No | Project-wide tombstone retention in days, written into `_settings.tombstone_ttl_days`. At least `1`. Default: `30`. |
| `--reap-schedule` | `<cron>` | No | UTC crontab for the tombstone reaper. Refused when it is not a valid five-field schedule, with a `crontab.guru` link to check it. Default: `16 3 * * *`. |
| `--compact-schedule` | `<cron>` | No | UTC crontab for the changelog compactor. Default: `47 3 * * *`. |
| `--client-prune-schedule` | `<cron>` | No | UTC crontab for the client pruner. Default: `31 3 * * *`. |
| `--client-ttl-days` | `<days>` | No | Days of silence after which a client row is pruned. At least `1`. Default: `90`. |
| `--hlc-max-skew-ms` | `<ms>` | No | Forward-drift tolerance for an origin HLC, in milliseconds. Cannot be negative. Default: `5000`. |
| `--max-pull-scan` | `<n>` | No | How many candidates one pull page examines at most, the rows it withholds included, written into [`_settings.max_pull_scan`](../reference/sql-pack.md#kizunasync_settings). A page that reaches the cap stops early, and the next page continues from there. At least `1`. Default: `5000`. |
| `--allow-no-cron` | boolean | No | Install without scheduled retention when `pg_cron` is absent, instead of refusing. Also drops the `pg_cron` gate from the generated migration. |
| `--allow-no-rls` | boolean | No | Provision a table whose row level security is disabled, instead of refusing, and name it in a warning. |

### Remote provisioning (`--project-ref`)

`kizunasync init --project-ref <ref>` provisions a hosted Supabase project through the [Management API](https://supabase.com/docs/reference/api/introduction) and touches nothing on disk. It emits no migration, patches no `supabase/config.toml`, and never runs `supabase db push`. It runs the same wizard the local path runs, reading the table catalog, columns, and RLS policies through that endpoint instead of a direct connection, or it applies the same flags non-interactively. `--schema` and `--max-batch-size` are live on this path, and `--require-atomic` is refused.

It exposes `kizunasync` by [reading](https://supabase.com/docs/reference/api/v1-get-postgrest-service-config) and [updating](https://supabase.com/docs/reference/api/v1-update-postgrest-service-config) the project's [PostgREST](https://postgrest.org/) configuration, the hosted equivalent of the `[api].schemas` patch. It then applies each pack file and the config SQL through the [run a query](https://supabase.com/docs/reference/api/v1-run-a-query) endpoint, the same `_config` upsert, triggers, and `_settings` statement the local path renders. It reports what the [`kizunasync._provisions`](../reference/sql-pack.md#kizunasync_provisions) ledger holds afterwards. Use this path when the project has no local `supabase/` directory. The default path keeps the pack in your migration history.

Authentication is a [Personal Access Token](https://supabase.com/docs/reference/api/introduction#authentication), from `--access-token <token>` or `SUPABASE_ACCESS_TOKEN`, never a service-role key. Without either, the command exits `2` naming both. The token travels only in the `Authorization` header. Kizuna never prints it, never writes it anywhere, and masks it out of any error text the platform echoes back.

The `kizunasync._provisions` ledger decides what happens, and there are four outcomes. An empty ledger is a fresh install. Every pack file applies in name order, and each one records a `pack-file` row as it lands, exactly as the local path does. A ledger that records each pack file with a matching `md5` is up to date. It applies nothing and exits `0`, which is what a project this command or the local `init` provisioned reports on every later run. A ledger that holds provisioned objects but no per-file row is already provisioned some other way. The project has Kizuna, but not from a `pack-file` row this or any `kizunasync init` wrote. This pack therefore cannot be version-matched against it, so the command applies nothing and exits `0`. Per-file accounting for that state is [`kizunasync upgrade`](#kizunasync-upgrade)'s job, and it decides whether the pending files are safe to apply. A ledger that does record pack files but disagrees with them is drift, through a missing file or a differing hash. The command lists each differing file with the ledger's hash and the pack's, and offers to run what `kizunasync upgrade --reapply --yes` runs, in one transaction, defaulting to no. Declining applies nothing: the run exits `0`, or goes back to the project list when the wizard picked the project. Off a terminal, under `--yes`, or under `--dry-run`, the offer is refused outright with exit `2`, naming `kizunasync upgrade --reapply --yes --project-ref <ref>`. No outcome ever applies part of a pack.

`--dry-run` prints the exposure outcome, the pack files and their hashes, and the generated config SQL, and changes nothing at all. It reads the exposed schemas rather than patching them. Applying requires `--yes`, or one interactive confirmation covering both the pack files and the config, and a non-interactive run without `--yes` exits `2`. A failed call surfaces the HTTP status and the platform's own message, and exits `1`. Nothing is retried, and a failure is never reported as a successful default. `--db-url` is refused alongside `--project-ref` rather than silently ignored.

```bash
kizunasync init --project-ref abcdefghijklmnopqrst --dry-run   # preview: exposure + pack plan, changes nothing
kizunasync init --project-ref abcdefghijklmnopqrst --yes       # expose kizunasync and apply the pack remotely
```

`init` also patches your `supabase/config.toml` so `kizunasync` appears in [`[api].schemas`](https://supabase.com/docs/guides/local-development/cli/config#api.schemas). PostgREST serves only the schemas listed there, which Supabase covers in [Exposing custom schemas](https://supabase.com/docs/guides/api/using-custom-schemas#exposing-custom-schemas). Without the entry, every [`kizunasync.pull`](../reference/sql-pack.md#kizunasyncpull) and [`kizunasync.push`](../reference/sql-pack.md#kizunasyncpush) call fails with `PGRST106` even though the pack installed cleanly.

The CLI reads the file as TOML and preserves the rest of it byte for byte. An existing `schemas` array gets `"kizunasync"` as its last entry: appended on the same line for a single-line array, or on a new line at the indentation of the entries above it for a multi-line one, with comments left on their lines. An `[api]` section with no `schemas` key gets `schemas = ["public", "graphql_public", "kizunasync"]`. That restates Supabase's defaults, because writing the key overrides them. A file with no `[api]` section gets one appended. The CLI never rewrites two cases, a `supabase/config.toml` that does not parse as TOML (it names the line and column of the error) and an absent one, and it prints what to add instead. Creating that file is [`supabase init`](https://supabase.com/docs/reference/cli/supabase-init)'s job. The patch runs under `--local-only` too, because it is a local file either way, and `--dry-run` only reports what it would do.

Run [`supabase config push`](https://supabase.com/docs/reference/cli/supabase-config-push) afterwards to carry the change to your hosted project. You can set it in the Dashboard instead, under Settings, API, Exposed schemas.

The command is [idempotent](https://grokipedia.com/page/Idempotence) through the content-hashed [`kizunasync._provisions`](../reference/sql-pack.md#kizunasync_provisions) ledger, and the database, not `supabase/migrations/`, decides what is already applied. A pack file counts as emitted only when the ledger records its `pack-file` row with the same hash, and the config migration only when `kizunasync._config` already holds everything it would write. Anything else gets a fresh timestamped migration that `init` pushes, whatever older files in the directory say, which is how `init` installs again after [`deprovision --purge`](#kizunasync-deprovision). Re-running it over an installed project is a no-op or an explicit upgrade diff. A re-run that proposes a table `kizunasync._config` does not hold yet, or answers a kept table differently, writes a new config migration covering every table it provisions. [`kizunasync sync --add`](#kizunasync-sync) remains the targeted way to add one table. Under `--local-only` the database is never read, so the command skips already-emitted pack files and the generated `_kizunasync_config.sql` migration by their timestamped filename label. The generated config SQL is itself idempotent, through upserts and drop-then-create triggers, so even a forced re-apply changes nothing.

After the pack applies, `init --project-ref` runs the same [`pg_cron`](../reference/sql-pack.md#scheduled-jobs) check as the local path and refuses to finish without a way to run the three retention jobs, unless `--allow-no-cron` accepts the gap.

```bash
kizunasync init --dry-run    # preview what would be written
kizunasync init --yes        # write migrations and apply them
kizunasync init --local-only --yes  # write files only, skip db push
```

## `kizunasync sync`

Adds and removes synced tables in an already-provisioned project. [`kizunasync init`](#kizunasync-init) is the installer, and a re-run writes a new config migration only when `kizunasync._config` does not already hold what it would write. `sync` is the targeted way to add or drop one table afterwards. It reads the synced set from [`kizunasync._config`](./configuration.md), generates the SQL that provisions or unwinds the table, and applies it. [Manage synced tables](./manage-synced-tables.md) walks the same flow as a task.

You decide the new table set in one of two ways. `--add <table>` and `--remove <table>` are repeatable, and each accepts either `--add todos` or `--add=todos`. A run that names them prompts for nothing, so a scripted run is deterministic. A terminal run with neither flag shows one checkbox with the synced tables pre-checked. [Interactive mode, colors, and output streams](#interactive-mode-colors-and-output-streams) describes that checkbox.

Every path needs a reachable database, because the current synced set lives in `kizunasync._config` and the delta is computed against it. A run that resolves no connection exits `2` naming the local stack command and `--db-url`. Three refusals come first and need no database: a bad table name, a flag value out of range, and a run with nothing to script and no terminal, which prints the usage line before it resolves anything.

A table added by flag takes the pull-only contract unless the per-table options below answer otherwise. Each of the eight per-table options applies to every `--add` in that invocation rather than to one name, so a run that adds tables needing different contracts uses the wizard or one run per table.

A terminal run reads each table's row level security with the catalog and refuses to add a table whose row level security is disabled, exit `2`, unless `--allow-no-rls` accepts it. A run that adds tables with `--add` reads the catalog only for their primary keys, so it checks no row level security and says so on stderr.

Both paths apply the key rules [`kizunasync init`](#kizunasync-init) describes. A table without a primary key, one whose key has a column of another type, and a read-write table keyed by a `generated always as identity` column are refused, exit `2`, before anything is written, and a read-write table whose key has a database default gets the offline-insert note. The checkbox lists a table without a usable key as unavailable instead. A table the synced set already holds stays on offer whatever its key, so unchecking it still removes it, and [`kizunasync doctor`](#kizunasync-doctor)'s `table-primary-key` and `sync-key` checks name it.

In a terminal the same flags pre-fill the matching wizard question, and an answer given there wins over the flag that pre-filled it. Passing all eight leaves nothing to ask, so the ladder is skipped for that run; `--conflict-journal` counts as answered only when you pass it, so a run that wants to be asked omits one of the other seven. Either way the run prints which flags decided the contract.

Naming a table in `--add` that the synced set already holds is not always a no-op. Name at least one of the eight per-table flags with it, and `sync` updates that table's [`_config`](../reference/sql-pack.md#kizunasync_config) row to the columns those flags cover. It writes them in declaration order: `sync_mode`, `bucket_column`, `soft_delete_column`, `conflict_mode`, `conflict_journal`, `register_clients`, `tombstone_ttl_days`, and `min_schema_version`. It leaves both change-capture triggers and its [`_provisions`](../reference/sql-pack.md#kizunasync_provisions) rows untouched, because the table is already provisioned. It states the update once on stderr before the plan, as `<table> is already synced: updating the options this run named.` The plan lists that table with a `~` marker and the assignments it writes, for example `~ todos updated: sync_mode = 'pull-only', conflict_mode = 'hlc', register_clients = true`. Naming an already-synced table with no per-table flag stays a no-op, `<table> is already synced, nothing to add.`

A synced table whose primary key changed keeps the old key in `_config.key_columns`, and every device still holds its rows under that key. `sync --add <table>` records the new key only in a run that also raises `--min-schema-version` above the table's recorded version. Otherwise it refuses, exit `2`, naming the command to run, `kizunasync sync --add <table> --min-schema-version <n>`. The migration then updates `key_columns` and calls [`kizunasync._rekey_changelog('<table>')`](../reference/sql-pack.md#internal-helpers), which deletes the table's change history, tombstones, and bucket grants recorded under the old key and records every current row again under the new one. A client whose schema version is below the new minimum receives the `RESET_REQUIRED` [lifecycle signal](../reference/protocol.md#lifecycle-signals), so an app build that declares the new version resets and pulls the table again under the new key. The checkbox raises no version, so it refuses a synced table whose key moved and names the same command.

Moving a synced table to another bucket column this way, giving an unbucketed table one included, changes what its changelog is labeled by. The delta calls [`kizunasync._relabel_changelog`](../reference/sql-pack.md#internal-helpers) right after the `_config` update. The call relabels the table's changelog rows from the new column and drops every tombstone whose snapshot does not carry that column. Every device then has to bootstrap the table again, so `sync` refuses the move, exit `2` with the reason, unless the same run raises `--min-schema-version` above the table's current value.

Ten further flags are global rather than per table, and they rewrite the single [`_settings`](../reference/sql-pack.md#kizunasync_settings) row one column at a time. The push policy takes `--max-batch-size` / `--no-max-batch-size` and `--no-require-atomic`, and `--require-atomic` is refused. The retention knobs take `--reap-schedule`, `--compact-schedule`, `--client-prune-schedule`, `--client-ttl-days`, and `--hlc-max-skew-ms`, and `--max-pull-scan` sets how many candidates one pull page examines. A column whose flag you did not name keeps exactly the value the project already has, so tightening one guard never quietly relaxes another, and the `--no-*` flags are how a run says permissive on purpose. Each statement is emitted only when the merged value differs from the live row, so a run that restates the current settings writes no `_settings` SQL at all. `sync` never asks about these in a scripted run: only the flags decide, and the wizard's Customize path is where the same questions get asked interactively.

Several values are range-checked before anything is written, and a bad one exits `2` with the range named. `--max-batch-size`, `--client-ttl-days`, `--max-pull-scan`, and `--min-schema-version` accept `1` or more. `--tombstone-ttl-days` accepts `1` or more too, because a retention of zero reaps a tombstone before any client can pull it and the row comes back on the next sync. `--hlc-max-skew-ms` refuses a negative value. Each of `--reap-schedule`, `--compact-schedule`, and `--client-prune-schedule` must be a valid five-field UTC crontab, checked against the same grammar the pack's own constraint enforces, with a `crontab.guru` link in the refusal. Every one of these is answered before the connection is resolved, and [`kizunasync init`](#kizunasync-init) runs the same checks on the flags it shares.

`sync` emits one delta migration, `<timestamp>_kizunasync_sync.sql`, timestamped past every version already in `supabase/migrations/` the way `init` names its files. One `begin; ... commit;` transaction wraps it, so the table changes and the settings move together. Its header comment names all three outcomes it may carry. Those are provisioning the tables you added, updating the options of the ones already synced, and unwinding the ones you removed. Added tables go through the same provisioning SQL `kizunasync init` uses, a [`kizunasync._config`](../reference/sql-pack.md#kizunasync_config) upsert plus the two [change-capture triggers](./whats-installed.md#the-per-table-hooks). Name an already-synced table again in `--add` alongside a per-table flag, and the delta updates it instead. That update is one `update kizunasync._config set …` statement naming only the columns those flags cover. Removed tables unwind their triggers, config row, and ledger rows.

Removal does not delete the [`_changelog`](../reference/sql-pack.md#kizunasync_changelog) and [`_tombstones`](../reference/sql-pack.md#kizunasync_tombstones) rows the table already produced. Retention reaps those on its own schedule, and rewriting them here would rewrite history other clients may be reading. Every run says so. A declared schedule change opens the transaction with the same `pg_cron`-presence gate the config migration carries, unless `--allow-no-cron` accepts the gap, and ends it with `select kizunasync._schedule_jobs();`. Once the delta applies, a run that declared a schedule also checks for `pg_cron` the same way `init` does, and again refuses unless `--allow-no-cron` accepts the gap. The delta applies with [`supabase db push`](https://supabase.com/docs/reference/cli/supabase-db-push), `--local`, `--db-url`, or `--linked` for whichever connection the run resolved, unless you pass `--local-only`, so it lands in your migration history like any other file. Over `--project-ref` it runs directly, with no local file at all.

| Name | Type | Required | Description |
|---|---|---|---|
| `--add` | `<table>` | No | Add a table to the synced set. Repeatable. |
| `--remove` | `<table>` | No | Remove a table from the synced set. Repeatable. |
| `--sync` | `pull-only` or `read-write` | No | The sync mode every added table is provisioned with. Default: `pull-only`. |
| `--bucket-column` | `<column>` | No | The column every added table's rows are scoped by, applied as a runtime-parameterized bucket; a pull that omits it then fails with `KZL01`. Default: none, so every permitted row is pulled. |
| `--soft-delete` | `<column>` | No | The soft-delete column for every added table. Default: none, so hard deletes are allowed. |
| `--conflict` | `arrival` or `hlc` | No | The [conflict mode](../sync/conflict-resolution.md) for every added table. Default: `arrival`. |
| `--conflict-journal` | boolean | No | Record overwritten same-column values server-side for every added table. Default: off. |
| `--register-clients` | boolean | No | Record one client row per device that syncs an added table. Default: off. |
| `--no-register-clients` | boolean | No | Do not record client rows for an added table, declared explicitly. Default: off. |
| `--min-schema-version` | `<n>` | No | Lowest client schema version every added table accepts. Default: `1`. |
| `--tombstone-ttl-days` | `<days>` | No | How long every added table's [tombstones](../resources/glossary.md#tombstone) enforce delete-wins. Default: the retention the project's own rows already carry. |
| `--max-batch-size` | `<n>` | No | Set the global push policy's batch limit in [`_settings`](../reference/sql-pack.md#kizunasync_settings). At least `1`. Default: the column is left as the project has it. |
| `--no-max-batch-size` | boolean | No | Accept a push of any size. Mutually exclusive with `--max-batch-size`. Default: the column is left as the project has it. |
| `--require-atomic` | boolean | No | Not supported in this release. Exits `2`. Use `--no-require-atomic` to turn the column off if a previous run set it. Default: the column is left as the project has it. |
| `--no-require-atomic` | boolean | No | Accept a non-atomic push. Mutually exclusive with `--require-atomic`. Default: the column is left as the project has it. |
| `--reap-schedule` | `<cron>` | No | UTC crontab for the tombstone reaper. Default: the column is left as the project has it. |
| `--compact-schedule` | `<cron>` | No | UTC crontab for the changelog compactor. Default: the column is left as the project has it. |
| `--client-prune-schedule` | `<cron>` | No | UTC crontab for the client pruner. Default: the column is left as the project has it. |
| `--client-ttl-days` | `<days>` | No | Days of silence after which a client row is pruned. At least `1`. Default: the column is left as the project has it. |
| `--hlc-max-skew-ms` | `<ms>` | No | Forward-drift tolerance for an origin HLC, in milliseconds. Default: the column is left as the project has it. |
| `--max-pull-scan` | `<n>` | No | How many candidates one pull page examines at most, written into [`_settings`](../reference/sql-pack.md#kizunasync_settings). At least `1`. Default: the column is left as the project has it. |
| `--allow-no-cron` | boolean | No | Write a declared schedule even when `pg_cron` is absent to run it, instead of refusing. Also drops the `pg_cron` gate from the generated migration. |
| `--allow-no-rls` | boolean | No | Add a table whose row level security is disabled from the terminal checkbox, instead of refusing, and name it in a warning. A run that adds with `--add` checks no row level security. |
| `--schema` | `<name>` | No | Schema the synced tables live in. Only `public` is accepted; anything else exits `2`. Default: `public`. |
| `--project-ref` | `<ref>` | No | Configure the hosted project over the Management API instead of a direct connection; applies the delta directly and writes no local migration. Mutually exclusive with `--db-url` and `--local-only`; passing either exits `2` before anything is read. |
| `--access-token` | `<token>` | No | Personal Access Token for `--project-ref`, never a service-role key. Default: `SUPABASE_ACCESS_TOKEN`. |
| `--dry-run` | boolean | No | Print the plan and the delta SQL, and change nothing. |
| `--yes` | boolean | No | Accept the plan and write without a terminal confirmation. Required on the scripted path. |
| `--local-only` | boolean | No | Write the migration but skip `supabase db push`. |
| `--db-url` | `<url>` | No | Use this connection to read `kizunasync._config` and to drive the interactive picker. Default: the ladder in [Database connection](#database-connection). |

Naming the same table in both `--add` and `--remove`, passing an invalid Postgres identifier to either, or giving a range-checked flag a value out of range, is refused before anything is written and exits `2`. Without `--add` or `--remove` and off a TTY, `sync` refuses and names the usage, exit `2`, unless the run declares a setting with no table change, which is a valid settings-only run. Without `--yes` and off a TTY, it refuses to write, exit `2`, while a real terminal asks a one-time confirmation instead.

Exit codes: `0` on success, on a cancelled run, or when neither the table set nor the settings change; `1` when `supabase db push` fails after the migration is already written, which you fix and push yourself; `2` for every refusal above, for a database that cannot be resolved or read, and for a pack that differs from this binary's under `--yes` or off a terminal. `--dry-run` and `--local-only` write nothing to the database, so they skip that comparison.

```bash
kizunasync sync --add projects --dry-run       # preview adding one table
kizunasync sync --add projects --sync read-write --bucket-column workspace_id --yes
kizunasync sync --max-batch-size 100 --yes   # policy only, no table change
kizunasync sync --no-max-batch-size --yes                     # back to unlimited, atomicity untouched
kizunasync sync --reap-schedule '0 4 * * *' --yes              # retention schedule only
kizunasync sync --add projects --remove todos --yes
kizunasync sync --project-ref abcdefghijklmnopqrst --add projects --yes
kizunasync sync                                # terminal: interactive checkbox
```

## `kizunasync status`

Reports what a project has provisioned. Where [`doctor`](#kizunasync-doctor) answers whether your local setup is sane, `status` answers what is out there. It writes nothing: no DDL, no ledger row, no file, and it never prompts.

The report has nine sections, and every key is present in `--json` even when a section needs a provisioned database and there is none.

`pack` distinguishes four states: not provisioned, up to date, pending files, and drift. `tables` lists one row per [`_config`](../reference/sql-pack.md#kizunasync_config) row, each in state `synced`. That table is the declaration rather than a second opinion about it. A table row also carries its live columns, its `key`, the recorded key columns in key order (a JSON array under `--json`, `key (owner_id, slug)` in text), and its [`syncMode`, `bucketColumn`, `conflictMode`, `conflictJournal`, and `softDeleteColumn`](./configuration.md). It carries its effective tombstone retention, its schema and client-registration metadata, and its creation time as well. Effective retention is the table's own value. When that column is null, it is the project default, reported with `tombstoneTtlInherited: true`.

`clients` summarizes the devices and users in [`_clients`](../reference/sql-pack.md#kizunasync_clients), plus how many are stale beyond `client_ttl_days`. It carries `perClient`, the newest 50 devices by `last_seen`, with six keys each: `clientId`, `userId`, `lastSeen`, `lastMutationId`, `cursorHighWater`, and `stale`. `lastMutationId` is `null` for a device that has only ever pulled. `cursorHighWater` is the high-water half of the opaque [cursor](../resources/glossary.md#cursor) that [`compact_changelog()`](../reference/sql-pack.md#kizunasynccompact_changelog) floors on.

`settings` reports all nine [`_settings`](../reference/sql-pack.md#kizunasync_settings) columns: the [push policy](./configuration.md), the three retention schedules, `clientTtlDays`, `hlcMaxSkewMs`, the project's own `tombstoneTtlDays`, and the pull scan cap `maxPullScan`. `jobs` is the same payload as [`kizunasync jobs list`](#kizunasync-jobs): whether `pg_cron` is present, and each of the three jobs with its schedule, drift against `_settings`, last run, and last status. `retention` reports tombstone and changelog row counts per table, and the reap watermark. `journal` reports the [`_conflict_journal`](../reference/sql-pack.md#kizunasync_conflict_journal) row count. `attachments` reports row counts by whether a row carries a `sha256`, broken down by bucket. `api schemas` reads exposure from the local [`supabase/config.toml`](https://supabase.com/docs/guides/local-development/cli/config#api.schemas), which reflects that file rather than the hosted project's current PostgREST configuration.

`status` answers without needing the shipped pack directory on disk: when it cannot resolve one, the `pack` section is built from the ledger alone and reports `provisioned (N pack file(s) recorded, no pack on disk to compare)` instead of failing the whole command. With the pack on disk, `provisioned (no pack-file row: not installed by kizunasync init)` is verified against the five core RPCs the client calls, [`pull`](../reference/sql-pack.md#kizunasyncpull), [`push`](../reference/sql-pack.md#kizunasyncpush), `attachment_confirm`, `attachment_metadata`, and `attachment_vacuum`, before it is reported; any one missing is reported as `drift (missing core RPCs: <names>)` instead of a false "provisioned". [`kizunasync upgrade`](#kizunasync-upgrade) refuses this state outright rather than reconciling it, because no per-file row exists to hash-compare against. `upgrade available (N pending pack file(s))` is the case where the only offenders are files the ledger has not recorded. A bare `drift` names the real offenders, a missing file or one whose recorded hash differs. `pack.fileCount` is how many files the shipped pack contains, or `0` in the ledger-only state.

On a TTY the same nine sections render as a Clack-style vermilion report with an intro, boxed notes, and an outro. Piped and CI runs stay compact labelled lines on stderr. `--json` and `--format json` print one JSON object on stdout with stable keys and no chrome, so a script reads the same report a human does. `--format text` forces the compact stderr view even on a TTY. `-q` prints only the pack state on stdout, in the style of the docker CLI.

`clients.perClient` on `--json`, one object per device:

```json
{"clientId":"c09ff09e-d4a3-4bdd-becc-26ff6df0457d","userId":"7cfbb6ab-44a8-4323-b658-610982319c83","lastSeen":"2026-09-11 12:42:52.237191+00","lastMutationId":"33e169d3-291a-44e3-bf98-7920632632c8","cursorHighWater":6525,"stale":false}
```

`settings` on `--json`, all nine keys always present:

```json
{"maxBatchSize":null,"requireAtomic":false,"reapSchedule":"16 3 * * *","compactSchedule":"47 3 * * *","clientPruneSchedule":"31 3 * * *","clientTtlDays":90,"hlcMaxSkewMs":5000,"tombstoneTtlDays":30,"maxPullScan":5000}
```

`--format text` prints one line per device under the `clients:` label, indented four spaces: `mutation none` replaces the mutation id for a device that has only ever pulled, `cursor unread` replaces an unreadable cursor, and a stale device closes its line with `stale`.

```
    c09ff09e-d4a3-4bdd-becc-26ff6df0457d  user 7cfbb6ab-44a8-4323-b658-610982319c83  last seen 2026-09-11 12:42:52.237191+00  cursor 6525  mutation 33e169d3-291a-44e3-bf98-7920632632c8
```

Seven lines follow under the `settings:` label, whose own summary line is unchanged (`max batch unlimited, require atomic false`):

```
    reap schedule           16 3 * * *
    compact schedule        47 3 * * *
    client prune schedule   31 3 * * *
    client ttl              90 day(s)
    hlc max skew            5000 ms
    tombstone ttl           30 day(s)
    max pull scan           5000 candidate(s)
```

A table whose retention comes from the project default states that in its meta line, `ttl 30d (project default)`; one with its own value stays `ttl 7d`.

Two transports are available, the same shape as [`kizunasync init`](#remote-provisioning---project-ref)'s remote path. `--project-ref` reads over the [Management API](https://supabase.com/docs/reference/api/introduction#authentication) with a Personal Access Token from `--access-token` or `SUPABASE_ACCESS_TOKEN`, never a service-role key. Everything else resolves a direct [database connection](#database-connection). `--project-ref` and `--db-url` are mutually exclusive and exit `2` when both are given.

| Name | Type | Required | Description |
|---|---|---|---|
| `--json` | boolean | No | Print one JSON object on stdout instead of the human report, the same payload as `--format json`. Cannot be combined with `--format text` or `--quiet`. |
| `--format` | `json` or `text` | No | `json` is the same payload as `--json`; `text` is compact labelled stderr even on a TTY. Cannot be combined with `--quiet`, and `text` cannot be combined with `--json`. |
| `-q`, `--quiet` | boolean | No | Print only the pack state on stdout, one line and no chrome. |
| `--project-ref` | `<ref>` | No | Read the report over the Management API instead of a direct connection. Mutually exclusive with `--db-url`. |
| `--access-token` | `<token>` | No | Personal Access Token for `--project-ref`, never a service-role key. Default: `SUPABASE_ACCESS_TOKEN`. |
| `--db-url` | `<url>` | No | Use this connection. Default: the ladder in [Database connection](#database-connection). |

Exit codes: `0` on every successful read, including a "not provisioned" report, because `status` describes state and does not gate CI on it the way `doctor` does; `2` when both transports are given, when flags contradict, when no token or connection resolves, or when the project could not be read.

```bash
kizunasync status                        # TTY: Clack report; else compact text on stderr
kizunasync status --json                 # one JSON object on stdout
kizunasync status --format json          # same payload as --json
kizunasync status --format text          # compact labelled stderr, even on a TTY
kizunasync status -q                     # pack state only, one line on stdout
kizunasync status --json | jq '.tables[] | {table, state, columns}'
kizunasync status --project-ref abcdefghijklmnopqrst
```

## `kizunasync doctor`

Verifies the project at the resolved [project root](#project-root) and prints a pass, warn, or fail line per check, exiting non-zero only when an error-level check fails. Checks run in three groups, in report order: the config record first, then fifteen checks that read what the pack installed, then five that read the filesystem, plus the optional live Data API probe last.

| Check | Level when it fails | What it looks for |
|---|---|---|
| `config-tables` | error | [`kizunasync._config`](./configuration.md) readable over the resolved connection, and how many synced tables it declares. An unreachable database and an uninstalled pack both fail here, and the hint names `kizunasync init`. |
| `pg-cron` | error | The `pg_cron` extension is installed, which is what schedules the three retention jobs. |
| `jobs` | error, or warn when `pg_cron` is absent | The three jobs exist, are active, and run on the schedules `_settings` declares. Drops to warn when the only cause is a missing `pg_cron`, since `pg-cron` already reports that. |
| `job-runs` | error on a failed run, warn on a job that has never run | The latest run of each job from `cron.job_run_details`. Every freshly installed project warns here until the first scheduled run. |
| `core-rpcs` | error | The five public RPCs (`pull`, `push`, `attachment_confirm`, `attachment_metadata`, `attachment_vacuum`) exist with the pack's own identity arguments. |
| `triggers` | error | Both change-capture triggers exist on every synced table. |
| `table-primary-key` | error | Every synced table has a primary key the pack can key its rows by: each key column is `uuid`, `text`, `character varying`, `smallint`, `integer`, or `bigint`, and a read-write table's key is not `generated always as identity`. The hint names each failing table with the reason, and names a reviewed migration that changes the key or `kizunasync sync --remove <table> --yes`. |
| `sync-key` | error | Every synced table's [`_config.key_columns`](../reference/sql-pack.md#kizunasync_config) is its current primary key, the key every change is recorded under. The hint names each table with the key `_config` records and the key it has now. [`kizunasync sync`](#kizunasync-sync) records the current key only in a run that also raises `--min-schema-version`, so every device bootstraps the table again. |
| `rls-enabled` | error | Row level security is enabled on every synced table. A pull reads every row under the caller's policies, so a synced table without row level security hands every row to any signed-in user. The hint names each table and the `alter table public.<table> enable row level security;` statement. |
| `trigger-search-path` | error | Every trigger function on a synced table pins its `search_path`. A push applies its writes through the pack's definer helpers, which run with an empty `search_path`, so an unqualified name in a function that pins none fails the push that fires it. The hint names each trigger with its function, and the `alter function <function> set search_path = '';` statement. |
| `change-stamp` | error | Every change is numbered at commit, so the largest visible sequence number is a safe [pull](../reference/sql-pack.md#kizunasyncpull) cursor. The check passes when four things hold: the statement trigger `kizunasync_arm_stamp` on `kizunasync._change_pending` exists and is enabled; the [`kizunasync._stamp_marker`](../reference/sql-pack.md#kizunasync_stamp_marker) table exists, and its deferred constraint trigger `kizunasync_stamp_transaction` exists and is deferrable, initially deferred, and enabled; `kizunasync._change_seq` has a cache size of 1; and no queued change sits committed in `_change_pending`, where no pull would deliver it. [The stamp trigger is missing, disabled, or not deferred](../operations/troubleshooting.md#the-stamp-trigger-is-missing-disabled-or-not-deferred) and [changes queued without a sequence number](../operations/troubleshooting.md#changes-queued-without-a-sequence-number) cover the two repairs. |
| `realtime-policy` | error | The `kizunasync wakeup receive` policy on `realtime.messages`. |
| `role-and-grants` | error | The `kizunasync_rls` role, schema `usage` for both client roles, and the execute grants in both directions: the five public RPCs to `authenticated`, the five maintenance functions (`reap_tombstones`, `compact_changelog`, `prune_clients`, `_schedule_jobs`, `jobs_status`) to `service_role`, and `select` on `kizunasync.attachments` to `service_role`, which the sync inspector's Attachments and Jobs panels need. |
| `column-privileges` | error when a key column or a table's bucket column is unreadable, otherwise warn | [Column-level privileges](../reference/sql-pack.md#column-level-privileges): every synced column `authenticated` cannot `SELECT`, and, on a `read-write` table, every column it cannot `UPDATE`. A key column or a bucket column unreadable fails every pull of that table with `KZL02`, so the hint names it and the check errors; any other hidden or unwritable column is a warning, a deliberate, hand-applied restriction `kizunasync upgrade` cannot fix. |
| `require-atomic` | error | [`kizunasync._settings.require_atomic`](../reference/sql-pack.md#kizunasync_settings) is off. The current client sends ordinary writes as non-atomic, and `KZP03` would dead-letter them if the column were on. Turn it off with `kizunasync sync --no-require-atomic --yes`. |
| `ledger` | error | Every [`_provisions`](../reference/sql-pack.md#kizunasync_provisions) row's object exists, every pack object the pack or a config migration created has a ledger row, and the ledger's `pack-file` rows record the pack this CLI ships. |
| `supabase-dir` | error | A `supabase/` project directory holding `config.toml`. |
| `migrations-dir` | error | A `supabase/migrations` directory. |
| `package-json` | error | A `package.json` at that root. A failure usually means the wrong root resolved, so point `--workdir` at your app. |
| `api-schemas` | error | `kizunasync` listed in that `config.toml`'s `[api].schemas`. |
| `engine-artifact` | error | The Rust engine of the app client, read from the `dependencies` of the `package.json` at the resolved root. With no `kizunasync` in `dependencies` the check passes with "no JavaScript app client in package.json" and the hint "add kizunasync to package.json". With `kizunasync` listed but `node_modules/kizunasync/package.json` missing, it fails and the hint says to install `kizunasync` with your package manager. A React Native or Expo app (`expo` or `react-native` in `dependencies`) passes when the installed `kizunasync` ships `RnUniffi.podspec`, because a development build compiles the engine into the app. A web app (`react-dom`, `vue`, or `vite` in `dependencies` or `devDependencies`) passes when the installed `kizunasync` ships `dist/web/wasm/kizunasync_wasm_bg.wasm`, the WebAssembly engine that runs in its worker. Any other app runs on [Node](https://grokipedia.com/page/Node.js) or [Bun](https://bun.sh) and passes when the N-API library of the `@kizunasync/<platform>` package resolves from the real directory of the installed `kizunasync`, through its own `node_modules` and then each ancestor `node_modules`. Its absence is what makes the first engine call of the app client [`createKizunaSync`](../reference/javascript/initializing.md) returns fail with `ENGINE_UNAVAILABLE`, and the hint says to reinstall `kizunasync` without `--no-optional` or `--omit=optional` so its platform package installs. A host with no platform package fails with "no @kizunasync platform package is published for <os>-<arch>". |
| `api-schemas-live` | error | The running project answering `GET <url>/rest/v1/` with `apikey: <key>` and `Accept-Profile: kizunasync`. Runs only when both a URL and a key are available. |

A failing `core-rpcs`, `realtime-policy`, `role-and-grants`, `ledger`, or `change-stamp` check names its remedy: [`kizunasync upgrade --reapply --yes`](#kizunasync-upgrade) re-applies the pack files the ledger already records.

A `role-and-grants` failure names the exact grant missing, for example `service_role cannot execute: jobs_status` or `service_role cannot select kizunasync.attachments`, so a project that has not run [`kizunasync upgrade`](#kizunasync-upgrade) since a grant landed says so directly rather than failing an unrelated check.

The `api-schemas` check is the one that catches a project where the [SQL pack](../reference/sql-pack.md) installed but the client cannot reach it. PostgREST serves only the schemas listed in [`[api].schemas`](https://supabase.com/docs/guides/api/using-custom-schemas#exposing-custom-schemas), so an unlisted `kizunasync` answers every RPC with `PGRST106`.

Its fix hint names the edit and [`supabase config push`](https://supabase.com/docs/reference/cli/supabase-config-push), or Settings, API, Exposed schemas for a project configured only in the Dashboard. When `supabase/config.toml` is missing entirely, the hint says to run [`supabase init`](https://supabase.com/docs/reference/cli/supabase-init) first.

The `ledger` check reads in both directions. A ledgered function, trigger, policy, role, cron job, or `_config` row absent from the database fails forward. A `kizunasync` function, one of the three cron jobs, a `kizunasync%` role, or a `_config` row with no matching ledger entry fails in reverse. Policies inside the `kizunasync` schema stay outside the reverse direction on purpose. `kizunasync deprovision --purge` removes them with the schema rather than one by one.

The `ledger` check also compares the ledger's `pack-file` rows with the pack this CLI ships, which is the comparison `init`, `sync`, and the control panel make before they write. A changed hash, or a pack file the ledger has no row for, fails the check. The hint lists each differing file with the ledger's hash and the pack's, and names `kizunasync upgrade --reapply --yes`. When a newer `kizunasync` recorded the pack, the hint names the update this CLI needs instead.

`api-schemas-live` runs only when both a project URL and a [publishable key](https://supabase.com/docs/guides/getting-started/api-keys#publishable-keys-and-public-components) resolve. That is the key class Supabase intends for public clients, and the probe needs nothing stronger. Each half is looked up on its own: first its flag (`--url`, `--publishable-key`), then the process environment, then your `.env` files. The environment and the files are read under the names apps already use, with no prefix and then with the `NEXT_PUBLIC_`, `VITE_`, `EXPO_PUBLIC_`, and `PUBLIC_` prefixes: `SUPABASE_URL` for the URL, and `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_PUBLISHABLE_DEFAULT_KEY`, and `SUPABASE_ANON_KEY` for the key. The unprefixed `SUPABASE_PUBLISHABLE_KEYS` is read as a JSON object of named keys, after the unprefixed publishable names and before the unprefixed anon key. When a half is still missing and the project ref is known (`--project-ref`, `SUPABASE_PROJECT_ID`, or the `supabase/.temp/project-ref` file `supabase link` writes) and a Personal Access Token resolves from `--access-token`, `SUPABASE_ACCESS_TOKEN`, your `.env` files, or the Supabase CLI's `access-token` file, the URL becomes `https://<ref>.supabase.co` and the key comes from the Management API's project API keys endpoint: the first publishable key, else the legacy `anon` key, and never a secret key. `doctor` never reads the OS credential store. The check's line names where the URL and the key came from, never the key itself. With either missing, `doctor` makes no Data API call and the check is not reported, so a purely local run stays offline and deterministic. A `2xx` passes. A `406` or `PGRST106` fails with the same fix hint as `api-schemas`. An unreachable host fails as a transport error and is never reported as "not exposed". The key travels in the request header and is never printed.

`--ci` emits one machine-readable JSON line per check, shaped `{ "check", "level": "ok" | "warn" | "error", "message" }`, and exits non-zero when any check is error-level, so CI can gate on it without a warning failing the build. `api-schemas-live` appears as one more line when it runs.

| Name | Type | Required | Description |
|---|---|---|---|
| `--ci` | boolean | No | Emit one JSONL object per check and exit non-zero on any error. |
| `--url` | `<url>` | No | Project URL for the live Data API probe. Default: `SUPABASE_URL` under each prefix, then the `.env` files, then the linked project. |
| `--publishable-key` | `<key>` | No | Publishable key for the live probe, never a secret or service-role key. Alias: `--anon-key`. Default: the key names above under each prefix, then the `.env` files, then the linked project through the Management API. |
| `--db-url` | `<url>` | No | Use this connection for the `config-tables` check. Default: the ladder in [Database connection](#database-connection). |
| `--project-ref` | `<ref>` | No | Read `kizunasync._config` over the Management API instead of a direct connection. Mutually exclusive with `--db-url`. |
| `--access-token` | `<token>` | No | Personal Access Token for `--project-ref` and the live probe's linked-project lookup, never a service-role key. Default: `SUPABASE_ACCESS_TOKEN`. |

Exit codes: `0` when every check is `ok` or `warn`; `1` when any check is `error`, an unreachable database included.

Broader live-database checks, such as policy and config agreement, are not part of `doctor`. [`kizunasync status`](#kizunasync-status) reports the installed pack's full state, and a failing check that is not about project shape usually belongs in [Troubleshooting](../operations/troubleshooting.md).

```bash
kizunasync doctor            # human-readable pass/fail
kizunasync doctor --ci       # JSONL for CI gating
kizunasync doctor --url https://<ref>.supabase.co --publishable-key <publishable-key>   # + the live exposure probe
```

## `kizunasync lint`

Classifies the `.sql` files in `supabase/migrations/` as additive or breaking against the sync contract, using the synced-table set from [`kizunasync._config`](./configuration.md). Only statements touching a synced table are classified. Supabase's own [migration tracking](https://supabase.com/docs/guides/deployment/database-migrations#how-migration-tracking-works) records which files ran; Kizuna adds the judgment of whether a file is safe for clients that are already offline with the old shape. Run it in CI, where the [GitHub Action](../operations/ci-cd.md#documentation-gates) wraps it.

| Rule | Severity | What it matches |
|---|---|---|
| `drop-table` | Breaking | `DROP TABLE` on a synced table. |
| `drop-column` | Breaking | `DROP COLUMN` on a synced table. |
| `rename` | Breaking | A column or table rename on a synced table. |
| `type-change` | Breaking | `ALTER COLUMN … TYPE` on a synced table. |
| `set-not-null` | Breaking | `ALTER COLUMN … SET NOT NULL` on a synced table, which rejects a push of a row written offline without it. |
| `drop-default` | Breaking | `ALTER COLUMN … DROP DEFAULT` on a synced table: a client that omits the column stops getting the server's value. |
| `add-constraint` | Breaking | `ADD CONSTRAINT`, `ADD PRIMARY KEY`, `ADD FOREIGN KEY`, `ADD UNIQUE`, `ADD CHECK`, or `ADD EXCLUDE` on a synced table, which rejects a push of a row written offline under the old rule. |
| `add-column-not-null-no-default` | Breaking | `ADD COLUMN … NOT NULL` with no `DEFAULT`, which rejects pre-existing offline rows. |
| `add-column` | Additive | `ADD COLUMN` that is nullable or carries a `DEFAULT`. |
| `drop-constraint` | Additive | `DROP CONSTRAINT` on a synced table, which only widens what a push may write. |

A breaking change requires a schema-version bump, so that stale clients soft-block instead of writing against a shape their schema version does not match. The failing line names both knobs to bump:

```
<N> breaking change(s): bump the schema version before shipping: `kizunasync sync --min-schema-version N` on the server and `schemaVersion` in `defineConfig` on the clients (stale clients then soft-block).
```

[Consistency model](../sync/consistency-model.md) covers what that block protects.

| Name | Type | Required | Description |
|---|---|---|---|
| `--db-url` | `<url>` | No | Use this connection to read the synced set. Default: the ladder in [Database connection](#database-connection). |
| `--project-ref` | `<ref>` | No | Read the synced set over the Management API instead of a direct connection. Mutually exclusive with `--db-url`. |
| `--access-token` | `<token>` | No | Personal Access Token for `--project-ref`, never a service-role key. Default: `SUPABASE_ACCESS_TOKEN`. |

This is a deliberately blunt regex scan, biased to flagging. It can produce a false positive, for example on `drop` inside text the comment stripping did not eliminate. It does not read the live schema, so nullability is inferred from the DDL text, and it does not track which migrations have already been applied. `kizunasync upgrade` reuses the same classifier for pack files absent from the file ledger.

`kizunasync lint` checks the migrations directory first, and offline, so a run from the wrong directory hears about that before it asks for a connection. A project whose `_config` declares nothing exits `0` cleanly, with one line saying there is nothing to lint.

Exit codes: `0` when everything is additive, nothing touches a synced table, or nothing is synced; `1` when at least one change is breaking; `2` when there is no migrations directory, or the synced set could not be read.

```bash
kizunasync lint              # check all migrations in supabase/migrations/
kizunasync lint --db-url postgresql://postgres:postgres@127.0.0.1:54322/postgres
```

Kizuna never runs [`supabase db diff`](https://supabase.com/docs/reference/cli/supabase-db-diff): the pack is hand-written SQL applied through `supabase db push`, `kizunasync sync` computes its delta from `_config`, and [`kizunasync upgrade`](#kizunasync-upgrade) reconciles against the `_provisions` ledger. If you author your own migrations from branch diffs, diff the application schema only (`supabase db diff -s public`). A diff-generated copy of the `kizunasync` schema recreates its objects with no matching `_provisions` rows, and [`kizunasync doctor`](#kizunasync-doctor) then fails its `ledger` check. Supabase's pg-delta preview keeps Row Level Security policies in generated migrations, which matters here because `kizunasync init` proposes synced tables from `pg_policies`.

## `kizunasync upgrade`

Reconciles an already-provisioned project's [`_provisions`](../reference/sql-pack.md#kizunasync_provisions) ledger with the pack you have installed, the lifecycle step between [`kizunasync init`](#kizunasync-init) and [`kizunasync deprovision`](#kizunasync-deprovision). It never installs from scratch: against a ledger with nothing provisioned it refuses and points at `kizunasync init`, exit `2`. [Upgrade](./upgrading.md) walks the same reconciliation as a task.

Against an already-provisioned project it reconciles three ledger states. `upgrade` refuses a `provisioned-unversioned` project outright, one whose ledger records objects but carries no `pack-file` row. `kizunasync init` writes a `pack-file` row on every install it makes. A ledger without one came from some other path, so there is no hash to reconcile against. The pending path is drift where every offending file is merely not recorded, meaning pack files newer than the ones the ledger records. There `upgrade` classifies each pending file's SQL with the same additive and breaking rules [`kizunasync lint`](#kizunasync-lint) uses. It classifies them against the synced-table set read live from [`kizunasync._config`](../reference/sql-pack.md#kizunasync_config). Any breaking statement refuses the whole batch with exit `1`, and an all-additive batch applies. On drift with a genuine offender, a hash mismatch, `upgrade` lists the offending files, the ledger's hash and the pack's, and refuses outright (exit `1`) unless you add `--reapply`. A ledger already matching the pack reports up to date and changes nothing. `--reapply` changes two of these states. Against a genuine drift it re-applies every pack file, in one transaction, each one followed by the upsert that records the file's hash, so the ledger matches the pack; a failure rolls the whole batch back and leaves the ledger unchanged. Against an up-to-date ledger it instead runs every pack file the ledger already records again, inside one transaction that writes no ledger row, to restore pack objects someone dropped or altered.

An apply sends one script: a header comment, `begin;`, then per pending file a `-- <name>` comment, the file's SQL, and its `_provisions` insert, then `commit;`. The whole batch runs inside that one transaction, so a failure anywhere in it rolls every earlier statement back too, and the ledger carries no row for any of it: "the batch ran inside one transaction, so nothing was applied and no ledger row was written." Once the transaction commits, `upgrade` calls [`kizunasync._schedule_jobs()`](../reference/sql-pack.md#kizunasync_schedule_jobs) and prints the schedules it applied, so a pack upgrade that changed a retention default reaches `pg_cron` at once without overwriting a customized schedule. A schedule that fails to apply ends the run on exit `1`, naming `kizunasync jobs schedule` as the fix, unless `--allow-no-cron` accepts running retention by hand; either way the pack itself is already applied.

A `--reapply` run against a genuine drift sends a script shaped the same way, one `begin;` … `commit;` transaction, but each `-- <name>` block is followed by the upsert that replaces that file's ledger hash rather than the plain insert a pending file gets, so a re-run keeps recording the pack's current hash. A `--reapply` run against an up-to-date ledger sends every pack file the same way with no ledger statement at all, since the ledger already carries the right hash. Either shape resets the `kizunasync` schema's grants for `public`, `anon`, and `authenticated` to the pack's own and recreates the pack's policies and its two change-stamp triggers, `kizunasync_arm_stamp` and `kizunasync_stamp_transaction`, undoing a hand-applied grant or policy change; synced tables, their data, and `kizunasync._settings` stay exactly as they are. It re-applies the job schedules the same way once it commits.

The pack creates its tables with `create table if not exists`, so a re-apply leaves a `kizunasync` table that an earlier build of the pack created as it is, without the columns that build did not create. The first statement that names a missing column or table fails with `42703` or `42P01`, the transaction rolls back, and the ledger keeps its hash. The run exits `1` and, after the rollback line, names the way out: remove Kizuna with `kizunasync deprovision --purge`, which leaves your application tables and their data in place, then install it again with `kizunasync init`. Both commands carry the connection the run was given, its password left to `PGPASSWORD`. Over `--project-ref` the step says the Management API path cannot run `deprovision` and names both commands with `--db-url <the project's connection string>`, the password again in `PGPASSWORD`. The re-apply that `init`, `sync`, and the control panel offer prints the same step when it fails this way.

Two transports are available, the same shape as [`kizunasync status`](#kizunasync-status). `--project-ref` drives the [Management API](https://supabase.com/docs/reference/api/v1-run-a-query), and everything else resolves a direct [database connection](#database-connection). The two are mutually exclusive and exit `2` when both are given.

| Name | Type | Required | Description |
|---|---|---|---|
| `--dry-run` | boolean | No | Print the pending files, their findings, and the exact transaction script an apply would send, and change nothing. |
| `--yes` | boolean | No | Apply without asking; `upgrade` never prompts on a TTY either. Required to apply pending pack files; a provisioned-unversioned ledger is refused regardless of this flag. |
| `--reapply` | boolean | No | Re-apply every pack file. Against an up-to-date ledger it restores pack objects someone dropped or altered and writes no ledger row; against a genuine drift it records each file's hash instead. Either way it needs `--yes` to apply or `--dry-run` to print its script, and leaves `_settings`, `_config`, and every changelog, tombstone, verdict, client, and journal row as it found them. |
| `--allow-no-cron` | boolean | No | Finish on exit `0` when the job schedules cannot be applied after the upgrade, instead of exit `1`, and run retention yourself. Read only once the pack itself has already applied. |
| `--project-ref` | `<ref>` | No | Apply over the Management API instead of a direct connection. Mutually exclusive with `--db-url`. |
| `--access-token` | `<token>` | No | Personal Access Token for `--project-ref`. Default: `SUPABASE_ACCESS_TOKEN`. |
| `--db-url` | `<url>` | No | Use this connection. Default: the ladder in [Database connection](#database-connection). |

Exit codes: `0` when up to date or applied, including under `--dry-run`, and when `--allow-no-cron` accepted a schedule that failed to apply; `1` when refused because a pending file is breaking, the ledger genuinely drifted, the ledger is provisioned but carries no per-file row to reconcile against, the transaction fails and rolls back, or the pack applied but its job schedules did not and `--allow-no-cron` was not given; `2` when nothing is provisioned, both transports were given, no connection or token resolved, or an apply lacked `--yes`.

```bash
kizunasync upgrade --dry-run                # preview: pending files, findings, and the transaction script
kizunasync upgrade --yes                    # apply pending pack files in one transaction (a pre-ledger install is refused)
kizunasync upgrade --project-ref abcdefghijklmnopqrst --yes
```

## `kizunasync deprovision`

Reads [`kizunasync._provisions`](../reference/sql-pack.md#kizunasync_provisions) and generates a reverse-dependency plan for every ledger row this CLI understands. The current base pack ledgers its functions, [Realtime](https://supabase.com/docs/guides/realtime/authorization#broadcast-and-presence-read) policies, [`pg_cron`](https://supabase.com/docs/guides/cron#how-does-cron-work) jobs, and owner role. Per-table migrations ledger their triggers and [`_config`](../reference/sql-pack.md#kizunasync_config) rows. By default the base schema, bookkeeping tables, indexes, and sequence are deliberately not ledgered, so they remain after a plain `kizunasync deprovision`, which [What Kizuna installs](./whats-installed.md#the-provision-ledger) spells out object by object. `--purge` is how you remove those too. Application tables and their data are never dropped, purge included. A role row is dropped only when its name starts with `kizunasync`; any other name is reported as a row the command cannot drop rather than dropped anyway. Applying requires `--yes` or `KSYNC_ALLOW_DEPROVISION=1` on every terminal, and there is no interactive prompt. The ledger read uses a direct [database connection](#database-connection). In a project with a `supabase/config.toml`, the teardown is then written to `supabase/migrations/` as `<timestamp>_kizunasync_deprovision.sql`, named past every version the directory and the migration history hold, and applied with [`supabase db push`](https://supabase.com/docs/reference/cli/supabase-db-push) the way `init` applies its own migrations. The migration history records it, and replaying the directory onto a fresh database reproduces the state. Each statement in that file first checks that the table or schema it needs exists, so the file applies over whatever the files before it left. Without a `supabase/config.toml`, the teardown runs as one transaction over the connection. [Remove](./removing.md) walks it as a task.

Because the drops cascade, `deprovision` reads `pg_depend` before it plans anything, looking for an object outside the `kizunasync` schema and outside the ledger that depends on a pack object, such as a view over a pack table or a column default that calls a pack function. Finding one refuses the whole run, exit `2`, listing every dependent it found and applying nothing; a `pg_depend` read that itself fails refuses the same way. An object the pack ledgers on your own tables, the change-capture triggers and their policies, is not a dependent for this check: it is exactly what a plain teardown already removes.

The pack's `kizunasync_rls` role belongs to the Postgres server, not to one database. After the ledgered drops, `deprovision` runs `drop owned by` for the role in this database, then tries `drop role` in a savepoint of its own. When another database on the same server still owns objects through the role, Postgres refuses that drop with `2BP01`. The role then stays, the rest of the teardown commits, the command exits `0`, and one line says the role was kept because other databases of this server still use it. To drop it later, run `drop owned by kizunasync_rls;` in each database that still uses it, then `drop role kizunasync_rls;`. On a server where no other database uses the role, the teardown drops it with everything else.

| Name | Type | Required | Description |
|---|---|---|---|
| `--dry-run` | boolean | No | Print the plan and change nothing. |
| `--yes` | boolean | No | Authorize the destructive apply. `KSYNC_ALLOW_DEPROVISION=1` is the alternative. On its own it does not authorize `--purge`. |
| `--purge` | boolean | No | Also drop the `kizunasync` schema itself: every table, sequence, index, policy, and grant, behind `--confirm`. |
| `--confirm` | `<target>` | With `--purge` | Type the project ref, or `local`, to confirm the purge. `--yes` alone is not enough. |
| `--db-url` | `<url>` | No | Use this connection. Default: the ladder in [Database connection](#database-connection). |
| `--local-only` | boolean | No | Accepted and then refused with exit `2` and an explanation, because the ledger lives in the project database. |

`object_name` carries three shapes, and the only reliable discriminator is `object_kind`: a `function` uses `schema.name`, a `trigger` or `policy` uses `schema.table.name` where a policy name may contain spaces, and a `config` row uses `schema.table`. A policy and a trigger share one shape, so `deprovision` tells them apart by kind, never by parsing the name.

`--purge` extends the plan past the ledger and into the schema itself. It runs after the ledger drops and after the cleanup that reads `_provisions`, so that table is the last thing to go. The plan gains one `[purge] <statement>` line per policy inside `kizunasync`, three `revoke all on all …` statements, one `revoke usage`, and `drop schema if exists kizunasync cascade;`. One more `[purge]` line then removes every role whose name starts with `kizunasync`, keeping a role another database of the server still uses, whether or not the ledger names it. The migration file always ends with the purge, even when the ledger is already empty, so a replay of the directory removes what the earlier `init` files created. The stderr warning names exactly what goes with it:

```
  --purge also removes the kizunasync schema: 14 table(s), 4 sequence(s), 27 index(es), 76 function(s), 3 policy(ies).
  Every row of sync bookkeeping goes with it, including the ledger. Your own tables are untouched.
```

`--yes` alone never applies a purge. The confirmation is a flag rather than a prompt, because `deprovision` never prompts by design, and its expected value is the project ref parsed from the connection (the `db.<ref>.supabase.co` host, or the `postgres.<ref>` pooler user) or the literal `local` for a connection that names neither:

```
  --purge needs the target typed out: --yes alone does not apply it.
  Re-run with --confirm local (the project ref, or "local" for a connection that names no project).
```

```bash
kizunasync deprovision --dry-run   # preview the DROP plan
kizunasync deprovision --yes       # apply (destructive), keeps the schema and bookkeeping tables
# or: KSYNC_ALLOW_DEPROVISION=1 kizunasync deprovision
kizunasync deprovision --purge --yes --confirm local   # also drop the kizunasync schema itself
```

## `kizunasync jobs`

Lists, runs by hand, and reschedules the pack's three background retention jobs: [`kizunasync.reap_tombstones()`](../reference/sql-pack.md#kizunasyncreap_tombstones), [`kizunasync.compact_changelog()`](../reference/sql-pack.md#kizunasynccompact_changelog), and [`kizunasync.prune_clients()`](../reference/sql-pack.md#kizunasyncprune_clients), which [`kizunasync._schedule_jobs()`](../reference/sql-pack.md#kizunasync_schedule_jobs) schedules from `kizunasync._settings`. There is no `--project-ref`: the three functions run over a service connection, which the Management API does not expose, so `jobs` reads `--db-url` only.

| Command | What it does | Exit codes |
|---|---|---|
| `kizunasync jobs list` | Prints the three jobs against the `_settings` schedules, their live `cron.job` schedule, whether they drifted, and the latest run from `cron.job_run_details`. | `0`; `2` without `pg_cron`, or when the read fails. |
| `kizunasync jobs run <reap\|compact\|prune\|all>` | Runs one job, or all three in order, by calling its function directly. | `0`; `1` when a function raises. |
| `kizunasync jobs schedule` | Re-applies `_schedule_jobs()`, so a manual `_settings` edit reaches `pg_cron` without a full `kizunasync sync`. | `0`; `2` without `pg_cron`, or when the call fails. |

`kizunasync jobs list` prints a table on stderr with the columns `job`, `schedule`, `active`, `settings`, `drift`, `last run`, and `status`, with an indented `→ <message>` line under a job whose latest run did not succeed. A drifted schedule, one that disagrees with `_settings`, closes the table with a warning naming `kizunasync jobs schedule`. Without `pg_cron` the table prints the settings schedules regardless, followed by a line naming `kizunasync jobs run all` as the way to run retention by hand, and the command exits `2`.

`kizunasync jobs run` prints one line per function with the count it returned and what the count counts: `tombstone(s) reaped`, `changelog row(s) compacted`, `client(s) pruned`. The batch stops at the first function that raises, because a connection that cannot run one retention function cannot run the next.

`kizunasync jobs schedule` prints `applied kizunasync._settings to pg_cron` followed by the three job names and their schedules, or the same list under `kizunasync._settings declares` when `pg_cron` is absent.

| Name | Type | Required | Description |
|---|---|---|---|
| `--json` | boolean | No | Print one JSON object on stdout instead of the human report. Without `pg_cron`, `list` and `schedule` still print the line naming `kizunasync jobs run all` on stderr. Global on the `jobs` group: valid before or after the subcommand. |
| `--db-url` | `<url>` | No | Use this connection. Default: the ladder in [Database connection](#database-connection). |

`kizunasync jobs list --json` shape, one object on stdout with `schedule`, `active`, `lastStart`, `lastStatus`, `lastMessage`, and `settingsSchedule` omitted when null:

```json
{"pgCron":true,"jobs":[{"name":"kizunasync-reap-tombstones","schedule":"16 3 * * *","active":true,"settingsSchedule":"16 3 * * *","drift":false,"lastStart":"2026-09-11 03:16:00.007+00","lastStatus":"succeeded","lastMessage":"1 row"}]}
```

`kizunasync jobs run --json`: `{"ran":[{"job":"reap","function":"kizunasync.reap_tombstones","count":0}]}`, in the order the jobs ran. `kizunasync jobs schedule --json` is `kizunasync._schedule_jobs()`'s own payload: `{"pgCron":true,"jobs":{"kizunasync-compact-changelog":"47 3 * * *","kizunasync-prune-clients":"31 3 * * *","kizunasync-reap-tombstones":"16 3 * * *"}}`.

```bash
kizunasync jobs list                 # schedule, drift, and last run for the three jobs
kizunasync jobs run reap             # run the tombstone reaper by hand
kizunasync jobs run all --json       # run all three, machine-readable
kizunasync jobs schedule             # re-apply _settings to pg_cron
```

## `kizunasync mock` (test tooling)

Both subcommands ship. [`mock seed`](#mock-seed) writes a deterministic dataset, and [`mock churn`](#mock-churn) runs deterministic write churn against the rows `mock seed` created. There is no `mock clients` subcommand for headless protocol clients: the [conformance corpus](../resources/glossary.md#conformance-corpus) in `@kizunasync/protocol` is the single test oracle for that ground, and [Drivers and the TCK](../reference/drivers-and-tck.md) describes how a third-party client runs against it.

### Target resolution

Both subcommands resolve the target identically. `--table <name>` wins when supplied and must be a Postgres identifier, and it needs no database. Without it the answer comes from [`kizunasync._config`](./configuration.md), which does: exactly one table must be declared there, and zero or several tables exit `2` asking for `--table`. Mock commands never open a table picker. Resolution runs for `--dry-run` too, so a dry run that names no table resolves a connection regardless.

Both subcommands apply server-side as the connection's own role rather than an owner-scoped one. For the fixed local `postgres` superuser that role is unrestricted, so a table's owner-scoped policies are [bypassed](https://supabase.com/docs/guides/database/postgres/row-level-security#bypassing-row-level-security) at write time. Seeded rows therefore prove nothing about whether your policies would have allowed the same write from a client. Both subcommands scope their work through the seeded rows' `title`, prefixed with the marker `[kizunasync-mock]`. That prefix is the whole scoping story: `mock churn` only ever touches rows `mock seed` created, and `mock seed --clean` removes exactly that set.

### `mock seed`

Writes a deterministic, reproducible dataset into the resolved table so the offline and convergence harness in [Test offline behavior](../operations/test-offline-behavior.md) has real rows to [pull](../resources/glossary.md#pull). The dataset derives entirely from the integer `--seed` through a seeded splitmix PRNG, including the row ids. There is no `Date.now`, no `Math.random`, and no `gen_random_uuid()`, so the same seed and flags produce a byte-identical dataset every run, and re-seeding is idempotent through `ON CONFLICT (id) DO NOTHING`.

The row shape is a fixed demo contract: `id`, `user_id`, `title`, `done`, and `image_path`. `mock seed` writes exactly that shape whatever table it targets, and when the resolved table lacks those columns the insert fails and the command reports the real Postgres error. Every seeded row's `title` carries the `[kizunasync-mock]` marker, and `--clean` removes exactly that set with a single `DELETE … WHERE title LIKE '[kizunasync-mock]%'`. The tooling assumes a table keyed by a `uuid` column named `id`: the seed inserts with `ON CONFLICT (id)`, and `mock churn` targets each row by `id`, so neither supports a table with another key.

SQL is applied over a direct [database connection](#database-connection), never a service-role key. Seeding prints its plan and applies only with `--yes` or `KSYNC_ALLOW_MOCK_SEED=1`, and it never prompts. `--dry-run` prints SQL and changes nothing; it needs no database connection when `--table` names the target.

| Name | Type | Required | Description |
|---|---|---|---|
| `--table` | `<name>` | No | Target table. Default: the lone table in `kizunasync._config`, per [Target resolution](#target-resolution). |
| `--rows` | `<n>` | No | Total rows to create, spread round-robin across users. Default: `20`. |
| `--users` | `<n>` | No | Distinct owner ids to spread the rows across. Default: `3`. |
| `--images` | `<n>` | No | How many rows get an `image_path`, using the owner path `<user_id>/<id>.jpg`. Default: `0`. |
| `--seed` | `<n>` | No | PRNG seed. The same seed reproduces the dataset exactly. Default: `1`. |
| `--clean` | boolean | No | Emit or apply the single marker-predicate delete instead of inserting. |
| `--dry-run` | boolean | No | Print the SQL and change nothing. |
| `--yes` | boolean | No | Authorize the apply. `KSYNC_ALLOW_MOCK_SEED=1` is the alternative. |
| `--db-url` | `<url>` | No | Use this connection. Default: the ladder in [Database connection](#database-connection). |

Seeded owner ids are synthetic, deterministic v4-shaped [UUIDs](https://grokipedia.com/page/Universally_unique_identifier), not real `auth.users` rows.

```bash
kizunasync mock seed --dry-run                    # preview the INSERT SQL
kizunasync mock seed --rows 50 --users 5 --yes    # write 50 rows to the resolved table
kizunasync mock seed --table todos --clean --yes  # delete all [kizunasync-mock] rows from public.todos
```

### `mock churn`

Feeds a steady, deterministic stream of writes against rows `mock seed` already created, for [fencing](../resources/glossary.md#fencing) and load testing. Each step targets exactly one marker-scoped row, chosen by a deterministic offset derived from `--seed`, so the same spec against the same seeded data edits rows in the same order. A step either toggles the row's `done` column or appends a step suffix to its `title`. Determinism is the same hard requirement as in `mock seed`: the same flags always produce a byte-identical statement list, reviewable before it touches a database.

`mock churn` edits marker rows in place, and the `[kizunasync-mock]` prefix survives a retitle, so [`mock seed --clean`](#mock-seed) stays the cleanup path. Statements apply one at a time over a direct [database connection](#database-connection), paced by `--interval-ms`. Applying requires `--yes` or `KSYNC_ALLOW_MOCK_SEED=1`, and the command never prompts. `--dry-run` needs no database connection when `--table` names the target.

| Name | Type | Required | Description |
|---|---|---|---|
| `--table` | `<name>` | No | Target table. Default: the lone table in `kizunasync._config`, per [Target resolution](#target-resolution). |
| `--iterations` | `<n>` | No | Number of write statements to generate. Default: `25`. |
| `--seed` | `<n>` | No | PRNG seed. The same seed reproduces the same plan. Default: `1`. |
| `--interval-ms` | `<n>` | No | Milliseconds to wait between writes. `0` disables pacing. Default: `200`. |
| `--dry-run` | boolean | No | Print the statements and change nothing. |
| `--yes` | boolean | No | Authorize the apply. `KSYNC_ALLOW_MOCK_SEED=1` is the alternative. |
| `--db-url` | `<url>` | No | Use this connection. Default: the ladder in [Database connection](#database-connection). |

When a step fails partway through, `mock churn` stops immediately and reports how many of the planned writes applied. Earlier steps are not rolled back.

```bash
kizunasync mock churn --dry-run                          # preview the UPDATE statements
kizunasync mock churn --iterations 100 --interval-ms 50 --yes
kizunasync mock churn --table todos --yes
```

Exit codes for both subcommands: `0` on success or a zero-row or zero-iteration no-op; `1` when an apply fails; `2` for an invalid `--table`, a synced set that is unreadable or does not name exactly one table, an unresolvable connection, or missing authorization.

## Related pages

- [Configuration](./configuration.md): the `kizunasync._config` and `kizunasync._settings` columns the CLI reads and writes.
- [Install](./install.md): the task guide for `kizunasync init`, on both transports.
- [What Kizuna installs](./whats-installed.md): the object inventory a provisioned project carries.
- [SQL pack reference](../reference/sql-pack.md): the schema, tables, and RPCs every `kizunasync init` provisions.
- [Manage synced tables](./manage-synced-tables.md): the day-to-day workflow `kizunasync sync` automates.
- [Upgrading the pack](./upgrading.md): the workflow `kizunasync upgrade` automates.
- [Remove](./removing.md): the teardown `kizunasync deprovision` plans and applies.
- [Local Supabase](./local-supabase.md): the development stack these commands run against in this repository.
