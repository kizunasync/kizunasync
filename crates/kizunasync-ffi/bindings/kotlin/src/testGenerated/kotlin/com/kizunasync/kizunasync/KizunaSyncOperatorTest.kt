package com.kizunasync.kizunasync

import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import org.json.JSONArray
import org.json.JSONObject

/**
 * The supabase-kt operators past the core set, each run end to end through
 * the engine: the filters, the count and head options, `stripNulls`, `csv`,
 * the refusals, and the write chains' returning `select`.
 */
class KizunaSyncOperatorTest {
    private suspend fun seeded(): Pair<KizunaSyncClient, KizunaSyncTable> {
        val client = KizunaSyncClient()
        client.create(
            KizunaSyncClientConfig(
                clientId = KSYNC_TEST_CLIENT_ID,
                tables = mapOf("items" to KizunaSyncTableConfig(bucket = KizunaSyncBucket.ByColumn("user_id"))),
                databasePath = Files.createTempDirectory("kizunasync-operators-").resolve("kizunasync.sqlite").toString(),
                remote = KSYNC_TEST_REMOTE,
            ),
        )
        client.setBucket(mapOf("user_id" to "u1"))
        val table = client.from("items")
        table.insert(mapOf("id" to "p1", "title" to "Alpha", "user_id" to "u1", "rank" to 2, "done" to false, "note" to "x", "tags" to "[\"a\",\"b\"]"))
        table.insert(mapOf("id" to "p2", "title" to "beta", "user_id" to "u1", "rank" to 1, "done" to true, "note" to null, "tags" to "[\"c\"]"))
        table.insert(mapOf("id" to "p3", "title" to "Gamma", "user_id" to "u1", "rank" to 3, "done" to false))
        return client to table
    }

    private fun ids(rows: Any?): List<String> {
        val array = rows as? JSONArray ?: return emptyList()
        return (0 until array.length()).map { array.getJSONObject(it).getString("id") }
    }

    private suspend fun assertRefused(code: String, fragment: String, run: suspend () -> Any) {
        val error = assertFailsWith<KizunaSyncError.Engine> { run() }
        assertEquals(code, error.code, error.message)
        assertTrue(error.message.contains(fragment), error.message)
    }

    @Test
    fun theOperatorsPastTheCoreSetSelectTheRowsTheKernelMatches() = runTest {
        val (client, table) = seeded()

        assertEquals(listOf("p1", "p3"), ids(table.select().order("rank").regexMatch("title", "^[AG]").execute()))
        assertEquals(listOf("p2"), ids(table.select().regexIMatch("title", "^BETA$").execute()))
        assertEquals(listOf("p3"), ids(table.select().match(mapOf("done" to false, "rank" to 3)).execute()))
        assertEquals(listOf("p3"), ids(table.select().likeAll("title", listOf("%a%", "%m%")).execute()))
        assertEquals(listOf("p1", "p3"), ids(table.select().order("rank").likeAny("title", listOf("A%", "G%")).execute()))
        assertEquals(listOf("p1"), ids(table.select().ilikeAll("title", listOf("a%", "%A")).execute()))
        assertEquals(listOf("p2"), ids(table.select().ilikeAny("title", listOf("b%")).execute()))
        assertEquals(listOf("p2", "p3"), ids(table.select().order("rank").isDistinct("note", "x").execute()))
        assertEquals(listOf("p1"), ids(table.select().isDistinct("note", null).execute()))
        assertEquals(listOf("p3"), ids(table.select().notIn("id", listOf("p1", "p2")).execute()))
        assertEquals(listOf("p1"), ids(table.select().overlaps("tags", listOf("b", "z")).execute()))
        assertEquals(listOf("p1"), ids(table.select().filter("rank", "gte", "2").filter("title", "not.like", "G*").execute()))
        assertEquals(listOf("p1", "p3"), ids(table.select().order("rank").filter("id", "in", "(p1,p3)").execute()))
        client.dispose()
    }

    @Test
    fun countHeadAndStripNullsShapeTheAnswer() = runTest {
        val (client, table) = seeded()

        val page = table.select("id", count = KizunaSyncCount.Exact).order("rank").range(0, 0).execute() as JSONObject
        assertEquals(3, page.getInt("count"))
        assertEquals(listOf("p2"), ids(page.get("rows")))
        val head = table.select(head = true, count = KizunaSyncCount.Planned).eq("done", false).execute() as JSONObject
        assertEquals(2, head.getInt("count"))
        assertTrue(head.isNull("rows"), head.toString())
        val stripped = table.select("id, note").eq("id", "p2").stripNulls().retry(false).single() as JSONObject
        assertEquals(listOf("id"), stripped.keys().asSequence().toList())
        client.dispose()
    }

    @Test
    fun csvQuotesFieldsAndOrdersTheHeader() = runTest {
        val (client, table) = seeded()
        table.insert(mapOf("id" to "p4", "title" to "a, \"quoted\" title", "user_id" to "u1", "rank" to 4))

        assertEquals("id,title\np2,beta\np1,Alpha\np3,Gamma\np4,\"a, \"\"quoted\"\" title\"", table.select("id, title").order("rank").csv())
        assertEquals("done,id,rank,title,user_id\nfalse,p3,3,Gamma,u1", table.select().eq("id", "p3").csv())
        assertEquals("id", table.select("id").eq("id", "none").csv())
        client.dispose()
    }

    @Test
    fun aMethodWithNoLocalMeaningIsRefusedWhenTheReadRuns() = runTest {
        val (client, table) = seeded()

        assertRefused("LOCAL_UNSUPPORTED", "unsupported filter operator \"cs\"") { table.select().filter("tags", "cs", "{a}").execute() }
        assertRefused("LOCAL_UNSUPPORTED", "unclosed double quote") { table.select().filter("title", "eq", "\"open").execute() }
        assertRefused("LOCAL_UNSUPPORTED", "(a)\\1") { table.select().regexMatch("title", "(a)\\1").execute() }
        assertRefused("LOCAL_UNSUPPORTED", "local writes enter the outbox") { table.select().dryRun().execute() }
        assertRefused("LOCAL_UNSUPPORTED", "PostGIS") { table.select().geojson().single() }
        assertRefused("LOCAL_UNSUPPORTED", "server query planner") { table.select().explain(analyze = true).csv() }
        client.dispose()
    }

    @Test
    fun aWriteSelectReturnsTheRowsItReached() = runTest {
        val (client, table) = seeded()

        val updated = table.update(mapOf("done" to true)).eq("done", false).select("id, done").execute()
        assertEquals(listOf("p1", "p3"), ids(updated))
        assertTrue((0 until updated.length()).all { updated.getJSONObject(it).getBoolean("done") })
        val deleted = table.delete().eq("id", "p2").select("id, title, note").stripNulls().single()
        assertEquals("beta", deleted.getString("title"))
        assertFalse(deleted.has("note"))
        assertEquals(JSONObject.NULL, table.delete().eq("id", "absent").select().maybeSingle())
        assertEquals(listOf("p3"), table.update(mapOf("title" to "x")).notIn("id", listOf("p1")).likeAny("title", listOf("G%")).execute())
        client.dispose()
    }

    @Test
    fun aOneRowOrCappedWriteThatBreaksItsBoundWritesNothing() = runTest {
        val (client, table) = seeded()
        val depth = client.outboxDepth()

        assertRefused("LOCAL_CONSTRAINT", "single() requires exactly one row; got 2") { table.update(mapOf("title" to "z")).eq("done", false).select().single() }
        assertRefused("LOCAL_CONSTRAINT", "single() requires exactly one row; got 0") { table.update(mapOf("title" to "z")).eq("id", "absent").select().single() }
        assertRefused("LOCAL_CONSTRAINT", "maybeSingle() requires at most one row; got 2") { table.delete().eq("done", false).select().maybeSingle() }
        assertRefused("LOCAL_CONSTRAINT", "maxAffected(1)") { table.update(mapOf("title" to "z")).eq("done", false).maxAffected(1).execute() }
        assertRefused("LOCAL_UNSUPPORTED", "maxAffected(-1)") { table.delete().eq("done", false).maxAffected(-1).execute() }
        assertRefused("LOCAL_UNSUPPORTED", "without foreign-key joins") { table.update(mapOf("title" to "z")).eq("id", "p1").select("id, author(name)").execute() }
        assertRefused("LOCAL_UNSUPPORTED", "outbox") { table.update(mapOf("title" to "z")).eq("id", "p1").dryRun().execute() }
        assertEquals(depth, client.outboxDepth())
        assertEquals(listOf("p1", "p3"), table.update(mapOf("title" to "z")).eq("done", false).maxAffected(2).retry(true).execute())
        client.dispose()
    }
}
