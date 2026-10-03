package com.kizunasync.kizunasync

/**
 * Errors raised by the Kizuna Kotlin app client.
 *
 * [Engine.code] is the stable catalog code an app switches on. It is the value
 * the engine reported, or the code the host itself assigns to a check it makes
 * before the call reaches the engine. [Engine.message] is always
 * `"CODE: message"`, the same payload Swift's `KizunaSyncError.engine` carries.
 *
 * Five conditions the host raises on its own, with the code each carries:
 *
 * - `CONFIG_INVALID`, `config is not utf8`: the encoded configuration is not
 *   text the engine can read. Swift only; `JSONObject.toString` cannot produce
 *   bytes outside UTF-8.
 * - `ENGINE_UNAVAILABLE`, `payload is not utf8`: the encoded call payload is
 *   not text the engine can read. Swift only, for the same reason.
 * - `ENGINE_UNAVAILABLE`, `inspect: expected an object` or
 *   `<method>: unreadable envelope`: the bridge answered with bytes the client
 *   cannot decode, which is the same class of fault as a missing engine
 *   artifact.
 * - `LOCAL_UNSUPPORTED`, `apply requires table and pk`, a builder call the
 *   client records and throws when the read or write runs (`range(<from>, <to>)`,
 *   `filter(...)`, `maxAffected(<n>)`, `select("<embed>")`, `dryRun()`,
 *   `geojson()`, `explain()`), each message naming the call and why: a local
 *   request the client refuses, the class the kernel uses for a request it
 *   cannot answer.
 *
 * `ATTACHMENT_PORTS_MISSING`, `UNKNOWN_TABLE` and the `CONFIG_INVALID` a client
 * id that is not a uuid carries are the other codes the host raises itself.
 * Every remaining code arrives from the engine unchanged.
 */
sealed class KizunaSyncError(override val message: String) : Exception(message) {
    /** One engine failure, carrying the catalog code an app switches on. */
    class Engine(val code: String, message: String) : KizunaSyncError("$code: $message") {
        /** The failure text without the code prefix; [message] keeps the prefix. */
        val detail: String = message
    }
}

/**
 * Catalog codes the client raises before a call reaches the engine. Every other
 * code arrives from the engine and is carried through unchanged. The conditions
 * behind these codes are listed on [KizunaSyncError].
 */
internal object KizunaSyncErrorCode {
    const val ATTACHMENT_PORTS_MISSING = "ATTACHMENT_PORTS_MISSING"
    const val UNKNOWN_TABLE = "UNKNOWN_TABLE"
    const val ENGINE_UNAVAILABLE = "ENGINE_UNAVAILABLE"
    const val LOCAL_UNSUPPORTED = "LOCAL_UNSUPPORTED"
    const val CONFIG_INVALID = "CONFIG_INVALID"
}
