package com.kizunasync.kizunasync

import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assumptions.assumeFalse
import uniffi.kizunasync_ffi.KizunaSyncFfiException

class KizunaSyncClientAttachmentTest {
    @Test
    fun createWithoutAttachmentRootFailsOnHost() = runTest {
        val client = KizunaSyncClient()
        val error =
            kotlin.test.assertFailsWith<KizunaSyncError.Engine> {
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
                                                    KizunaSyncAttachmentSpec("media", "user_id"),
                                            ),
                                    ),
                            ),
                    ),
                )
            }
        assertEquals(
            "ATTACHMENT_PORTS_MISSING: a table declares attachments but attachmentRoot is unset",
            error.message,
        )
    }

    @Test
    fun fromFileEnqueuesWithoutRemote() = runTest {
        val dir = Files.createTempDirectory("kizunasync-att-")
        val source = dir.resolve("photo.bin")
        Files.write(source, "hello-bytes".toByteArray())
        val client = KizunaSyncClient()
        try {
            client.create(
                KizunaSyncClientConfig(
                    clientId = KSYNC_TEST_CLIENT_ID,
                    tables =
                        mapOf(
                            "items" to
                                KizunaSyncTableConfig(
                                    bucket = KizunaSyncBucket.ByColumn("user_id"),
                                    attachments =
                                        mapOf("image" to KizunaSyncAttachmentSpec("media", "user_id")),
                                ),
                        ),
                    databasePath = dir.resolve("kizunasync.sqlite").toString(),
                    attachmentRoot = dir.resolve("sandbox").toString(),
                ),
            )
        } catch (error: KizunaSyncError.Engine) {
            assumeFalse(
                error.code == "CONFIG_INVALID" && error.detail.contains("remote is required"),
                "packaged build requires a remote",
            )
            throw error
        }
        client.setBucket(mapOf("user_id" to KSYNC_TEST_OWNER))
        client.apply(
            table = "items",
            pk = KSYNC_TEST_ROW_ID,
            op = KizunaSyncOp.Insert,
            columns = mapOf("title" to "pic", "user_id" to KSYNC_TEST_OWNER),
            mutationId = "m1",
        )
        val imported =
            client.fromFile(
                table = "items",
                column = "image",
                pk = KSYNC_TEST_ROW_ID,
                sourcePath = source.toString(),
                mediaType = "image/png",
            )
        val status = client.getStatus(imported.reference)
        assertEquals("queued", status?.state)
        client.sync()
        assertEquals(imported.localPath, client.resolveDownload(imported.reference))
    }

    @Test
    fun applyBeforeCreateHasErrorCode() {
        val engine = uniffi.kizunasync_ffi.KizunaSyncEngine()
        val error =
            kotlin.test.assertFailsWith<KizunaSyncFfiException.Engine> {
                engine.apply("""{"table":"items","pk":"p1","op":"insert"}""")
            }
        assertTrue(error.code.isNotEmpty())
    }
}
