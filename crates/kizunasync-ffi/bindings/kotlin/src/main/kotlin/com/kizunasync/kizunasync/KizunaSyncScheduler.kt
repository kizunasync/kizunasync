package com.kizunasync.kizunasync

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import uniffi.kizunasync_ffi.FfiEngineEvent

/** Why an out-of-band sync was requested. */
enum class KizunaSyncWakeReason {
    /** The periodic tick. */
    Poll,

    /** The app came back to the foreground. */
    Foreground,

    /** The network path became satisfied. */
    Path,

    /** The app rang the doorbell, usually from a realtime message. */
    Doorbell,

    /** A local write left the client's outbox with something to push. */
    LocalWrite,

    /** The scheduler started. */
    Start,
}

/** What the automatic loop is doing right now. */
enum class KizunaSyncSyncPhase {
    /** Nothing in flight and no failure streak. */
    Idle,

    /** An attempt is running. */
    Syncing,

    /** The last attempt failed and the next one is armed further out. */
    Backoff,

    /** The attempt in flight has occupied the slot for two ticks. */
    Stalled,

    /** The path gate is shut. */
    Offline,
}

/** The failure the last attempt reported. */
data class KizunaSyncSyncHealthError(
    /** The stable catalog code when the failure carried one, else null. */
    val code: String?,
    /** The failure text. */
    val message: String,
    /** Epoch milliseconds when the client recorded the failure. */
    val at: Long,
)

/** An observable snapshot of the automatic loop. */
data class KizunaSyncSyncHealth(
    /** What the loop is doing right now. */
    val phase: KizunaSyncSyncPhase,
    /** How many attempts have failed in a row. */
    val consecutiveFailures: Int,
    /** Epoch milliseconds of the next armed attempt; null when none is armed. */
    val nextAttemptAt: Long?,
    /** Epoch milliseconds when the attempt now in flight started; null when idle. */
    val attemptStartedAt: Long?,
    /** Epoch milliseconds of the last attempt that settled successfully; null before the first. */
    val lastSuccessAt: Long?,
    /** The failure the last attempt reported; null after a success. */
    val lastError: KizunaSyncSyncHealthError?,
    /**
     * Whether the server has blocked this client until `reset()` runs. It is the
     * checkpoint's soft block, read through the `needsReset` source the app
     * passed; a scheduler built without one reports false.
     */
    val needsReset: Boolean = false,
)

private const val KSYNC_MAX_BACKOFF_MS = 30_000L
private const val KSYNC_STALLED_ATTEMPT_TICKS = 2

/**
 * Network-path source the scheduler gates on. `KizunaSyncConnectivityPathMonitor`
 * is the Android implementation over `ConnectivityManager.NetworkCallback`.
 * The shared scheduler compiles without the Android SDK, so a JVM host has no
 * path to watch, passes no monitor, and runs ungated.
 */
interface KizunaSyncPathMonitor {
    /** Begin reporting. The callback runs with the current state and on every change. */
    fun start(onSatisfied: (Boolean) -> Unit)

    /** Stop reporting. Idempotent. */
    fun stop()
}

/**
 * Host scheduler over one client: it syncs once at start, on its own timer, on
 * every local write to [client], and on the wake sources below. A scheduler
 * given no [sync] runs the client's `sync()`; pass one to run more than that,
 * such as a refresh of what the screen shows. Path and lifecycle stay in the
 * app. [refreshSession] must run before [sync]; a backgrounded process must not
 * poll with an expired JWT.
 * Pass a [pathMonitor] to gate every run on connectivity, or call [notifyOnline]
 * when the app tracks reachability itself. Pass a [foregroundSource] to sync
 * when the app returns to the front. On Android that is the `:android` module's
 * `KizunaSyncProcessForegroundSource` over `ProcessLifecycleOwner`. A plain JVM host
 * has no lifecycle to watch and calls [notifyForeground] itself. [realtime] is
 * the doorbell the app's own Supabase channel rings: the scheduler subscribes to
 * `kizunasync:<table>` for each of [realtimeTables] and syncs on every message.
 * [needsReset] is read after each attempt and published on the health snapshot;
 * wire it to `client.checkpoint().softBlocked`. [jitterSource] draws the jitter
 * fraction in `[0, 1)`; pass a constant in tests to make the armed delay
 * deterministic.
 */
class KizunaSyncScheduler(
    private val client: KizunaSyncClient,
    refreshSession: suspend () -> Boolean,
    sync: suspend () -> Unit = { client.sync() },
    pollIntervalMs: Long = 15_000L,
    private val pathMonitor: KizunaSyncPathMonitor? = null,
    onError: ((Throwable) -> Unit)? = null,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
    private val jitterSource: () -> Double = { Math.random() },
    private val foregroundSource: KizunaSyncForegroundSource? = null,
    private val realtime: KizunaSyncRealtimeWakeup? = null,
    realtimeTables: List<String> = emptyList(),
    private val needsResetSource: (suspend () -> Boolean)? = null,
) {
    private val realtimeTopics: List<String> = realtimeTables.map { "kizunasync:$it" }
    /**
     * The work of one run: the client's `sync()` unless the app passed its own.
     * A swap has to reach a coroutine already scheduled.
     */
    @Volatile
    var sync: suspend () -> Unit = sync

    /**
     * Receives whatever [sync] or [refreshSession] threw, and a local-write
     * subscription the client refused. Unset, a failed run is dropped and the
     * next wake tries again: the behavior an offline device needs.
     */
    @Volatile
    var onError: ((Throwable) -> Unit)? = onError

    /** Assigning restarts a running timer, so a new interval takes effect at once. */
    @Volatile
    var pollIntervalMs: Long = pollIntervalMs
        set(value) {
            field = value
            restartTimerIfRunning()
        }

    /**
     * Assigning restarts a running timer, so the next wake is a full interval
     * away from the swap rather than firing on the old schedule.
     */
    @Volatile
    var refreshSession: suspend () -> Boolean = refreshSession
        set(value) {
            field = value
            restartTimerIfRunning()
        }

    @Volatile
    private var running = false

    /** Open until a monitor is started; the monitor owns the gate while it runs. */
    @Volatile
    private var pathSatisfied = true

    private val inFlight = AtomicBoolean(false)
    private val trailing = AtomicBoolean(false)
    private var pollJob: Job? = null
    private var monitorRunning = false
    private val consecutiveFailures = AtomicInteger(0)
    private val attemptStartedAt = AtomicLong(0)
    private val lastSuccessAt = AtomicLong(0)
    private val lastError = AtomicReference<KizunaSyncSyncHealthError?>(null)
    private val isAttemptStalled = AtomicBoolean(false)
    private val stallTicks = AtomicInteger(0)
    private val nextAttemptAt = AtomicLong(0)
    private val needsReset = AtomicBoolean(false)
    private var foregroundRunning = false
    private var realtimeSubscription: KizunaSyncRealtimeSubscription? = null

    /** Moved by every start and stop, so a subscription or an event from an earlier run is ignored. */
    @Volatile
    private var localWritesGeneration = 0L

    private var releaseLocalWrites: (() -> Unit)? = null
    private val healthListeners = CopyOnWriteArrayList<(KizunaSyncSyncHealth) -> Unit>()

    /**
     * Arm the poll timer, the path monitor, the foreground source, the realtime
     * doorbell and the client's local-write events, then run one attempt, so the
     * first pull does not wait for the first tick. Idempotent.
     */
    @Synchronized
    fun start() {
        if (running) {
            return
        }
        running = true
        // The monitor is armed first, so a throw from it leaves no timer running.
        try {
            startPathMonitor()
        } catch (error: Throwable) {
            running = false
            throw error
        }
        startForegroundSource()
        startRealtime()
        startLocalWrites()
        startTimer()
        wake(KizunaSyncWakeReason.Start)
    }

    /** Disarm every source and publish the disarmed health. */
    @Synchronized
    fun stop() {
        running = false
        pollJob?.cancel()
        pollJob = null
        stopPathMonitor()
        stopForegroundSource()
        stopRealtime()
        stopLocalWrites()
        nextAttemptAt.set(0)
        publishHealth()
    }

    /**
     * Request an attempt now. Every reason other than [KizunaSyncWakeReason.Poll] is
     * fresh external evidence, so it clears the failure streak first.
     */
    fun wake(reason: KizunaSyncWakeReason = KizunaSyncWakeReason.Doorbell) {
        if (reason != KizunaSyncWakeReason.Poll) {
            clearFailures()
        }
        scope.launch { run(reason) }
    }

    /** The loop's current state. */
    fun health(): KizunaSyncSyncHealth = snapshotHealth()

    /**
     * Observe every transition. The handler is called once with the current
     * snapshot. Returns an unsubscribe function.
     */
    fun onHealth(handler: (KizunaSyncSyncHealth) -> Unit): () -> Unit {
        healthListeners.add(handler)
        handler(snapshotHealth())
        return { healthListeners.remove(handler) }
    }

    /**
     * Call when the app returns to the foreground. A scheduler holding a
     * [KizunaSyncForegroundSource] calls it itself.
     */
    fun notifyForeground() {
        wake(KizunaSyncWakeReason.Foreground)
    }

    /** Call when the app tracks reachability itself instead of gating on a monitor. */
    fun notifyOnline() {
        wake(KizunaSyncWakeReason.Path)
    }

    /**
     * The poll loop. Each pass arms the next tick itself, so jitter and backoff
     * are recomputed per arm. The tick dispatches the attempt to its own
     * coroutine; a wedged run cannot hold the loop.
     */
    @Synchronized
    private fun startTimer() {
        pollJob?.cancel()
        pollJob = null
        if (pollIntervalMs <= 0) {
            nextAttemptAt.set(0)
            publishHealth()
            return
        }
        pollJob =
            scope.launch {
                while (isActive && running) {
                    val waitMs = armDelayMs()
                    nextAttemptAt.set(System.currentTimeMillis() + waitMs)
                    publishHealth()
                    delay(waitMs)
                    if (!isActive || !running) {
                        break
                    }
                    wake(KizunaSyncWakeReason.Poll)
                }
            }
    }

    @Synchronized
    private fun restartTimerIfRunning() {
        if (!running) {
            return
        }
        startTimer()
    }

    /**
     * Full jitter in `[delay/2, delay]` so many devices de-sync rather than
     * stampede a recovering server. The streak grows the delay exponentially up
     * to 30 seconds and never below the interval the caller configured, so a
     * deliberately slow poll is never sped up by a failure.
     */
    private fun armDelayMs(): Long {
        val base = pollIntervalMs
        val failures = consecutiveFailures.get()
        val ceiling = maxOf(base, KSYNC_MAX_BACKOFF_MS)
        val grown =
            if (failures <= 0) {
                base
            } else {
                minOf(ceiling, base * (1L shl failures.coerceAtMost(16)))
            }
        val half = grown / 2
        return half + (jitterSource() * half).toLong()
    }

    @Synchronized
    private fun startPathMonitor() {
        val monitor = pathMonitor ?: return
        if (monitorRunning) {
            return
        }
        monitorRunning = true
        pathSatisfied = false
        try {
            monitor.start { satisfied -> updatePath(satisfied) }
        } catch (error: Throwable) {
            monitorRunning = false
            pathSatisfied = true
            throw error
        }
    }

    @Synchronized
    private fun startForegroundSource() {
        val source = foregroundSource ?: return
        if (foregroundRunning) {
            return
        }
        foregroundRunning = true
        try {
            source.start { notifyForeground() }
        } catch (error: Throwable) {
            foregroundRunning = false
            throw error
        }
    }

    @Synchronized
    private fun stopForegroundSource() {
        if (!foregroundRunning) {
            return
        }
        foregroundRunning = false
        foregroundSource?.stop()
    }

    /**
     * Subscribe the doorbell to every configured table's topic. A port with no
     * table to watch is not subscribed at all, because a subscription to nothing
     * would hold a channel open for messages that cannot arrive.
     */
    @Synchronized
    private fun startRealtime() {
        val port = realtime ?: return
        if (realtimeTopics.isEmpty() || realtimeSubscription != null) {
            return
        }
        realtimeSubscription = port.subscribe(realtimeTopics) { wake(KizunaSyncWakeReason.Doorbell) }
    }

    @Synchronized
    private fun stopRealtime() {
        val handle = realtimeSubscription ?: return
        realtimeSubscription = null
        handle.cancel()
    }

    /**
     * Subscribe to the client's queue depth: a local write then syncs without
     * waiting for the next tick. `on` suspends, so each start takes a
     * generation: a subscription that resolves after [stop] or a later [start]
     * is released at once, and its events wake nothing. A refused subscription
     * reaches [onError] while the timer and the other sources keep the loop
     * going.
     */
    @Synchronized
    private fun startLocalWrites() {
        localWritesGeneration += 1
        val generation = localWritesGeneration
        scope.launch {
            val release =
                try {
                    client.on { event -> onClientEvent(event, generation) }
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Throwable) {
                    if (generation == localWritesGeneration) {
                        onError?.invoke(error)
                    }
                    return@launch
                }
            adoptLocalWrites(release, generation)
        }
    }

    private fun onClientEvent(event: FfiEngineEvent, generation: Long) {
        if (event is FfiEngineEvent.QueueDepth && event.depth > 0u && generation == localWritesGeneration) {
            wake(KizunaSyncWakeReason.LocalWrite)
        }
    }

    @Synchronized
    private fun adoptLocalWrites(release: () -> Unit, generation: Long) {
        if (generation == localWritesGeneration && releaseLocalWrites == null) {
            releaseLocalWrites = release
            return
        }
        release()
    }

    @Synchronized
    private fun stopLocalWrites() {
        localWritesGeneration += 1
        val release = releaseLocalWrites ?: return
        releaseLocalWrites = null
        release()
    }

    @Synchronized
    private fun stopPathMonitor() {
        if (!monitorRunning) {
            return
        }
        monitorRunning = false
        pathSatisfied = true
        pathMonitor?.stop()
    }

    @Synchronized
    private fun updatePath(satisfied: Boolean) {
        // A callback already in flight when stop() ran must not shut a gate nothing can reopen.
        if (!monitorRunning) {
            return
        }
        val resumed = satisfied && !pathSatisfied
        pathSatisfied = satisfied
        if (resumed) {
            wake(KizunaSyncWakeReason.Path)
        }
    }

    private suspend fun run(reason: KizunaSyncWakeReason) {
        if (!pathSatisfied) {
            publishHealth()
            return
        }
        if (!beginRun(reason)) {
            return
        }
        attemptStartedAt.set(System.currentTimeMillis())
        isAttemptStalled.set(false)
        stallTicks.set(0)
        publishHealth()

        var failure: Throwable? = null
        var attempted = false
        try {
            val hasSession =
                try {
                    refreshSession()
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Throwable) {
                    onError?.invoke(error)
                    null
                }
            if (hasSession == true) {
                attempted = true
                try {
                    sync()
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Throwable) {
                    failure = error
                    onError?.invoke(error)
                }
            }
        } finally {
            readNeedsReset()
            finishRun(failure, attempted)
        }
    }

    /**
     * Read the checkpoint's soft block after the attempt, so a `RESET_REQUIRED`
     * the server just sent reaches the snapshot the UI renders. A failing read
     * leaves the last answer in place rather than reporting a block nobody saw.
     */
    private suspend fun readNeedsReset() {
        val source = needsResetSource ?: return
        try {
            needsReset.set(source())
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            onError?.invoke(error)
        }
    }

    /**
     * Answers whether this wake owns the in-flight slot. Busy, a wake books the
     * one catch-up run because it is fresh evidence the run under way may
     * predate it, while a plain poll tick is dropped: booking one would turn a
     * sync that merely takes longer than the interval into a back-to-back loop.
     */
    private fun beginRun(reason: KizunaSyncWakeReason): Boolean {
        if (inFlight.compareAndSet(false, true)) {
            return true
        }
        if (reason != KizunaSyncWakeReason.Poll) {
            trailing.set(true)
        } else {
            notePollTickOnBusyAttempt()
        }
        return false
    }

    /**
     * Two ticks on one attempt call it wedged: the eventual settlement is not
     * progress, so it counts a failure, books one catch-up run, and re-arms with
     * the grown backoff. It does not free the slot, because the request is still
     * out there.
     */
    private fun notePollTickOnBusyAttempt() {
        val crossed =
            stallTicks.incrementAndGet() >= KSYNC_STALLED_ATTEMPT_TICKS &&
                isAttemptStalled.compareAndSet(false, true)
        if (!crossed) {
            return
        }
        consecutiveFailures.incrementAndGet()
        trailing.set(true)
        restartTimerIfRunning()
        publishHealth()
    }

    private fun finishRun(failure: Throwable?, attempted: Boolean) {
        attemptStartedAt.set(0)
        isAttemptStalled.set(false)
        stallTicks.set(0)
        var streakMoved = false
        if (attempted) {
            if (failure != null) {
                consecutiveFailures.incrementAndGet()
                lastError.set(healthError(failure))
                streakMoved = true
            } else {
                streakMoved = consecutiveFailures.getAndSet(0) > 0
                lastSuccessAt.set(System.currentTimeMillis())
                lastError.set(null)
            }
        }
        inFlight.set(false)
        val catchUp = trailing.compareAndSet(true, false)
        if (streakMoved || catchUp) {
            restartTimerIfRunning()
        }
        publishHealth()
        if (catchUp) {
            /**
             * The catch-up run is owed to a wake or a stall, not to fresh
             * evidence of its own, so it runs without clearing the streak.
             */
            scope.launch { run(KizunaSyncWakeReason.Doorbell) }
        }
    }

    private fun healthError(error: Throwable): KizunaSyncSyncHealthError {
        val engine = error as? KizunaSyncError.Engine
        val message = engine?.detail ?: error.message ?: error.toString()
        return KizunaSyncSyncHealthError(engine?.code, message, System.currentTimeMillis())
    }

    private fun clearFailures() {
        // Every flag is cleared, so none of these three reads may short-circuit.
        val hadFailures = consecutiveFailures.getAndSet(0) > 0
        val wasStalled = isAttemptStalled.getAndSet(false)
        val hadError = lastError.getAndSet(null) != null
        val moved = hadFailures || wasStalled || hadError
        stallTicks.set(0)
        // The streak decides the armed delay, so clearing it re-arms at the base.
        if (moved) {
            restartTimerIfRunning()
        }
        publishHealth()
    }

    private fun snapshotHealth(): KizunaSyncSyncHealth {
        val started = attemptStartedAt.get().takeIf { it != 0L }
        val phase =
            when {
                !pathSatisfied -> KizunaSyncSyncPhase.Offline
                started != null && isAttemptStalled.get() -> KizunaSyncSyncPhase.Stalled
                started != null -> KizunaSyncSyncPhase.Syncing
                consecutiveFailures.get() > 0 -> KizunaSyncSyncPhase.Backoff
                else -> KizunaSyncSyncPhase.Idle
            }
        return KizunaSyncSyncHealth(
            phase = phase,
            consecutiveFailures = consecutiveFailures.get(),
            nextAttemptAt = nextAttemptAt.get().takeIf { it != 0L },
            attemptStartedAt = started,
            lastSuccessAt = lastSuccessAt.get().takeIf { it != 0L },
            lastError = lastError.get(),
            needsReset = needsReset.get(),
        )
    }

    private fun publishHealth() {
        val snapshot = snapshotHealth()
        for (listener in healthListeners) {
            listener(snapshot)
        }
    }
}
