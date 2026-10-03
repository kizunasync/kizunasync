package com.kizunasync.kizunasync

import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.atomic.AtomicInteger
import java.util.logging.Level
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assumptions.assumeFalse
import uniffi.kizunasync_ffi.FfiEngineEvent

class KizunaSyncInspectorTest {
    private suspend fun client(dir: Path): KizunaSyncClient {
        val client = KizunaSyncClient()
        client.create(
            KizunaSyncClientConfig(
                clientId = KSYNC_TEST_CLIENT_ID,
                tables = mapOf("items" to KizunaSyncTableConfig(bucket = KizunaSyncBucket.ByColumn("user_id"))),
                databasePath = dir.resolve("kizunasync.sqlite").toString(),
                remote = KSYNC_TEST_REMOTE,
            ),
        )
        client.setBucket(mapOf("user_id" to "u1"))
        return client
    }

    @Test
    fun snapshotReadsTheTypedQueue() = runTest {
        val client = client(Files.createTempDirectory("kizunasync-inspector-"))
        client.from("items").insert(mapOf("id" to "p1", "title" to "alpha", "user_id" to "u1"))
        val inspector = client.inspector()
        val queued = inspector.snapshot()
        assertEquals(1, queued.depth)
        assertEquals("0", queued.cursor)
        assertEquals(1, queued.queued.length())
        // The field is the exactly-once push watermark, so it stays null until a push lands.
        assertNull(queued.lastMutationId)
        try {
            client.sync()
        } catch (error: KizunaSyncError.Engine) {
            assumeFalse(
                error.code == "AUTH_SESSION_MISSING" || error.code.startsWith("REMOTE"),
                "queue snapshot across a push needs the offline scripted remote; the packaged build has none",
            )
            throw error
        }
        val pushed = inspector.snapshot()
        assertEquals(0, pushed.depth)
        assertNotNull(pushed.lastMutationId)
        client.dispose()
    }

    @Test
    fun oneInspectorPerClient() = runTest {
        val client = client(Files.createTempDirectory("kizunasync-inspector-"))
        assertSame(client.inspector(), client.inspector())
        client.dispose()
    }

    @Test
    fun theRingRecordsBothRefusalsAndCapsAtFifty() = runTest {
        val client = client(Files.createTempDirectory("kizunasync-inspector-"))
        val inspector = client.inspector()
        assertTrue(inspector.verdicts().isEmpty())

        inspector.record(FfiEngineEvent.MutationRejected("m1", "rls"))
        inspector.record(FfiEngineEvent.BatchAborted("m2", "conflict"))
        inspector.record(FfiEngineEvent.LocalChanged)

        val recorded = inspector.verdicts()
        assertEquals(2, recorded.size, "only a refusal joins the ring")
        assertEquals("m1", recorded[0].mutationId)
        assertEquals(KizunaSyncInspectorVerdictKind.Rejected, recorded[0].kind)
        assertEquals("rls", recorded[0].reason)
        assertEquals("m2", recorded[1].mutationId)
        assertEquals(KizunaSyncInspectorVerdictKind.Aborted, recorded[1].kind)

        for (index in 0 until 60) {
            inspector.record(FfiEngineEvent.MutationRejected("n$index", "rls"))
        }
        val capped = inspector.verdicts()
        assertEquals(50, capped.size)
        assertEquals("n10", capped.first().mutationId, "the ring drops the oldest first")
        assertEquals("n59", capped.last().mutationId)
        client.dispose()
    }

    @Test
    fun theRingRecordsAnOverwrittenColumn() = runTest {
        val client = client(Files.createTempDirectory("kizunasync-inspector-"))
        val inspector = client.inspector()

        inspector.record(
            FfiEngineEvent.ColumnOverwritten(
                table = "items",
                pk = "p1",
                column = "title",
                loserValueJson = "\"mine\"",
                winnerMutationId = "peer-1",
                conflictMode = "hlc",
            ),
        )

        val recorded = inspector.verdicts()
        assertEquals(1, recorded.size)
        assertEquals(KizunaSyncInspectorVerdictKind.Overwritten, recorded[0].kind)
        assertEquals("peer-1", recorded[0].mutationId, "the winner is a peer's write")
        assertEquals("items.title", recorded[0].reason, "the column the peer took")
        client.dispose()
    }

    @Test
    fun subscribeAndClear() = runTest {
        val client = client(Files.createTempDirectory("kizunasync-inspector-"))
        val inspector = client.inspector()
        val changes = AtomicInteger(0)
        val unsubscribe = inspector.subscribe { changes.incrementAndGet() }

        inspector.record(FfiEngineEvent.MutationRejected("m1", "rls"))
        assertEquals(1, changes.get())
        inspector.clear()
        assertEquals(2, changes.get())
        assertTrue(inspector.verdicts().isEmpty())

        unsubscribe()
        inspector.record(FfiEngineEvent.MutationRejected("m2", "rls"))
        assertEquals(2, changes.get(), "an unsubscribed observer hears nothing")
        assertEquals(1, inspector.verdicts().size, "the ring keeps recording")
        client.dispose()
    }

    @Test
    fun aThrowingListenerIsLoggedAndTheOthersStillRun() = runTest {
        val client = client(Files.createTempDirectory("kizunasync-inspector-"))
        val inspector = client.inspector()
        val failure = IllegalStateException("listener bug")
        val later = AtomicInteger(0)
        inspector.subscribe { throw failure }
        inspector.subscribe { later.incrementAndGet() }

        capturingClientLog { capture ->
            inspector.clear()
            inspector.record(FfiEngineEvent.MutationRejected("m1", "rls"))

            assertEquals(2, later.get(), "the listener after the throwing one still ran")
            assertEquals(2, capture.records.size)
            for (record in capture.records) {
                assertEquals(Level.WARNING, record.level)
                assertSame(failure, record.thrown)
            }
        }
        assertEquals(1, inspector.verdicts().size, "the ring keeps recording")
        client.dispose()
    }
}
