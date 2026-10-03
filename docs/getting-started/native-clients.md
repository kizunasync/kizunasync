---
title: Swift and Kotlin
description: Open KizunaSyncClient once when a native iOS or Android app starts, start the host scheduler, and read and write locally.
status: alpha
docType: how-to
audience: app-developer
---

# Swift and Kotlin

Build a native iOS or Android app that reads and writes a local database and syncs it with your Supabase project, with the Rust engine running on the device through [UniFFI](https://mozilla.github.io/uniffi-rs/). You create the app client once in `TodoSync.swift` or `TodoSync.kt` and open it when the app starts, whether or not anyone has signed in yet. Beside it runs `KizunaSyncScheduler`, the native sync loop, which syncs when it starts, after every local write, on a timer, when the network comes back, and when the app returns to the foreground. Reads answer from the device, and writes wait in the [outbox](../resources/glossary.md#outbox) until the scheduler's next run. The [Swift](../reference/swift/introduction.md) and [Kotlin](../reference/kotlin/introduction.md) references document every call this guide uses.

## Before you begin

- A Supabase project provisioned with [`kizunasync`](../cli/cli.md) in your app repository. See [Quick start](./quickstart.md).
- Xcode for Swift, or JDK 17 plus the Android SDK for Kotlin. The Kotlin screens in this guide use Jetpack Compose.
- A sign-in flow in the app. Your [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security#grants-and-policies) policies judge every pushed write under the signed-in user's [JWT](https://grokipedia.com/page/JSON_Web_Token), so sync starts once a user has signed in, while the local database opens and answers without one. Supabase documents sign-in in [`signInWithPassword`](https://supabase.com/docs/reference/swift/auth-signinwithpassword) for Swift and [`signInWith`](https://supabase.com/docs/reference/kotlin/auth-signinwithpassword) for Kotlin.

## 1. Install

Add the dependencies as described in [Swift: Installing](../reference/swift/installing.md) or [Kotlin: Installing](../reference/kotlin/installing.md). An iOS app adds the Swift packages `https://github.com/kizunasync/kizunasync-swift` (product `KizunaSync`) and `https://github.com/supabase/supabase-swift.git` (product `Supabase`). An Android app adds `com.kizunasync:kizunasync`, the supabase-kt BOM `io.github.jan-tennert.supabase:bom` with `auth-kt` and `realtime-kt`, and the Ktor engine `io.ktor:ktor-client-okhttp`. An Android app also declares `android.permission.INTERNET` in its own `AndroidManifest.xml`, because the library manifest adds only `ACCESS_NETWORK_STATE`. You should now resolve `KizunaSyncClient` or `com.kizunasync.kizunasync.KizunaSyncClient`.

## 2. Connect Supabase

Step 1 added Supabase's own SDK, supabase-swift or supabase-kt. Create its client in one file, so the sign-in screen and the sync scheduler share one session. The Kotlin client needs the `Auth` plugin.

:::tabs{group=lang}
```swift tab=Swift
// TodoApp/Supabase.swift
import Foundation
import Supabase

let supabaseURL = URL(string: "https://your-project-ref.supabase.co")!
let supabasePublishableKey = "your-publishable-key"

let supabase = SupabaseClient(supabaseURL: supabaseURL, supabaseKey: supabasePublishableKey)
```

```kotlin tab=Kotlin
// app/src/main/kotlin/com/example/todo/Supabase.kt
package com.example.todo

import io.github.jan.supabase.auth.Auth
import io.github.jan.supabase.createSupabaseClient

const val SUPABASE_URL = "https://your-project-ref.supabase.co"
const val SUPABASE_PUBLISHABLE_KEY = "your-publishable-key"

val supabase = createSupabaseClient(
    supabaseUrl = SUPABASE_URL,
    supabaseKey = SUPABASE_PUBLISHABLE_KEY,
) {
    install(Auth)
}
```
:::

Replace the URL and the key with your project's values. The key is the project's [publishable key](https://supabase.com/docs/guides/getting-started/api-keys#publishable-keys-and-public-components), which is safe in the app because RLS decides every row regardless.

Both SDKs keep the signed-in session on the device by default, which is how a relaunch comes back as the same user: supabase-swift stores it in the Keychain, and supabase-kt saves it in its settings storage (`SharedPreferences` on Android). In Swift, `supabase.auth.session` answers with that session and refreshes an expired access token first, which needs the network. supabase-kt loads the stored session in the background at launch, so Kotlin code waits for `supabase.auth.awaitInitialization()` before it calls `supabase.auth.currentSessionOrNull()`, and while the app runs supabase-kt refreshes the session on its own, because `alwaysAutoRefresh` defaults to `true`. Supabase describes the session in [Auth sessions](https://supabase.com/docs/guides/auth/sessions#what-is-a-session) and the client options in [Swift: Initializing](https://supabase.com/docs/reference/swift/initializing) and [Kotlin: Initializing](https://supabase.com/docs/reference/kotlin/initializing). You should now be able to use `supabase` from any file in the app.

## 3. Create the app client

Create the app client in one file, `TodoSync.swift` or `TodoSync.kt`. It is the only file that opens the local database, and it opens it once per launch.

:::tabs{group=lang}
```swift tab=Swift
// TodoApp/TodoSync.swift
import Foundation
import KizunaSync

let kizunasync = KizunaSyncClient()

/// Swift runs a global's initializer once, the first time code reads it, so every `await kizunasyncReady.value` waits for this one open.
let kizunasyncReady = Task { @MainActor in
  let databaseURL = try FileManager.default
    .url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    .appendingPathComponent("kizunasync.sqlite")
  try await kizunasync.create(KizunaSyncClientConfig(
    tables: ["todos": KizunaSyncTableConfig(bucket: .byOwner("user_id"))],
    databasePath: databaseURL.path,
    remote: KizunaSyncRemoteConfig(url: supabaseURL.absoluteString, publishableKey: supabasePublishableKey)
  ))
}
```

```kotlin tab=Kotlin
// app/src/main/kotlin/com/example/todo/TodoSync.kt
package com.example.todo

import android.content.Context
import com.kizunasync.kizunasync.KizunaSyncBucket
import com.kizunasync.kizunasync.KizunaSyncClient
import com.kizunasync.kizunasync.KizunaSyncClientConfig
import com.kizunasync.kizunasync.KizunaSyncRemoteConfig
import com.kizunasync.kizunasync.KizunaSyncTableConfig
import java.io.File
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

val kizunasync = KizunaSyncClient()

private val openLock = Mutex()
private var isOpen = false

/** Opens the local database once per process. A failed open is forgotten, so the next call tries again. */
suspend fun openKizunaSync(context: Context) {
    openLock.withLock {
        if (!isOpen) {
            kizunasync.create(
                KizunaSyncClientConfig(
                    tables = mapOf("todos" to KizunaSyncTableConfig(bucket = KizunaSyncBucket.ByOwner("user_id"))),
                    databasePath = File(context.filesDir, "kizunasync.sqlite").absolutePath,
                    remote = KizunaSyncRemoteConfig(url = SUPABASE_URL, publishableKey = SUPABASE_PUBLISHABLE_KEY),
                ),
            )
            isOpen = true
        }
    }
}
```
:::

The config declares each table with the options `kizunasync init` provisioned for it. [`kizunasync status`](../cli/cli.md#kizunasync-status), the command the [Quick start](./quickstart.md#4-confirm-project-shape) runs, lists each table's `syncMode`, `bucketColumn`, and `conflictMode`. `syncMode` and `conflictMode` become the same-named fields of `KizunaSyncTableConfig`, and the bucket column becomes its `bucket`: `.byOwner(column)` in Swift or `KizunaSyncBucket.ByOwner(column)` in Kotlin when the column holds the owning user's id, as `user_id` does here, `.byColumn(column)` or `KizunaSyncBucket.ByColumn(column)` when it holds another value such as a team id, and the default, no bucket, for a table provisioned without one. [Swift: Initializing](../reference/swift/initializing.md#parameters) and [Kotlin: Initializing](../reference/kotlin/initializing.md#parameters) list every other option.

An owner bucket needs no code of its own. The client learns the signed-in user's id from the first session token it receives and keeps it in the local database. From then on it pulls only the rows whose `user_id` holds that id, and it fills `user_id` on every insert that leaves the column out, offline and after a relaunch too. You never call `setBucket` for this table: [Swift: Set bucket](../reference/swift/set-bucket.md) and [Kotlin: Set bucket](../reference/kotlin/set-bucket.md) are for `byColumn` buckets.

`create` makes no network call and needs no session, so the app opens and shows its local rows offline and before anyone signs in. The config passes no access token, because the scheduler in step 6 hands the client the current session before every sync, and that hand-over is also how the client learns who the user is. `publishableKey` and the session's access token travel on every pull and push; Kizuna holds no identity of its own. The config leaves `clientId` unset, so the client mints a [uuid](https://grokipedia.com/page/Universally_unique_identifier) for the device on the first launch and the local database keeps it across launches.

The open runs once per launch, because the client does not support opening the same database file a second time. In Swift, every window that awaits `kizunasyncReady.value` waits for the same open, and a failed open stays failed until the next launch. The task runs on the main actor, so the file compiles whether or not the app target isolates code to the main actor by default. In Kotlin, a `Mutex` guards `openKizunaSync`, so a recreated activity finds the client already open, and a failed open is forgotten so the next call tries again. You should now be able to open the client from the app's root.

## 4. Provide it to the app

Open the client from the app's root, with a loading state until the open finishes and the error message if it fails. The native bindings have no provider type, so the screens use `kizunasync` directly once the root has opened it.

:::tabs{group=lang}
```swift tab=Swift
// TodoApp/TodoApp.swift
import SwiftUI

@main
struct TodoApp: App {
  @State private var isOpen = false
  @State private var failure: String?

  var body: some Scene {
    WindowGroup {
      Group {
        if isOpen {
          TodoListView()
        } else if let failure {
          Text(failure)
        } else {
          ProgressView("Opening the local database")
        }
      }
      .task {
        do {
          try await kizunasyncReady.value
          isOpen = true
        } catch {
          failure = String(describing: error)
        }
      }
    }
  }
}
```

```kotlin tab=Kotlin
// app/src/main/kotlin/com/example/todo/MainActivity.kt
package com.example.todo

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                TodoRoot()
            }
        }
    }
}

@Composable
private fun TodoRoot() {
    val context = LocalContext.current
    var isOpen by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        try {
            openKizunaSync(context)
            isOpen = true
        } catch (error: Exception) {
            failure = error.message ?: error.toString()
        }
    }

    when {
        isOpen -> TodoScreen()
        failure != null -> Text(failure.orEmpty())
        else -> CircularProgressIndicator()
    }
}
```
:::

The root shows the error's own text, so a failed open shows up on screen instead of in a log: a Kizuna failure such as `CONFIG_INVALID` or a database path the app cannot open reads `CODE: message`. The root compiles once the screen from step 7 exists. You should then see the loading indicator, followed by the todo list.

## 5. Sign in

The local database opens without a session, and sync waits for one. Sign the user in with Supabase's own SDK from your sign-in screen, as [`signInWithPassword`](https://supabase.com/docs/reference/swift/auth-signinwithpassword) for Swift and [`signInWith`](https://supabase.com/docs/reference/kotlin/auth-signinwithpassword) for Kotlin describe. The root from step 4 opens the client without waiting for a sign-in, so your sign-in screen can sit wherever the app shows it. The SDK keeps the session it returns, as step 2 describes, and the scheduler in step 6 hands that session to the client before every sync.

The first session the client receives names the user the local database belongs to. From then on the owner bucket from step 3 pulls that user's rows, and an insert that leaves `user_id` out gets that user's id. The local database remembers the owner, so on later launches both work before the first sync, offline too. You should now get a session from `supabase.auth.session` in Swift, or from `supabase.auth.currentSessionOrNull()` in Kotlin, once your sign-in screen succeeds.

## 6. Start the host scheduler

The native client does not sync on its own. [`sync()`](../reference/swift/sync.md) pushes the outbox, moves the queued attachment bytes, and pulls, in one pass, and `KizunaSyncScheduler` is the loop that calls it. Connectivity and lifecycle are host concerns on native, so the scheduler lives in the binding rather than in the engine. Build it beside the client and start it right after the open: replace `TodoSync.swift` or `TodoSync.kt` from step 3 with this version.

:::tabs{group=lang}
```swift tab=Swift
// TodoApp/TodoSync.swift
import Foundation
import KizunaSync
import Supabase

let kizunasync = KizunaSyncClient()

let syncScheduler = KizunaSyncScheduler(
  client: kizunasync,
  refreshSession: {
    guard let session = try? await supabase.auth.session else { return false }
    try? await kizunasync.setAccessToken(session.accessToken)
    return true
  },
  needsReset: { (try? await kizunasync.checkpoint().softBlocked) ?? false }
)

/// Swift runs a global's initializer once, the first time code reads it, so every `await kizunasyncReady.value` waits for this one open.
let kizunasyncReady = Task { @MainActor in
  let databaseURL = try FileManager.default
    .url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    .appendingPathComponent("kizunasync.sqlite")
  try await kizunasync.create(KizunaSyncClientConfig(
    tables: ["todos": KizunaSyncTableConfig(bucket: .byOwner("user_id"))],
    databasePath: databaseURL.path,
    remote: KizunaSyncRemoteConfig(url: supabaseURL.absoluteString, publishableKey: supabasePublishableKey)
  ))
  syncScheduler.start()
}
```

```kotlin tab=Kotlin
// app/src/main/kotlin/com/example/todo/TodoSync.kt
package com.example.todo

import android.content.Context
import com.kizunasync.kizunasync.KizunaSyncBucket
import com.kizunasync.kizunasync.KizunaSyncClient
import com.kizunasync.kizunasync.KizunaSyncClientConfig
import com.kizunasync.kizunasync.KizunaSyncConnectivityPathMonitor
import com.kizunasync.kizunasync.KizunaSyncProcessForegroundSource
import com.kizunasync.kizunasync.KizunaSyncRemoteConfig
import com.kizunasync.kizunasync.KizunaSyncScheduler
import com.kizunasync.kizunasync.KizunaSyncTableConfig
import io.github.jan.supabase.auth.auth
import java.io.File
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

val kizunasync = KizunaSyncClient()

lateinit var syncScheduler: KizunaSyncScheduler
    private set

private val openLock = Mutex()
private var isOpen = false

/** Opens the local database and starts the scheduler, once per process. A failed open is forgotten, so the next call tries again. */
suspend fun openKizunaSync(context: Context) {
    openLock.withLock {
        if (!isOpen) {
            kizunasync.create(
                KizunaSyncClientConfig(
                    tables = mapOf("todos" to KizunaSyncTableConfig(bucket = KizunaSyncBucket.ByOwner("user_id"))),
                    databasePath = File(context.filesDir, "kizunasync.sqlite").absolutePath,
                    remote = KizunaSyncRemoteConfig(url = SUPABASE_URL, publishableKey = SUPABASE_PUBLISHABLE_KEY),
                ),
            )
            syncScheduler = startSyncScheduler(context.applicationContext)
            isOpen = true
        }
    }
}

private fun startSyncScheduler(context: Context): KizunaSyncScheduler {
    val scheduler = KizunaSyncScheduler(
        client = kizunasync,
        refreshSession = {
            supabase.auth.awaitInitialization()
            val token = supabase.auth.currentSessionOrNull()?.accessToken
            if (token != null) {
                kizunasync.setAccessToken(token)
            }
            token != null
        },
        pathMonitor = KizunaSyncConnectivityPathMonitor(context),
        foregroundSource = KizunaSyncProcessForegroundSource(),
        needsResetSource = { runCatching { kizunasync.checkpoint().softBlocked }.getOrDefault(false) },
    )
    scheduler.start()
    return scheduler
}
```
:::

Before every run the scheduler calls `refreshSession`, which hands the current access token to the client with [`setAccessToken`](../reference/swift/set-access-token.md). In Swift, `supabase.auth.session` refreshes an expired token before it answers; in Kotlin, supabase-kt keeps the session refreshed on its own, and `currentSessionOrNull()` returns the latest one. A `false` answer skips the run, as it should while nobody is signed in or when a refresh could not reach Supabase, and refreshing first keeps a backgrounded app from pushing with a token that expired while it slept. The first token the client receives is the session from step 5, which names the owner of the local database. Supabase covers the token side in [Auth sessions](https://supabase.com/docs/guides/auth/sessions#what-is-a-session). When `refreshSession` answers `true`, the scheduler calls `sync()` on these triggers:

- `start()` runs one attempt right away, so the first pull does not wait for the timer.
- A local write wakes it, so an insert goes out without waiting for the next tick.
- The timer fires every 15 seconds by default, at a random point between half the interval and the full interval, so many devices do not hit a recovering server at once. After a failure the delay grows exponentially up to 30 seconds, or up to the interval when that is longer, and a success brings it back to the interval.
- The network path comes back. Swift watches the path with `NWPathMonitor` by default. Kotlin watches it when you pass `KizunaSyncConnectivityPathMonitor(context)`, as `startSyncScheduler` does, because the shared scheduler compiles without the Android SDK. While the path is down, every trigger waits.
- The app returns to the foreground. Swift installs its own foreground observer by default, and Kotlin takes `KizunaSyncProcessForegroundSource()` from the `:android` module, because the shared scheduler also compiles for the plain JVM, which has no process lifecycle.
- A Realtime doorbell rings, when you pass a `realtime` adapter and `realtimeTables`. Neither binding depends on Supabase directly, so [Swift: Host scheduler](../reference/swift/scheduler.md#realtime-wake) and [Kotlin: Host scheduler](../reference/kotlin/scheduler.md#realtime-wake) show the adapter to copy from your own Supabase [Realtime](https://supabase.com/docs/guides/realtime) channel.

Runs never overlap: a trigger that arrives during a run becomes one trailing run. Call `syncScheduler.wake()` when your sign-in screen succeeds, so the new session reaches the client at once instead of on the next timer tick, and from a **Sync now** button or pull-to-refresh. A wake goes through the same session refresh and network gate. `kizunasync.sync()` runs one pass directly without either, which suits a test.

`needsReset` (Swift) and `needsResetSource` (Kotlin) read the checkpoint's soft block after every attempt and publish it on `health().needsReset`, which is how a UI learns that sync is blocked until [Reset](../reference/swift/reset.md) runs; step 8 shows when that happens.

The scheduler runs for the life of the process. In Kotlin, `openKizunaSync` builds it from the application context, so a recreated activity keeps it, and the root calls `openKizunaSync` from the main thread, which `KizunaSyncProcessForegroundSource` needs when `start()` registers its lifecycle observer. [Swift: Host scheduler](../reference/swift/scheduler.md) and [Kotlin: Host scheduler](../reference/kotlin/scheduler.md) document every parameter.

When sync stops after a backgrounded app wakes, see [Sync goes quiet after sleep, background, or a token expiry](../operations/troubleshooting.md#sync-goes-quiet-after-sleep-background-or-a-token-expiry).

## 7. Read and write

Read and write in the screen the root renders. There are no hooks on native, so the screen subscribes with [`on`](../reference/swift/on.md) and reads again on every event. The client raises one after every local write and after every pull that commits rows, so the list follows both your own inserts and the rows sync brings in.

:::tabs{group=lang}
```swift tab=Swift
// TodoApp/TodoListView.swift
import KizunaSync
import SwiftUI

@MainActor
final class TodoListModel: ObservableObject {
  @Published private(set) var titles: [String] = []
  @Published private(set) var failure: String?
  private var stopListening: (@Sendable () -> Void)?

  func start() async {
    if stopListening == nil {
      stopListening = try? await kizunasync.on { [weak self] _ in
        Task { @MainActor in await self?.reload() }
      }
    }
    await reload()
  }

  func stop() {
    stopListening?()
    stopListening = nil
  }

  func reload() async {
    do {
      let rows = try await kizunasync.from("todos").select().execute() as? [[String: Any]] ?? []
      titles = rows.compactMap { $0["title"] as? String }
    } catch {
      failure = String(describing: error)
    }
  }

  func add(title: String) async {
    do {
      try await kizunasync.from("todos").insert(["title": title, "done": false])
    } catch {
      failure = String(describing: error)
    }
  }
}

struct TodoListView: View {
  @StateObject private var model = TodoListModel()
  @State private var draft = ""

  var body: some View {
    NavigationStack {
      List(model.titles, id: \.self) { Text($0) }
        .navigationTitle("Todos")
        .safeAreaInset(edge: .bottom) {
          VStack {
            if let failure = model.failure {
              Text(failure)
            }
            HStack {
              TextField("New todo", text: $draft)
              Button("Add") {
                let title = draft
                draft = ""
                Task { await model.add(title: title) }
              }
            }
          }
          .padding()
        }
    }
    .task { await model.start() }
    .onDisappear { model.stop() }
  }
}
```

```kotlin tab=Kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt
package com.example.todo

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.ListItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
import org.json.JSONArray

@Composable
fun TodoScreen() {
    val scope = rememberCoroutineScope()
    var titles by remember { mutableStateOf(emptyList<String>()) }
    var draft by remember { mutableStateOf("") }
    var failure by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        suspend fun reload() {
            try {
                titles = readTitles()
            } catch (error: Exception) {
                failure = error.message
            }
        }

        reload()
        val stop = kizunasync.on { launch { reload() } }
        try {
            awaitCancellation()
        } finally {
            stop()
        }
    }

    Column(Modifier.padding(16.dp)) {
        failure?.let { Text(it) }
        OutlinedTextField(value = draft, onValueChange = { draft = it }, label = { Text("New todo") })
        Button(
            onClick = {
                val title = draft.trim()
                draft = ""
                scope.launch {
                    try {
                        kizunasync.from("todos").insert(mapOf("title" to title, "done" to false))
                    } catch (error: Exception) {
                        failure = error.message
                    }
                }
            },
        ) {
            Text("Add")
        }
        LazyColumn {
            items(titles) { title -> ListItem(headlineContent = { Text(title) }) }
        }
    }
}

private suspend fun readTitles(): List<String> {
    val rows = kizunasync.from("todos").select().execute() as JSONArray
    return List(rows.length()) { index -> rows.getJSONObject(index).optString("title") }
}
```
:::
`select().execute()` answers from the device's [SQLite](https://grokipedia.com/page/SQLite) file and reaches no network, so the list is the same offline as online. `insert` commits the row locally, mints its primary key, and queues one outbox mutation. That local write wakes the scheduler, which pushes it right away when the device is online, and [Offline writes](../sync/offline-writes.md) walks through the queue end to end. The insert leaves `user_id` out, and the client fills it with the id of the user who signed in at step 5, the owner your RLS policy checks on push. The fill needs a user the client knows, so an insert made on a device where nobody has signed in yet keeps only the columns you passed. See [Swift: Fetch data](../reference/swift/fetch-data.md) or [Kotlin: Fetch data](../reference/kotlin/fetch-data.md), and [Swift: Insert data](../reference/swift/insert-data.md) or [Kotlin: Insert data](../reference/kotlin/insert-data.md). You should now see a new todo in the list as soon as you add it, with the network on or off, and while the device is online, in the `todos` table of the Supabase Table Editor right after.

## 8. Show sync state

Read the loop's state from the scheduler: `health()` returns a snapshot, and `onHealth` calls you with it on every change. It carries the `phase` (`idle`, `syncing`, `backoff`, `stalled`, or `offline`), the failure streak, the next attempt, the last success, the last error, and `needsReset`. This view shows the phase, a **Sync now** button, and a **Reset** button while the scheduler reports `needsReset`.

:::tabs{group=lang}
```swift tab=Swift
// TodoApp/TodoListView.swift (excerpt)
import KizunaSync
import SwiftUI

@MainActor
final class SyncStatusModel: ObservableObject {
  @Published private(set) var health = syncScheduler.health()
  private var stopObserving: (() -> Void)?

  func start() {
    guard stopObserving == nil else { return }
    stopObserving = syncScheduler.onHealth { [weak self] health in
      Task { @MainActor in self?.health = health }
    }
  }

  func stop() {
    stopObserving?()
    stopObserving = nil
  }
}

struct SyncStatusView: View {
  @StateObject private var model = SyncStatusModel()

  var body: some View {
    HStack {
      Text(model.health.phase.rawValue)
      Spacer()
      if model.health.needsReset {
        Button("Reset") {
          Task {
            _ = try? await kizunasync.reset()
            syncScheduler.wake()
          }
        }
      }
      Button("Sync now") { syncScheduler.wake() }
    }
    .onAppear { model.start() }
    .onDisappear { model.stop() }
  }
}
```

```kotlin tab=Kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
package com.example.todo

import androidx.compose.foundation.layout.Row
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import kotlinx.coroutines.launch

@Composable
fun SyncStatus() {
    val scope = rememberCoroutineScope()
    var health by remember { mutableStateOf(syncScheduler.health()) }

    DisposableEffect(Unit) {
        val stop = syncScheduler.onHealth { health = it }
        onDispose { stop() }
    }

    Row {
        Text(health.phase.name)
        if (health.needsReset) {
            Button(
                onClick = {
                    scope.launch {
                        runCatching { kizunasync.reset() }
                        syncScheduler.wake()
                    }
                },
            ) {
                Text("Reset")
            }
        }
        Button(onClick = { syncScheduler.wake() }) {
            Text("Sync now")
        }
    }
}
```
:::

Place `SyncStatusView()` in the list's bottom inset above the text field, or call `SyncStatus()` first inside the `Column` of `TodoScreen`.

The **Reset** button is how the app switches accounts. A different user signing in on the same device soft-blocks sync with the reason `identity_changed` as soon as the new user's first token reaches the client: pull and push stay off the network, so the previous user's queued writes are never pushed under the new user's session, and the scheduler publishes `needsReset` as `true` after its next attempt. `reset()` drops the local rows and the queued writes that have not reached the server, clears the soft block and the stored owner, and mints a new client id. The client stays open, and the wake after the reset hands it the new user's token, which makes that user the owner and pulls their rows. The button wakes the scheduler because a reset raises no local write, and `needsReset` keeps its last value until the next attempt.

The same button clears the `RESET_REQUIRED` a server sends when this client's schema version falls below the server minimum. Calling `reset()` right after a user signs out, before the next one signs in, avoids the soft block; read [`outboxDepth()`](../reference/swift/outbox-depth.md) first when unsynced writes matter. [Swift: Reset](../reference/swift/reset.md) and [Kotlin: Reset](../reference/kotlin/reset.md) describe what the call removes.

The client has its own calls for the queue and the journals. [`outboxDepth()`](../reference/swift/outbox-depth.md) returns the pending count, [`rejections()`](../reference/swift/rejections.md) with [`dismissRejection`](../reference/swift/dismiss-rejection.md) covers writes the server refused, and [`overwrites()`](../reference/swift/overwrites.md) with [`dismissOverwrite`](../reference/swift/dismiss-overwrite.md) covers the column values a peer's write replaced for the same row. The Kotlin twins are [`outboxDepth()`](../reference/kotlin/outbox-depth.md), [`rejections()`](../reference/kotlin/rejections.md), [`dismissRejection`](../reference/kotlin/dismiss-rejection.md), [`overwrites()`](../reference/kotlin/overwrites.md), and [`dismissOverwrite`](../reference/kotlin/dismiss-overwrite.md). There are no native [React](https://react.dev)-style hooks, so pair these calls with [`on`](../reference/swift/on.md) and Combine or Flow for a live view.

## Verify it worked

Run the app on two simulators or devices signed in as the same user, add a todo on one, and confirm it appears on the other after its next scheduler run, or at once when you bring the other app back to the foreground. The iOS and Android examples in the [Playground](./playground.md#native-ios) run the same client against a local stack.

## Common errors

- `BUCKET_UNSET` means a table's bucket has no value when the pull runs. On an owner bucket, the client has received no session token yet, for example in a test that calls `sync()` before `setAccessToken`. On a `byColumn` bucket, `setBucket` has not run. See [BUCKET_UNSET](../operations/troubleshooting.md#bucket_unset).
- Sync that stays blocked with `needsReset` true after another user signs in is the `identity_changed` soft block. Call `reset()` as step 8 shows. See [Sync soft-blocks after switching accounts](../operations/troubleshooting.md#sync-soft-blocks-after-switching-accounts).
- `ATTACHMENT_PORTS_MISSING` means a table declares attachments and `attachmentRoot` is unset. See [Swift: Attach a file](../reference/swift/from-file.md), [Kotlin: Attach a file](../reference/kotlin/from-file.md), and [Troubleshooting](../operations/troubleshooting.md#attachment_ports_missing).
- `CONFIG_INVALID` with a `clientId` message means the value you passed is not a [uuid](https://grokipedia.com/page/Universally_unique_identifier). Leave `clientId` unset to have the client mint one, or persist a minted uuid across launches instead of a plain string. With a `bucket_owner` message, the owner bucket names an empty column or `id`, which the client cannot fill.
- `PGRST106` means `kizunasync` is not in the project's exposed schemas, so the [Data API](https://supabase.com/docs/guides/api) refuses the RPC. See [Troubleshooting](../operations/troubleshooting.md).
- Writes that stay queued while every run fails with `42501` mean the client is sending no valid user JWT. Check that `refreshSession` hands the refreshed token to [Swift: Set access token](../reference/swift/set-access-token.md) or [Kotlin: Set access token](../reference/kotlin/set-access-token.md) before it answers `true`. See [Sync goes quiet after sleep, background, or a token expiry](../operations/troubleshooting.md#sync-goes-quiet-after-sleep-background-or-a-token-expiry).

## Next steps

- [Swift: Introduction](../reference/swift/introduction.md): the full Swift surface.
- [Kotlin: Introduction](../reference/kotlin/introduction.md): the Kotlin twin of that tree.
- [Offline writes](../sync/offline-writes.md): the queue, the verdicts, and the rejection journal.
- [Native packaging](../resources/native-packaging.md): the maintainer lane for bindings and artifacts.
- [Project status](./status.md): what native distribution does and does not include.
