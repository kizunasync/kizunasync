---
title: Host scheduler
description: Refresh the session, then run sync on a timer, on the network path, and on foreground.
status: alpha
docType: reference
library: swift
pageKind: guide
audience: app-developer
---

# Swift: Host scheduler

`KizunaSyncScheduler` is the loop the client does not have. It watches one client and syncs it once when it starts, after every local write to that client, on its own timer, when the network path becomes satisfied, and when the app comes back to the foreground. Before every run it refreshes the Supabase session, and it runs only when that succeeds.

An app builds one scheduler beside the client and starts it right after [Initializing](./initializing.md) opens the client, and nothing else in the app builds one. In [Swift and Kotlin](../../getting-started/native-clients.md#6-start-the-host-scheduler) that is `syncScheduler` in `TodoSync.swift`. Read this page to change the poll interval, add the Realtime doorbell, take over the path or foreground signal, or read the loop's health.

## Usage

This is `syncScheduler` from `TodoSync.swift` in [Swift and Kotlin](../../getting-started/native-clients.md#6-start-the-host-scheduler), with the default interval and path monitor written out and an `onError` handler added. `kizunasync` is the app client from the same file, and `supabase` comes from `Supabase.swift` in [step 2](../../getting-started/native-clients.md#2-connect-supabase) of that guide.

```swift
// TodoApp/TodoSync.swift (excerpt)
import KizunaSync
import Supabase

let syncScheduler = KizunaSyncScheduler(
  client: kizunasync,
  pollInterval: 15,
  monitorPath: true,
  refreshSession: {
    guard let session = try? await supabase.auth.session else { return false }
    try? await kizunasync.setAccessToken(session.accessToken)
    return true
  },
  onError: { failure in print("sync failed: \(failure)") },
  needsReset: { (try? await kizunasync.checkpoint().softBlocked) ?? false }
)
```

The guide calls `syncScheduler.start()` right after `create(_:)` succeeds, and a scheduler started before the client has an engine loses its local-write wake, as [Notes](#notes) explains. Call `syncScheduler.stop()` when the client is torn down, and `syncScheduler.wake()` for a **Sync now** button, pull-to-refresh, or right after a sign-in. `observeForeground` already wires the foreground by default; `notifyForeground()` is for an app that turned it off and calls it from SwiftUI when `scenePhase` becomes `.active`, or from the UIKit foreground callback.

### With realtime and a reset gate

The same scheduler with the Realtime doorbell added.

```swift
// TodoApp/TodoSync.swift (excerpt)
import KizunaSync
import Supabase

let syncScheduler = KizunaSyncScheduler(
  client: kizunasync,
  realtime: SupabaseRealtimeWakeup(client: supabase),
  realtimeTables: ["todos"],
  refreshSession: {
    guard let session = try? await supabase.auth.session else { return false }
    try? await kizunasync.setAccessToken(session.accessToken)
    return true
  },
  needsReset: { (try? await kizunasync.checkpoint().softBlocked) ?? false }
)
```

`SupabaseRealtimeWakeup` conforms to [`KizunaSyncRealtimeWakeup`](#realtime-wake), shown below.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `client` | `KizunaSyncClient` | Yes | The client the scheduler syncs and watches. `start()` subscribes to its events, and every local write, which raises a `queueDepth` event above zero, wakes a run. With `sync` left `nil`, a run calls this client's `sync()`. |
| `pollInterval` | `TimeInterval` | No | Seconds between timer wakes. `0` or less arms no timer, which leaves the path, the foreground, the realtime doorbell, and explicit wakes as the only triggers. Default: `15`. |
| `monitorPath` | `Bool` | No | Whether the scheduler watches the network path itself with `NWPathMonitor` and gates every run on it. Assigning it on a running scheduler arms or cancels the monitor at once, and turning it off reopens the gate. Default: `true`. |
| `pathMonitor` | `KizunaSyncPathMonitor?` | No | The path source `monitorPath` gates on. Default: `nil`, which builds a `KizunaSyncNetworkPathMonitor`, so a scheduler built with no arguments gates on connectivity. A test injects its own. |
| `observeForeground` | `Bool` | No | Whether the scheduler registers its own did-become-active observer through `KizunaSyncNotificationForegroundSource`. Default: `true`. See [Foreground wake](#foreground-wake). |
| `foregroundSource` | `KizunaSyncForegroundSource?` | No | The source `observeForeground` arms. Default: `nil`, which builds a `KizunaSyncNotificationForegroundSource` when `observeForeground` is `true`. A test injects its own. |
| `realtime` | `KizunaSyncRealtimeWakeup?` | No | The app's realtime doorbell. Default: `nil`, which wakes on no realtime message. See [Realtime wake](#realtime-wake). |
| `realtimeTables` | `[String]` | No | Tables the doorbell subscribes to, each as topic `kizunasync:<table>`. An empty list subscribes to nothing even when `realtime` is set. Default: `[]`. |
| `refreshSession` | `() async -> Bool` | Yes | Runs before every sync. Return `false` to abort the run, which is the answer for a signed-out user or a refresh that failed. It is also where the new token is handed to [Set access token](./set-access-token.md). |
| `sync` | `(() async throws -> Void)?` | No | The work of one run. Default: `nil`, which runs `client.sync()`. Pass a closure to run more than that, such as `client.sync()` followed by a reload of the screens. |
| `onError` | `((Error) -> Void)?` | No | Receives whatever the `sync` closure threw, and the error of a local-write subscription the client refused, such as `ENGINE_UNAVAILABLE` from a client that has no engine yet. Unset, the failure is dropped and the next wake tries again. Default: `nil`. |
| `jitterSource` | `@Sendable () -> Double` | No | Draws the jitter fraction in `[0, 1)` for each armed delay. Default: `{ Double.random(in: 0..<1) }`. A documented testing seam: pass a constant to make the armed delay deterministic in a test. |
| `needsReset` | `(@Sendable () async -> Bool)?` | No | Read after every attempt and published on `health().needsReset`. Wire it to `client.checkpoint().softBlocked`. Default: `nil`, which always publishes `false`. |

`pollInterval`, `monitorPath`, `refreshSession`, `sync`, and `onError` stay settable after construction. A sign-in can replace `refreshSession` without building a new scheduler. Assigning `pollInterval` or `refreshSession` restarts a running timer. The next wake is then a full interval away from the assignment. `client`, `pathMonitor`, `observeForeground`'s resulting source, `realtime`, `realtimeTables`, `jitterSource`, and `needsReset` are fixed at construction. The scheduler stores them privately and exposes no settable property for them.

## Methods

| Name | Type | Required | Description |
|---|---|---|---|
| `start()` | `() -> Void` | — | Arms the timer, the path monitor when `monitorPath` is true, the foreground source, the realtime subscription, and the subscription to the client's local writes, then requests one attempt, so the first pull does not wait for the first tick. That attempt waits on the path gate like any other. Calling it on a running scheduler does nothing. The timer is added to the main run loop in the common mode, so it keeps firing while a list is being scrolled. |
| `stop()` | `() -> Void` | — | Invalidates the timer, cancels the path monitor (which reopens the gate), stops the foreground source, cancels the realtime subscription, and releases the local-write subscription. A run already in flight is not canceled. |
| `wake(reason:)` | `(KizunaSyncWakeReason) -> Void` | — | Requests a run now. `reason` is `.poll`, `.foreground`, `.path`, `.doorbell`, `.localWrite`, or `.start`, and it names the trigger rather than changing what the run does. A non-poll wake clears the failure streak. Default: `.doorbell`. |
| `notifyForeground()` | `() -> Void` | — | `wake(reason: .foreground)`, for an app that turned `observeForeground` off and tracks the lifecycle itself. |
| `notifyOnline()` | `() -> Void` | — | `wake(reason: .path)`, for a connectivity signal the app owns. The built-in monitor already wakes itself, and this run is held too while that monitor reports the path unsatisfied. |
| `health()` | `() -> KizunaSyncSyncHealth` | — | Snapshot of the loop: `phase` (`idle`, `syncing`, `backoff`, `stalled`, `offline`), `consecutiveFailures`, `nextAttemptAt`, `attemptStartedAt`, `lastSuccessAt`, `lastError`, `needsReset`. |
| `onHealth(_:)` | `(@escaping (KizunaSyncSyncHealth) -> Void) -> () -> Void` | — | Calls the listener with the current snapshot, then on every transition. Returns the unsubscribe function. |

## Path monitoring

While `monitorPath` is true the scheduler runs its own `NWPathMonitor` and gates every run on it. An unsatisfied path holds the loop. The first satisfied path after that resumes the loop and wakes a run at once, so a reconnect syncs without extra wiring.

Set `monitorPath` to `false` when the app already tracks reachability.

`start()` arms the monitor and `stop()` cancels it. Turning `monitorPath` off cancels the monitor, reopens the gate, and leaves `notifyOnline()` to the app's own observer instead.

The gate holds every wake reason, so an unsatisfied path stops a foreground wake and a doorbell as surely as it stops a timer wake. Arming the monitor on a device that is already online syncs at once, because the first path the monitor delivers is itself the satisfied report.

Swift gates by default through `NWPathMonitor` under `monitorPath: true`. Kotlin gates when the caller passes `KizunaSyncConnectivityPathMonitor(context)`, because the shared scheduler compiles without the Android SDK. [Kotlin: Host scheduler](../kotlin/scheduler.md#path-monitoring) covers the other side.

## Foreground wake

`observeForeground` defaults to `true`. A scheduler built with no arguments therefore installs `KizunaSyncNotificationForegroundSource` and syncs on every return to the front. That source listens on `UIApplication.didBecomeActiveNotification` where [UIKit](https://developer.apple.com/documentation/uikit) is available and on `NSApplication.didBecomeActiveNotification` otherwise.

`start()` registers it and `stop()` removes the registration. Pass `observeForeground: false`, or a `foregroundSource`, to take it over. An app that turns the default off calls `notifyForeground()` itself, typically from SwiftUI's `scenePhase` or a UIKit lifecycle callback.

`KizunaSyncForegroundSource` is a protocol, `start(onForeground:)` and `stop()`, so a test or an app with its own activation signal can implement it directly. Kotlin has no default source: [Kotlin: Host scheduler](../kotlin/scheduler.md#foreground-wake) covers why.

## Realtime wake

`realtime` is the doorbell the app's own Supabase [Realtime](https://supabase.com/docs/guides/realtime) channel rings. Realtime is a WebSocket, which is outside the Rust engine, so the scheduler takes a port instead of a dependency. `KizunaSyncRealtimeWakeup`'s `subscribe(topics:onWake:)` is called once per configured table, as topic `kizunasync:<table>`, and `onWake` is expected on every broadcast.

`start()` subscribes and `stop()` cancels through the `KizunaSyncRealtimeSubscription` the app returned. `realtimeTables` left empty subscribes to nothing, even with `realtime` set, because a subscription to no table would hold a channel open for messages that cannot arrive.

`KizunaSync` declares no Supabase dependency, so the app writes the adapter. This one uses [`RealtimeChannelV2`](https://supabase.com/docs/reference/swift/subscribe#examples) broadcast:

```swift
// TodoApp/SupabaseRealtimeWakeup.swift
import KizunaSync
import Supabase

final class SupabaseRealtimeWakeup: KizunaSyncRealtimeWakeup {
  private let client: SupabaseClient

  init(client: SupabaseClient) {
    self.client = client
  }

  func subscribe(
    topics: [String],
    onWake: @escaping @Sendable () -> Void
  ) -> KizunaSyncRealtimeSubscription {
    let channels = topics.map { topic -> RealtimeChannelV2 in
      let channel = client.realtimeV2.channel(topic)
      Task {
        for await _ in channel.broadcastStream(event: "changed") {
          onWake()
        }
      }
      return channel
    }
    Task {
      for channel in channels {
        await channel.subscribe()
      }
    }
    return ChannelSubscription(channels: channels)
  }
}

private final class ChannelSubscription: KizunaSyncRealtimeSubscription {
  private let channels: [RealtimeChannelV2]

  init(channels: [RealtimeChannelV2]) {
    self.channels = channels
  }

  func cancel() {
    Task {
      for channel in channels {
        await channel.unsubscribe()
      }
    }
  }
}
```

What the server broadcasts on `kizunasync:<table>` is the app's own database trigger or Edge Function; a message is only a hint, so a dropped socket delays a pull rather than losing one, and the scheduler still polls on its own timer underneath.

## Notes

Runs never overlap: a wake that arrives while a run is in flight is remembered as a single trailing run, which starts once the current one finishes, so a burst of doorbells costs one extra run rather than one per signal.

A failing `sync` closure does not stop the scheduler: the error goes to `onError` and the next wake tries again, which is the behavior an offline device needs. It is dropped when `onError` is unset. Watch the outcome through [Subscribe to events](./on.md) and [Outbox depth](./outbox-depth.md) rather than from the closure's return.

Refreshing before the run is the point of the `refreshSession` step: a backgrounded app whose access token expired would otherwise push with a dead bearer and stall on `42501`. The token it hands over is also how an owner bucket learns its user, as [Set access token](./set-access-token.md#notes) describes. `supabase.auth.session` in the Usage example refreshes an expired token before it answers, and `try?` turns anything it throws, such as a refresh that cannot reach Supabase, into a skipped run. Supabase documents the refresh itself under [`refreshSession`](https://supabase.com/docs/reference/swift/auth-refreshsession#examples) and the lifetimes under [Auth sessions](https://supabase.com/docs/guides/auth/sessions#what-is-a-session). [Start the host scheduler](../../getting-started/native-clients.md#6-start-the-host-scheduler) shows the wiring inside an app, and [Sync goes quiet after sleep, background, or a token expiry](../../operations/troubleshooting.md#sync-goes-quiet-after-sleep-background-or-a-token-expiry) covers what to check when runs stop.

Every arm draws a full jitter fraction from `jitterSource` in `[0, 1)` over the range `[delay / 2, delay]`. Many devices then de-sync rather than stampede a recovering server. A failure streak grows `delay` exponentially, capped at 30 seconds and never below `pollInterval`. A successful run, and any non-poll wake, clears the streak and re-arms the timer at the base interval.

The scheduler refreshes `nextAttemptAt` on every arm and clears it when `stop()` disarms the timer. That clear happens on the main thread. `stop()` called from any other thread hops there to disarm the timer, so a `health()` read immediately after an off-main-thread `stop()` may still report the armed state until that hop lands.

A poll tick that lands while an attempt is in flight is dropped. A second tick on the same attempt marks it `stalled`, counts one failure, books exactly one catch-up run, and re-arms with the grown backoff. `health()` and `onHealth` are the native peer of JavaScript `getSyncHealth` / `onSyncHealth`. They live on the scheduler because that is the loop, not on `KizunaSyncClient`.

`needsReset` is read after every attempt, whether or not the run itself succeeded, and published on `health().needsReset`. A scheduler built with no `needsReset` closure always publishes `false`. Wire it to `client.checkpoint().softBlocked` so a fresh `RESET_REQUIRED`, or the `identity_changed` block a token of another user latches, reaches the snapshot a UI renders. After [Reset](./reset.md), call `wake()`: a reset raises no local write, and the snapshot keeps its last `needsReset` until the next attempt reads it again.

A local write reaches the scheduler through the client's events: `start()` subscribes with [`on`](./on.md), and a `queueDepth` event above zero wakes a run with the reason `.localWrite`, while a depth of zero wakes nothing. The subscription belongs to the engine the client held at `start()`. Calling `create(_:)` again replaces that engine and ends its subscriptions, and a running scheduler does not subscribe again, so call `stop()` and then `start()` after it, which subscribes to the new engine. A subscription the client refuses, as it does before `create(_:)` has built an engine, goes to `onError`, and the timer and the other triggers keep the loop going without the local-write wake.

## Related reference

- [Sync](./sync.md)
- [Set access token](./set-access-token.md)
- [Subscribe to events](./on.md)
- [Outbox depth](./outbox-depth.md)
- [Reset](./reset.md)
- [Checkpoint](./checkpoint.md)
- [Types](./types.md)
- [Kotlin: Host scheduler](../kotlin/scheduler.md)
