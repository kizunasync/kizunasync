package com.kizunasync.kizunasync

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlinx.coroutines.test.runTest
import uniffi.kizunasync_ffi.KizunaSyncEngine
import uniffi.kizunasync_ffi.KizunaSyncFfiException
import uniffi.kizunasync_ffi.NoHandle

/**
 * Answers `inspect()` with a JSON array, so the client's decode refuses the
 * payload instead of the engine refusing the call.
 */
private class NonObjectInspectEngine : KizunaSyncEngine(NoHandle) {
    override fun inspect(): String = "[1, 2]"
}

/**
 * Raises one engine failure without a Rust engine behind it, so the mapping is
 * tested rather than the engine's own verdict.
 */
private class FailingEngine(
    private val code: String,
    private val msg: String,
) : KizunaSyncEngine(NoHandle) {
    override fun queryTable(table: String, planJson: String): String =
        throw KizunaSyncFfiException.Engine(code, msg)

    override fun sync(): Unit = throw KizunaSyncFfiException.Engine(code, msg)
}

/**
 * The code every failure carries, engine and host alike. The two host
 * conditions the type documents as Swift-only have no Kotlin site to test:
 * `JSONObject.toString` cannot emit bytes outside UTF-8.
 */
class KizunaSyncClientErrorTest {
    @Test
    fun engineFailureCarriesTheCodeAsAField() = runTest {
        val client = KizunaSyncClient(FailingEngine("UNKNOWN_TABLE", "no such table"))
        val error = assertFailsWith<KizunaSyncError.Engine> { client.query("todos") }
        assertEquals("UNKNOWN_TABLE", error.code)
        assertEquals("no such table", error.detail)
        assertEquals("UNKNOWN_TABLE: no such table", error.message)
    }

    @Test
    fun everyCallSiteMapsTheSameWay() = runTest {
        val client = KizunaSyncClient(FailingEngine("ENGINE_UNAVAILABLE", "not created"))
        val error = assertFailsWith<KizunaSyncError.Engine> { client.sync() }
        assertEquals("ENGINE_UNAVAILABLE", error.code)
        assertEquals("ENGINE_UNAVAILABLE: not created", error.message)
    }

    @Test
    fun anUndecodableInspectPayloadIsEngineUnavailable() = runTest {
        val client = KizunaSyncClient(NonObjectInspectEngine())
        val error = assertFailsWith<KizunaSyncError.Engine> { client.inspect() }
        assertEquals("ENGINE_UNAVAILABLE", error.code)
        assertEquals("ENGINE_UNAVAILABLE: inspect: expected an object", error.message)
    }

    @Test
    fun aHostCheckCarriesACatalogCodeToo() = runTest {
        val client = KizunaSyncClient(KizunaSyncEngine(NoHandle))
        val error = assertFailsWith<KizunaSyncError.Engine> {
            client.apply(table = "", pk = "", op = KizunaSyncOp.Insert)
        }
        assertEquals("LOCAL_UNSUPPORTED", error.code)
        assertEquals("LOCAL_UNSUPPORTED: apply requires table and pk", error.message)
    }

    @Test
    fun attachmentPortsMissingIsAKizunaSyncError() = runTest {
        val client = KizunaSyncClient(KizunaSyncEngine(NoHandle))
        val error =
            assertFailsWith<KizunaSyncError.Engine> {
                client.create(
                    KizunaSyncClientConfig(
                        clientId = KSYNC_TEST_CLIENT_ID,
                        tables =
                            mapOf(
                                "items" to
                                    KizunaSyncTableConfig(
                                        attachments =
                                            mapOf("image" to KizunaSyncAttachmentSpec("media", "user_id")),
                                    ),
                            ),
                    ),
                )
            }
        assertEquals("ATTACHMENT_PORTS_MISSING", error.code)
        assertEquals(
            "ATTACHMENT_PORTS_MISSING: a table declares attachments but attachmentRoot is unset",
            error.message,
        )
    }
}
