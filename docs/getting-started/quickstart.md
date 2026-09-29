---
title: Quick start
description: Provision Kizuna into your Supabase app with kizunasync from your terminal.
status: alpha
docType: tutorial
audience: app-developer
---

# Quick start

Provision Kizuna into the Supabase application you already ship, so your app reads and writes offline through the client libraries. Run [`kizunasync`](../cli/cli.md) from your app project's root, or pass [`--workdir`](../cli/cli.md#global-options).

`kizunasync` installs the [SQL pack](../reference/sql-pack.md) into your own Supabase project. It records the synced tables in that project's own [configuration tables](../cli/configuration.md). The [sync rules and buckets](../sync/sync-rules-and-buckets.md) there decide which rows reach a device.

## Before you begin

| Requirement | Notes |
|---|---|
| A Supabase project | Hosted on Supabase Cloud, or local through the [Supabase CLI](https://supabase.com/docs/reference/cli/introduction) in your app repository |
| Your application repository | The tree that contains (or will contain) `supabase/config.toml`, migrations, and app source |
| A `uuid` primary key named `id` on every table you sync | The SQL pack keys every change by that column, so the wizard lists a table without it as unavailable. A [per-table sync key column](../resources/roadmap.md#per-table-sync-key-column) is planned |
| Supabase access | Linked project, local stack, Postgres URL, or account login. The wizard discovers what is available |
| [Node.js](https://grokipedia.com/page/Node.js) `^20.19.0` or `>=22.12.0` | Required by the `kizunasync` npm launcher |
| Docker (optional) | Only if you run [Supabase locally](https://supabase.com/docs/guides/local-development#quickstart) inside your app repository |

## 1. Verify `kizunasync`

From any directory:

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

You should now see the command list (`init`, `sync`, `status`, `doctor`, `lint`, and the rest), which [CLI](../cli/cli.md#commands) documents one by one.

## 2. Open your app project

```bash
cd /path/to/your-supabase-app
```

The CLI resolves the working directory (or `--workdir`) for `supabase/` and the generated migrations.

## 3. Run `kizunasync init`

From your app tree, in a real terminal:

:::tabs{group=pm}
```bash tab=npm
npx kizunasync init
```

```bash tab=pnpm
pnpm dlx kizunasync init
```

```bash tab=yarn
yarn dlx kizunasync init
```

```bash tab=bun
bunx kizunasync init
```
:::

The wizard walks you through four stages, and nothing is written until you accept the plan. [`kizunasync init`](../cli/cli.md#kizunasync-init) documents every flag it accepts.

1. Connection: linked Supabase project, `.env` database URL, local stack, or a project from your Supabase account
2. Schema and tables: proposes synced tables from your [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security#grants-and-policies) policies, which keep deciding every write after provisioning
3. Review: shows the pack and config migrations before anything is written
4. Confirm: applies when you accept

You should now have the `kizunasync` schema, or an updated provision ledger on a hosted-only path, with one `kizunasync._config` row per table you kept. On the local migration path you also get timestamped files under `supabase/migrations/`. Those behave like any other [schema migration](https://supabase.com/docs/guides/deployment/database-migrations#schema-migrations) in your repository. [What is installed](../cli/whats-installed.md) itemizes the objects the pack creates.

### Scripted or CI

For pipelines and one-shot runs, pass explicit flags with `--yes`. [Install](../cli/install.md) carries the full matrix: `--dry-run`, `--db-url`, `--project-ref`, and the hosted [Management API](https://supabase.com/docs/reference/api/introduction) path, which Kizuna uses to apply the same pack without a direct [Postgres](https://grokipedia.com/page/PostgreSQL) connection.

## 4. Confirm project shape

Still from your app tree:

:::tabs{group=pm}
```bash tab=npm
npx kizunasync doctor
npx kizunasync status
```

```bash tab=pnpm
pnpm dlx kizunasync doctor
pnpm dlx kizunasync status
```

```bash tab=yarn
yarn dlx kizunasync doctor
yarn dlx kizunasync status
```

```bash tab=bun
bunx kizunasync doctor
bunx kizunasync status
```
:::

On a TTY, [`kizunasync status`](../cli/cli.md#kizunasync-status) renders the same read-only report the wizard uses elsewhere. [`kizunasync doctor`](../cli/cli.md#kizunasync-doctor) reads `kizunasync._config`, checks the local project files, and can probe the [Data API](https://supabase.com/docs/guides/api) when credentials are available, which is how it catches a `kizunasync` schema that is not exposed.

Once Kizuna is installed, `kizunasync` with no command in a terminal opens a control panel that runs these checks and the other commands from one menu, listed in [Interactive mode](../cli/cli.md#interactive-mode).

## 5. Wire the client in your app

After provisioning, add the offline client for your UI:

| UI | Next page | Reference |
|---|---|---|
| React | [React](react.md) | [React](../reference/react/introduction.md) |
| Vue | [Vue](vue.md) | [Vue](../reference/vue/introduction.md) |
| Expo / React Native | [Expo / React Native](expo.md) | [Expo](../reference/expo/introduction.md) |
| Vite (browser) | [Vite](vite.md) | [JavaScript](../reference/javascript/introduction.md) |
| Other JavaScript | [Vanilla JavaScript](vanilla-js.md) | [JavaScript](../reference/javascript/introduction.md) |
| Swift or Kotlin (no JS UI) | [Swift and Kotlin](native-clients.md) | [Swift](../reference/swift/introduction.md), [Kotlin](../reference/kotlin/introduction.md) |

Every JavaScript guide follows the same shape. One module creates the app client once, at module scope, and every other file imports it. In a browser app that module is `src/kizunasync.ts`, next to the `src/supabase-client.ts` file that exports your supabase-js client:

```ts
// src/kizunasync.ts
import { byOwner, defineConfig } from '@kizunasync/core'
import { createSupabaseKizunaSync } from '@kizunasync/supabase'
import { createWebWorkerDriver } from '@kizunasync/web'
import { supabase } from './supabase-client'

const config = defineConfig({
  tables: { todos: { sync: 'read-write', bucket: byOwner('user_id') } },
})

export const kizunasync = createSupabaseKizunaSync({
  supabase,
  driver: createWebWorkerDriver('todos.db'),
  config,
})
```

[`defineConfig`](../reference/javascript/define-config.md) declares the tables with the options `kizunasync status` reports for them in step 4. [`createSupabaseKizunaSync`](../reference/javascript/initializing.md) composes the client over [`createWebWorkerDriver`](../reference/javascript/create-web-worker-driver.md), and creating it opens nothing: the first query or write opens the browser database and runs the first sync. The client follows the Supabase session by itself, so the app signs in with supabase-js as usual, or passes `anonymousSignIn: true` when its first run has no sign-in screen. The engine fills the `byOwner` bucket with the signed-in user's id. On Expo and React Native the module swaps the driver for `openExpoDriver`, as [Expo / React Native](expo.md) shows.

A write then goes through the same client:

```ts
// src/add-todo.ts
import { kizunasync } from './kizunasync'

export async function addTodo(title: string): Promise<void> {
  await kizunasync.from('todos').insert({ title, done: false })
}
```

The insert mirrors Supabase's [`insert`](https://supabase.com/docs/reference/javascript/insert), except that it commits locally first, mints the `id` itself, and fills `user_id` with the signed-in user. The client pushes it on its own, because a local write, a poll tick, the network coming back, and a return to the tab each start a sync run, and the server's verdict arrives with that run. [`sync()`](../reference/javascript/sync.md) is there for a **Sync now** button or a test. The framework guides in the table above add the rest: the Supabase client file, the sign-in, the root file that provides the client, and the screens that read and write.

Install the client library for your platform from its registry: npm `@kizunasync/*` ([JavaScript: Installing](../reference/javascript/installing.md)), the `KizunaSync` Swift package ([Swift: Installing](../reference/swift/installing.md)), or Maven `com.kizunasync:kizunasync` ([Kotlin: Installing](../reference/kotlin/installing.md)).

## See Kizuna move without provisioning

- [demo.kizunasync.com](https://demo.kizunasync.com): the hosted two-pane browser demo, with a wire viewer for pull and push.
- [Playground](./playground.md): the five in-repository reference apps against a local Supabase stack.

## Next steps

- [Install](../cli/install.md): the scripted and hosted provisioning matrix.
- [CLI](../cli/cli.md): every subcommand, flag, and exit code.
- [Configuration](../cli/configuration.md): the `kizunasync._config` and `kizunasync._settings` columns the CLI writes.
- [How Kizuna works](./how-kizuna-works.md): outbox, pull, verdicts, and files in five steps.
- [Project status](./status.md): what is implemented and what is verified.
- [Contribute](../resources/contribute.md): the monorepo path for maintaining Kizuna Sync itself.
