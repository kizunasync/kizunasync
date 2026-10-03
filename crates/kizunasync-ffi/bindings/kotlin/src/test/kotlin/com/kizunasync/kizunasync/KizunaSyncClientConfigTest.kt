package com.kizunasync.kizunasync

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.json.JSONObject

class KizunaSyncClientConfigTest {
    @Test
    fun encodeOmitsRemoteWhenAbsent() {
        val json =
            KizunaSyncClientConfig(
                clientId = KSYNC_TEST_CLIENT_ID,
                tables = mapOf("todos" to KizunaSyncTableConfig()),
            ).toJson()
        assertEquals(KSYNC_TEST_CLIENT_ID, json.getString("client_id"))
        assertFalse(json.has("remote"))
        assertFalse(json.has("database_path"))
        assertFalse(json.has("default_limit"), "an unset page size leaves limit to the server")
        assertFalse(json.has("attachment_attempts"), "an unset budget leaves the engine's own")
    }

    @Test
    fun encodeWritesTheOptionalEngineKeys() {
        val json =
            KizunaSyncClientConfig(
                clientId = KSYNC_TEST_CLIENT_ID,
                tables = mapOf("todos" to KizunaSyncTableConfig(conflictMode = KizunaSyncConflictMode.Hlc)),
                defaultLimit = 250,
                attachmentAttempts = 3,
            ).toJson()
        assertEquals(250, json.getInt("default_limit"))
        assertEquals(3, json.getInt("attachment_attempts"))
        assertEquals(
            "hlc",
            json.getJSONObject("tables").getJSONObject("todos").getString("conflict_mode"),
        )
    }

    @Test
    fun anArrivalTableCarriesNoConflictMode() {
        val json =
            KizunaSyncClientConfig(
                clientId = KSYNC_TEST_CLIENT_ID,
                tables = mapOf("todos" to KizunaSyncTableConfig()),
            ).toJson()
        assertFalse(
            json.getJSONObject("tables").getJSONObject("todos").has("conflict_mode"),
            "arrival is the engine default, so the key stays off the wire",
        )
    }

    @Test
    fun aPullOnlyTableCarriesItsSyncMode() {
        val json =
            KizunaSyncClientConfig(
                clientId = KSYNC_TEST_CLIENT_ID,
                tables = mapOf("todos" to KizunaSyncTableConfig(syncMode = KizunaSyncSyncMode.PullOnly)),
            ).toJson()
        assertEquals(
            "pull-only",
            json.getJSONObject("tables").getJSONObject("todos").getString("sync_mode"),
        )
    }

    @Test
    fun aTableKeyedByIdCarriesNoKey() {
        val tables =
            KizunaSyncClientConfig(
                clientId = KSYNC_TEST_CLIENT_ID,
                tables =
                    mapOf(
                        "todos" to KizunaSyncTableConfig(),
                        "items" to KizunaSyncTableConfig(key = listOf("id")),
                    ),
            ).toJson().getJSONObject("tables")
        assertFalse(tables.getJSONObject("todos").has("key"), "id is the engine default, so the key stays off the wire")
        assertFalse(tables.getJSONObject("items").has("key"), "an explicit id key sends the same bytes as the default")
    }

    @Test
    fun aTableWithItsOwnKeyCarriesItInKeyOrder() {
        val tables =
            KizunaSyncClientConfig(
                clientId = KSYNC_TEST_CLIENT_ID,
                tables =
                    mapOf(
                        "seats" to KizunaSyncTableConfig(key = listOf("hall", "seat")),
                        "slugs" to KizunaSyncTableConfig(key = listOf("slug")),
                    ),
            ).toJson().getJSONObject("tables")
        assertEquals("""["hall","seat"]""", tables.getJSONObject("seats").getJSONArray("key").toString())
        assertEquals("""["slug"]""", tables.getJSONObject("slugs").getJSONArray("key").toString())
    }

    @Test
    fun aReadWriteTableCarriesNoSyncMode() {
        val json =
            KizunaSyncClientConfig(
                clientId = KSYNC_TEST_CLIENT_ID,
                tables = mapOf("todos" to KizunaSyncTableConfig(syncMode = KizunaSyncSyncMode.ReadWrite)),
            ).toJson()
        assertFalse(
            json.getJSONObject("tables").getJSONObject("todos").has("sync_mode"),
            "read-write is the engine default, so the key stays off the wire",
        )
    }

    @Test
    fun anUnbucketedTableCarriesNoBucketKeys() {
        val todos =
            KizunaSyncClientConfig(
                clientId = KSYNC_TEST_CLIENT_ID,
                tables = mapOf("todos" to KizunaSyncTableConfig()),
            ).toJson().getJSONObject("tables").getJSONObject("todos")
        assertFalse(todos.has("bucket_column"), "a table with no bucket pulls every row RLS allows")
        assertFalse(todos.has("bucket_owner"))
        assertFalse(todos.has("bucket_params"), "bucket values reach the engine through setBucket only")
    }

    @Test
    fun anOwnerBucketNamesItsColumnAndAsksForTheOwner() {
        val todos =
            KizunaSyncClientConfig(
                clientId = KSYNC_TEST_CLIENT_ID,
                tables = mapOf("todos" to KizunaSyncTableConfig(bucket = KizunaSyncBucket.ByOwner("user_id"))),
            ).toJson().getJSONObject("tables").getJSONObject("todos")
        assertEquals("user_id", todos.getString("bucket_column"))
        assertTrue(todos.getBoolean("bucket_owner"), "the engine fills the value from the session")
        assertFalse(todos.has("bucket_params"))
    }

    @Test
    fun aColumnBucketNamesItsColumnAlone() {
        val boards =
            KizunaSyncClientConfig(
                clientId = KSYNC_TEST_CLIENT_ID,
                tables = mapOf("boards" to KizunaSyncTableConfig(bucket = KizunaSyncBucket.ByColumn("team_id"))),
            ).toJson().getJSONObject("tables").getJSONObject("boards")
        assertEquals("team_id", boards.getString("bucket_column"))
        assertFalse(boards.has("bucket_owner"), "the app names the value through setBucket")
        assertFalse(boards.has("bucket_params"))
    }

    @Test
    fun anAbsentClientIdMintsAUuid() {
        val config = KizunaSyncClientConfig(tables = mapOf("todos" to KizunaSyncTableConfig()))
        assertTrue(config.carriesUuidClientId(), "a minted identity is a uuid: ${config.deviceId}")
    }

    @Test
    fun encodeWritesRemoteAndPath() {
        val json =
            KizunaSyncClientConfig(
                clientId = KSYNC_TEST_CLIENT_ID,
                tables = mapOf("todos" to KizunaSyncTableConfig(bucket = KizunaSyncBucket.ByColumn("user_id"))),
                databasePath = "/tmp/kizunasync.sqlite",
                remote = KizunaSyncRemoteConfig(url = "https://example.supabase.co", publishableKey = "pub"),
            ).toJson()
        assertEquals("/tmp/kizunasync.sqlite", json.getString("database_path"))
        assertEquals("https://example.supabase.co", json.getJSONObject("remote").getString("url"))
        assertEquals("pub", json.getJSONObject("remote").getString("publishable_key"))
        assertTrue(json.getJSONObject("tables").getJSONObject("todos").has("bucket_column"))
    }

    @Test
    fun encodeWritesAttachments() {
        val json =
            KizunaSyncClientConfig(
                clientId = KSYNC_TEST_CLIENT_ID,
                tables =
                    mapOf(
                        "todos" to
                            KizunaSyncTableConfig(
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
                attachmentRoot = "/tmp/kizunasync-bytes",
            ).toJson()
        assertEquals("/tmp/kizunasync-bytes", json.getString("attachment_root"))
        val todos = json.getJSONObject("tables").getJSONObject("todos")
        assertEquals(
            "media",
            todos.getJSONObject("attachments").getJSONObject("image").getString("storage_bucket"),
        )
    }

    @Test
    fun queryHelpersCoverTheLocalAst() {
        assertEquals("neq", KizunaSyncQuery.neq("done", true).getString("kind"))
        assertEquals("%plane%", KizunaSyncQuery.ilike("title", "%plane%").getString("pattern"))
        assertEquals("in", KizunaSyncQuery.inValues("id", listOf("a", "b")).getString("kind"))
        assertEquals("or", KizunaSyncQuery.or(KizunaSyncQuery.eq("done", false)).getString("kind"))
        assertEquals("maybeSingle", KizunaSyncQuery.maybeSingle().getString("cardinality"))
    }

    @Test
    fun theSortKeyUsesTheWireName() {
        val ordered = KizunaSyncQuery.order("title", ascending = false, nullsFirst = true)
        assertTrue(ordered.getBoolean("nullsFirst"))
        assertFalse(ordered.has("nulls_first"))
    }

    @Test
    fun theIdentityTestTakesABooleanOrNull() {
        assertTrue(KizunaSyncQuery.isValue("done", true).getBoolean("value"))
        assertEquals(JSONObject.NULL, KizunaSyncQuery.isValue("done", null).get("value"))
    }

    @Test
    fun textSearchCarriesTheClosedParseMode() {
        assertEquals(
            "websearch",
            KizunaSyncQuery.textSearch("title", "plane", KizunaSyncTextSearchType.Websearch).getString("type"),
        )
        assertEquals("plain", KizunaSyncQuery.textSearch("title", "plane").getString("type"))
    }

    @Test
    fun encodeWritesSoftDeleteColumn() {
        val json =
            KizunaSyncClientConfig(
                clientId = KSYNC_TEST_CLIENT_ID,
                tables = mapOf("todos" to KizunaSyncTableConfig(softDeleteColumn = "deleted_at")),
            ).toJson()
        assertEquals(
            "deleted_at",
            json.getJSONObject("tables").getJSONObject("todos").getString("soft_delete_column"),
        )
    }
}
