package com.kizunasync.kizunasync

import java.nio.file.Files
import java.nio.file.Path
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.logging.Level
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertSame
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import org.json.JSONArray
import org.json.JSONObject
import uniffi.kizunasync_ffi.EventObserver
import uniffi.kizunasync_ffi.FfiEngineEvent
import uniffi.kizunasync_ffi.KizunaSyncEngine
import uniffi.kizunasync_ffi.NoHandle

/** Hands out one subscription, keeps its observer, and counts its release, without a Rust engine behind it. */
private class SubscriptionEngine : KizunaSyncEngine(NoHandle) {
    val released = CountDownLatch(1)

    @Volatile
    var observer: EventObserver? = null

    override fun create(configJson: String) {}

    override fun shutdown() {}

    override fun subscribe(observer: EventObserver): ULong {
        this.observer = observer
        return 7uL
    }

    override fun unsubscribe(subscriptionId: ULong) {
        if (subscriptionId == 7uL) {
            released.countDown()
        }
    }
}

/** An unsigned JWT naming [subject]: the engine reads the claim, and only the server verifies it. */
private fun testToken(subject: String): String {
    val encoder = Base64.getUrlEncoder().withoutPadding()
    val header = encoder.encodeToString("""{"alg":"none"}""".toByteArray())
    val payload = encoder.encodeToString(JSONObject().put("sub", subject).toString().toByteArray())
    return "$header.$payload.unsigned"
}

class KizunaSyncClientSurfaceTest {
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
    fun inspectFromAndDispose() = runTest {
        val client = client(Files.createTempDirectory("kizunasync-surface-"))
        client.from("items").insert(mapOf("title" to "one", "user_id" to "u1", "id" to "p1"))
        val rows = client.from("items").select().eq("id", "p1").execute()
        assertTrue(rows is JSONArray)
        val snapshot = client.inspect()
        assertEquals(1, snapshot.getInt("depth"))
        assertEquals("0", snapshot.getString("cursor"))
        client.dispose()
        assertFailsWith<KizunaSyncError.Engine> { client.outboxDepth() }
    }

    @Test
    fun fromRefusesATableTheConfigNeverDeclared() = runTest {
        val client = client(Files.createTempDirectory("kizunasync-surface-"))
        val error = assertFailsWith<KizunaSyncError.Engine> { client.from("ghosts") }
        assertEquals("UNKNOWN_TABLE", error.code)
        assertTrue(
            error.message.contains("configured: items"),
            "the refusal names the configured tables, got ${error.message}",
        )
        client.dispose()
    }

    @Test
    fun writeBuilderTargetsEveryOperator() = runTest {
        val client = client(Files.createTempDirectory("kizunasync-surface-"))
        val table = client.from("items")
        table.insert(mapOf("id" to "p1", "title" to "alpha", "user_id" to "u1", "rank" to 1, "done" to false))
        table.insert(mapOf("id" to "p2", "title" to "beta", "user_id" to "u1", "rank" to 2, "done" to false))
        table.insert(mapOf("id" to "p3", "title" to "gamma", "user_id" to "u1", "rank" to 3, "done" to true))
        val assign = mapOf("title" to "x")

        assertEquals(listOf("p2"), table.update(assign).eq("rank", 2).execute().sorted())
        assertEquals(listOf("p1", "p3"), table.update(assign).neq("rank", 2).execute().sorted())
        assertEquals(listOf("p3"), table.update(assign).gt("rank", 2).execute().sorted())
        assertEquals(listOf("p2", "p3"), table.update(assign).gte("rank", 2).execute().sorted())
        assertEquals(listOf("p1"), table.update(assign).lt("rank", 2).execute().sorted())
        assertEquals(listOf("p1", "p2"), table.update(assign).lte("rank", 2).execute().sorted())
        assertEquals(listOf("p1"), table.update(assign).like("id", "p1").execute().sorted())
        assertEquals(listOf("p1"), table.update(assign).ilike("id", "P1").execute().sorted())
        assertEquals(listOf("p3"), table.update(assign).isValue("done", true).execute().sorted())
        assertEquals(
            listOf("p1", "p3"),
            table.update(assign).inValues("id", listOf("p1", "p3")).execute().sorted(),
        )
        assertEquals(listOf("p2"), table.update(assign).contains("id", "p2").execute().sorted())
        assertEquals(listOf("p2"), table.update(assign).containedBy("id", "p2").execute().sorted())
        assertEquals(
            listOf("p1", "p2"),
            table.update(assign)
                .or(KizunaSyncQuery.eq("id", "p1"), KizunaSyncQuery.eq("id", "p2"))
                .execute()
                .sorted(),
        )
        assertEquals(
            listOf("p1"),
            table.update(assign)
                .and(KizunaSyncQuery.eq("id", "p1"), KizunaSyncQuery.eq("done", false))
                .execute()
                .sorted(),
        )
        assertEquals(
            listOf("p2", "p3"),
            table.update(assign).not(KizunaSyncQuery.eq("id", "p1")).execute().sorted(),
        )
        assertEquals(listOf("p3"), table.delete().eq("id", "p3").execute())
        client.dispose()
    }

    @Test
    fun anUnfilteredWriteIsLocalUnsupported() = runTest {
        val client = client(Files.createTempDirectory("kizunasync-surface-"))
        val table = client.from("items")
        table.insert(mapOf("id" to "p1", "title" to "alpha", "user_id" to "u1"))
        val error = assertFailsWith<KizunaSyncError.Engine> { table.update(mapOf("title" to "x")).execute() }
        assertEquals("LOCAL_UNSUPPORTED", error.code)
        client.dispose()
    }

    @Test
    fun cardinalityMissesAreLocalConstraint() = runTest {
        val client = client(Files.createTempDirectory("kizunasync-surface-"))
        val table = client.from("items")
        table.insert(mapOf("id" to "p1", "title" to "alpha", "user_id" to "u1"))
        table.insert(mapOf("id" to "p2", "title" to "alpha", "user_id" to "u1"))
        assertEquals(
            "LOCAL_CONSTRAINT",
            assertFailsWith<KizunaSyncError.Engine> {
                table.select().eq("title", "absent").single()
            }.code,
        )
        assertEquals(
            "LOCAL_CONSTRAINT",
            assertFailsWith<KizunaSyncError.Engine> {
                table.select().eq("title", "alpha").maybeSingle()
            }.code,
        )
        client.dispose()
    }

    @Test
    fun anEmbedProjectionIsLocalUnsupported() = runTest {
        val client = client(Files.createTempDirectory("kizunasync-surface-"))
        val table = client.from("items")
        table.insert(mapOf("id" to "p1", "title" to "alpha", "user_id" to "u1"))
        val error = assertFailsWith<KizunaSyncError.Engine> { table.select("title, author(name)").execute() }
        assertEquals("LOCAL_UNSUPPORTED", error.code)
        client.dispose()
    }

    @Test
    fun anEmptyProjectionSegmentIsDropped() = runTest {
        val client = client(Files.createTempDirectory("kizunasync-surface-"))
        val table = client.from("items")
        table.insert(mapOf("id" to "p1", "title" to "alpha", "user_id" to "u1"))
        val rows = table.select("title,,user_id").execute() as JSONArray
        assertEquals(1, rows.length())
        assertEquals(setOf("title", "user_id"), rows.getJSONObject(0).keys().asSequence().toSet())
        client.dispose()
    }

    @Test
    fun aNonStringIdOnInsertIsLocalConstraint() = runTest {
        val client = client(Files.createTempDirectory("kizunasync-surface-"))
        val error =
            assertFailsWith<KizunaSyncError.Engine> {
                client.from("items").insert(mapOf("id" to 7, "title" to "alpha", "user_id" to "u1"))
            }
        assertEquals("LOCAL_CONSTRAINT", error.code)
        client.dispose()
    }

    @Test
    fun anUnsubscribeAfterDisposeAndCreateReachesTheEngine() = runTest {
        val engine = SubscriptionEngine()
        val client = KizunaSyncClient(engine)
        val config =
            KizunaSyncClientConfig(clientId = KSYNC_TEST_CLIENT_ID, tables = mapOf("items" to KizunaSyncTableConfig()))
        client.create(config)
        client.dispose()
        client.create(config)
        val unsubscribe = client.on {}
        unsubscribe()
        assertTrue(
            engine.released.await(5, TimeUnit.SECONDS),
            "the unsubscribe issued after a re-create never reached the engine",
        )
    }

    @Test
    fun aThrowingEventHandlerIsCaughtAndLogged() = runTest {
        val engine = SubscriptionEngine()
        val client = KizunaSyncClient(engine)
        client.create(
            KizunaSyncClientConfig(clientId = KSYNC_TEST_CLIENT_ID, tables = mapOf("items" to KizunaSyncTableConfig())),
        )
        val failure = IllegalStateException("handler bug")
        client.on { throw failure }
        val observer = assertNotNull(engine.observer, "the client never subscribed")

        capturingClientLog { capture ->
            observer.onEvent(FfiEngineEvent.LocalChanged)
            val record = capture.records.single()
            assertEquals(Level.WARNING, record.level)
            assertSame(failure, record.thrown)
        }
    }

    @Test
    fun aPullOnlyTableRefusesALocalWrite() = runTest {
        val dir = Files.createTempDirectory("kizunasync-surface-")
        val client = KizunaSyncClient()
        client.create(
            KizunaSyncClientConfig(
                clientId = KSYNC_TEST_CLIENT_ID,
                tables =
                    mapOf(
                        "items" to
                            KizunaSyncTableConfig(
                                bucket = KizunaSyncBucket.ByColumn("user_id"),
                                syncMode = KizunaSyncSyncMode.PullOnly,
                            ),
                    ),
                databasePath = dir.resolve("kizunasync.sqlite").toString(),
                remote = KSYNC_TEST_REMOTE,
            ),
        )
        val error =
            assertFailsWith<KizunaSyncError.Engine> {
                client.from("items").insert(mapOf("title" to "alpha", "user_id" to "u1"))
            }
        assertEquals("LOCAL_UNSUPPORTED", error.code)
        assertEquals(0, client.outboxDepth(), "the refused write never reached the outbox")
        client.dispose()
    }

    @Test
    fun anOwnerBucketTakesTheSessionUser() = runTest {
        val dir = Files.createTempDirectory("kizunasync-surface-")
        val client = KizunaSyncClient()
        client.create(
            KizunaSyncClientConfig(
                clientId = KSYNC_TEST_CLIENT_ID,
                tables = mapOf("items" to KizunaSyncTableConfig(bucket = KizunaSyncBucket.ByOwner("user_id"))),
                databasePath = dir.resolve("kizunasync.sqlite").toString(),
                remote = KSYNC_TEST_REMOTE,
            ),
        )
        client.setAccessToken(testToken(subject = KSYNC_TEST_OWNER))
        client.from("items").insert(mapOf("id" to KSYNC_TEST_ROW_ID, "title" to "works on a plane"))

        val rows = client.from("items").select().eq("id", KSYNC_TEST_ROW_ID).execute() as JSONArray
        assertEquals(KSYNC_TEST_OWNER, rows.getJSONObject(0).opt("user_id"), "the local row carries the session user")
        val queued = client.inspect().getJSONArray("queued")
        assertEquals(
            KSYNC_TEST_OWNER,
            queued.getJSONObject(0).getJSONObject("columns").opt("user_id"),
            "the queued insert carries the session user",
        )

        try {
            client.pullOnce()
        } catch (error: KizunaSyncError.Engine) {
            assertNotEquals("BUCKET_UNSET", error.code, "an owner bucket needs no setBucket")
        }
        client.dispose()
    }

    @Test
    fun aMintedIdIsNotWrittenIntoTheColumnMap() = runTest {
        val client = client(Files.createTempDirectory("kizunasync-surface-"))
        val table = client.from("items")
        table.insert(mapOf("title" to "alpha", "user_id" to "u1"))
        val rows = table.select().execute() as JSONArray
        assertEquals(1, rows.length())
        val pk = rows.getJSONObject(0).getString("id")
        assertNotNull(pk)
        assertEquals(pk.lowercase(), pk, "a minted key is a lowercase uuid")
        client.dispose()
    }
}
