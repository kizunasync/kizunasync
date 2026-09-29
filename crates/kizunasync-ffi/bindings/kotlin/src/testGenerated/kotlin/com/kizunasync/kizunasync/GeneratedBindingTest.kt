package com.kizunasync.kizunasync

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import org.json.JSONArray
import org.json.JSONObject
import org.junit.jupiter.api.Assumptions.assumeTrue
import uniffi.kizunasync_ffi.KizunaSyncEngine as UniffiEngine
import uniffi.kizunasync_ffi.KizunaSyncFfiException

/** [KSYNC_TEST_REMOTE] as the `remote` object of a raw `create` config, which the packaged build requires. */
private fun placeholderRemote(): JSONObject =
    JSONObject().put("url", KSYNC_TEST_REMOTE.url).put("publishable_key", KSYNC_TEST_REMOTE.publishableKey)

/**
 * Exercises the **generated** UniFFI Kotlin binding (`Generated/uniffi/kizunasync_ffi`)
 * loaded through JNA against the cargo-built `libkizunasync_ffi`.
 *
 * `build.gradle.kts` points `jna.library.path` at the monorepo `target/debug`, so
 * `cargo build -p kizunasync-ffi` must have run first.
 */
class GeneratedBindingTest {
    /**
     * Thin adapter: shared runner to the UniFFI JSON-string surface. Beyond
     * marshalling it carries the engine's catalog code into
     * [KizunaSyncScenarioException], so a step with `expect_code` grades the typed
     * discriminant rather than the message.
     */
    private class GeneratedEngineAdapter : KizunaSyncScenarioEngine {
        private val engine = UniffiEngine()

        /**
         * The shared oracle carries no `remote`, because the same corpus also
         * replays on lanes with an offline scripted remote, and the packaged build
         * refuses a config without one. The scenarios set no token, so a sync stops
         * at `AUTH_SESSION_MISSING` before any request reaches the placeholder.
         */
        override fun create(config: JSONObject) {
            val withRemote = JSONObject(config.toString())
            if (!withRemote.has("remote")) {
                withRemote.put("remote", placeholderRemote())
            }
            coded { engine.create(withRemote.toString()) }
        }

        override fun apply(mutation: JSONObject) = coded { engine.apply(mutation.toString()) }

        override fun query(request: JSONObject): Any? {
            val raw = coded { engine.query(request.toString()) }
            // Rust returns an array (many) or an object / literal null (single, maybeSingle).
            return JSONTokenerCompat.parse(raw)
        }

        override fun sync() = coded { engine.sync() }

        override fun outboxDepth(): Int = coded { engine.outboxDepth().toInt() }

        override fun invoke(method: String, params: JSONObject): Any? {
            val raw = coded { engine.call(method, params.toString()) }
            val envelope = JSONObject(raw)
            if (!envelope.optBoolean("ok", false)) {
                // Every refusal the engine encodes carries a code; one without it is an
                // envelope this adapter does not understand, not a gradeable failure.
                val failure =
                    envelope.optJSONObject("error")
                        ?: error("call($method) answered without an error object: $raw")
                val code =
                    failure.optString("code").ifEmpty {
                        error("call($method) answered without an error code: $raw")
                    }
                throw KizunaSyncScenarioException(
                    code,
                    failure.optString("message").ifEmpty { "call failed" },
                )
            }
            return envelope.opt("value")
        }

        private fun <T> coded(block: () -> T): T =
            try {
                block()
            } catch (error: KizunaSyncFfiException.Engine) {
                throw KizunaSyncScenarioException(error.code, error.msg)
            }
    }

    private object JSONTokenerCompat {
        fun parse(raw: String): Any? {
            val trimmed = raw.trim()
            return when {
                trimmed == "null" -> null
                trimmed.startsWith("[") -> JSONArray(trimmed)
                trimmed.startsWith("{") -> JSONObject(trimmed)
                else -> error("unexpected query payload: $trimmed")
            }
        }
    }

    @Test
    fun sharedScenariosRunOnGeneratedBinding() {
        val root = KizunaSyncScenarios.loadFromRepo()
        KizunaSyncScenarios.validateStructure(root)
        val scenarios = root.getJSONArray("scenarios")
        assertTrue(scenarios.length() >= 12, "shared oracle shrank to ${scenarios.length()}")

        val skipped = mutableListOf<String>()
        for (i in 0 until scenarios.length()) {
            val scenario = scenarios.getJSONObject(i)
            try {
                KizunaSyncScenarioRunner.run(scenario, GeneratedEngineAdapter(), "kotlin-uniffi-scenario")
            } catch (failure: KizunaSyncScenarioException) {
                if (!needsOfflineScriptedRemote(failure.code)) {
                    throw failure
                }
                skipped.add(scenario.optString("id"))
            }
        }
        assumeTrue(
            skipped.isEmpty(),
            "scenario ${skipped.joinToString(", ")} needs the offline scripted remote; the packaged build has none",
        )
    }

    /** True when the placeholder remote was reached, rather than an assertion missed. */
    private fun needsOfflineScriptedRemote(code: String): Boolean =
        code == "AUTH_SESSION_MISSING" || code.startsWith("REMOTE")

    @Test
    fun createApplyQueryThroughGeneratedEngine() {
        val engine = UniffiEngine()
        engine.create(
            """
            {"client_id":"kotlin-uniffi","schema_version":1,
             "tables":{"items":{"bucket_column":"user_id","bucket_params":{"user_id":"u1"}}},
             "remote":${placeholderRemote()}}
            """.trimIndent(),
        )
        engine.apply(
            """
            {"table":"items","pk":"p1","op":"insert","mutation_id":"m1",
             "columns":{"title":"Alpha","user_id":"u1"}}
            """.trimIndent(),
        )
        val rows = JSONArray(
            engine.query(
                """
                {"table":"items","plan":{"filters":[{"kind":"eq","column":"title","value":"Alpha"}],
                 "cardinality":"many"}}
                """.trimIndent(),
            ),
        )
        assertEquals(1, rows.length())
        assertEquals("Alpha", rows.getJSONObject(0).getString("title"))
        assertEquals(1u, engine.outboxDepth())
    }

    // --- Error mapping: typed sealed class, never a free-text string match ---

    @Test
    fun createWithInvalidJsonThrowsTypedException() {
        val engine = UniffiEngine()
        val error = assertFailsWith<KizunaSyncFfiException.Engine> {
            engine.create("{not json")
        }
        assertTrue(error.msg.isNotEmpty())
        assertTrue(error.code.isNotEmpty())
    }

    @Test
    fun applyWithInvalidJsonThrowsTypedException() {
        val engine = UniffiEngine()
        engine.create(
            """
            {"client_id":"kotlin-uniffi","schema_version":1,
             "tables":{"items":{"bucket_column":"user_id","bucket_params":{"user_id":"u1"}}},
             "remote":${placeholderRemote()}}
            """.trimIndent(),
        )
        assertFailsWith<KizunaSyncFfiException.Engine> {
            engine.apply("[[not-a-mutation")
        }
    }

    @Test
    fun applyBeforeCreateThrowsTypedException() {
        val engine = UniffiEngine()
        assertFailsWith<KizunaSyncFfiException.Engine> {
            engine.apply("""{"table":"items","pk":"p1","op":"insert"}""")
        }
    }

    @Test
    fun queryWithoutTableThrowsTypedException() {
        val engine = UniffiEngine()
        engine.create(
            """
            {"client_id":"kotlin-uniffi","schema_version":1,
             "tables":{"items":{"bucket_column":"user_id","bucket_params":{"user_id":"u1"}}},
             "remote":${placeholderRemote()}}
            """.trimIndent(),
        )
        assertFailsWith<KizunaSyncFfiException.Engine> {
            engine.query("""{"plan":{}}""")
        }
    }
}
