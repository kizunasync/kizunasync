package com.kizunasync.kizunasync

import androidx.lifecycle.Lifecycle
import androidx.lifecycle.testing.TestLifecycleOwner
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Drives a `TestLifecycleOwner` through the injected [Lifecycle] seam instead
 * of the real `ProcessLifecycleOwner`, so the transitions run synchronously
 * and deterministically; only the real process lifecycle is out of reach here.
 */
@RunWith(RobolectricTestRunner::class)
class KizunaSyncProcessForegroundSourceTest {
    // Dispatchers.Unconfined runs every mutation on the calling thread, so no
    // Main dispatcher needs to be installed for this test.
    private val owner =
        TestLifecycleOwner(Lifecycle.State.CREATED, Dispatchers.Unconfined)

    @Test
    fun wakesOnTheStartAndResumeTransitions() {
        var wakes = 0
        val source = KizunaSyncProcessForegroundSource(owner.lifecycle)

        source.start { wakes++ }
        owner.currentState = Lifecycle.State.RESUMED

        assertEquals(1, wakes)
        source.stop()
    }

    @Test
    fun staysSilentOnStop() {
        var wakes = 0
        val source = KizunaSyncProcessForegroundSource(owner.lifecycle)
        source.start { wakes++ }
        owner.currentState = Lifecycle.State.RESUMED
        assertEquals(1, wakes)

        owner.currentState = Lifecycle.State.CREATED

        assertEquals(1, wakes)
        source.stop()
    }

    @Test
    fun removesItsObserverOnStopAndWakesNothingAfter() {
        var wakes = 0
        val source = KizunaSyncProcessForegroundSource(owner.lifecycle)
        source.start { wakes++ }
        assertEquals(1, owner.observerCount)

        source.stop()
        owner.currentState = Lifecycle.State.RESUMED

        assertEquals(0, owner.observerCount)
        assertEquals(0, wakes)
    }
}
