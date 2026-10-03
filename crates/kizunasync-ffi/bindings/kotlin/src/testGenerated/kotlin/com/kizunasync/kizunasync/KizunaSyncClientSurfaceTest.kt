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
    fun rangeSkipsThenCapsTheSortedRows() = runTest {
        val client = client(Files.createTempDirectory("kizunasync-surface-"))
        val table = client.from("items")
        for (rank in listOf(4, 2, 5, 1, 3)) {
            table.insert(mapOf("id" to "p$rank", "title" to "t$rank", "user_id" to "u1", "rank" to rank))
        }
        fun ids(rows: Any): List<String> {
            val array = rows as JSONArray
            return (0 until array.length()).map { array.getJSONObject(it).getString("id") }
        }

        assertEquals(listOf("p2", "p3"), ids(table.select().order("rank").range(1, 2).execute()))
        assertEquals(
            emptyList<String>(),
            ids(table.select().order("rank").range(3, 2).execute()),
            "a to one below from keeps no row",
        )
        assertEquals(emptyList<String>(), ids(table.select().order("rank").range(9, 12).execute()))
        assertEquals(
            listOf("p2"),
            ids(table.select().order("rank").range(1, 3).limit(1).execute()),
            "a later limit replaces only the row count",
        )
        assertEquals(
            listOf("p4", "p5"),
            ids(table.select().order("rank").limit(1).range(3, 4).execute()),
            "a later range replaces the offset and the row count",
        )

        val second = table.select().order("rank").range(1, 1).single() as JSONObject
        assertEquals("p2", second.getString("id"))
        assertEquals(JSONObject.NULL, table.select().order("rank").range(5, 9).maybeSingle())
        client.dispose()
    }

    @Test
    fun anInvalidRangeIsLocalUnsupportedWhenTheReadRuns() = runTest {
        val client = client(Files.createTempDirectory("kizunasync-surface-"))
        val table = client.from("items")
        table.insert(mapOf("id" to "p1", "title" to "alpha", "user_id" to "u1"))
        for ((from, to) in listOf(-1 to 2, 0 to -1, 5 to 3)) {
            val error = assertFailsWith<KizunaSyncError.Engine> { table.select().range(from, to).execute() }
            assertEquals("LOCAL_UNSUPPORTED", error.code)
            assertTrue(error.detail.contains("range($from, $to)"), error.message)
        }
        val sticky =
            assertFailsWith<KizunaSyncError.Engine> {
                table.select().range(-1, 2).range(0, 0).single()
            }
        assertEquals("LOCAL_UNSUPPORTED", sticky.code, "an earlier invalid range still refuses the read")
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
    fun anIdThatIsNeitherAStringNorAnIntegerIsLocalConstraint() = runTest {
        val client = client(Files.createTempDirectory("kizunasync-surface-"))
        val error =
            assertFailsWith<KizunaSyncError.Engine> {
                client.from("items").insert(mapOf("id" to 1.5, "title" to "alpha", "user_id" to "u1"))
            }
        assertEquals("LOCAL_CONSTRAINT", error.code)
        assertEquals(0, client.outboxDepth(), "the refused write never reached the outbox")
        client.dispose()
    }

    private suspend fun keyedClient(tables: Map<String, KizunaSyncTableConfig>): KizunaSyncClient {
        val client = KizunaSyncClient()
        client.create(
            KizunaSyncClientConfig(
                clientId = KSYNC_TEST_CLIENT_ID,
                tables = tables,
                databasePath = Files.createTempDirectory("kizunasync-surface-").resolve("kizunasync.sqlite").toString(),
                remote = KSYNC_TEST_REMOTE,
            ),
        )
        return client
    }

    @Test
    fun aCompositeKeyRowIsWrittenAndReadBackByItsKeyColumns() = runTest {
        val client = keyedClient(mapOf("seats" to KizunaSyncTableConfig(key = listOf("hall", "seat"))))
        val seats = client.from("seats")
        seats.insert(mapOf("hall" to 1, "seat" to 12, "holder" to "ada"))

        val rows = seats.select().eq("hall", 1).eq("seat", 12).execute() as JSONArray
        assertEquals(1, rows.length())
        assertEquals("ada", rows.getJSONObject(0).getString("holder"))
        assertTrue(!rows.getJSONObject(0).has("id"), "a composite key adds no id column")
        val queued = client.inspect().getJSONArray("queued")
        assertEquals("""["1", "12"]""", queued.getJSONObject(0).getString("pk"))
        client.dispose()
    }

    @Test
    fun anIntegerIdReadsBackAsTheIntegerItWasWrittenAs() = runTest {
        val client = keyedClient(mapOf("notices" to KizunaSyncTableConfig()))
        val notices = client.from("notices")
        notices.insert(mapOf("id" to 42, "body" to "doors at ten"))

        val rows = notices.select().eq("id", 42).execute() as JSONArray
        assertEquals(1, rows.length())
        assertEquals(42, rows.getJSONObject(0).getInt("id"))
        assertTrue(rows.getJSONObject(0).get("id") is Number, "the key keeps its integer type")
        client.dispose()
    }

    @Test
    fun anUppercaseUuidIdIsStoredAndQueuedLowercase() = runTest {
        val client = client(Files.createTempDirectory("kizunasync-surface-"))
        val id = java.util.UUID.randomUUID().toString().uppercase()
        client.from("items").insert(mapOf("id" to id, "title" to "alpha", "user_id" to "u1"))

        val rows = client.from("items").select().eq("id", id).execute() as JSONArray
        assertEquals(id.lowercase(), rows.getJSONObject(0).getString("id"), "the filter on the key matches in any case")
        val queued = client.inspect().getJSONArray("queued").getJSONObject(0)
        assertEquals(id.lowercase(), queued.getString("pk"))
        assertEquals(id.lowercase(), queued.getJSONObject("columns").getString("id"))
        client.dispose()
    }

    @Test
    fun anInsertMissingAKeyColumnIsRefusedNamingIt() = runTest {
        val client = keyedClient(mapOf("seats" to KizunaSyncTableConfig(key = listOf("hall", "seat"))))
        val error =
            assertFailsWith<KizunaSyncError.Engine> {
                client.from("seats").insert(mapOf("hall" to 1, "holder" to "ada"))
            }
        assertEquals("LOCAL_CONSTRAINT", error.code)
        assertTrue(error.message.orEmpty().contains("\"seat\""), "the refusal names the column, got ${error.message}")
        assertEquals(0, client.outboxDepth())
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
