package com.kizunasync.kizunasync

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest

/**
 * [KizunaSyncPathMonitor] over `ConnectivityManager.NetworkCallback`. It is the
 * Android twin of the satisfied path Swift reads from `NWPathMonitor`: a
 * network that carries [REQUIRED_CAPABILITIES] reports `true`, and losing it
 * reports `false`. The library manifest carries the `ACCESS_NETWORK_STATE`
 * permission the callback needs.
 *
 * This file is Android-only. The shared `com.kizunasync.kizunasync` sources also
 * compile for the plain JVM, where `android.net` does not exist.
 */
class KizunaSyncConnectivityPathMonitor(context: Context) : KizunaSyncPathMonitor {
    private val connectivity =
        context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE)
            as ConnectivityManager

    private var callback: ConnectivityManager.NetworkCallback? = null

    override fun start(onSatisfied: (Boolean) -> Unit) {
        if (callback != null) {
            return
        }
        onSatisfied(isSatisfiedNow())
        val registered =
            object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    onSatisfied(true)
                }

                override fun onLost(network: Network) {
                    onSatisfied(false)
                }

                override fun onUnavailable() {
                    onSatisfied(false)
                }
            }
        val request = NetworkRequest.Builder()
        for (capability in REQUIRED_CAPABILITIES) {
            request.addCapability(capability)
        }
        connectivity.registerNetworkCallback(request.build(), registered)
        callback = registered
    }

    override fun stop() {
        val registered = callback ?: return
        callback = null
        connectivity.unregisterNetworkCallback(registered)
    }

    /**
     * The active network's capabilities, read once at registration. Without it
     * the gate would stay shut until the first callback happened to arrive. It
     * reads the same [REQUIRED_CAPABILITIES] the request matches on, so a
     * captive portal is unsatisfied on both paths rather than only on this one.
     */
    private fun isSatisfiedNow(): Boolean {
        val active = connectivity.activeNetwork ?: return false
        val capabilities = connectivity.getNetworkCapabilities(active) ?: return false
        return REQUIRED_CAPABILITIES.all { capabilities.hasCapability(it) }
    }

    companion object {
        /**
         * The one capability rule. The registered `NetworkRequest` matches on it
         * and the direct read applies it, so `onAvailable` and the reading at
         * `start()` cannot disagree about the same network.
         */
        val REQUIRED_CAPABILITIES =
            listOf(
                NetworkCapabilities.NET_CAPABILITY_INTERNET,
                NetworkCapabilities.NET_CAPABILITY_VALIDATED,
            )
    }
}
