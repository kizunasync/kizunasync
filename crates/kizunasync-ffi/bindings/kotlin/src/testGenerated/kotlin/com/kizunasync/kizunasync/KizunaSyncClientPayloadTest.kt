package com.kizunasync.kizunasync

import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import org.json.JSONArray
import org.json.JSONObject
import uniffi.kizunasync_ffi.KizunaSyncEngine
import uniffi.kizunasync_ffi.NoHandle

/** Keeps every payload the client hands the engine, without a Rust engine behind it. */
private class RecordingEngine : KizunaSyncEngine(NoHandle) {
    val payloads = CopyOnWriteArrayList<String>()

    override fun create(configJson: String) {}

    override fun apply(mutationJson: String) {
        payloads.add(mutationJson)
    }

    override fun applyWhere(
        table: String,
        op: String,
        filtersJson: String,
        columnsJson: String,
        transformsJson: String,
        preconditionJson: String,
    ): List<String> {
        payloads.addAll(listOf(columnsJson, transformsJson, preconditionJson))
        return emptyList()
    }

    override fun setBucket(paramsJson: String) {
        payloads.add(paramsJson)
    }
}

/**
 * A null value is data: setting a column to NULL, or requiring that a column is
 * NULL, has to reach the engine as an explicit JSON null at every depth.
 */
class KizunaSyncClientPayloadTest {
    private fun assertExplicitNull(json: JSONObject, key: String) {
        assertTrue(json.has(key), "\"$key\" is missing from $json")
        assertTrue(json.isNull(key), "\"$key\" is not null in $json")
    }

    @Test
    fun applyKeepsANullColumnAndANullPrecondition() = runTest {
        val engine = RecordingEngine()
        val client = KizunaSyncClient(engine)
        client.apply(
            table = "todos",
            pk = KSYNC_TEST_ROW_ID,
            op = KizunaSyncOp.Update,
            columns = mapOf("title" to null, "done" to true),
            transforms = mapOf("count" to mapOf("increment" to mapOf("by" to 1))),
            precondition = mapOf("title" to null),
        )
        val mutation = JSONObject(engine.payloads.single())
        assertExplicitNull(mutation.getJSONObject("columns"), "title")
        assertEquals(true, mutation.getJSONObject("columns").getBoolean("done"))
        assertExplicitNull(mutation.getJSONObject("precondition"), "title")
        assertEquals(
            1,
            mutation.getJSONObject("transforms").getJSONObject("count").getJSONObject("increment").getInt("by"),
        )
    }

    @Test
    fun applyWhereKeepsANullInEveryMap() = runTest {
        val engine = RecordingEngine()
        val client = KizunaSyncClient(engine)
        client.applyWhere(
            table = "todos",
            op = KizunaSyncOp.Update,
            filters = JSONArray().put(KizunaSyncQuery.eq("done", false)),
            columns = mapOf("note" to null),
            transforms = mapOf("tally" to null),
            precondition = mapOf("title" to null),
        )
        val (columns, transforms, precondition) = engine.payloads.map(::JSONObject)
        assertExplicitNull(columns, "note")
        assertExplicitNull(transforms, "tally")
        assertExplicitNull(precondition, "title")
    }

    @Test
    fun theWriteBuilderKeepsANullColumn() = runTest {
        val engine = RecordingEngine()
        val client = KizunaSyncClient(engine)
        client.create(
            KizunaSyncClientConfig(clientId = KSYNC_TEST_CLIENT_ID, tables = mapOf("todos" to KizunaSyncTableConfig())),
        )
        client.from("todos").update(mapOf("note" to null)).eq("id", KSYNC_TEST_ROW_ID).execute()
        assertExplicitNull(JSONObject(engine.payloads.first()), "note")
    }

    @Test
    fun setBucketKeepsANullValue() = runTest {
        val engine = RecordingEngine()
        val client = KizunaSyncClient(engine)
        client.setBucket(mapOf("team_id" to null, "user_id" to KSYNC_TEST_OWNER))
        val params = JSONObject(engine.payloads.single())
        assertExplicitNull(params, "team_id")
        assertEquals(KSYNC_TEST_OWNER, params.getString("user_id"))
    }

    @Test
    fun aNestedMapOrListKeepsItsNulls() = runTest {
        val engine = RecordingEngine()
        val client = KizunaSyncClient(engine)
        client.apply(
            table = "todos",
            pk = KSYNC_TEST_ROW_ID,
            op = KizunaSyncOp.Update,
            columns = mapOf("meta" to mapOf("color" to null), "tags" to listOf(null, mapOf("label" to null))),
        )
        val columns = JSONObject(engine.payloads.single()).getJSONObject("columns")
        assertExplicitNull(columns.getJSONObject("meta"), "color")
        val tags = columns.getJSONArray("tags")
        assertEquals(2, tags.length())
        assertTrue(tags.isNull(0), "a null list element survives: $tags")
        assertExplicitNull(tags.getJSONObject(1), "label")
    }
}
