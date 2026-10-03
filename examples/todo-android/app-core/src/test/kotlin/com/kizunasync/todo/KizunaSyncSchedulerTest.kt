package com.kizunasync.todo

import com.kizunasync.kizunasync.KizunaSyncClient
import com.kizunasync.kizunasync.KizunaSyncPathMonitor
import com.kizunasync.kizunasync.KizunaSyncScheduler
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/**
 * Long enough that a leftover timer misses every assertion window, short enough
 * to keep the suite under three seconds.
 */
private const val POLL_MS = 1_000L

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

class KizunaSyncSchedulerTest {
    private fun scope() = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @Test
    fun syncFailureReachesOnError() {
        val failures = CopyOnWriteArrayList<String>()
        val done = CountDownLatch(1)
        val scheduler =
            KizunaSyncScheduler(
                client = KizunaSyncClient(),
                refreshSession = { true },
                sync = { throw IllegalStateException("offline") },
                pollIntervalMs = 0,
                onError = { error ->
                    failures.add(error.message ?: "unknown")
                    done.countDown()
                },
                scope = scope(),
                jitterSource = { 1.0 },
            )
        scheduler.wake()
        assertTrue(done.await(2, TimeUnit.SECONDS))
        assertEquals(listOf("offline"), failures.toList())
        scheduler.stop()
    }

    @Test
    fun pollIntervalChangeRestartsTheTimer() {
        // The start attempt, then a tick at the new interval.
        val done = CountDownLatch(2)
        val scheduler =
            KizunaSyncScheduler(
                client = KizunaSyncClient(),
                refreshSession = { true },
                sync = { done.countDown() },
                pollIntervalMs = 60_000L,
                scope = scope(),
                jitterSource = { 1.0 },
            )
        scheduler.start()
        scheduler.pollIntervalMs = 100L
        assertTrue(done.await(2, TimeUnit.SECONDS))
        scheduler.stop()
    }

    @Test
    fun refreshSessionChangeRestartsTheTimer() {
        val refreshes = CopyOnWriteArrayList<String>()
        val scheduler =
            KizunaSyncScheduler(
                client = KizunaSyncClient(),
                refreshSession = {
                    refreshes.add("first")
                    true
                },
                sync = {},
                pollIntervalMs = POLL_MS,
                scope = scope(),
                jitterSource = { 1.0 },
            )
        scheduler.start()
        Thread.sleep(POLL_MS * 7 / 10)
        assertEquals(listOf("first"), refreshes.toList(), "the start attempt refreshes once")
        scheduler.refreshSession = {
            refreshes.add("second")
            true
        }
        Thread.sleep(POLL_MS / 2)
        assertEquals(
            listOf("first"),
            refreshes.toList(),
            "the swap must push the pending wake back a full interval",
        )
        Thread.sleep(POLL_MS * 7 / 10)
        assertEquals(listOf("first", "second"), refreshes.toList())
        scheduler.stop()
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
                jitterSource = { 1.0 },
            )
        assertFalse(monitor.started.get())
        scheduler.start()
        assertTrue(monitor.started.get())
        scheduler.stop()
        assertFalse(monitor.started.get())
    }

    @Test
    fun anUnsatisfiedPathHoldsTheLoop() {
        val monitor = FakePathMonitor()
        val runs = CopyOnWriteArrayList<String>()
        val opened = CountDownLatch(1)
        val scheduler =
            KizunaSyncScheduler(
                client = KizunaSyncClient(),
                refreshSession = { true },
                sync = {
                    runs.add("sync")
                    opened.countDown()
                },
                pollIntervalMs = 0,
                pathMonitor = monitor,
                scope = scope(),
                jitterSource = { 1.0 },
            )
        scheduler.start()
        // The start attempt meets the shut gate before the path reports.
        Thread.sleep(100)
        monitor.report(true)
        assertTrue(opened.await(2, TimeUnit.SECONDS))
        assertEquals(listOf("sync"), runs.toList())
        monitor.report(false)
        scheduler.wake()
        scheduler.notifyForeground()
        Thread.sleep(300)
        assertEquals(listOf("sync"), runs.toList(), "an unsatisfied path holds every later run")
        scheduler.stop()
    }

    @Test
    fun aSatisfiedPathResumesTheLoop() {
        val monitor = FakePathMonitor()
        val done = CountDownLatch(1)
        val runs = CopyOnWriteArrayList<String>()
        val scheduler =
            KizunaSyncScheduler(
                client = KizunaSyncClient(),
                refreshSession = { true },
                sync = {
                    runs.add("sync")
                    done.countDown()
                },
                pollIntervalMs = 0,
                pathMonitor = monitor,
                scope = scope(),
                jitterSource = { 1.0 },
            )
        scheduler.start()
        monitor.report(false)
        Thread.sleep(150)
        assertEquals(emptyList(), runs.toList())
        monitor.report(true)
        assertTrue(done.await(2, TimeUnit.SECONDS))
        assertEquals(listOf("sync"), runs.toList())
        scheduler.stop()
    }
}
