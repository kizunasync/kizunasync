package com.kizunasync.kizunasync

import java.io.File
import org.json.JSONArray
import org.json.JSONObject

/**
 * One engine failure a scenario step can grade. An adapter carries the engine's
 * catalog code into [code], so `expect_code` pins the typed discriminant and
 * never the message text.
 */
class KizunaSyncScenarioException(val code: String, message: String) : Exception(message)

/**
 * Engine operations a shared scenario needs. The UniFFI-generated
 * `uniffi.kizunasync_ffi.KizunaSyncEngine` adapts to this so the shared runner grades it
 * against the same JSON oracle used by the other language bindings.
 */
interface KizunaSyncScenarioEngine {
    /** Open the store and declare the tables. */
    fun create(config: JSONObject)

    /** Queue one mutation. */
    fun apply(mutation: JSONObject)

    /** Run one query request. */
    fun query(request: JSONObject): Any?

    /** Pull then push once. */
    fun sync()

    /** How many mutations are queued. */
    fun outboxDepth(): Int

    /** Any other engine method, through the JSON-RPC surface. */
    fun invoke(method: String, params: JSONObject): Any?
}

/** Loading and structural validation of the shared oracle. */
object KizunaSyncScenarios {
    /** Monorepo-relative location of the single cross-language oracle. */
    const val REPO_RELATIVE_PATH = "crates/kizunasync-scenarios/scenarios.json"

    /** Read and decode the oracle at [file]. */
    fun load(file: File): JSONObject = JSONObject(file.readText())

    /**
     * Walk up from the working directory to find the shared scenarios.
     * Fails loud: a missing oracle must not silently skip the binding suites.
     */
    fun locate(cwd: File = File(System.getProperty("user.dir"))): File {
        var dir: File? = cwd.absoluteFile
        repeat(12) {
            val current = dir ?: return@repeat
            val found = File(current, REPO_RELATIVE_PATH)
            if (found.isFile) {
                return found
            }
            dir = current.parentFile
        }
        error("$REPO_RELATIVE_PATH not found from ${cwd.absolutePath}")
    }

    /** Read the oracle from the repository this suite runs inside. */
    fun loadFromRepo(): JSONObject = load(locate())

    /**
     * Assert the oracle's shape: a known version, at least one scenario, and a
     * unique identifier and steps on each.
     */
    fun validateStructure(root: JSONObject) {
        require(root.getInt("version") >= 1) { "bad version" }
        val scenarios = root.getJSONArray("scenarios")
        require(scenarios.length() > 0) { "no scenarios" }
        val seen = mutableSetOf<String>()
        for (i in 0 until scenarios.length()) {
            val s = scenarios.getJSONObject(i)
            val id = s.getString("id")
            require(id.isNotEmpty()) { "empty id" }
            require(seen.add(id)) { "duplicate scenario id $id" }
            require(s.getJSONArray("steps").length() > 0) { "empty steps" }
        }
    }
}

/** One runner for every Kotlin backend; only marshalling differs per adapter. */
object KizunaSyncScenarioRunner {
    /** Execute every step of [scenario], failing on the first unmet expectation. */
    fun run(scenario: JSONObject, engine: KizunaSyncScenarioEngine, clientId: String) {
        val id = scenario.optString("id", "<unnamed>")
        val steps = scenario.getJSONArray("steps")
        for (i in 0 until steps.length()) {
            val step = steps.getJSONObject(i)
            val ctx = "$id#$i"
            when (val op = step.getString("op")) {
                "create" -> {
                    val params = JSONObject()
                        .put("client_id", clientId)
                        .put("schema_version", 1)
                    if (step.has("tables")) {
                        params.put("tables", step.getJSONObject("tables"))
                    }
                    graded(step, ctx, "create") { engine.create(params) }
                }
                "apply" -> runApply(step, ctx, engine)
                "query" -> runQuery(step, ctx, engine)
                "outbox_depth" -> {
                    val expected = step.getInt("expect_depth")
                    var depth = 0
                    graded(step, ctx, "outbox_depth") { depth = engine.outboxDepth() }
                    if (!step.optBoolean("expect_error", false)) {
                        require(depth == expected) { "$ctx: outbox depth $expected, got $depth" }
                    }
                }
                "sync" -> graded(step, ctx, "sync") { engine.sync() }
                "apply_where" -> {
                    val params = JSONObject()
                        .put("table", step.optString("table"))
                        .put("op", step.optString("mutation_op", "update"))
                    if (step.has("filters")) {
                        params.put("filters", step.get("filters"))
                    }
                    if (step.has("columns")) {
                        params.put("columns", step.getJSONObject("columns"))
                    }
                    if (step.has("transforms")) {
                        params.put("transforms", step.getJSONObject("transforms"))
                    }
                    invoke(step, ctx, engine, "apply_where", params)
                }
                "rejections" -> runRejections(step, ctx, engine)
                "checkpoint" -> runCheckpoint(step, ctx, engine)
                "seed_checkpoint" -> {
                    invoke(
                        step, ctx, engine,
                        "seed_checkpoint",
                        JSONObject().put("cursor", step.getString("cursor")),
                    )
                }
                "set_bucket" -> {
                    val params = JSONObject()
                    if (step.has("params")) {
                        params.put("params", step.getJSONObject("params"))
                    }
                    invoke(step, ctx, engine, "set_bucket", params)
                }
                "attachment_put" ->
                    invoke(step, ctx, engine, "attachment_put", step.getJSONObject("attachment"))
                "attachment_patch" -> {
                    val params = JSONObject()
                        .put("reference", reference(step, ctx))
                        .put("patch", step.optJSONObject("patch") ?: JSONObject())
                    invoke(step, ctx, engine, "attachment_patch", params)
                }
                "attachment_pending" -> runAttachmentPending(step, ctx, engine)
                "attachment_fail_next" -> runAttachmentFailNext(step, ctx, engine)
                "attachment_status", "attachment_retry", "attachment_cancel", "attachment_remove" ->
                    runAttachmentReference(step, ctx, engine, op)
                else -> error("$ctx: unknown scenario op $op")
            }
        }
    }

    /**
     * Run one operation against the step's own expectation: a step that declares
     * `expect_error` asserts the refusal and its `expect_code`, and anything else
     * that fails is the engine breaking its own contract.
     */
    private fun graded(step: JSONObject, ctx: String, op: String, block: () -> Unit) {
        if (!step.optBoolean("expect_error", false)) {
            try {
                block()
            } catch (failure: Exception) {
                throw stepFailure("$ctx: $op failed: $failure", failure)
            }
            return
        }
        requireFails(step, ctx, op, block)
    }

    /**
     * One JSON-RPC call through a shared grader. A refused step answers null.
     * Refusal is assertable on the two typed-surface calls and on
     * `apply_where`, `set_bucket`, and the attachment methods.
     */
    private fun invoke(
        step: JSONObject,
        ctx: String,
        engine: KizunaSyncScenarioEngine,
        method: String,
        params: JSONObject,
    ): Any? {
        if (!step.optBoolean("expect_error", false)) {
            return try {
                engine.invoke(method, params)
            } catch (failure: Exception) {
                throw stepFailure("$ctx: $method failed: $failure", failure)
            }
        }
        requireFails(step, ctx, method) { engine.invoke(method, params) }
        return null
    }

    /**
     * A step that failed without declaring `expect_error`. It keeps the engine's
     * catalog code when the adapter carried one, so a caller grades the code
     * rather than the rendered message.
     */
    private fun stepFailure(message: String, failure: Exception): Exception =
        if (failure is KizunaSyncScenarioException) {
            KizunaSyncScenarioException(failure.code, message)
        } else {
            IllegalStateException(message)
        }

    private fun reference(step: JSONObject, ctx: String): String {
        require(step.has("reference")) { "$ctx: reference required" }
        return step.getString("reference")
    }

    /**
     * Compare the answered value against whatever the step named: `expect_value`
     * is the whole value, `expect_status` a subset of its keys, and `expect_null`
     * the absence of a row.
     */
    private fun assertAnswer(step: JSONObject, ctx: String, value: Any?) {
        if (step.has("expect_value")) {
            val expected = step.get("expect_value")
            require(sameJson(value, expected)) { "$ctx: expect_value $expected, got $value" }
        }
        if (step.optBoolean("expect_null", false)) {
            require(value == null || value == JSONObject.NULL) { "$ctx: expect_null, got $value" }
        }
        if (step.has("expect_status")) {
            val expected = step.getJSONObject("expect_status")
            val status = value as? JSONObject ?: error("$ctx: expect_status needs an object, got $value")
            for (key in expected.keys()) {
                require(sameJson(status.opt(key), expected.get(key))) {
                    "$ctx: expect_status[$key] ${expected.get(key)} in $status"
                }
            }
        }
    }

    /**
     * Value equality over decoded JSON. `org.json` boxes an integer as `Int` or
     * `Long` depending on the parser's path, so a number is compared by its
     * numeric value rather than by its box.
     */
    private fun sameJson(actual: Any?, expected: Any?): Boolean {
        val left = if (actual == JSONObject.NULL) null else actual
        val right = if (expected == JSONObject.NULL) null else expected
        if (left is Number && right is Number) {
            return left.toDouble() == right.toDouble()
        }
        return left == right
    }

    private fun runRejections(step: JSONObject, ctx: String, engine: KizunaSyncScenarioEngine) {
        val result = invoke(
            step, ctx, engine,
            "rejections",
            JSONObject().put("include_dismissed", step.optBoolean("include_dismissed", false)),
        ) ?: return
        if (step.has("expect_count")) {
            val expected = step.getInt("expect_count")
            val rows = result as? JSONArray ?: error("$ctx: rejections expected array, got $result")
            require(rows.length() == expected) {
                "$ctx: rejections count $expected, got ${rows.length()}"
            }
        }
    }

    private fun runCheckpoint(step: JSONObject, ctx: String, engine: KizunaSyncScenarioEngine) {
        val result = invoke(step, ctx, engine, "checkpoint", JSONObject()) ?: return
        if (step.has("expect_cursor")) {
            val expected = step.getString("expect_cursor")
            val actual = when (result) {
                is String -> result
                is JSONObject -> result.optString("cursor")
                else -> error("$ctx: checkpoint cursor, got $result")
            }
            require(actual == expected) { "$ctx: expect_cursor $expected, got $actual" }
        }
    }

    /** The candidates one direction would drive next. */
    private fun runAttachmentPending(step: JSONObject, ctx: String, engine: KizunaSyncScenarioEngine) {
        val params = JSONObject().put("direction", step.optString("direction", "upload"))
        val value = invoke(step, ctx, engine, "attachment_pending", params) ?: return
        if (step.has("expect_count")) {
            val expected = step.getInt("expect_count")
            val rows = value as? JSONArray ?: error("$ctx: expected a row array, got $value")
            require(rows.length() == expected) { "$ctx: expect_count $expected, got ${rows.length()}" }
        }
    }

    /** Every method that takes one reference and answers one value. */
    private fun runAttachmentReference(
        step: JSONObject,
        ctx: String,
        engine: KizunaSyncScenarioEngine,
        method: String,
    ) {
        val params = JSONObject().put("reference", reference(step, ctx))
        val value = invoke(step, ctx, engine, method, params)
        if (value == null && step.optBoolean("expect_error", false)) {
            return
        }
        assertAnswer(step, ctx, value)
    }

    /**
     * One failed transfer attempt, recorded as a host queue records one: claim
     * the row, then write the attempt and the failure back. Runners attach no
     * transfer port; this stands in for real bytes failing. The step's
     * `expect_value` is the claim's own answer, pinning the attempt at which
     * the transfer budget stops claiming.
     */
    private fun runAttachmentFailNext(step: JSONObject, ctx: String, engine: KizunaSyncScenarioEngine) {
        val reference = reference(step, ctx)
        val params = JSONObject().put("reference", reference)
        val entry = engine.invoke("attachment_get", params) as? JSONObject
            ?: error("$ctx: no attachment row carries $reference")
        val running = if (entry.optString("direction") == "download") "downloading" else "uploading"
        val claimed = engine.invoke(
            "attachment_claim",
            JSONObject().put("reference", reference).put("state", running),
        )
        if (claimed == true) {
            val patch = JSONObject()
                .put("state", "failed")
                .put("in_flight", false)
                .put("attempts", entry.optInt("attempts", 0) + 1)
                .put("error", "the scenario's transfer failed")
            engine.invoke(
                "attachment_patch",
                JSONObject().put("reference", reference).put("patch", patch),
            )
        }
        assertAnswer(step, ctx, claimed)
    }

    private fun runApply(step: JSONObject, ctx: String, engine: KizunaSyncScenarioEngine) {
        val mutation = JSONObject()
            .put("table", step.optString("table"))
            .put("pk", step.optString("pk"))
            .put("op", step.optString("mutation_op", "insert"))
            .put("mutation_id", step.optString("mutation_id", ctx))
        if (step.has("columns")) {
            mutation.put("columns", step.getJSONObject("columns"))
        }
        if (step.has("transforms")) {
            mutation.put("transforms", step.getJSONObject("transforms"))
        }
        if (step.has("precondition")) {
            mutation.put("precondition", step.getJSONObject("precondition"))
        }
        if (step.optBoolean("expect_error", false)) {
            requireFails(step, ctx, "apply") { engine.apply(mutation) }
            return
        }
        engine.apply(mutation)
    }

    private fun runQuery(step: JSONObject, ctx: String, engine: KizunaSyncScenarioEngine) {
        val request = JSONObject().put("table", step.optString("table"))
        if (step.has("plan")) {
            request.put("plan", step.get("plan"))
        }
        if (step.optBoolean("expect_error", false)) {
            requireFails(step, ctx, "query") { engine.query(request) }
            return
        }

        val result = engine.query(request)

        if (step.has("expect_count")) {
            val expected = step.getInt("expect_count")
            val rows = result as? JSONArray ?: error("$ctx: expected a row array, got $result")
            require(rows.length() == expected) {
                "$ctx: expect_count $expected, got ${rows.length()}"
            }
        }
        if (step.optBoolean("expect_null", false)) {
            require(result == null || result == JSONObject.NULL) {
                "$ctx: expect_null, got $result"
            }
        }
        if (step.has("expect_single_title")) {
            val expected = step.getString("expect_single_title")
            val row = when (result) {
                is JSONObject -> result
                is JSONArray -> result.getJSONObject(0)
                else -> error("$ctx: expected a row, got $result")
            }
            require(row.getString("title") == expected) {
                "$ctx: expect_single_title $expected, got $row"
            }
        }
        if (step.has("expect_column_values")) {
            val spec = step.getJSONObject("expect_column_values")
            val column = spec.getString("column")
            val wanted = spec.getJSONArray("values")
            val rows = result as? JSONArray ?: error("$ctx: expected a row array, got $result")
            require(rows.length() == wanted.length()) {
                "$ctx: expect_column_values[$column] size ${wanted.length()}, got ${rows.length()}"
            }
            for (i in 0 until wanted.length()) {
                val actual = rows.getJSONObject(i).opt(column)
                require(actual == wanted.get(i)) {
                    "$ctx: expect_column_values[$column][$i] ${wanted.get(i)}, got $actual"
                }
            }
        }
    }

    /**
     * Grade the failure a step expected. A step without `expect_code` pins only
     * that the operation failed; one with it pins the catalog code the adapter
     * carried out of the engine.
     */
    private fun requireFails(step: JSONObject, ctx: String, op: String, block: () -> Unit) {
        val raised =
            try {
                block()
                null
            } catch (error: Exception) {
                error
            }
        require(raised != null) { "$ctx: expected $op to fail" }
        val expected = step.optString("expect_code", "")
        if (expected.isEmpty()) {
            return
        }
        val code = (raised as? KizunaSyncScenarioException)?.code
        require(code == expected) { "$ctx: expect_code $expected, got $raised" }
    }
}
