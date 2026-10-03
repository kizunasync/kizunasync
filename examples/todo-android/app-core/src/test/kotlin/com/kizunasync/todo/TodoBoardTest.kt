package com.kizunasync.todo

import com.kizunasync.kizunasync.KizunaSyncClient
import com.kizunasync.kizunasync.KizunaSyncOp
import java.nio.file.Files
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlinx.coroutines.test.runTest
import org.json.JSONArray

class TodoBoardTest {
    @Test
    fun sharedBoardOmitsRemoteWithoutCredentials() {
        val json =
            TodoBoard.clientConfig(
                clientId = TODO_TEST_CLIENT_ID,
                databasePath = "/tmp/kizunasync-todos.sqlite",
            ).toJson()
        assertEquals("/tmp/kizunasync-todos.sqlite", json.getString("database_path"))
        assertFalse(json.has("remote"))
        assert(json.getJSONObject("tables").has(TodoBoard.TABLE))
    }

    @Test
    fun createApplyQueryOnFileStore() = runTest {
        val dir = Files.createTempDirectory("todo-android-")
        val path = dir.resolve("kizunasync.sqlite").toString()
        val client = KizunaSyncClient()
        client.create(
            TodoBoard.clientConfig(
                clientId = TODO_TEST_CLIENT_ID,
                databasePath = path,
                supabaseUrl = TODO_TEST_REMOTE_URL,
                publishableKey = TODO_TEST_REMOTE_PUBLISHABLE_KEY,
            ),
        )
        val pk = UUID.randomUUID().toString()
        client.apply(
            table = TodoBoard.TABLE,
            pk = pk,
            op = KizunaSyncOp.Insert,
            columns = mapOf("title" to "works on a plane", "user_id" to "user-1", "done" to false),
            mutationId = UUID.randomUUID().toString(),
        )
        assertEquals(1, client.outboxDepth())

        val reopened = KizunaSyncClient()
        reopened.create(
            TodoBoard.clientConfig(
                clientId = TODO_TEST_CLIENT_ID,
                databasePath = path,
                supabaseUrl = TODO_TEST_REMOTE_URL,
                publishableKey = TODO_TEST_REMOTE_PUBLISHABLE_KEY,
            ),
        )
        val rows = reopened.query(TodoBoard.TABLE) as JSONArray
        assertEquals(1, rows.length())
    }

    @Test
    fun clampedTitleKeepsATitleWithinTheLimit() {
        assertEquals("Buy milk", TodoBoard.clampedTitle("Buy milk"))
    }

    @Test
    fun clampedTitleCapsATitleOverTheLimit() {
        val over = "a".repeat(TodoBoard.TITLE_MAX_LENGTH + 10)

        assertEquals("a".repeat(TodoBoard.TITLE_MAX_LENGTH), TodoBoard.clampedTitle(over))
    }

    @Test
    fun authenticatedHttpRemoteConfig() {
        val json =
            TodoBoard.clientConfig(
                clientId = TODO_TEST_CLIENT_ID,
                databasePath = "/tmp/kizunasync-todos.sqlite",
                supabaseUrl = "https://abc.supabase.co",
                publishableKey = "pub-xxx",
                accessToken = "session-jwt",
            ).toJson()
        val remote = json.getJSONObject("remote")
        assertEquals("https://abc.supabase.co", remote.getString("url"))
        assertEquals("pub-xxx", remote.getString("publishable_key"))
        assertEquals("session-jwt", remote.getString("access_token"))
        assertEquals("/tmp/kizunasync-todos.sqlite", json.getString("database_path"))
    }
}

/**
 * The device identity the suite creates under. `create` refuses anything that is
 * not a uuid, because the server's registry column is one.
 */
private const val TODO_TEST_CLIENT_ID = "00000000-0000-4000-8000-00000000da01"

/**
 * The remote the store is created with, because the packaged build refuses a
 * config without one. The test never syncs, so nothing contacts it.
 */
private const val TODO_TEST_REMOTE_URL = "https://127.0.0.1:1"
private const val TODO_TEST_REMOTE_PUBLISHABLE_KEY = "pub-xxx"
