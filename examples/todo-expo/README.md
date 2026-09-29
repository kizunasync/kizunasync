<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">example: todo-expo</span>
</h1>

Private workspace. Expo SDK 57 with React Native 0.86.3 and React 19.2.3. Normal todo operations use Kizuna's local query app client; `supabase-js` supplies authentication and the Supabase adapters. The lab's `force conflict` action writes through `supabase-js` so the local client has a conflicting server value to reconcile.

Routes live under `app/`. [`src/kizunasync-shim.ts`](./src/kizunasync-shim.ts) owns the database driver, Kizuna/Supabase composition, attachment ports, session-aware owner state, live-sync gates, and lab controls.

## Runtime paths

The app calls `openExpoDriver` on every platform:

- Native iOS and Android use `expo-sqlite` with a file-backed database. The Rust engine reaches it through `@kizunasync/rn-uniffi`. Without that Turbo Module, `createKizunaSync` throws `ENGINE_UNAVAILABLE`
- Expo web hands the open to `@kizunasync/web` (wasm worker, OPFS or relaxed IndexedDB, BroadcastChannel leadership). No SharedArrayBuffer or COOP/COEP
- Native attachment bytes use the Expo document-directory file store; web uses the OPFS file store. Both use the Supabase transfer adapter
- A row whose image transfer budget stopped for good shows retry and remove in place of the thumbnail
- Header journal badges (`useRejections`, `useOverwrites`) and a reset banner when `needsReset` is true
- A Live sync setting on every platform: when it is on, the app syncs by itself as you make changes and on a timer, and when it is off, it syncs only when you press "sync now"

This example does not use the optional op-sqlite driver.

## Visibility and ownership

The client declares no client-side bucket. It requests the complete set [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security) permits. The demo migration shares the board: every visitor reads every row. An anonymous visitor's rows accept writes from any visitor; the registered demo rows stay writable only by their owner, and an identity switch resets the local cache. The caps of 100 todos and 300 writes per minute live in the fixture rather than in the installable pack. The cleanup beside them lives there too.

## Prerequisites

- Bun `1.4.2`
- Docker (or another daemon for the local Supabase setup)
- Expo-compatible browser, iOS simulator, Android emulator, or native toolchain for a development build
- This source checkout (`@kizunasync/*` via `workspace:*`)
- Expo Go cannot run this example's native engine: the Turbo Module's glue compiles into the app binary during the native build, and the engine arrives prebuilt, through Swift Package Manager on iOS and Maven Central on Android, or from the `ubrn:ios` / `ubrn:android` build in `packages/rn-uniffi` when that build exists in this repository. Use a development build (`bun run ios` / `bun run android`) on iOS and Android; the web target needs no native build.

## Get started

From the repository root:

```bash
bun install
bun run db:start
bun run db:status
cp .env.example .env
```

```dotenv
EXPO_PUBLIC_TODO_EXPO_SUPABASE_URL=http://127.0.0.1:55321
EXPO_PUBLIC_TODO_EXPO_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

The client also reads `EXPO_PUBLIC_TODO_EXPO_SUPABASE_ANON_KEY` as an alias. Never put a service-role key in an Expo bundle. A physical-device LAN host override belongs in the repo-root `.env.local`.

Choose the URL for the runtime that will make the request:

- Expo web and the iOS simulator on the development Mac: `http://127.0.0.1:55321`
- Standard Android emulator: `http://10.0.2.2:55321` (unless you configure port forwarding)
- Physical phone: a reachable LAN address such as `http://192.168.x.x:55321`

```bash
bun run --filter=@kizunasync/example-todo-expo dev
```

The script runs `expo start -c`. For a native development client:

```bash
cd examples/todo-expo
bun run ios    # or bun run android
```

Studio is at `http://127.0.0.1:55323`. Stop the stack with `bun run db:stop` from the root.

## Session persistence

The Supabase client stores its session through Expo SecureStore on native and AsyncStorage on web. Startup reuses an existing session and creates an anonymous session only when none exists. That wiring is not a crash-safety guarantee; the headless tests do not kill an Expo process.

## What to try

1. Let initial sign-in and sync finish, then add a todo with an image.
2. Enable simulated offline, add or edit a todo, watch the outbox, then sync.
3. Open a separate client with a fresh anonymous identity and confirm it receives the first visitor's rows too, since the board is shared.
4. Sign in as Mary (`mary@kizunasync.local` / `kizunasync-demo`), create a todo, switch to Anonymous, enable "Test non-owner edit", and edit it to see the registered-owner refusal.
5. Use two clients on the same registered account for same-owner convergence.
6. Lab controls: `force conflict`, `expire checkpoint`, `reset local`.

## Tests

```bash
bun run cargo:napi
bun test examples/todo-expo
```

Deterministic client flows over in-memory SQLite and fake remotes. They do not launch Expo, Metro, a simulator, or a device, and they do not reach Auth, Postgres, Realtime, or Storage.

## Hosted projects

For a hosted application, review a dry run and provision the pack plus your own table configuration and RLS:

```bash
npx kizunasync init --project-ref your-project-ref --dry-run --access-token "$SUPABASE_ACCESS_TOKEN"
```

`pnpm dlx kizunasync`, `yarn dlx kizunasync`, and `bunx kizunasync` work the same way. Read [Install Kizuna](../../docs/cli/install.md) before you apply anything.

Changing this example's URL and key alone does not create its todo table, policies, Storage bucket, or demo identities in a hosted project.

## Troubleshooting

Expo Go shows "Kizuna could not start". It carries no compiled Turbo Module, so `createKizunaSync` throws `ENGINE_UNAVAILABLE`. Use a development build (`bun run ios` / `bun run android`).

Android cannot reach local Supabase. Use `10.0.2.2` for the standard emulator, or the machine's LAN address on a physical device.

Sign-in fails. Re-run `bun run db:status`, check the public URL/key variables, and confirm the runtime can reach that URL.

## Related

- [Expo guide](../../docs/getting-started/expo.md)
- [Local Supabase setup](../../docs/cli/local-supabase.md)
- [Media and attachments](../../docs/attachments/media-and-attachments.md)
- [How Kizuna works](../../docs/getting-started/how-kizuna-works.md#kernel-and-app-clients)
- [Test offline behavior](../../docs/operations/test-offline-behavior.md)
