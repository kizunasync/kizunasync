package com.kizunasync.kizunasync

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowNetworkCapabilities

/**
 * Runs against Robolectric's `ShadowConnectivityManager`, which drives the
 * real `ConnectivityManager.NetworkCallback` registration and capability
 * reads this class makes; only the physical radio is out of reach here.
 */
@RunWith(RobolectricTestRunner::class)
class KizunaSyncConnectivityPathMonitorTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val connectivity =
        context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    private fun satisfiedCapabilities(): NetworkCapabilities {
        val capabilities = ShadowNetworkCapabilities.newInstance()
        val shadow = shadowOf(capabilities)
        shadow.addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        shadow.addCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        return capabilities
    }

    @Test
    fun armsOnANetworkThatCarriesInternetAndValidated() {
        val active = requireNotNull(connectivity.activeNetwork)
        shadowOf(connectivity).setNetworkCapabilities(active, satisfiedCapabilities())
        val received = mutableListOf<Boolean>()
        val monitor = KizunaSyncConnectivityPathMonitor(context)

        monitor.start { satisfied -> received.add(satisfied) }

        assertEquals(listOf(true), received)
        monitor.stop()
    }

    @Test
    fun ignoresANetworkThatLacksEitherCapability() {
        val active = requireNotNull(connectivity.activeNetwork)
        val capabilities = ShadowNetworkCapabilities.newInstance()
        shadowOf(capabilities).addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        // NET_CAPABILITY_VALIDATED is withheld, so the network stays unsatisfied.
        shadowOf(connectivity).setNetworkCapabilities(active, capabilities)
        val received = mutableListOf<Boolean>()
        val monitor = KizunaSyncConnectivityPathMonitor(context)

        monitor.start { satisfied -> received.add(satisfied) }

        assertEquals(listOf(false), received)
        monitor.stop()
    }

    @Test
    fun reArmsAfterLossThenRegain() {
        val active = requireNotNull(connectivity.activeNetwork)
        shadowOf(connectivity).setNetworkCapabilities(active, satisfiedCapabilities())
        val received = mutableListOf<Boolean>()
        val monitor = KizunaSyncConnectivityPathMonitor(context)
        monitor.start { satisfied -> received.add(satisfied) }
        val callback = shadowOf(connectivity).networkCallbacks.single()

        callback.onLost(active)
        callback.onAvailable(active)

        assertEquals(listOf(true, false, true), received)
        monitor.stop()
    }

    @Test
    fun unregistersItsCallbackOnStop() {
        val monitor = KizunaSyncConnectivityPathMonitor(context)
        monitor.start {}
        assertEquals(1, shadowOf(connectivity).networkCallbacks.size)

        monitor.stop()

        assertTrue(shadowOf(connectivity).networkCallbacks.isEmpty())
    }
}
