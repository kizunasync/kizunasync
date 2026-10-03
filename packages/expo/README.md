<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">@kizunasync/expo</span>
</h1>

Native-side adapters for Kizuna on Expo and bare React Native. The package points the Rust engine at the SQLite file it opens, through the `kizunasync` `IStoreLocator` interface. It wraps `@react-native-community/netinfo` as the connectivity port the engine reads to tell online from offline. It also ships file-store and transfer adapters for attachment sync.

`createKizunaSync` is exported from `kizunasync`, not from this package.

## Install

This workspace is private. Apps install the `kizunasync` package and import it as `kizunasync/expo`, `kizunasync/expo/file-store`, `kizunasync/expo/transfer`, and `kizunasync/expo/op-sqlite`.

```bash
npm install kizunasync
npx expo install expo-sqlite expo-file-system @react-native-community/netinfo @supabase/supabase-js
```

The React Native module inside `kizunasync` (the `rn-uniffi` workspace) autolinks and carries the Rust engine for iOS and Android. It reaches the app through a native rebuild that links a prebuilt engine at the same version: the `KizunaSyncEngine` product of the [`kizunasync-swift`](https://github.com/kizunasync/kizunasync-swift) Swift package on iOS 16 or later, and `com.kizunasync:kizunasync-engine` from Maven Central on Android. The app needs no Rust toolchain. Expo Go cannot load the engine, so iOS and Android need a development build. `@op-engineering/op-sqlite` is an optional peer.

## Exports

| Entry point | Exports |
|---|---|
| `kizunasync/expo` | `openExpoDriver`, `createExpoConnectivity`, `createExpoForeground`, related option types |
| `kizunasync/expo/file-store` | `openExpoFileStore` |
| `kizunasync/expo/transfer` | `createExpoSupabaseDownload` (its deadline defaults, `DEFAULT_TRANSFER_CONTROL_TIMEOUT_MS` and `DEFAULT_TRANSFER_BYTES_TIMEOUT_MS`, come from `kizunasync`) |
| `kizunasync/expo/op-sqlite` | `openOpSqliteDriver`, `verifyOpSqliteDriver`, `probeHandle`, and related types (opt-in) |

## Get started

```ts
// src/kizunasync.ts
import { createSupabaseKizunaSync } from 'kizunasync/supabase'
import { openExpoDriver } from 'kizunasync/expo'

const driver = openExpoDriver('myapp.db')
const kizunasync = createSupabaseKizunaSync({ supabase, driver, config })
```

On native, `createSupabaseKizunaSync` attaches the [UniFFI](https://mozilla.github.io/uniffi-rs/) HTTP remote, the transport the Rust engine uses to reach Supabase. `createKizunaSync` with `createRpcRemote` leaves the React Native path with no remote at all. The engine then ACKs every push without talking to your project.

`openExpoDriver` returns an `IStoreLocator` right away and opens nothing. On native the locator names the `expo-sqlite` file for the Rust kernel. It opens `expo-sqlite` to read that path and closes it again on the app client's first engine call, not when you build it. If that read fails, the app client's calls fail with `ENGINE_UNAVAILABLE` and the `expo-sqlite` message from that first call on. It also carries `createExpoConnectivity()` and `createExpoForeground()` as `platformPorts`, so the app client follows NetInfo and `AppState` unless you pass your own `connectivity` or `foreground`. Its `loadNativeEngine` loads the Rust engine through `@kizunasync/rn-uniffi` on that same first call, so `@kizunasync/core` never imports that package. On web `openExpoDriver` returns the `@kizunasync/web` worker driver, which carries the browser's connectivity. It hands that driver the resolver for the engine binary's Metro asset URL, and the driver calls it when the worker spawns, so a static render never reads `location`.

## op-sqlite (opt-in)

When `@op-engineering/op-sqlite` is present, swap the import and name the directory the database lives in:

```ts
// src/kizunasync.ts (excerpt)
import { openOpSqliteDriver } from 'kizunasync/expo/op-sqlite'

const driver = openOpSqliteDriver('myapp.db', { location: databaseDirectory })
```

`location` is required (absolute path or `file://` URI). A call without it throws. The locator carries the same device ports as `openExpoDriver`, and building it loads nothing: the kernel opens the file itself, and only `verifyOpSqliteDriver` loads the peer to open a real handle. Import from the subpath so Metro does not resolve the uninstalled peer for every consumer.

## Session persistence

Persist the Supabase session so a relaunch recovers the signed-in user. Without persistence, a restart mints a new anonymous identity and queued outbox entries are rejected by [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security) under the wrong user ID.

Use `expo-secure-store` on native and `AsyncStorage` on web:

```ts
// src/supabase-client.ts
import { Platform } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { deleteItemAsync, getItemAsync, setItemAsync } from 'expo-secure-store'
import { createClient } from '@supabase/supabase-js'

const sessionStore =
  Platform.OS === 'web'
    ? AsyncStorage
    : {
        getItem: (key: string) => getItemAsync(key),
        setItem: (key: string, value: string) => setItemAsync(key, value),
        removeItem: (key: string) => deleteItemAsync(key),
      }

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: sessionStore,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
})
```

## Attachments

Pass `fileStore` and `transfer` to `createKizunaSync`.

Native uses `openExpoFileStore` and composes `createExpoSupabaseDownload` over `createSupabaseTransfer` from `kizunasync/supabase`. Web uses `createWebFileStore` from `kizunasync/web` with the unmodified transfer. Neither store touches the file system when you build it: the first operation creates the sandbox, and without a `documentDirectory` every operation fails with `STORE_UNAVAILABLE`. React Native forbids `Blob`-from-`ArrayBuffer`, which is why only the native `download` needs `expo/fetch`.

Control waits default to 30s; byte waits to 120s. A blown deadline rejects with `ATTACHMENT_TRANSFER_TIMEOUT`, which the attachment queue treats as retryable.

```ts
// src/kizunasync.ts (excerpt)
import { openExpoFileStore } from 'kizunasync/expo/file-store'
import { createExpoSupabaseDownload } from 'kizunasync/expo/transfer'
import { createSupabaseTransfer } from 'kizunasync/supabase'
import { createConsoleLogger } from 'kizunasync'

const fileStore = openExpoFileStore()
const logger = createConsoleLogger('debug')
const transferPorts = { client: supabase, fileStore, logger: logger.child('transfer') }
const transfer = { ...createSupabaseTransfer(transferPorts), download: createExpoSupabaseDownload(transferPorts) }

const kizunasync = createKizunaSync(driver, remote, config, { fileStore, transfer })
```

## Peer dependencies

| Package | Required | Constraint |
|---|---|---|
| `expo-sqlite` | Yes | `~57.0.1` |
| `react-native` | Yes | `>=0.86.0` |
| `@react-native-community/netinfo` | Yes | `>=11` |
| `expo` | Yes | any |
| `expo-file-system` | Only with `openExpoFileStore` | any |
| `@supabase/supabase-js` | Only with `createExpoSupabaseDownload` | `^2.0.0` |
| `@op-engineering/op-sqlite` | Only with `openOpSqliteDriver` | any (optional) |

## Related

- [Expo guide](../../docs/getting-started/expo.md)
- [Expo reference](../../docs/reference/expo/introduction.md)
- [Media and attachments](../../docs/attachments/media-and-attachments.md)
- [Offline writes](../../docs/sync/offline-writes.md)
- [`@kizunasync/rn-uniffi`](../rn-uniffi/README.md)
