package com.kizunasync.kizunasync

import java.util.UUID
import java.util.logging.Level
import java.util.logging.Logger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import uniffi.kizunasync_ffi.AttachmentListener
import uniffi.kizunasync_ffi.EventObserver
import uniffi.kizunasync_ffi.FfiAttachmentStatus
import uniffi.kizunasync_ffi.FfiCheckpoint
import uniffi.kizunasync_ffi.FfiEngineEvent
import uniffi.kizunasync_ffi.FfiFromFileResult
import uniffi.kizunasync_ffi.FfiRejection
import uniffi.kizunasync_ffi.KizunaSyncFfiException

/** One attachment column: Storage bucket plus the owner column used to derive the object key. */
data class KizunaSyncAttachmentSpec(
    /** The Supabase Storage bucket the object lives in. */
    val storageBucket: String,
    /** The row column whose value scopes the object key to one owner. */
    val ownerColumn: String,
)

/** Which rule resolves two writes to one column. */
enum class KizunaSyncConflictMode(val wire: String) {
    /** Server arrival order decides, trusting no device clock. */
    Arrival("arrival"),

    /**
     * The origin clock decides: every mutation this device queues for such a
     * table carries the stamp the server compares.
     */
    Hlc("hlc"),
}

/** Which directions a table syncs in. */
enum class KizunaSyncSyncMode(val wire: String) {
    /** The device pulls the table and pushes its local writes. */
    ReadWrite("read-write"),

    /**
     * The server owns the table: the device pulls it, and the engine refuses
     * every local write with `LOCAL_UNSUPPORTED`.
     */
    PullOnly("pull-only"),
}

/** Which rows of a table this device pulls. */
sealed class KizunaSyncBucket {
    /** Every row the server's RLS lets the signed-in user read. */
    data object None : KizunaSyncBucket()

    /**
     * The rows whose [column] holds the signed-in user's id. The engine takes
     * that id from the session, so the app never calls `setBucket` for this
     * table, and an insert that leaves the column out is written with it.
     */
    data class ByOwner(val column: String) : KizunaSyncBucket()

    /** The rows whose [column] holds the value the app passes to `setBucket`. */
    data class ByColumn(val column: String) : KizunaSyncBucket()
}

/** Table declaration that encodes to the UniFFI `create` JSON. */
data class KizunaSyncTableConfig(
    /** Which rows of this table the device pulls. */
    val bucket: KizunaSyncBucket = KizunaSyncBucket.None,
    /** Attachment columns of this table, by column name. */
    val attachments: Map<String, KizunaSyncAttachmentSpec> = emptyMap(),
    /**
     * The app-level deletion marker column. Set it and a filter-targeted
     * `delete` becomes an update stamping this column, a low-level `apply` with
     * op `delete` raises `SOFT_DELETE_VIOLATION`, and a marked row leaves every
     * read until the plan asks for `includeDeleted`; null leaves hard deletes
     * legal.
     */
    val softDeleteColumn: String? = null,
    /** Which rule resolves two writes to one of this table's columns. */
    val conflictMode: KizunaSyncConflictMode = KizunaSyncConflictMode.Arrival,
    /** Which directions this table syncs in. */
    val syncMode: KizunaSyncSyncMode = KizunaSyncSyncMode.ReadWrite,
    /**
     * The table's primary-key columns in key order. The engine derives each
     * row's pk from them and refuses a write that changes one. A table with
     * attachment columns keeps `listOf("id")`.
     */
    val key: List<String> = listOf("id"),
)

/** The key of a table whose config names none: the one column `id`. */
internal val DEFAULT_KEY: List<String> = listOf("id")

/**
 * PostgREST remote. A present remote must have [url] and [publishableKey]; the
 * engine rejects an incomplete object instead of falling back to the scripted remote.
 */
data class KizunaSyncRemoteConfig(
    /** The Supabase project URL. */
    val url: String,
    /** The project's publishable key. */
    val publishableKey: String,
    /** The user's JWT, when one is already available at create time. */
    val accessToken: String? = null,
    /** The Postgres schema the RPCs live in, when it is not the default. */
    val schema: String? = null,
    /** Columns the client keeps out of every push payload. */
    val localOnlyColumns: List<String> = emptyList(),
)

/** Typed `create(config_json)` payload. */
data class KizunaSyncClientConfig(
    /**
     * Stable identifier of this device, carried on every pull and push. The
     * server's `kizunasync._clients.client_id` is a uuid column, so this is one
     * too: [KizunaSyncClient.create] refuses anything else with `CONFIG_INVALID`
     * rather than letting the server refuse it later. Passing null mints one.
     */
    val clientId: String? = null,
    /** The schema generation the client expects from the server. */
    val schemaVersion: Int = 1,
    /** The synced tables, by table name. */
    val tables: Map<String, KizunaSyncTableConfig>,
    /** The SQLite file. Absent, the engine opens an in-memory store. */
    val databasePath: String? = null,
    /**
     * The remote. The packaged library refuses an absent one with
     * `CONFIG_INVALID`; only a host-test build without the `http` feature runs
     * offline against a scripted remote.
     */
    val remote: KizunaSyncRemoteConfig? = null,
    /** The directory attachment bytes are staged in. Required when a table declares attachments. */
    val attachmentRoot: String? = null,
    /**
     * How many rows one pull page asks for. Absent, the request omits `limit`
     * and the server's own default applies.
     */
    val defaultLimit: Int? = null,
    /**
     * How many transfer attempts one attachment gets before the queue marks it
     * permanently failed. Absent, the engine's own budget of five applies.
     */
    val attachmentAttempts: Int? = null,
) {
    /** The identity this client syncs under: [clientId], or a minted uuid. */
    val deviceId: String = clientId ?: UUID.randomUUID().toString()

    /** Answers whether any table declares an attachment column. */
    fun declaresAttachments(): Boolean = tables.values.any { it.attachments.isNotEmpty() }

    /** Whether [deviceId] is the uuid `kizunasync._clients.client_id` stores. */
    internal fun carriesUuidClientId(): Boolean = UUID_SHAPE.matches(deviceId)

    /**
     * The wire object the engine's `create` reads. A key the config left at the
     * engine's own default stays out of the object, so this client and a
     * JavaScript one built from the same declaration send the same bytes.
     */
    fun toJson(): JSONObject {
        val tablesJson = JSONObject()
        for ((name, table) in tables) {
            val encoded = JSONObject()
            when (val bucket = table.bucket) {
                is KizunaSyncBucket.None -> {}
                is KizunaSyncBucket.ByOwner -> encoded.put("bucket_column", bucket.column).put("bucket_owner", true)
                is KizunaSyncBucket.ByColumn -> encoded.put("bucket_column", bucket.column)
            }
            if (table.attachments.isNotEmpty()) {
                val attachments = JSONObject()
                for ((column, spec) in table.attachments) {
                    attachments.put(
                        column,
                        JSONObject()
                            .put("storage_bucket", spec.storageBucket)
                            .put("owner_column", spec.ownerColumn),
                    )
                }
                encoded.put("attachments", attachments)
            }
            if (table.softDeleteColumn != null) {
                encoded.put("soft_delete_column", table.softDeleteColumn)
            }
            if (table.conflictMode == KizunaSyncConflictMode.Hlc) {
                encoded.put("conflict_mode", table.conflictMode.wire)
            }
            if (table.syncMode == KizunaSyncSyncMode.PullOnly) {
                encoded.put("sync_mode", table.syncMode.wire)
            }
            if (table.key != DEFAULT_KEY) {
                encoded.put("key", JSONArray(table.key))
            }
            tablesJson.put(name, encoded)
        }
        val root =
            JSONObject()
                .put("client_id", deviceId)
                .put("schema_version", schemaVersion)
                .put("tables", tablesJson)
        if (defaultLimit != null) {
            root.put("default_limit", defaultLimit)
        }
        if (attachmentAttempts != null) {
            root.put("attachment_attempts", attachmentAttempts)
        }
        if (databasePath != null) {
            root.put("database_path", databasePath)
        }
        if (remote != null) {
            val remoteJson =
                JSONObject()
                    .put("url", remote.url)
                    .put("publishable_key", remote.publishableKey)
            if (remote.accessToken != null) {
                remoteJson.put("access_token", remote.accessToken)
            }
            if (remote.schema != null) {
                remoteJson.put("schema", remote.schema)
            }
            if (remote.localOnlyColumns.isNotEmpty()) {
                val cols = JSONArray()
                for (col in remote.localOnlyColumns) {
                    cols.put(col)
                }
                remoteJson.put("local_only_columns", cols)
            }
            root.put("remote", remoteJson)
        }
        if (attachmentRoot != null) {
            root.put("attachment_root", attachmentRoot)
        }
        return root
    }

    private companion object {
        /** RFC-4122 textual form the registry column takes. */
        val UUID_SHAPE =
            Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
    }
}

/**
 * One journalled column overwrite: a value this device wrote that a peer's push
 * replaced. The winner is somebody else's write, so the entry carries its own
 * [id] and that is what [KizunaSyncClient.dismissOverwrite] acknowledges.
 */
data class KizunaSyncOverwrite(
    /** The journal row's own identifier. */
    val id: Long,
    /** The synced table the overwritten row belongs to. */
    val table: String,
    /** The row's primary key. */
    val pk: String,
    /** The column whose value was replaced. */
    val column: String,
    /** The value this device lost, as JSON. */
    val loserValueJson: String,
    /** The winning peer write's exactly-once identifier. */
    val winnerMutationId: String,
    /** The rule that decided it, `arrival` or `hlc`. */
    val conflictMode: String,
    /**
     * The changelog sequence the winning value arrived on, when the pull page
     * carried one.
     */
    val winnerSeq: String?,
    /** When the journal recorded it, in epoch milliseconds. */
    val at: Long,
    /** Whether the app dismissed it. */
    val dismissed: Boolean,
) {
    internal companion object {
        /**
         * Read one journal row out of the `overwrites` payload. Answers null when
         * a required field is missing or of another type, so a malformed row is
         * dropped rather than invented.
         */
        fun from(row: JSONObject): KizunaSyncOverwrite? {
            val id =
                when (val raw = row.opt("id")) {
                    is Int -> raw.toLong()
                    is Long -> raw
                    else -> return null
                }
            return KizunaSyncOverwrite(
                id = id,
                table = row.opt("table") as? String ?: return null,
                pk = row.opt("pk") as? String ?: return null,
                column = row.opt("column") as? String ?: return null,
                loserValueJson = row.opt("loser_value").let { if (it == null || it == JSONObject.NULL) "null" else it.toString() },
                winnerMutationId = row.opt("winner_mutation_id") as? String ?: return null,
                conflictMode = row.opt("conflict_mode") as? String ?: return null,
                winnerSeq = if (row.isNull("winner_seq")) null else row.optString("winner_seq"),
                at = row.optLong("at"),
                dismissed = row.optBoolean("dismissed", false),
            )
        }
    }
}

/** The three write operations a mutation carries. */
enum class KizunaSyncOp(val wire: String) {
    /** Create the row. */
    Insert("insert"),

    /** Merge the given columns into the row. */
    Update("update"),

    /** Tombstone the row. */
    Delete("delete"),
}

/**
 * The three parse modes `textSearch` accepts. The engine refuses any other
 * value with `LOCAL_UNSUPPORTED`, so the type closes the set at the call site.
 */
enum class KizunaSyncTextSearchType(val wire: String) {
    /** Every term has to appear, in any order. */
    Plain("plain"),

    /** The terms have to appear adjacent and in order. */
    Phrase("phrase"),

    /**
     * Every quoted phrase and every other word has to appear. A leading minus
     * stays part of its word and excludes nothing.
     */
    Websearch("websearch"),
}

/** Query-plan helpers. They serialize the local AST; they are not a second query engine. */
object KizunaSyncQuery {
    /** Equality against [value]. */
    fun eq(column: String, value: Any?): JSONObject =
        JSONObject().put("kind", "eq").put("column", column).put("value", value ?: JSONObject.NULL)

    /** Inequality against [value]. */
    fun neq(column: String, value: Any?): JSONObject =
        JSONObject().put("kind", "neq").put("column", column).put("value", value ?: JSONObject.NULL)

    /** Greater than [value]. */
    fun gt(column: String, value: Any): JSONObject =
        JSONObject().put("kind", "gt").put("column", column).put("value", value)

    /** Greater than or equal to [value]. */
    fun gte(column: String, value: Any): JSONObject =
        JSONObject().put("kind", "gte").put("column", column).put("value", value)

    /** Less than [value]. */
    fun lt(column: String, value: Any): JSONObject =
        JSONObject().put("kind", "lt").put("column", column).put("value", value)

    /** Less than or equal to [value]. */
    fun lte(column: String, value: Any): JSONObject =
        JSONObject().put("kind", "lte").put("column", column).put("value", value)

    /** Case-sensitive pattern match, `%` and `_` as in SQL. */
    fun like(column: String, pattern: String): JSONObject =
        JSONObject().put("kind", "like").put("column", column).put("pattern", pattern)

    /** Case-insensitive pattern match, `%` and `_` as in SQL. */
    fun ilike(column: String, pattern: String): JSONObject =
        JSONObject().put("kind", "ilike").put("column", column).put("pattern", pattern)

    /**
     * Identity test. The engine accepts null, true, and false only, so the
     * operand is `Boolean?` and null is the null test. The name is `isValue`
     * because `is` is a Kotlin keyword and the call site reads better unquoted.
     */
    fun isValue(column: String, value: Boolean?): JSONObject =
        JSONObject().put("kind", "is").put("column", column).put("value", value ?: JSONObject.NULL)

    /** Membership in [values]. The name mirrors [isValue]; `in` is a Kotlin keyword. */
    fun inValues(column: String, values: Collection<Any?>): JSONObject {
        val array = JSONArray()
        for (value in values) {
            array.put(value ?: JSONObject.NULL)
        }
        return JSONObject().put("kind", "in").put("column", column).put("values", array)
    }

    /** The column contains [value]. */
    fun contains(column: String, value: Any): JSONObject =
        JSONObject().put("kind", "contains").put("column", column).put("value", value)

    /** The column is contained by [value]. */
    fun containedBy(column: String, value: Any): JSONObject =
        JSONObject().put("kind", "containedBy").put("column", column).put("value", value)

    /** Every nested filter has to match. */
    fun and(vararg filters: JSONObject): JSONObject {
        val array = JSONArray()
        for (filter in filters) {
            array.put(filter)
        }
        return JSONObject().put("kind", "and").put("filters", array)
    }

    /** At least one nested filter has to match. */
    fun or(vararg filters: JSONObject): JSONObject {
        val array = JSONArray()
        for (filter in filters) {
            array.put(filter)
        }
        return JSONObject().put("kind", "or").put("filters", array)
    }

    /** Negates the nested filter. */
    fun not(filter: JSONObject): JSONObject = JSONObject().put("kind", "not").put("filter", filter)

    /** Free-text search over [columns], or over every text column when it is null. */
    fun search(query: String, columns: Collection<String>? = null): JSONObject {
        val filter = JSONObject().put("kind", "search").put("query", query)
        if (columns != null) {
            val array = JSONArray()
            for (column in columns) {
                array.put(column)
            }
            filter.put("columns", array)
        }
        return filter
    }

    /** Text search over one column in the given parse mode. */
    fun textSearch(
        column: String,
        query: String,
        type: KizunaSyncTextSearchType = KizunaSyncTextSearchType.Plain,
    ): JSONObject =
        JSONObject()
            .put("kind", "textSearch")
            .put("column", column)
            .put("query", query)
            .put("type", type.wire)

    /** One sort key. [nullsFirst] left null keeps the engine's default placement. */
    fun order(column: String, ascending: Boolean = true, nullsFirst: Boolean? = null): JSONObject {
        val key = JSONObject().put("column", column).put("ascending", ascending)
        if (nullsFirst != null) {
            key.put("nullsFirst", nullsFirst)
        }
        return key
    }

    /**
     * A whole query plan. [projection] null selects every column, and
     * [includeDeleted] true brings back the rows a soft-delete column marks.
     */
    fun plan(
        filters: JSONArray = JSONArray(),
        order: JSONArray? = null,
        limit: Int? = null,
        projection: JSONArray? = null,
        cardinality: String = "many",
        includeDeleted: Boolean = false,
    ): JSONObject {
        val plan = JSONObject().put("filters", filters).put("cardinality", cardinality)
        if (order != null) {
            plan.put("orders", order)
        }
        if (limit != null) {
            plan.put("limit", limit)
        }
        if (projection != null) {
            plan.put("projection", projection)
        }
        if (includeDeleted) {
            plan.put("includeDeleted", true)
        }
        return plan
    }

    /** A plan that answers with every matching row. */
    fun many(vararg filters: JSONObject): JSONObject {
        val array = JSONArray()
        for (filter in filters) {
            array.put(filter)
        }
        return plan(filters = array, cardinality = "many")
    }

    /** A plan that requires exactly one matching row. */
    fun single(vararg filters: JSONObject): JSONObject {
        val array = JSONArray()
        for (filter in filters) {
            array.put(filter)
        }
        return plan(filters = array, cardinality = "single")
    }

    /** A plan that allows zero or one matching row. */
    fun maybeSingle(vararg filters: JSONObject): JSONObject {
        val array = JSONArray()
        for (filter in filters) {
            array.put(filter)
        }
        return plan(filters = array, cardinality = "maybeSingle")
    }
}

/**
 * [map] as a JSON object that keeps every null, at any depth, as an explicit JSON
 * null. `JSONObject(map)` drops null entries on the JVM, so a column set to NULL
 * or a null precondition would leave the payload without a trace.
 */
private fun jsonObjectOf(map: Map<*, *>): JSONObject {
    val json = JSONObject()
    for ((key, value) in map) {
        json.put(key.toString(), jsonValueOf(value))
    }
    return json
}

private fun jsonValueOf(value: Any?): Any? =
    when (value) {
        null -> JSONObject.NULL
        is Map<*, *> -> jsonObjectOf(value)
        is Iterable<*> -> jsonArrayOf(value)
        is Array<*> -> jsonArrayOf(value.asIterable())
        else -> JSONObject.wrap(value)
    }

private fun jsonArrayOf(values: Iterable<*>): JSONArray {
    val array = JSONArray()
    for (value in values) {
        array.put(jsonValueOf(value))
    }
    return array
}

/** The JDK logger, so the client adds no dependency; Android forwards it to logcat. */
private val clientLogger: Logger = Logger.getLogger("com.kizunasync.kizunasync")

/**
 * Report a throwable from an app callback the client invoked. The caller
 * catches it, because a throw would otherwise cross the engine's delivery or
 * skip the callbacks after it.
 */
internal fun logCallbackFailure(callback: String, failure: Throwable) {
    clientLogger.log(Level.WARNING, "$callback threw", failure)
}

/** One event from the engine's bus. */
typealias KizunaSyncEngineEvent = FfiEngineEvent

/** The state of one attachment object. */
typealias KizunaSyncAttachmentStatus = FfiAttachmentStatus

/** One server refusal held in the journal. */
typealias KizunaSyncRejection = FfiRejection

/** The pull cursor, and whether and why the engine keeps pull and push off the network until `reset()`. */
typealias KizunaSyncCheckpoint = FfiCheckpoint

/** What `fromFile` staged: the reference and the local path. */
typealias KizunaSyncFromFileResult = FfiFromFileResult

/**
 * Typed host over the generated UniFFI engine. Every call runs on [Dispatchers.IO]
 * so `sync()` cannot block the Android main thread.
 */
class KizunaSyncClient(
    private val engine: uniffi.kizunasync_ffi.KizunaSyncEngine = uniffi.kizunasync_ffi.KizunaSyncEngine(),
) {
    /** [dispose] cancels it and [create] replaces a cancelled one, so an unsubscribe works after a re-create. */
    @Volatile
    private var disposalScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val inspectorLock = Any()

    /**
     * The tables the last successful [create] declared, with their key columns.
     * [from] reads them, so an unconfigured table fails at the call rather than
     * at execute, and an insert knows whether it mints.
     */
    @Volatile
    private var configuredTables: Map<String, List<String>> = emptyMap()

    private var attachedInspector: KizunaSyncInspector? = null

    /**
     * Open the store and declare the synced tables.
     *
     * @throws KizunaSyncError.Engine `ATTACHMENT_PORTS_MISSING` when a table declares
     * attachments and [KizunaSyncClientConfig.attachmentRoot] is unset,
     * `CONFIG_INVALID` when the client id is not a uuid, and whatever the engine
     * reports otherwise.
     */
    suspend fun create(config: KizunaSyncClientConfig) {
        if (config.declaresAttachments() && config.attachmentRoot == null) {
            throw KizunaSyncError.Engine(
                KizunaSyncErrorCode.ATTACHMENT_PORTS_MISSING,
                "a table declares attachments but attachmentRoot is unset",
            )
        }
        if (!config.carriesUuidClientId()) {
            throw KizunaSyncError.Engine(
                KizunaSyncErrorCode.CONFIG_INVALID,
                "clientId must be a uuid, got \"${config.deviceId}\"",
            )
        }
        val json = config.toJson().toString()
        runOffCallingThread { engine.create(json) }
        if (!disposalScope.isActive) {
            disposalScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        }
        configuredTables = config.tables.mapValues { (_, table) -> table.key }
    }

    /**
     * Queue one mutation against one row.
     *
     * @throws KizunaSyncError.Engine `LOCAL_UNSUPPORTED` when [table] or [pk] is
     * empty, and the engine's code otherwise.
     */
    suspend fun apply(
        table: String,
        pk: String,
        op: KizunaSyncOp,
        columns: Map<String, Any?> = emptyMap(),
        mutationId: String? = null,
        transforms: Map<String, Any?>? = null,
        precondition: Map<String, Any?>? = null,
    ) {
        if (table.isEmpty() || pk.isEmpty()) {
            throw KizunaSyncError.Engine(
                KizunaSyncErrorCode.LOCAL_UNSUPPORTED,
                "apply requires table and pk",
            )
        }
        queue(table, pk, op, columns, mutationId, transforms, precondition)
    }

    /**
     * [apply] without its pk guard: an insert whose pk the engine derives from
     * the key columns passes an empty one.
     */
    internal suspend fun queue(
        table: String,
        pk: String,
        op: KizunaSyncOp,
        columns: Map<String, Any?>,
        mutationId: String? = null,
        transforms: Map<String, Any?>? = null,
        precondition: Map<String, Any?>? = null,
    ) {
        val mutation =
            JSONObject()
                .put("table", table)
                .put("pk", pk)
                .put("op", op.wire)
                .put("columns", jsonObjectOf(columns))
        if (mutationId != null) {
            mutation.put("mutation_id", mutationId)
        }
        if (transforms != null) {
            mutation.put("transforms", jsonObjectOf(transforms))
        }
        if (precondition != null) {
            mutation.put("precondition", jsonObjectOf(precondition))
        }
        runOffCallingThread { engine.apply(mutation.toString()) }
    }

    /**
     * Queue one mutation per row the filters target, and answer with their primary keys.
     *
     * @throws KizunaSyncError.Engine `LOCAL_UNSUPPORTED` when [filters] is empty, and
     * the engine's code otherwise.
     */
    suspend fun applyWhere(
        table: String,
        op: KizunaSyncOp,
        filters: JSONArray,
        columns: Map<String, Any?> = emptyMap(),
        transforms: Map<String, Any?>? = null,
        precondition: Map<String, Any?>? = null,
    ): List<String> = applyWhere(table, op, filters, columns, transforms, precondition, JSONObject())

    /**
     * [applyWhere] with the kernel options a builder sets: `max_affected`,
     * `returning` (the answer is then one JSON row per element), and a one-row
     * `cardinality`.
     */
    internal suspend fun applyWhere(
        table: String,
        op: KizunaSyncOp,
        filters: JSONArray,
        columns: Map<String, Any?>,
        transforms: Map<String, Any?>?,
        precondition: Map<String, Any?>?,
        options: JSONObject,
    ): List<String> {
        return runOffCallingThread {
            engine.applyWhere(
                table,
                op.wire,
                filters.toString(),
                jsonObjectOf(columns).toString(),
                jsonObjectOf(transforms.orEmpty()).toString(),
                jsonObjectOf(precondition.orEmpty()).toString(),
                options.toString(),
            )
        }
    }

    /**
     * Run one plan and answer with the decoded JSON the engine returned.
     *
     * @throws KizunaSyncError.Engine `LOCAL_CONSTRAINT` for a cardinality miss and
     * `LOCAL_UNSUPPORTED` for a construct the local subset cannot answer.
     */
    suspend fun query(table: String, plan: JSONObject = JSONObject()): Any {
        val raw = runOffCallingThread { engine.queryTable(table, plan.toString()) }
        val trimmed = raw.trim()
        if (trimmed == "null") {
            return JSONObject.NULL
        }
        if (trimmed.startsWith("[")) {
            return JSONArray(trimmed)
        }
        return JSONObject(trimmed)
    }

    /**
     * Push the outbox, move the queued attachment bytes, then pull, in one pass.
     *
     * @throws KizunaSyncError.Engine whatever the engine or the remote reported.
     */
    suspend fun sync() {
        runOffCallingThread { engine.sync() }
    }

    /**
     * Pull once, without pushing.
     *
     * @throws KizunaSyncError.Engine whatever the engine or the remote reported.
     */
    suspend fun pullOnce() {
        runOffCallingThread { engine.pullOnce() }
    }

    /**
     * Push the outbox once, without pulling.
     *
     * @throws KizunaSyncError.Engine whatever the engine or the remote reported.
     */
    suspend fun pushOnce() {
        runOffCallingThread { engine.pushOnce() }
    }

    /**
     * How many mutations are still queued.
     *
     * @throws KizunaSyncError.Engine the store's code when the queue cannot be read.
     */
    suspend fun outboxDepth(): Int {
        return runOffCallingThread { engine.outboxDepth().toInt() }
    }

    /**
     * Swap the JWT the remote sends. Passing null clears it.
     *
     * @throws KizunaSyncError.Engine the engine's code when the client has no engine yet.
     */
    suspend fun setAccessToken(token: String?) {
        runOffCallingThread { engine.setAccessToken(token) }
    }

    /**
     * Rebind the bucket predicate's values.
     *
     * @throws KizunaSyncError.Engine the engine's code when the params cannot be read.
     */
    suspend fun setBucket(params: Map<String, Any?>) {
        runOffCallingThread { engine.setBucket(jsonObjectOf(params).toString()) }
    }

    /**
     * The server refusals held in the journal.
     *
     * @throws KizunaSyncError.Engine the store's code when the journal cannot be read.
     */
    suspend fun rejections(includeDismissed: Boolean = false): List<KizunaSyncRejection> {
        return runOffCallingThread { engine.rejections(includeDismissed) }
    }

    /**
     * Mark one refusal as seen. Answers false when no such refusal is held.
     *
     * @throws KizunaSyncError.Engine the store's code when the journal cannot be written.
     */
    suspend fun dismissRejection(mutationId: String): Boolean {
        return runOffCallingThread { engine.dismissRejection(mutationId) }
    }

    /**
     * The column overwrites held in the journal, newest first: the values this
     * device wrote that a peer's push replaced.
     *
     * @throws KizunaSyncError.Engine the store's code when the journal cannot be read.
     */
    suspend fun overwrites(includeDismissed: Boolean = false): List<KizunaSyncOverwrite> {
        val value = invoke("overwrites", JSONObject().put("include_dismissed", includeDismissed))
        val rows = value as? JSONArray ?: return emptyList()
        return (0 until rows.length()).mapNotNull { index ->
            rows.optJSONObject(index)?.let(KizunaSyncOverwrite::from)
        }
    }

    /**
     * Acknowledge one journalled overwrite by its own id. Answers false when no
     * entry carries it.
     *
     * @throws KizunaSyncError.Engine the store's code when the journal cannot be written.
     */
    suspend fun dismissOverwrite(id: Long): Boolean =
        invoke("dismiss_overwrite", JSONObject().put("id", id)) as? Boolean ?: false

    /**
     * Take one permanently failed attachment back: the transfer budget is
     * forgiven and the next drive sees the row again. Answers false when no row
     * carries [reference].
     *
     * @throws KizunaSyncError.Engine the store's code when the row cannot be written.
     */
    suspend fun attachmentRetry(reference: String): Boolean =
        invoke("attachment_retry", JSONObject().put("reference", reference)) as? Boolean ?: false

    /**
     * Stop one transfer at the app's request. The row lands `failed` and stays
     * retryable, so the next drive may take it. Answers false when no row
     * carries [reference].
     *
     * @throws KizunaSyncError.Engine the store's code when the row cannot be written.
     */
    suspend fun attachmentCancel(reference: String): Boolean =
        invoke("attachment_cancel", JSONObject().put("reference", reference)) as? Boolean ?: false

    /**
     * Forget one attachment row and answer the sandbox path whose bytes the app
     * still has to delete, or null when the row carried none or did not exist.
     *
     * @throws KizunaSyncError.Engine the store's code when the row cannot be written.
     */
    suspend fun attachmentRemove(reference: String): String? =
        invoke("attachment_remove", JSONObject().put("reference", reference)) as? String

    /**
     * Drop every local row, the outbox, the cursor, and the journals, keep a
     * newly minted client identity, and answer with the attachment sandbox
     * paths whose bytes the app still has to delete.
     *
     * @throws KizunaSyncError.Engine the store's code when the wipe cannot be written.
     */
    suspend fun reset(): List<String> {
        return runOffCallingThread { engine.reset() }
    }

    /**
     * The pull cursor, and whether and why the engine keeps pull and push off
     * the network until [reset] runs.
     *
     * @throws KizunaSyncError.Engine the store's code when the cursor cannot be read.
     */
    suspend fun checkpoint(): KizunaSyncCheckpoint {
        return runOffCallingThread { engine.checkpoint() }
    }

    /**
     * Adopt a cursor the host already holds, skipping the rows behind it.
     *
     * @throws KizunaSyncError.Engine the store's code when the cursor cannot be written.
     */
    suspend fun seedCheckpoint(cursor: String) {
        runOffCallingThread { engine.seedCheckpoint(cursor) }
    }

    /**
     * Subscribe to engine events. The returned unsubscribe function is safe to call from
     * any thread, including main, because it dispatches the FFI call off the calling thread.
     * A throw from [handler] is logged at `WARNING` on the `com.kizunasync.kizunasync`
     * logger, and the events after it still arrive.
     *
     * @throws KizunaSyncError.Engine the engine's code when the client has no engine yet.
     */
    suspend fun on(handler: (KizunaSyncEngineEvent) -> Unit): () -> Unit {
        val observer =
            object : EventObserver {
                override fun onEvent(event: FfiEngineEvent) {
                    try {
                        handler(event)
                    } catch (failure: Throwable) {
                        logCallbackFailure("onEvent handler", failure)
                    }
                }
            }
        val id = runOffCallingThread { engine.subscribe(observer) }
        return {
            disposalScope.launch { runCatching { runOffCallingThread { engine.unsubscribe(id) } } }
        }
    }

    /**
     * Stage a local file as the attachment of one row and queue its upload.
     *
     * @throws KizunaSyncError.Engine the transfer's code when the bytes cannot be staged.
     */
    suspend fun fromFile(
        table: String,
        column: String,
        pk: String,
        sourcePath: String,
        mediaType: String? = null,
    ): KizunaSyncFromFileResult {
        return runOffCallingThread {
            engine.fromFile(table, column, pk, sourcePath, mediaType)
        }
    }

    /**
     * The local path of an attachment, or null while its bytes are still remote.
     *
     * @throws KizunaSyncError.Engine the transfer's code when the download cannot be resolved.
     */
    suspend fun resolveDownload(reference: String): String? {
        return runOffCallingThread { engine.resolveDownload(reference) }
    }

    /**
     * Drop the staged bytes no row references any more.
     *
     * @throws KizunaSyncError.Engine the store's code when the sweep cannot run.
     */
    suspend fun vacuum() {
        runOffCallingThread { engine.vacuum() }
    }

    /**
     * The state of one attachment, or null when the engine holds none.
     *
     * @throws KizunaSyncError.Engine the store's code when the state cannot be read.
     */
    suspend fun getStatus(reference: String): KizunaSyncAttachmentStatus? {
        return runOffCallingThread { engine.getStatus(reference) }
    }

    /**
     * Watch attachment status for [reference]. The returned unwatch function is safe to
     * call from any thread, including main, because it dispatches the FFI call off the
     * calling thread.
     *
     * @throws KizunaSyncError.Engine the engine's code when the client has no engine yet.
     */
    suspend fun watch(reference: String, handler: (KizunaSyncAttachmentStatus) -> Unit): () -> Unit {
        val listener =
            object : AttachmentListener {
                override fun onStatus(status: FfiAttachmentStatus) {
                    handler(status)
                }
            }
        val id = runOffCallingThread { engine.watch(reference, listener) }
        return {
            disposalScope.launch { runCatching { runOffCallingThread { engine.unwatch(id) } } }
        }
    }

    /**
     * The raw devtools snapshot of the command queue. [KizunaSyncInspector.snapshot]
     * is the typed reading of the same five fields.
     *
     * @throws KizunaSyncError.Engine `ENGINE_UNAVAILABLE` when the payload is not an
     * object, and the engine's code otherwise.
     */
    suspend fun inspect(): JSONObject {
        val raw = runOffCallingThread { engine.inspect() }
        return try {
            JSONObject(raw)
        } catch (malformed: JSONException) {
            throw KizunaSyncError.Engine(
                KizunaSyncErrorCode.ENGINE_UNAVAILABLE,
                "inspect: expected an object",
            )
        }
    }

    /**
     * The devtools inspector over this client: the queue snapshot plus the
     * bounded verdict ring the engine's event bus feeds. One per client, so
     * every caller reads the same ring.
     *
     * @throws KizunaSyncError.Engine the engine's code when the event subscription
     * cannot be installed.
     */
    suspend fun inspector(): KizunaSyncInspector {
        synchronized(inspectorLock) { attachedInspector }?.let { return it }
        val created = KizunaSyncInspector(this)
        created.attach()
        val winner = synchronized(inspectorLock) { attachedInspector ?: created.also { attachedInspector = it } }
        if (winner !== created) {
            created.detach()
        }
        return winner
    }

    /** Close the engine and its store. Further calls fail with `ENGINE_UNAVAILABLE`. */
    suspend fun dispose() {
        val inspector = synchronized(inspectorLock) { attachedInspector.also { attachedInspector = null } }
        configuredTables = emptyMap()
        inspector?.detach()
        runCatching { runOffCallingThread { engine.shutdown() } }
        disposalScope.cancel()
    }

    /**
     * The fluent surface of one table.
     *
     * @throws KizunaSyncError.Engine `UNKNOWN_TABLE` when the table is absent from the
     * config the last [create] declared, because reads and filter-targeted
     * writes on it would otherwise no-op with no bucket and no sync rules.
     */
    fun from(table: String): KizunaSyncTable {
        val known = configuredTables
        val key = known[table]
        if (key == null) {
            val configured = if (known.isEmpty()) "none" else known.keys.sorted().joinToString(", ")
            throw KizunaSyncError.Engine(
                KizunaSyncErrorCode.UNKNOWN_TABLE,
                "from(\"$table\"): table is not in the kizunasync config (configured: $configured)",
            )
        }
        return KizunaSyncTable(this, table, key)
    }

    /**
     * One kernel method the typed surface does not export, through the same
     * JSON-RPC envelope every bridge answers. A refused call arrives as
     * [KizunaSyncError.Engine] carrying the kernel's own code, so a caller switches
     * on `code` here exactly as it does on a typed method.
     *
     * @throws KizunaSyncError.Engine `ENGINE_UNAVAILABLE` when the envelope carries
     * no code, because an envelope this client cannot read is not a gradeable
     * failure.
     */
    private suspend fun invoke(method: String, params: JSONObject): Any? {
        val raw = runOffCallingThread { engine.call(method, params.toString()) }
        val envelope =
            try {
                JSONObject(raw)
            } catch (malformed: JSONException) {
                throw KizunaSyncError.Engine(KizunaSyncErrorCode.ENGINE_UNAVAILABLE, "$method: unreadable envelope")
            }
        if (envelope.optBoolean("ok", false)) {
            return envelope.opt("value").takeUnless { it == JSONObject.NULL }
        }
        val failure = envelope.optJSONObject("error")
        throw KizunaSyncError.Engine(
            failure?.optString("code")?.ifEmpty { null } ?: KizunaSyncErrorCode.ENGINE_UNAVAILABLE,
            failure?.optString("message")?.ifEmpty { null } ?: "$method failed",
        )
    }

    /**
     * Runs one engine call off the calling thread and translates the generated
     * exception, so no `uniffi.kizunasync_ffi` type escapes the client.
     */
    private suspend fun <T> runOffCallingThread(block: () -> T): T =
        withContext(Dispatchers.IO) {
            try {
                block()
            } catch (error: KizunaSyncFfiException.Engine) {
                throw KizunaSyncError.Engine(error.code, error.msg)
            }
        }
}
