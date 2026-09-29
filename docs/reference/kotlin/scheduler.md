---
title: Host scheduler
description: Refresh the session, then run sync on a timer, on the network path, and on foreground.
status: alpha
docType: reference
library: kotlin
pageKind: guide
audience: app-developer
---

# Kotlin: Host scheduler

`KizunaSyncScheduler` is the loop the client does not have. It watches one client and syncs it once when it starts, after every local write to that client, on its own timer, when the network path comes back, and when the app returns to the foreground. Before every run it refreshes the Supabase session, and it runs only when that succeeds.

An app builds one scheduler right after [Initializing](./initializing.md) opens the client, and nothing else in the app builds one. In [Swift and Kotlin](../../getting-started/native-clients.md#6-start-the-host-scheduler) that is `startSyncScheduler` in `TodoSync.kt`. Read this page to change the poll interval, add the Realtime doorbell, take over the path or foreground signal, or read the loop's health.

## Usage

This is `startSyncScheduler` from `TodoSync.kt` in [Swift and Kotlin](../../getting-started/native-clients.md#6-start-the-host-scheduler), with the default interval written out and an `onError` handler added. `kizunasync` is the app client from the same file, and `supabase` comes from `Supabase.kt` in [step 2](../../getting-started/native-clients.md#2-connect-supabase) of that guide.

```kotlin
// app/src/main/kotlin/com/example/todo/TodoSync.kt (excerpt)
package com.example.todo

import android.content.Context
import android.util.Log
import com.kizunasync.kizunasync.KizunaSyncConnectivityPathMonitor
import com.kizunasync.kizunasync.KizunaSyncProcessForegroundSource
import com.kizunasync.kizunasync.KizunaSyncScheduler
import io.github.jan.supabase.auth.auth

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
        pollIntervalMs = 15_000L,
        pathMonitor = KizunaSyncConnectivityPathMonitor(context),
        onError = { failure -> Log.w("kizunasync", "sync failed", failure) },
        foregroundSource = KizunaSyncProcessForegroundSource(),
        needsResetSource = { runCatching { kizunasync.checkpoint().softBlocked }.getOrDefault(false) },
    )
    scheduler.start()
    return scheduler
}
```

The guide calls it from `openKizunaSync` right after `create` succeeds, on the main thread, which `KizunaSyncProcessForegroundSource` needs when `start()` registers its lifecycle observer. A scheduler started before the client has an engine loses its local-write wake, as [Notes](#notes) explains. Call `stop()` when the client is torn down, and `wake()` for a **Sync now** button, pull-to-refresh, or right after a sign-in. An app that passes no `foregroundSource` calls `notifyForeground()` from an `ON_START` lifecycle observer instead; see [Foreground wake](#foreground-wake).

### With realtime and a reset gate

The same function with the Realtime doorbell added. The adapter gets its own coroutine scope.

```kotlin
// app/src/main/kotlin/com/example/todo/TodoSync.kt (excerpt)
package com.example.todo

import android.content.Context
import com.kizunasync.kizunasync.KizunaSyncConnectivityPathMonitor
import com.kizunasync.kizunasync.KizunaSyncProcessForegroundSource
import com.kizunasync.kizunasync.KizunaSyncScheduler
import io.github.jan.supabase.auth.auth
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers

private fun startSyncScheduler(context: Context): KizunaSyncScheduler {
    val scheduler = KizunaSyncScheduler(
        client = kizunasync,
        realtime = SupabaseRealtimeWakeup(supabase, CoroutineScope(Dispatchers.IO)),
        realtimeTables = listOf("todos"),
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

`SupabaseRealtimeWakeup` implements [`KizunaSyncRealtimeWakeup`](#realtime-wake), shown below.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `client` | `KizunaSyncClient` | Yes | The client the scheduler syncs and watches. `start()` subscribes to its events, and every local write, which raises a `QueueDepth` event above zero, wakes a run. The default `sync` calls this client's `sync()`. |
| `refreshSession` | `suspend () -> Boolean` | Yes | Runs before every sync. Return `false` to abort the run, which is the answer for a signed-out user or a refresh that failed. It is also where the new token is handed to [Set access token](./set-access-token.md). |
| `sync` | `suspend () -> Unit` | No | The work of one run. Default: `{ client.sync() }`. Pass a lambda to run more than that, such as `client.sync()` followed by a reload of the screens. |
| `pollIntervalMs` | `Long` | No | Milliseconds between timer wakes. `0` or less arms no loop, which leaves the path, the foreground, the realtime doorbell, and explicit wakes as the only triggers. Default: `15000`. |
| `pathMonitor` | `KizunaSyncPathMonitor?` | No | The network-path source every run is gated on. `KizunaSyncConnectivityPathMonitor(context)` is the Android implementation. Default: `null`, which leaves the scheduler ungated. |
| `onError` | `((Throwable) -> Unit)?` | No | Receives whatever `sync` or `refreshSession` threw, and the error of a local-write subscription the client refused, such as `ENGINE_UNAVAILABLE` from a client that has no engine yet. Unset, the failure is dropped and the next wake tries again. Default: `null`. |
| `scope` | `CoroutineScope` | No | Scope every wake and the poll loop are launched in. Default: a new scope over a `SupervisorJob` on `Dispatchers.IO`. |
| `jitterSource` | `() -> Double` | No | Draws the jitter fraction in `[0, 1)` for each armed delay. Default: `{ Math.random() }`. A documented testing seam: pass a constant to make the armed delay deterministic in a test. |
| `foregroundSource` | `KizunaSyncForegroundSource?` | No | The return-to-foreground source that wakes a run. Default: `null`, which wakes on no foreground signal until the app calls `notifyForeground()` itself. See [Foreground wake](#foreground-wake). |
| `realtime` | `KizunaSyncRealtimeWakeup?` | No | The app's realtime doorbell. Default: `null`, which wakes on no realtime message. See [Realtime wake](#realtime-wake). |
| `realtimeTables` | `List<String>` | No | Tables the doorbell subscribes to, each as topic `kizunasync:<table>`. An empty list subscribes to nothing even when `realtime` is set. Default: `emptyList()`. |
| `needsResetSource` | `(suspend () -> Boolean)?` | No | Read after every attempt and published on `health().needsReset`. Wire it to `client.checkpoint().softBlocked`. Default: `null`, which always publishes `false`. |

`pollIntervalMs`, `refreshSession`, `sync`, and `onError` are settable properties after construction, so a sign-in can replace `refreshSession` without building a new scheduler. Assigning `pollIntervalMs` or `refreshSession` restarts a running timer, so the next wake is a full interval away from the assignment. `client`, `pathMonitor`, `scope`, `jitterSource`, `foregroundSource`, `realtime`, `realtimeTables`, and `needsResetSource` are fixed at construction, stored privately, with no settable property.

## Methods

| Name | Type | Required | Description |
|---|---|---|---|
| `start()` | `() -> Unit` | — | Starts `pathMonitor` when one was supplied, arms the foreground source, subscribes the realtime doorbell and the client's local writes, launches the poll loop when `pollIntervalMs` is above `0`, then requests one attempt, so the first pull does not wait for the first tick. That attempt waits on the path gate like any other. Calling it on a running scheduler does nothing. |
| `stop()` | `() -> Unit` | — | Cancels the poll loop, stops the path monitor (which reopens the gate), stops the foreground source, cancels the realtime subscription, and releases the local-write subscription. A run already in flight is not canceled, and the scope stays usable for later wakes. |
| `wake(reason)` | `(KizunaSyncWakeReason) -> Unit` | — | Requests a run now. `reason` is `Poll`, `Foreground`, `Path`, `Doorbell`, `LocalWrite`, or `Start`, and it names the trigger rather than changing what the run does. A non-poll wake clears the failure streak. Default: `Doorbell`. |
| `notifyForeground()` | `() -> Unit` | — | `wake(KizunaSyncWakeReason.Foreground)`, for an app with no `foregroundSource` that tracks the lifecycle itself. |
| `notifyOnline()` | `() -> Unit` | — | `wake(KizunaSyncWakeReason.Path)`, for a connectivity signal the app owns. A monitored scheduler already wakes itself, and this run is held too while the monitor reports the path unsatisfied. |
| `health()` | `() -> KizunaSyncSyncHealth` | — | Snapshot of the loop: `phase` (`Idle`, `Syncing`, `Backoff`, `Stalled`, `Offline`), `consecutiveFailures`, `nextAttemptAt`, `attemptStartedAt`, `lastSuccessAt`, `lastError`, `needsReset`. |
| `onHealth(handler)` | `((KizunaSyncSyncHealth) -> Unit) -> () -> Unit` | — | Calls the listener with the current snapshot, then on every transition. Returns the unsubscribe function. |

## Path monitoring

Pass a `pathMonitor` and every run is gated on it. A path the monitor reports as unsatisfied holds the loop. The first satisfied report after that resumes the loop and wakes a run at once.

`start()` starts the monitor and `stop()` stops it. Pass no monitor and there is no gate, which is what a JVM host process wants: the timer, the foreground signal, and explicit wakes stay the only triggers.

The gate holds every wake reason, so an unsatisfied path stops a foreground wake and a doorbell as surely as it stops a timer wake. Arming the monitor on a device that is already online syncs at once, because reading the live path is itself the first satisfied report.

`KizunaSyncConnectivityPathMonitor(context)` is the Android implementation. It reads the active network's capabilities once at registration, then registers a `ConnectivityManager.NetworkCallback` for networks that carry both `NET_CAPABILITY_INTERNET` and `NET_CAPABILITY_VALIDATED`, so a captive portal with connectivity but no real internet access is unsatisfied on both the direct read and the callback. It reports `true` from `onAvailable`, and `false` from `onLost` and `onUnavailable`. The library manifest carries the `ACCESS_NETWORK_STATE` permission the callback needs. It takes a `Context`, so it ships in the Android artifact rather than in the plain JVM one.

Swift gates by default through `NWPathMonitor` under `monitorPath: true`. Kotlin gates when the caller passes `KizunaSyncConnectivityPathMonitor(context)`, because the shared scheduler compiles without the Android SDK. [Swift: Host scheduler](../swift/scheduler.md#path-monitoring) covers the other side.

`KizunaSyncPathMonitor` is an interface, so an app with its own reachability source can implement `start(onSatisfied)` and `stop()` over that. An app that would rather not gate at all leaves the monitor unset and calls `notifyOnline()` from its own observer.

## Foreground wake

The shared scheduler compiles for the plain JVM, which has no process lifecycle to watch. Kotlin therefore takes `foregroundSource` from the app exactly as it already takes `pathMonitor`, and there is no default.

On Android, pass `KizunaSyncProcessForegroundSource()`, the `:android` module's `ProcessLifecycleOwner` implementation. A JVM host with no `foregroundSource` calls `notifyForeground()` itself when it knows.

The whole process returning to the front reports once, however many activities the app has, so a rotation is not a wake. `start()` arms the source and `stop()` releases it.

`KizunaSyncForegroundSource` is an interface, `start(onForeground)` and `stop()`, so a test or an app with its own activation signal can implement it directly. Swift installs a default source: [Swift: Host scheduler](../swift/scheduler.md#foreground-wake) covers why Kotlin does not.

## Realtime wake

`realtime` is the doorbell the app's own Supabase [Realtime](https://supabase.com/docs/guides/realtime) channel rings. Realtime is a WebSocket, which is outside the Rust engine, so the scheduler takes a port instead of a dependency. `KizunaSyncRealtimeWakeup`'s `subscribe(topics, onWake)` is called once per configured table, as topic `kizunasync:<table>`, and `onWake` is expected on every broadcast.

`start()` subscribes and `stop()` cancels through the `KizunaSyncRealtimeSubscription` the app returned. `realtimeTables` left empty subscribes to nothing, even with `realtime` set, because a subscription to no table would hold a channel open for messages that cannot arrive.

The library declares no Supabase dependency, so the app writes the adapter. This one uses [`broadcastFlow`](https://supabase.com/docs/reference/kotlin/subscribe#examples):

```kotlin
// app/src/main/kotlin/com/example/todo/SupabaseRealtimeWakeup.kt
package com.example.todo

import com.kizunasync.kizunasync.KizunaSyncRealtimeSubscription
import com.kizunasync.kizunasync.KizunaSyncRealtimeWakeup
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.realtime.broadcastFlow
import io.github.jan.supabase.realtime.channel
import io.github.jan.supabase.realtime.realtime
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch

class SupabaseRealtimeWakeup(
    private val supabase: SupabaseClient,
    private val scope: CoroutineScope,
) : KizunaSyncRealtimeWakeup {
    override fun subscribe(topics: List<String>, onWake: () -> Unit): KizunaSyncRealtimeSubscription {
        val channels = topics.map { supabase.channel(it) }
        val job =
            scope.launch {
                supabase.realtime.connect()
                for (channel in channels) {
                    launch {
                        channel.broadcastFlow<Map<String, String>>("changed").collect { onWake() }
                    }
                    channel.subscribe()
                }
            }
        return KizunaSyncRealtimeSubscription {
            job.cancel()
            scope.launch {
                for (channel in channels) {
                    supabase.realtime.removeChannel(channel)
                }
            }
        }
    }
}
```

What the server broadcasts on `kizunasync:<table>` is the app's own database trigger or Edge Function; a message is only a hint, so a dropped socket delays a pull rather than losing one, and the scheduler still polls on its own timer underneath.

## Notes

Runs never overlap: a wake that arrives while a run is in flight is remembered as a single trailing run, which starts once the current one finishes, so a burst of doorbells costs one extra run rather than one per signal.

A failing `sync` or `refreshSession` lambda does not stop the scheduler: the throwable goes to `onError` and the next wake tries again, which is the behavior an offline device needs. It is dropped when `onError` is unset. Watch the outcome through [Subscribe to events](./on.md) and [Outbox depth](./outbox-depth.md) rather than from the lambda's return.

Refreshing before the run is the point of the `refreshSession` step: a backgrounded app whose access token expired would otherwise push with a dead bearer and stall on `42501`. The token it hands over is also how an owner bucket learns its user, as [Set access token](./set-access-token.md#notes) describes. The Usage lambda waits for `awaitInitialization()`, because supabase-kt loads the stored session in the background at launch, and calls no refresh itself: supabase-kt refreshes the stored session on its own while `alwaysAutoRefresh` keeps its default of `true`, and `currentSessionOrNull()` returns the latest one. Supabase documents the refresh itself under [`refreshSession`](https://supabase.com/docs/reference/kotlin/auth-refreshsession#examples) and the lifetimes under [Auth sessions](https://supabase.com/docs/guides/auth/sessions#what-is-a-session). [Start the host scheduler](../../getting-started/native-clients.md#6-start-the-host-scheduler) shows the wiring inside an app, and [Sync goes quiet after sleep, background, or a token expiry](../../operations/troubleshooting.md#sync-goes-quiet-after-sleep-background-or-a-token-expiry) covers what to check when runs stop.

Every arm draws a full jitter fraction from `jitterSource` in `[0, 1)` over the range `[delay / 2, delay]`. Many devices then de-sync rather than stampede a recovering server. A failure streak grows `delay` exponentially, capped at 30 seconds and never below `pollIntervalMs`. A successful run, and any non-poll wake, clears the streak and re-arms the timer at the base interval.

The scheduler refreshes `nextAttemptAt` on every arm and clears it when `stop()` cancels the loop. `stop()` publishes that disarmed health, so `health()` reflects it at once.

A poll tick that lands while an attempt is in flight is dropped. A second tick on the same attempt marks it `Stalled`, counts one failure, books exactly one catch-up run, and re-arms with the grown backoff. `health()` and `onHealth` are the native peer of JavaScript `getSyncHealth` / `onSyncHealth`. They live on the scheduler because that is the loop, not on `KizunaSyncClient`.

`needsResetSource` is read after every attempt, whether or not the run itself succeeded, and published on `health().needsReset`. A scheduler built with no `needsResetSource` always publishes `false`. Wire it to `client.checkpoint().softBlocked` so a fresh `RESET_REQUIRED`, or the `identity_changed` block a token of another user latches, reaches the snapshot a UI renders. After [Reset](./reset.md), call `wake()`: a reset raises no local write, and the snapshot keeps its last `needsReset` until the next attempt reads it again.

A local write reaches the scheduler through the client's events: `start()` subscribes with [`on`](./on.md), and a `QueueDepth` event above zero wakes a run with the reason `LocalWrite`, while a depth of zero wakes nothing. The subscription belongs to the engine the client held at `start()`. Calling `create` again replaces that engine and ends its subscriptions, and a running scheduler does not subscribe again, so call `stop()` and then `start()` after it, which subscribes to the new engine. A subscription the client refuses, as it does before `create` has built an engine, goes to `onError`, and the timer and the other triggers keep the loop going without the local-write wake.

## Related reference

- [Sync](./sync.md)
- [Set access token](./set-access-token.md)
- [Subscribe to events](./on.md)
- [Outbox depth](./outbox-depth.md)
- [Reset](./reset.md)
- [Checkpoint](./checkpoint.md)
- [Types](./types.md)
- [Swift: Host scheduler](../swift/scheduler.md)
