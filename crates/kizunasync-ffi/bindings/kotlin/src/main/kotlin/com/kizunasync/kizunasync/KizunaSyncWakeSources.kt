package com.kizunasync.kizunasync

/** A subscription the scheduler holds and releases. [cancel] is idempotent. */
fun interface KizunaSyncRealtimeSubscription {
    /** Stop delivering. Calling it twice is a no-op. */
    fun cancel()
}

/**
 * The realtime doorbell, implemented by the app.
 *
 * Supabase Realtime is a WebSocket, which is outside the Rust engine, so these
 * bindings take a port instead of a dependency: the app owns the channel and
 * rings the doorbell, and the scheduler turns that into one sync. The topic of a
 * table is `kizunasync:<table>`. The README carries a supabase-kt adapter the app
 * copies.
 */
interface KizunaSyncRealtimeWakeup {
    /**
     * Subscribe to [topics] and call [onWake] on every message. The handle stops
     * the subscription.
     */
    fun subscribe(topics: List<String>, onWake: () -> Unit): KizunaSyncRealtimeSubscription
}

/**
 * The return-to-foreground source the scheduler wakes on. The plain JVM has no
 * application lifecycle to watch, so a JVM host passes none and calls
 * [KizunaSyncScheduler.notifyForeground] itself; an Android app passes
 * `KizunaSyncProcessForegroundSource`, which is the `:android` module's
 * `ProcessLifecycleOwner` implementation of this interface.
 */
interface KizunaSyncForegroundSource {
    /** Begin reporting. [onForeground] runs on every return to the front. */
    fun start(onForeground: () -> Unit)

    /** Stop reporting. Idempotent. */
    fun stop()
}
