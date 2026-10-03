package com.kizunasync.kizunasync

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import uniffi.kizunasync_ffi.EventObserver
import uniffi.kizunasync_ffi.FfiEngineEvent
import uniffi.kizunasync_ffi.KizunaSyncEngine
import uniffi.kizunasync_ffi.KizunaSyncFfiException
import uniffi.kizunasync_ffi.NoHandle

private val SUBSCRIPTION_ID: ULong = 7uL

/**
 * Hands out one event subscription, keeps its observer, counts `sync()`, and
 * records every release, without a Rust engine behind it. The observer stays
 * after a release, so a test can deliver an event the engine had already
 * dispatched.
 */
private class EventEngine(private val refusesSubscriptions: Boolean = false) : KizunaSyncEngine(NoHandle) {
    val syncs = AtomicInteger(0)
    val released = CopyOnWriteArrayList<ULong>()

    @Volatile
    var observer: EventObserver? = null

    override fun subscribe(observer: EventObserver): ULong {
        if (refusesSubscriptions) {
            throw KizunaSyncFfiException.Engine("ENGINE_UNAVAILABLE", "no engine")
        }
        this.observer = observer
        return SUBSCRIPTION_ID
    }

    override fun unsubscribe(subscriptionId: ULong) {
        released.add(subscriptionId)
    }

    override fun sync() {
        syncs.incrementAndGet()
    }

    /** Deliver one event the way the engine's delivery thread does. */
    fun emit(event: FfiEngineEvent) {
        observer?.onEvent(event)
    }
}

class KizunaSyncSchedulerClientTest {
    private fun scope() = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @Test
    fun syncDefaultsToTheClient() {
        val engine = EventEngine()
        val scheduler =
            KizunaSyncScheduler(
                client = KizunaSyncClient(engine),
                refreshSession = { true },
                pollIntervalMs = 0,
                scope = scope(),
            )
        scheduler.wake()
        Thread.sleep(200)
        assertEquals(1, engine.syncs.get(), "a scheduler given no sync runs the client's")
        scheduler.stop()
    }

    @Test
    fun startRunsOneAttemptRightAway() {
        val runs = AtomicInteger(0)
        val scheduler =
            KizunaSyncScheduler(
                client = KizunaSyncClient(EventEngine()),
                refreshSession = { true },
                sync = { runs.incrementAndGet() },
                pollIntervalMs = 60_000L,
                scope = scope(),
            )
        scheduler.start()
        Thread.sleep(300)
        assertEquals(1, runs.get(), "the first sync does not wait for the first tick")
        scheduler.stop()
    }

    @Test
    fun aQueueDepthAboveZeroWakesTheLoopAndZeroDoesNot() {
        val engine = EventEngine()
        val runs = AtomicInteger(0)
        val scheduler =
            KizunaSyncScheduler(
                client = KizunaSyncClient(engine),
                refreshSession = { true },
                sync = { runs.incrementAndGet() },
                pollIntervalMs = 0,
                scope = scope(),
            )
        scheduler.start()
        Thread.sleep(200)
        assertNotNull(engine.observer, "start subscribes to the client's events")
        assertEquals(1, runs.get())

        engine.emit(FfiEngineEvent.QueueDepth(0u))
        Thread.sleep(200)
        assertEquals(1, runs.get(), "an empty outbox has nothing to push")

        engine.emit(FfiEngineEvent.QueueDepth(1u))
        Thread.sleep(200)
        assertEquals(2, runs.get(), "a local write syncs without waiting for a tick")
        scheduler.stop()
    }

    @Test
    fun stopReleasesTheEventSubscription() {
        val engine = EventEngine()
        val runs = AtomicInteger(0)
        val scheduler =
            KizunaSyncScheduler(
                client = KizunaSyncClient(engine),
                refreshSession = { true },
                sync = { runs.incrementAndGet() },
                pollIntervalMs = 0,
                scope = scope(),
            )
        scheduler.start()
        Thread.sleep(200)
        assertTrue(engine.released.isEmpty(), "the subscription lives while the scheduler runs")

        scheduler.stop()
        Thread.sleep(200)
        assertEquals(listOf(SUBSCRIPTION_ID), engine.released.toList(), "stop releases the subscription start made")

        engine.emit(FfiEngineEvent.QueueDepth(1u))
        Thread.sleep(200)
        assertEquals(1, runs.get(), "an event delivered after stop wakes nothing")
    }

    @Test
    fun aSubscriptionTheClientRefusesReachesOnError() {
        val failures = CopyOnWriteArrayList<String>()
        val scheduler =
            KizunaSyncScheduler(
                client = KizunaSyncClient(EventEngine(refusesSubscriptions = true)),
                refreshSession = { true },
                sync = {},
                pollIntervalMs = 0,
                onError = { error -> failures.add((error as? KizunaSyncError.Engine)?.code ?: "uncoded") },
                scope = scope(),
            )
        scheduler.start()
        Thread.sleep(200)
        assertEquals(listOf("ENGINE_UNAVAILABLE"), failures.toList())
        scheduler.stop()
    }
}
