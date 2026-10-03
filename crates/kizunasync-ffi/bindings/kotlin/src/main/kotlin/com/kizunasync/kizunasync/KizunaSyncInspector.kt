package com.kizunasync.kizunasync

import java.util.concurrent.CopyOnWriteArrayList
import org.json.JSONArray
import uniffi.kizunasync_ffi.FfiEngineEvent

/** One coherent read of the local command queue. */
data class KizunaSyncInspectorSnapshot(
    /** The head of the outbox, oldest first. */
    val queued: JSONArray,
    /** How many mutations are still queued, including the ones past the page. */
    val depth: Int,
    /** The most recent mutation the engine recorded, or null before the first. */
    val lastMutationId: String?,
    /** The pull cursor the next pull resumes from. */
    val cursor: String,
    /** The identity this client is registered under. `reset()` mints a new one. */
    val clientId: String,
)

/** Which side of the server's answer produced a verdict. */
enum class KizunaSyncInspectorVerdictKind(val wire: String) {
    /** The server refused one mutation on its own. */
    Rejected("rejected"),

    /** The server refused a whole atomic batch and blamed one member. */
    Aborted("aborted"),

    /** A peer's write won one column and this device's value was replaced. */
    Overwritten("overwritten"),
}

/** One entry of the ring: a server refusal, or a column a peer took. */
data class KizunaSyncInspectorVerdict(
    /**
     * The refused mutation, the member the server blamed for the batch, or the
     * peer write that won the column.
     */
    val mutationId: String,
    /** Which of the three the entry is. */
    val kind: KizunaSyncInspectorVerdictKind,
    /**
     * The server's reason code, or `"<table>.<column>"` for an overwrite: the
     * conflict mode is a configuration fact rather than a verdict.
     */
    val reason: String,
    /** Epoch milliseconds when the client recorded the verdict. */
    val at: Long,
)

private const val KSYNC_VERDICT_RING_CAP = 50

/**
 * Devtools over one client: the queue snapshot the engine answers with, plus a
 * bounded ring of the refusals its event bus reported. Refusals are otherwise
 * transient, so the ring is the only place a UI can read them back.
 *
 * [KizunaSyncClient.inspector] builds and memoizes one per client.
 */
class KizunaSyncInspector internal constructor(
    private val client: KizunaSyncClient,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val lock = Any()
    private val ring = ArrayDeque<KizunaSyncInspectorVerdict>()
    private val listeners = CopyOnWriteArrayList<() -> Unit>()

    @Volatile
    private var unsubscribe: (() -> Unit)? = null

    /**
     * Subscribe the ring to the engine's event bus.
     *
     * @throws KizunaSyncError.Engine the engine's code when the subscription cannot
     * be installed.
     */
    internal suspend fun attach() {
        unsubscribe = client.on { event -> record(event) }
    }

    /** Release the event subscription. Idempotent. */
    internal fun detach() {
        val cancel = unsubscribe
        unsubscribe = null
        cancel?.invoke()
    }

    /**
     * One coherent read of the local command queue.
     *
     * @throws KizunaSyncError.Engine the engine's code when the snapshot cannot be read.
     */
    suspend fun snapshot(): KizunaSyncInspectorSnapshot {
        val raw = client.inspect()
        return KizunaSyncInspectorSnapshot(
            queued = raw.optJSONArray("queued") ?: JSONArray(),
            depth = raw.optInt("depth", 0),
            lastMutationId = if (raw.isNull("last_mutation_id")) null else raw.optString("last_mutation_id"),
            cursor = raw.optString("cursor", ""),
            clientId = raw.optString("client_id", ""),
        )
    }

    /** The refusals the ring holds, oldest first. It keeps the last 50. */
    fun verdicts(): List<KizunaSyncInspectorVerdict> = synchronized(lock) { ring.toList() }

    /**
     * Observe every change to the ring. Returns an unsubscribe function. A throw
     * from [onChange] is logged at `WARNING` on the `com.kizunasync.kizunasync`
     * logger, and the other observers still run.
     */
    fun subscribe(onChange: () -> Unit): () -> Unit {
        listeners.add(onChange)
        return { listeners.remove(onChange) }
    }

    /** Drop the ring. The examples' "reset local" wipes devtools state too. */
    fun clear() {
        synchronized(lock) { ring.clear() }
        notifyListeners()
    }

    /**
     * The event-bus seam. A refusal or an overwrite joins the ring, and every
     * event notifies the observers, because a snapshot read beside the ring may
     * also have moved.
     */
    internal fun record(event: FfiEngineEvent) {
        val verdict =
            when (event) {
                is FfiEngineEvent.MutationRejected ->
                    KizunaSyncInspectorVerdict(
                        mutationId = event.mutationId,
                        kind = KizunaSyncInspectorVerdictKind.Rejected,
                        reason = event.reason,
                        at = now(),
                    )
                is FfiEngineEvent.BatchAborted ->
                    KizunaSyncInspectorVerdict(
                        mutationId = event.offenderMutationId,
                        kind = KizunaSyncInspectorVerdictKind.Aborted,
                        reason = event.reason,
                        at = now(),
                    )
                is FfiEngineEvent.ColumnOverwritten ->
                    KizunaSyncInspectorVerdict(
                        mutationId = event.winnerMutationId,
                        kind = KizunaSyncInspectorVerdictKind.Overwritten,
                        reason = "${event.table}.${event.column}",
                        at = now(),
                    )
                else -> null
            }
        if (verdict != null) {
            synchronized(lock) {
                ring.addLast(verdict)
                while (ring.size > KSYNC_VERDICT_RING_CAP) {
                    ring.removeFirst()
                }
            }
        }
        notifyListeners()
    }

    private fun notifyListeners() {
        for (listener in listeners) {
            try {
                listener()
            } catch (failure: Throwable) {
                logCallbackFailure("inspector listener", failure)
            }
        }
    }
}