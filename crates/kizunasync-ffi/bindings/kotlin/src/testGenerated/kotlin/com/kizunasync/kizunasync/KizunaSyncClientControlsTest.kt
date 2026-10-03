package com.kizunasync.kizunasync

import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import org.json.JSONArray
import org.json.JSONObject
import uniffi.kizunasync_ffi.KizunaSyncEngine
import uniffi.kizunasync_ffi.NoHandle

/** Answers `overwrites` with the rows it holds, without a Rust engine behind it. */
private class JournalEngine(private val rows: JSONArray) : KizunaSyncEngine(NoHandle) {
    override fun call(method: String, paramsJson: String): String =
        JSONObject().put("ok", true).put("value", rows).toString()
}

/**
 * The kernel capabilities the client reaches through the JSON-RPC surface
 * rather than through a typed UniFFI method: the attachment controls, the
 * overwrite journal, and the soft-delete modifier on a read. Each case pins the
 * same answers the shared scenario oracle pins for the same kernel method.
 */
class KizunaSyncClientControlsTest {
    private suspend fun client(dir: Path, table: KizunaSyncTableConfig): KizunaSyncClient {
        val client = KizunaSyncClient()
        client.create(
            KizunaSyncClientConfig(
                clientId = KSYNC_TEST_CLIENT_ID,
                tables = mapOf("items" to table),
                databasePath = dir.resolve("kizunasync.sqlite").toString(),
                remote = KSYNC_TEST_REMOTE,
            ),
        )
        client.setBucket(mapOf("user_id" to "u1"))
        return client
    }

    @Test
    fun anUnknownReferenceAnswersFalseOrNull() = runTest {
        val client =
            client(
                Files.createTempDirectory("kizunasync-controls-"),
                KizunaSyncTableConfig(bucket = KizunaSyncBucket.ByColumn("user_id")),
            )
        assertFalse(client.attachmentRetry("u1/p1/absent.png"), "no row carries the reference")
        assertFalse(client.attachmentCancel("u1/p1/absent.png"))
        assertNull(client.attachmentRemove("u1/p1/absent.png"))
        client.dispose()
    }

    /** One queued upload behind a real client, so a control runs against a row the engine wrote. */
    private suspend fun stage(
        engine: KizunaSyncEngine = KizunaSyncEngine(),
    ): Pair<KizunaSyncClient, KizunaSyncFromFileResult> {
        val dir = Files.createTempDirectory("kizunasync-controls-")
        val source = dir.resolve("photo.bin")
        Files.write(source, "hello-bytes".toByteArray())
        val client = KizunaSyncClient(engine)
        client.create(
            KizunaSyncClientConfig(
                clientId = KSYNC_TEST_CLIENT_ID,
                tables =
                    mapOf(
                        "items" to
                            KizunaSyncTableConfig(
                                bucket = KizunaSyncBucket.ByColumn("user_id"),
                                attachments =
                                    mapOf(
                                        "image" to
                                            KizunaSyncAttachmentSpec(
                                                storageBucket = "media",
                                                ownerColumn = "user_id",
                                            ),
                                    ),
                            ),
                    ),
                databasePath = dir.resolve("kizunasync.sqlite").toString(),
                remote = KSYNC_TEST_REMOTE,
                attachmentRoot = dir.resolve("sandbox").toString(),
            ),
        )
        client.setBucket(mapOf("user_id" to KSYNC_TEST_OWNER))
        client.apply(
            table = "items",
            pk = KSYNC_TEST_ROW_ID,
            op = KizunaSyncOp.Insert,
            columns = mapOf("title" to "pic", "user_id" to KSYNC_TEST_OWNER),
            mutationId = UUID.randomUUID().toString(),
        )
        return client to client.fromFile("items", "image", KSYNC_TEST_ROW_ID, source.toString(), "image/png")
    }

    @Test
    fun cancelKeepsTheRowAndRemoveHandsBackTheSandboxPath() = runTest {
        val (client, imported) = stage()

        assertTrue(client.attachmentCancel(imported.reference))
        val afterCancel = assertNotNull(client.getStatus(imported.reference))
        assertEquals("failed", afterCancel.state)
        assertFalse(afterCancel.permanent, "cancel leaves the row retryable")

        assertTrue(client.attachmentRetry(imported.reference))
        assertEquals("queued", assertNotNull(client.getStatus(imported.reference)).state)

        assertEquals(
            imported.localPath,
            client.attachmentRemove(imported.reference),
            "remove answers the bytes the host still holds",
        )
        assertNull(
            client.getStatus(imported.reference)?.localPath,
            "the row is gone, so the status is the missing placeholder",
        )
        assertNull(client.attachmentRemove(imported.reference), "a second remove answers nothing")
        client.dispose()
    }

    @Test
    fun theStatusCarriesTheFailureCodeAndTheEvictedState() = runTest {
        val engine = KizunaSyncEngine()
        val (client, imported) = stage(engine)
        val queued = assertNotNull(client.getStatus(imported.reference))
        assertEquals("queued", queued.state)
        assertNull(queued.errorCode, "a row with no recorded failure carries no code")

        val patch =
            JSONObject()
                .put("reference", imported.reference)
                .put("patch", JSONObject().put("state", "evicted").put("error", "refused").put("error_code", "TRANSFER"))
        val envelope = JSONObject(engine.call("attachment_patch", patch.toString()))
        assertTrue(envelope.getBoolean("ok"), "the patch was refused: $envelope")

        val evicted = assertNotNull(client.getStatus(imported.reference))
        assertEquals("evicted", evicted.state)
        assertEquals("TRANSFER", evicted.errorCode)
        assertEquals("refused", evicted.error)
        client.dispose()
    }

    @Test
    fun theOverwriteJournalIsEmptyUntilAPeerWins() = runTest {
        val client =
            client(
                Files.createTempDirectory("kizunasync-controls-"),
                KizunaSyncTableConfig(bucket = KizunaSyncBucket.ByColumn("user_id")),
            )
        assertTrue(client.overwrites().isEmpty())
        assertFalse(client.dismissOverwrite(1), "no entry carries that id")
        assertTrue(client.overwrites(includeDismissed = true).isEmpty())
        client.dispose()
    }

    @Test
    fun anOverwriteRowMissingARequiredFieldIsDropped() = runTest {
        val complete =
            JSONObject()
                .put("id", 7)
                .put("table", "items")
                .put("pk", KSYNC_TEST_ROW_ID)
                .put("column", "title")
                .put("loser_value", "mine")
                .put("winner_mutation_id", "peer-1")
                .put("conflict_mode", "arrival")
                .put("at", 1_700_000_000_000L)
        val rows = JSONArray().put(complete)
        for (required in listOf("id", "table", "pk", "column", "winner_mutation_id", "conflict_mode")) {
            rows.put(JSONObject(complete.toString()).apply { remove(required) })
        }
        rows.put(JSONObject(complete.toString()).put("id", "7"))
        rows.put(JSONObject(complete.toString()).put("table", JSONObject.NULL))

        val entries = KizunaSyncClient(JournalEngine(rows)).overwrites()
        assertEquals(1, entries.size, "only the complete row is read: $entries")
        assertEquals(7L, entries.single().id)
    }

    @Test
    fun includeDeletedBringsBackAMarkedRow() = runTest {
        val client =
            client(
                Files.createTempDirectory("kizunasync-controls-"),
                KizunaSyncTableConfig(
                    bucket = KizunaSyncBucket.ByColumn("user_id"),
                    softDeleteColumn = "deleted_at",
                ),
            )
        client.from("items").insert(mapOf("id" to "p1", "title" to "Alpha", "user_id" to "u1"))
        client.from("items").insert(mapOf("id" to "p2", "title" to "Bravo", "user_id" to "u1"))
        client.from("items").delete().eq("id", "p1").execute()

        val visible = client.from("items").select().execute() as JSONArray
        assertEquals(1, visible.length(), "a marked row leaves the default read")
        val all = client.from("items").select().includeDeleted().execute() as JSONArray
        assertEquals(2, all.length())
        val marked = (0 until all.length())
            .map { all.getJSONObject(it) }
            .first { it.optString("id") == "p1" }
        assertFalse(
            marked.isNull("deleted_at"),
            "the delete stamped the column instead of removing the row",
        )
        client.dispose()
    }

    @Test
    fun aNonUuidClientIdIsRefused() = runTest {
        val client = KizunaSyncClient()
        val error =
            assertFailsWith<KizunaSyncError.Engine> {
                client.create(
                    KizunaSyncClientConfig(
                        clientId = "local-dev",
                        tables = mapOf("items" to KizunaSyncTableConfig()),
                    ),
                )
            }
        assertEquals("CONFIG_INVALID", error.code)
    }
}
