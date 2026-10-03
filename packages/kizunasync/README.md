<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="https://raw.githubusercontent.com/kizunasync/kizunasync/main/branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">Kizuna Sync</span>
</h1>

Kizuna Sync gives a Supabase app a local SQLite database, so the app keeps reading and writing while the device is offline. A durable outbox holds the writes until they reach your Supabase project, pull is incremental and fenced, push is transactional, and conflict resolution is column-level. The server half is a readable SQL pack that the `kizunasync` CLI installs into the project you own.

`kizunasync` is the one npm package an app installs. It holds the CLI, the SQL pack, every JavaScript entry point as a subpath, and the React Native module that autolinks in Expo and React Native apps. npm also installs the single `@kizunasync/<platform>` package that matches the machine, which carries the CLI binary and the Rust engine for Node and Bun.

## Install

```bash
npm install kizunasync @supabase/supabase-js
```

The framework peers (`react`, `vue`, `react-native`, `expo`, `expo-sqlite`, and the other native modules the Expo entry points wrap) are optional. Install the ones your platform uses.

## Entry points

| Import path | What it gives an app |
|---|---|
| `kizunasync` | `createKizunaSync`, the local query builder, and the shared types |
| `kizunasync/config` | `defineConfig` and the bucket and attachment helpers |
| `kizunasync/constants` | The shared constants |
| `kizunasync/testing` | Test helpers such as `createTempDatabase` |
| `kizunasync/supabase` | `createSupabaseKizunaSync` and the Supabase RPC, Storage, and Realtime adapters |
| `kizunasync/web` | The browser driver, which runs the Rust engine as WebAssembly in a worker |
| `kizunasync/react` | `KizunaSyncProvider` and the React hooks |
| `kizunasync/vue` | `createKizunaSyncPlugin` and the Vue composables |
| `kizunasync/expo` | The Expo SQLite driver, connectivity, and foreground signals |
| `kizunasync/expo/op-sqlite` | The op-sqlite driver (opt-in) |
| `kizunasync/expo/file-store` | The attachment file store for Expo |
| `kizunasync/expo/transfer` | The native attachment download over Supabase Storage |

## CLI

```bash
npx kizunasync init
npx kizunasync doctor
```

`init` reports the project, proposes the synced tables from your Row Level Security policies, and provisions the SQL pack. `doctor` checks the provisioned server and the engine the app installed.

## Documentation

- [Quick start](https://kizunasync.com/docs/quickstart)
- [JavaScript reference](https://kizunasync.com/docs/reference/javascript/introduction)
- [All docs](https://kizunasync.com/docs)

## License

Apache-2.0
