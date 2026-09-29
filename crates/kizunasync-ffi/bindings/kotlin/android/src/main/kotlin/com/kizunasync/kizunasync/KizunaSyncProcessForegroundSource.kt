package com.kizunasync.kizunasync

import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner

/**
 * [KizunaSyncForegroundSource] over `ProcessLifecycleOwner`. Android counterpart of
 * the did-become-active notification Swift observes: the process reports once
 * when it returns to the front, however many activities the app has. A rotation
 * is not a wake.
 *
 * This file is Android-only. The shared `com.kizunasync.kizunasync` sources also
 * compile for the plain JVM, which has no process lifecycle to watch.
 *
 * [lifecycle] defaults to the real process lifecycle. A Robolectric test passes
 * a `TestLifecycleOwner` lifecycle instead; the public no-argument constructor
 * an app uses stays unchanged.
 *
 * Pass one to the scheduler:
 *
 * ```kotlin
 * KizunaSyncScheduler(
 *     client = client,
 *     refreshSession = { true },
 *     foregroundSource = KizunaSyncProcessForegroundSource(),
 * )
 * ```
 */
class KizunaSyncProcessForegroundSource(
    private val lifecycle: Lifecycle = ProcessLifecycleOwner.get().lifecycle,
) : KizunaSyncForegroundSource, DefaultLifecycleObserver {
    private var onForeground: (() -> Unit)? = null

    override fun start(onForeground: () -> Unit) {
        if (this.onForeground != null) {
            return
        }
        this.onForeground = onForeground
        lifecycle.addObserver(this)
    }

    override fun stop() {
        if (onForeground == null) {
            return
        }
        onForeground = null
        lifecycle.removeObserver(this)
    }

    /**
     * `onStart` is the process becoming visible: the transition a sync is owed.
     * `onResume` would also fire for a dialog losing focus.
     */
    override fun onStart(owner: LifecycleOwner) {
        onForeground?.invoke()
    }
}
