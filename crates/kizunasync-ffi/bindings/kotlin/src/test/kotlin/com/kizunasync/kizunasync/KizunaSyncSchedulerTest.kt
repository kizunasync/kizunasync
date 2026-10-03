package com.kizunasync.kizunasync

import java.lang.reflect.Modifier
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay

class KizunaSyncSchedulerTest {
    private fun scope() = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /**
     * The app assigns these from its own thread while the loop reads them on
     * the scope's threads, so each backing field has to publish a new value.
     */
    @Test
    fun everySettingTheLoopReadsIsVolatile() {
        for (name in listOf("sync", "onError", "pollIntervalMs", "refreshSession")) {
            val field = KizunaSyncScheduler::class.java.getDeclaredField(name)
            assertTrue(Modifier.isVolatile(field.modifiers), "$name is not volatile")
        }
    }

    @Test
    fun foregroundRefreshesThenSyncs() {
        val order = CopyOnWriteArrayList<String>()
        val done = CountDownLatch(1)
        val scheduler =
            KizunaSyncScheduler(
                client = KizunaSyncClient(),
                refreshSession = {
                    order.add("refresh")
                    true
                },
                sync = {
                    order.add("sync")
                    done.countDown()
                },
                pollIntervalMs = 0,
                scope = scope(),
            )
        scheduler.notifyForeground()
        assert(done.await(2, TimeUnit.SECONDS))
        assertEquals(listOf("refresh", "sync"), order.toList())
        scheduler.stop()
    }

    @Test
    fun missingSessionSkipsSync() {
        val order = CopyOnWriteArrayList<String>()
        val done = CountDownLatch(1)
        val scheduler =
            KizunaSyncScheduler(
                client = KizunaSyncClient(),
                refreshSession = {
                    order.add("refresh")
                    done.countDown()
                    false
                },
                sync = { order.add("sync") },
                pollIntervalMs = 0,
                scope = scope(),
            )
        scheduler.wake()
        assert(done.await(2, TimeUnit.SECONDS))
        Thread.sleep(50)
        assertEquals(listOf("refresh"), order.toList())
        scheduler.stop()
    }

    @Test
    fun concurrentWakesRunAtMostTwiceWithoutOverlap() {
        val runCount = AtomicInteger(0)
        val concurrentRuns = AtomicInteger(0)
        val maxConcurrentRuns = AtomicInteger(0)
        val scheduler =
            KizunaSyncScheduler(
                client = KizunaSyncClient(),
                refreshSession = { true },
                sync = {
                    val concurrent = concurrentRuns.incrementAndGet()
                    maxConcurrentRuns.updateAndGet { current -> maxOf(current, concurrent) }
                    runCount.incrementAndGet()
                    delay(50)
                    concurrentRuns.decrementAndGet()
                },
                pollIntervalMs = 0,
                // Real OS threads on the multi-threaded IO pool reproduce the check-then-act race.
                scope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
            )
        val ready = CountDownLatch(1)
        val threads =
            (1..20).map {
                Thread {
                    ready.await()
                    scheduler.wake()
                }
            }
        threads.forEach { it.start() }
        ready.countDown()
        threads.forEach { it.join(2_000) }
        Thread.sleep(300)
        assertEquals(1, maxConcurrentRuns.get())
        assert(runCount.get() <= 2)
        scheduler.stop()
    }

    @Test
    fun healthTracksSuccessAndFailure() {
        val done = CountDownLatch(1)
        val scheduler =
            KizunaSyncScheduler(
                client = KizunaSyncClient(),
                refreshSession = { true },
                sync = {
                    done.countDown()
                    throw KizunaSyncError.Engine("REMOTE_UNAVAILABLE", "offline")
                },
                pollIntervalMs = 0,
                scope = scope(),
            )
        assertEquals(KizunaSyncSyncPhase.Idle, scheduler.health().phase)
        scheduler.wake()
        assert(done.await(2, TimeUnit.SECONDS))
        Thread.sleep(50)
        assertEquals(1, scheduler.health().consecutiveFailures)
        assertEquals(KizunaSyncSyncPhase.Backoff, scheduler.health().phase)
        scheduler.stop()
    }

    @Test
    fun theLastErrorCarriesTheCodeAndTheMessage() {
        val done = CountDownLatch(1)
        val scheduler =
            KizunaSyncScheduler(
                client = KizunaSyncClient(),
                refreshSession = { true },
                sync = {
                    done.countDown()
                    throw KizunaSyncError.Engine("REMOTE_UNAVAILABLE", "offline")
                },
                pollIntervalMs = 0,
                scope = scope(),
            )
        scheduler.wake()
        assert(done.await(2, TimeUnit.SECONDS))
        Thread.sleep(50)
        val failure = scheduler.health().lastError
        assertNotNull(failure)
        assertEquals("REMOTE_UNAVAILABLE", failure.code)
        assertEquals("offline", failure.message)
        assertTrue(failure.at > 0)
        scheduler.stop()
    }

    @Test
    fun anUncodedFailureKeepsItsText() {
        val done = CountDownLatch(1)
        val scheduler =
            KizunaSyncScheduler(
                client = KizunaSyncClient(),
                refreshSession = { true },
                sync = {
                    done.countDown()
                    throw IllegalStateException("offline")
                },
                pollIntervalMs = 0,
                scope = scope(),
            )
        scheduler.wake()
        assert(done.await(2, TimeUnit.SECONDS))
        Thread.sleep(50)
        val failure = scheduler.health().lastError
        assertNotNull(failure)
        assertNull(failure.code)
        assertEquals("offline", failure.message)
        scheduler.stop()
    }

    @Test
    fun everyArmIsJitteredWithinHalfTheDelay() {
        // Read on every arm, so one scheduler can be walked from the low end of
        // the window to the high end.
        val fraction = AtomicReference(0.0)
        val scheduler =
            KizunaSyncScheduler(
                client = KizunaSyncClient(),
                refreshSession = { true },
                sync = {},
                pollIntervalMs = 8_000L,
                scope = scope(),
                jitterSource = { fraction.get() },
            )
        scheduler.start()
        Thread.sleep(80)
        val low = assertNotNull(scheduler.health().nextAttemptAt) - System.currentTimeMillis()
        assertTrue(low in 3_500..4_100, "the low end of the window is half the delay, got $low")

        fraction.set(0.999999)
        scheduler.pollIntervalMs = 8_000L
        Thread.sleep(80)
        val high = assertNotNull(scheduler.health().nextAttemptAt) - System.currentTimeMillis()
        assertTrue(high in 7_500..8_100, "the high end of the window is the whole delay, got $high")
        scheduler.stop()
    }

    @Test
    fun backoffGrowsAfterAFailureAndResetsAfterASuccess() {
        val failing = AtomicBoolean(false)
        val settled = CopyOnWriteArrayList<String>()
        val scheduler =
            KizunaSyncScheduler(
                client = KizunaSyncClient(),
                refreshSession = { true },
                sync = {
                    if (failing.get()) {
                        settled.add("fail")
                        throw KizunaSyncError.Engine("REMOTE_UNAVAILABLE", "offline")
                    }
                    settled.add("ok")
                },
                pollIntervalMs = 4_000L,
                scope = scope(),
                jitterSource = { 0.0 },
            )
        scheduler.start()
        Thread.sleep(80)
        val base = assertNotNull(scheduler.health().nextAttemptAt) - System.currentTimeMillis()
        assertTrue(base in 1_500..2_100, "the base arm is half the interval, got $base")
        assertEquals(listOf("ok"), settled.toList(), "the start attempt succeeded")

        failing.set(true)
        scheduler.wake()
        Thread.sleep(250)
        assertEquals(1, scheduler.health().consecutiveFailures)
        val grown = assertNotNull(scheduler.health().nextAttemptAt) - System.currentTimeMillis()
        assertTrue(grown in 3_500..4_100, "one failure doubles the delay, got $grown")

        failing.set(false)
        scheduler.wake()
        Thread.sleep(250)
        assertEquals(0, scheduler.health().consecutiveFailures)
        val reset = assertNotNull(scheduler.health().nextAttemptAt) - System.currentTimeMillis()
        assertTrue(reset in 1_500..2_100, "a success re-arms at the base interval, got $reset")
        assertEquals(listOf("ok", "fail", "ok"), settled.toList())
        scheduler.stop()
    }

    @Test
    fun theArmedAttemptAdvancesOnEveryTick() {
        val scheduler =
            KizunaSyncScheduler(
                client = KizunaSyncClient(),
                refreshSession = { true },
                sync = {},
                pollIntervalMs = 400L,
                scope = scope(),
                jitterSource = { 0.999999 },
            )
        scheduler.start()
        Thread.sleep(80)
        val first = assertNotNull(scheduler.health().nextAttemptAt)
        Thread.sleep(600)
        val second = assertNotNull(scheduler.health().nextAttemptAt)
        assertTrue(
            second > first,
            "a tick arms the next attempt rather than leaving a timestamp in the past",
        )
        scheduler.stop()
    }

    @Test
    fun stopClearsTheArmedAttemptAndPublishes() {
        val published = CopyOnWriteArrayList<KizunaSyncSyncHealth>()
        val scheduler =
            KizunaSyncScheduler(
                client = KizunaSyncClient(),
                refreshSession = { true },
                sync = {},
                pollIntervalMs = 4_000L,
                scope = scope(),
            )
        val unsubscribe = scheduler.onHealth { health -> published.add(health) }
        scheduler.start()
        Thread.sleep(80)
        assertNotNull(scheduler.health().nextAttemptAt)
        scheduler.stop()
        assertNull(scheduler.health().nextAttemptAt)
        assertNull(published.last().nextAttemptAt, "stop() publishes the disarmed snapshot")
        unsubscribe()
    }

    @Test
    fun aPollTickIsDroppedWhileARunIsInFlight() {
        val gate = CountDownLatch(1)
        val runs = AtomicInteger(0)
        val scheduler =
            KizunaSyncScheduler(
                client = KizunaSyncClient(),
                refreshSession = { true },
                sync = {
                    runs.incrementAndGet()
                    while (gate.count > 0L) {
                        delay(5)
                    }
                },
                pollIntervalMs = 300L,
                scope = scope(),
                jitterSource = { 0.999999 },
            )
        scheduler.start()
        // The start attempt takes the slot, and the first tick finds it busy and is dropped.
        Thread.sleep(450)
        assertEquals(1, runs.get())
        // No further tick can start a run, so anything after the release is a catch-up.
        scheduler.stop()
        gate.countDown()
        Thread.sleep(400)
        assertEquals(1, runs.get(), "a plain poll tick books no catch-up run")
    }

    @Test
    fun twoTicksOnOneAttemptCountAFailureAndBookACatchUpRun() {
        val gate = CountDownLatch(1)
        val runs = AtomicInteger(0)
        val scheduler =
            KizunaSyncScheduler(
                client = KizunaSyncClient(),
                refreshSession = { true },
                sync = {
                    runs.incrementAndGet()
                    while (gate.count > 0L) {
                        delay(5)
                    }
                },
                pollIntervalMs = 300L,
                scope = scope(),
                jitterSource = { 0.999999 },
            )
        scheduler.start()
        // The start attempt takes the slot; the ticks at ~300 and ~600 find it busy, and the second calls it wedged.
        Thread.sleep(800)
        assertEquals(KizunaSyncSyncPhase.Stalled, scheduler.health().phase)
        assertEquals(1, scheduler.health().consecutiveFailures)
        scheduler.stop()
        gate.countDown()
        Thread.sleep(500)
        assertEquals(2, runs.get(), "a stall books exactly one catch-up run")
    }

    @Test
    fun theMonitorRunsForAsLongAsTheSchedulerDoes() {
        val monitor = FakePathMonitor()
        val scheduler =
            KizunaSyncScheduler(
                client = KizunaSyncClient(),
                refreshSession = { true },
                sync = {},
                pollIntervalMs = 0,
                pathMonitor = monitor,
                scope = scope(),
            )
        assertFalse(monitor.started.get())
        scheduler.start()
        assertTrue(monitor.started.get())
        assertEquals(KizunaSyncSyncPhase.Offline, scheduler.health().phase)
        scheduler.stop()
        assertFalse(monitor.started.get())
    }

    @Test
    fun aCancelledMonitorCannotShutTheGate() {
        val monitor = FakePathMonitor()
        val scheduler =
            KizunaSyncScheduler(
                client = KizunaSyncClient(),
                refreshSession = { true },
                sync = {},
                pollIntervalMs = 0,
                pathMonitor = monitor,
                scope = scope(),
            )
        scheduler.start()
        monitor.report(true)
        scheduler.stop()
        monitor.report(false)
        assertTrue(
            scheduler.health().phase != KizunaSyncSyncPhase.Offline,
            "a late report from a cancelled monitor shuts no gate",
        )
    }

    /**
     * The gate a path monitor drives. `KizunaSyncConnectivityPathMonitor` reports
     * `false` for a network that carries internet without validation, on the
     * registered request and on the reading at `start()` alike; that class needs
     * an Android SDK, which this lane unsets, so what runs here is the
     * scheduler's half of the contract.
     */
    @Test
    fun anUnsatisfiedPathHoldsTheLoopAndASatisfiedOneResumesIt() {
        val monitor = FakePathMonitor()
        val runs = AtomicInteger(0)
        val done = CountDownLatch(1)
        val scheduler =
            KizunaSyncScheduler(
                client = KizunaSyncClient(),
                refreshSession = { true },
                sync = {
                    runs.incrementAndGet()
                    done.countDown()
                },
                pollIntervalMs = 0,
                pathMonitor = monitor,
                scope = scope(),
            )
        scheduler.start()
        monitor.report(false)
        scheduler.wake()
        Thread.sleep(200)
        assertEquals(0, runs.get(), "an unsatisfied path holds every run")
        monitor.report(true)
        assertTrue(done.await(2, TimeUnit.SECONDS))
        assertEquals(1, runs.get())
        scheduler.stop()
    }

    @Test
    fun theForegroundSourceWakesTheLoopAndStopReleasesIt() {
        val source = FakeForegroundSource()
        val runs = AtomicInteger(0)
        val started = CountDownLatch(1)
        val done = CountDownLatch(2)
        val scheduler =
            KizunaSyncScheduler(
                client = KizunaSyncClient(),
                refreshSession = { true },
                sync = {
                    runs.incrementAndGet()
                    started.countDown()
                    done.countDown()
                },
                pollIntervalMs = 0,
                scope = scope(),
                foregroundSource = source,
            )
        assertFalse(source.started.get(), "nothing is observed before start()")
        scheduler.start()
        assertTrue(source.started.get())
        assertTrue(started.await(2, TimeUnit.SECONDS), "start runs one attempt")
        Thread.sleep(50)

        source.report()
        assertTrue(done.await(2, TimeUnit.SECONDS), "a return to the front syncs")

        scheduler.stop()
        assertFalse(source.started.get(), "stop() releases the registration")
        source.report()
        Thread.sleep(100)
        assertEquals(2, runs.get(), "a late report from a released source wakes nothing")
    }

    @Test
    fun theRealtimePortSubscribesToEveryConfiguredTable() {
        val port = FakeRealtimeWakeup()
        val started = CountDownLatch(1)
        val done = CountDownLatch(2)
        val scheduler =
            KizunaSyncScheduler(
                client = KizunaSyncClient(),
                refreshSession = { true },
                sync = {
                    started.countDown()
                    done.countDown()
                },
                pollIntervalMs = 0,
                scope = scope(),
                realtime = port,
                realtimeTables = listOf("todos", "lists"),
            )
        scheduler.start()
        assertEquals(listOf("kizunasync:todos", "kizunasync:lists"), port.topics)
        assertTrue(started.await(2, TimeUnit.SECONDS), "start runs one attempt")
        Thread.sleep(50)

        port.deliver()
        assertTrue(done.await(2, TimeUnit.SECONDS), "a realtime message is one sync")

        scheduler.stop()
        assertTrue(port.cancelled.get(), "stop() cancels the subscription")
    }

    @Test
    fun aRealtimePortWithNoTableIsNotSubscribed() {
        val port = FakeRealtimeWakeup()
        val scheduler =
            KizunaSyncScheduler(
                client = KizunaSyncClient(),
                refreshSession = { true },
                sync = {},
                pollIntervalMs = 0,
                scope = scope(),
                realtime = port,
            )
        scheduler.start()
        assertTrue(port.topics.isEmpty(), "a doorbell with nothing to watch holds no channel")
        scheduler.stop()
    }

    @Test
    fun needsResetIsReadAfterEveryAttemptAndPublished() {
        val blocked = AtomicBoolean(false)
        val first = CountDownLatch(1)
        val scheduler =
            KizunaSyncScheduler(
                client = KizunaSyncClient(),
                refreshSession = { true },
                sync = { first.countDown() },
                pollIntervalMs = 0,
                scope = scope(),
                needsResetSource = { blocked.get() },
            )
        assertFalse(scheduler.health().needsReset, "nothing is known before the first attempt")

        scheduler.wake()
        assertTrue(first.await(2, TimeUnit.SECONDS))
        Thread.sleep(100)
        assertFalse(scheduler.health().needsReset)

        blocked.set(true)
        scheduler.wake()
        Thread.sleep(300)
        assertTrue(
            scheduler.health().needsReset,
            "the checkpoint's soft block reaches the snapshot",
        )
        scheduler.stop()
    }

    @Test
    fun aSchedulerWithoutANeedsResetSourceReportsFalse() {
        val done = CountDownLatch(1)
        val scheduler =
            KizunaSyncScheduler(
                client = KizunaSyncClient(),
                refreshSession = { true },
                sync = { done.countDown() },
                pollIntervalMs = 0,
                scope = scope(),
            )
        scheduler.wake()
        assertTrue(done.await(2, TimeUnit.SECONDS))
        Thread.sleep(100)
        assertFalse(scheduler.health().needsReset)
        scheduler.stop()
    }
}

/** Stands in for `KizunaSyncConnectivityPathMonitor`, which needs an Android SDK. */
private class FakePathMonitor : KizunaSyncPathMonitor {
    val started = AtomicBoolean(false)
    private var onSatisfied: ((Boolean) -> Unit)? = null

    override fun start(onSatisfied: (Boolean) -> Unit) {
        started.set(true)
        this.onSatisfied = onSatisfied
    }

    override fun stop() {
        started.set(false)
        onSatisfied = null
    }

    fun report(satisfied: Boolean) {
        onSatisfied?.invoke(satisfied)
    }
}

/** Stands in for `KizunaSyncProcessForegroundSource`, which needs an Android SDK. */
private class FakeForegroundSource : KizunaSyncForegroundSource {
    val started = AtomicBoolean(false)
    private var onForeground: (() -> Unit)? = null

    override fun start(onForeground: () -> Unit) {
        started.set(true)
        this.onForeground = onForeground
    }

    override fun stop() {
        started.set(false)
        onForeground = null
    }

    fun report() {
        onForeground?.invoke()
    }
}

/** Stands in for the app's own Supabase channel. */
private class FakeRealtimeWakeup : KizunaSyncRealtimeWakeup {
    var topics: List<String> = emptyList()
        private set
    val cancelled = AtomicBoolean(false)
    private var onWake: (() -> Unit)? = null

    override fun subscribe(topics: List<String>, onWake: () -> Unit): KizunaSyncRealtimeSubscription {
        this.topics = topics
        this.onWake = onWake
        cancelled.set(false)
        return KizunaSyncRealtimeSubscription {
            cancelled.set(true)
            this.onWake = null
        }
    }

    fun deliver() {
        onWake?.invoke()
    }
}
