package com.kizunasync.kizunasync

import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

/** Table-scoped fluent surface matching JavaScript `kizunasync.from(table)`. */
class KizunaSyncTable internal constructor(
    private val client: KizunaSyncClient,
    private val table: String,
    private val key: List<String>,
) {
    /**
     * Queue one insert. A table keyed by `id` whose row names no `id` gets a
     * minted uuid; every other row's primary key is the one the engine derives
     * from the key columns, which must all be present as strings or integers.
     *
     * @throws KizunaSyncError.Engine `LOCAL_CONSTRAINT` for a missing or invalid
     * key column or a duplicate primary key and `UNKNOWN_TABLE` for a table the
     * config never declared.
     */
    suspend fun insert(columns: Map<String, Any?>) {
        val mints = key == DEFAULT_KEY && "id" !in columns
        val pk = if (mints) UUID.randomUUID().toString() else ""
        client.queue(table = table, pk = pk, op = KizunaSyncOp.Insert, columns = columns)
    }

    /** Start an update of [columns] over the rows the filters target. */
    fun update(
        columns: Map<String, Any?>,
        transforms: Map<String, Any?>? = null,
        precondition: Map<String, Any?>? = null,
    ): KizunaSyncWriteBuilder =
        KizunaSyncWriteBuilder(client, table, KizunaSyncOp.Update, columns, transforms, precondition)

    /**
     * Start a delete over the rows the filters target. The store's delete path
     * reads neither columns nor transforms, so the builder carries only a
     * precondition.
     */
    fun delete(precondition: Map<String, Any?>? = null): KizunaSyncWriteBuilder =
        KizunaSyncWriteBuilder(client, table, KizunaSyncOp.Delete, emptyMap(), null, precondition)

    /**
     * Start a read. [columns] is a comma-separated projection, and `"*"`
     * selects every column. Relational embeds and renames are not part of the
     * local subset and the engine refuses them with `LOCAL_UNSUPPORTED`.
     *
     * [count] asks for the rows the filters match before `range` and `limit`:
     * every option returns the exact local count, and the terminals then answer
     * a `JSONObject` with `rows` and `count`. [head] drops the rows from that
     * answer.
     */
    fun select(
        columns: String = "*",
        head: Boolean = false,
        count: KizunaSyncCount? = null,
    ): KizunaSyncSelectBuilder = KizunaSyncSelectBuilder(client, table, projection(columns), head, count != null)
}

/** The row-count options `select` takes. Every one returns the exact local count, since the kernel counts every match. */
enum class KizunaSyncCount {
    Exact,
    Planned,
    Estimated,
}

/** Fluent read over one table. Every filter is the same AST [KizunaSyncQuery] builds. */
class KizunaSyncSelectBuilder internal constructor(
    private val client: KizunaSyncClient,
    private val table: String,
    private val projection: JSONArray?,
    private val isHead: Boolean,
    private val isCounted: Boolean,
) {
    private val filters = JSONArray()
    private val orders = JSONArray()
    private var limitCount: Int? = null
    private var offsetCount: Int? = null
    private var refusal: String? = null
    private var includeDeletedRows = false
    private var isStrippingNulls = false

    /** Keeps the first refusal: the read throws it when it runs. */
    private fun refuse(message: String): KizunaSyncSelectBuilder {
        refusal = refusal ?: message
        return this
    }

    private fun append(filter: JSONObject): KizunaSyncSelectBuilder {
        filters.put(filter)
        return this
    }

    /** Keep the rows whose column equals [value]. */
    fun eq(column: String, value: Any?): KizunaSyncSelectBuilder {
        filters.put(KizunaSyncQuery.eq(column, value))
        return this
    }

    /** Keep the rows whose column differs from [value]. */
    fun neq(column: String, value: Any?): KizunaSyncSelectBuilder {
        filters.put(KizunaSyncQuery.neq(column, value))
        return this
    }

    /** Keep the rows whose column is greater than [value]. */
    fun gt(column: String, value: Any): KizunaSyncSelectBuilder {
        filters.put(KizunaSyncQuery.gt(column, value))
        return this
    }

    /** Keep the rows whose column is greater than or equal to [value]. */
    fun gte(column: String, value: Any): KizunaSyncSelectBuilder {
        filters.put(KizunaSyncQuery.gte(column, value))
        return this
    }

    /** Keep the rows whose column is less than [value]. */
    fun lt(column: String, value: Any): KizunaSyncSelectBuilder {
        filters.put(KizunaSyncQuery.lt(column, value))
        return this
    }

    /** Keep the rows whose column is less than or equal to [value]. */
    fun lte(column: String, value: Any): KizunaSyncSelectBuilder {
        filters.put(KizunaSyncQuery.lte(column, value))
        return this
    }

    /** Keep the rows whose column matches the case-sensitive pattern. */
    fun like(column: String, pattern: String): KizunaSyncSelectBuilder {
        filters.put(KizunaSyncQuery.like(column, pattern))
        return this
    }

    /** Keep the rows whose column matches the case-insensitive pattern. */
    fun ilike(column: String, pattern: String): KizunaSyncSelectBuilder {
        filters.put(KizunaSyncQuery.ilike(column, pattern))
        return this
    }

    /** Keep the rows whose column is null, true, or false. null is the null test. */
    fun isValue(column: String, value: Boolean?): KizunaSyncSelectBuilder {
        filters.put(KizunaSyncQuery.isValue(column, value))
        return this
    }

    /** Keep the rows whose column is one of [values]. */
    fun inValues(column: String, values: Collection<Any?>): KizunaSyncSelectBuilder {
        filters.put(KizunaSyncQuery.inValues(column, values))
        return this
    }

    /** Keep the rows whose column contains [value]. */
    fun contains(column: String, value: Any): KizunaSyncSelectBuilder {
        filters.put(KizunaSyncQuery.contains(column, value))
        return this
    }

    /** Keep the rows whose column is contained by [value]. */
    fun containedBy(column: String, value: Any): KizunaSyncSelectBuilder {
        filters.put(KizunaSyncQuery.containedBy(column, value))
        return this
    }

    /** Keep the rows at least one nested filter matches. */
    fun or(vararg filters: JSONObject): KizunaSyncSelectBuilder {
        this.filters.put(KizunaSyncQuery.or(*filters))
        return this
    }

    /** Keep the rows every nested filter matches. */
    fun and(vararg filters: JSONObject): KizunaSyncSelectBuilder {
        this.filters.put(KizunaSyncQuery.and(*filters))
        return this
    }

    /** Keep the rows the nested filter rejects. */
    fun not(filter: JSONObject): KizunaSyncSelectBuilder {
        filters.put(KizunaSyncQuery.not(filter))
        return this
    }

    /**
     * Keep the rows matching a free-text query over [columns], or over every
     * text column when it is null.
     */
    fun search(query: String, columns: Collection<String>? = null): KizunaSyncSelectBuilder {
        filters.put(KizunaSyncQuery.search(query, columns))
        return this
    }

    /** Keep the rows whose column matches a text-search query in the given parse mode. */
    fun textSearch(
        column: String,
        query: String,
        type: KizunaSyncTextSearchType = KizunaSyncTextSearchType.Plain,
    ): KizunaSyncSelectBuilder {
        filters.put(KizunaSyncQuery.textSearch(column, query, type))
        return this
    }

    /** Append one sort key. */
    fun order(column: String, ascending: Boolean = true, nullsFirst: Boolean? = null): KizunaSyncSelectBuilder {
        orders.put(KizunaSyncQuery.order(column, ascending, nullsFirst))
        return this
    }

    /** Cap how many rows come back. A count below zero is `LOCAL_UNSUPPORTED`. */
    fun limit(count: Int): KizunaSyncSelectBuilder {
        limitCount = count
        return this
    }

    /**
     * Keep the rows at indexes [from] through [to], both inclusive and counted
     * from zero after the sort, as supabase-js `range` does: the plan skips
     * [from] rows and keeps `to - from + 1`, so a [to] one below [from] keeps
     * none. A later [limit] replaces only the row count. A negative bound, or a
     * [to] further below [from], throws `LOCAL_UNSUPPORTED` when the read runs,
     * and so does every read of this builder after it.
     */
    fun range(from: Int, to: Int): KizunaSyncSelectBuilder {
        if (from < 0 || to < 0 || to < from - 1) {
            return refuse("range($from, $to): the bounds must be zero or more, and to at least from - 1")
        }
        offsetCount = from
        // range(0, Int.MAX_VALUE) spans one row more than Int counts; saturating still keeps every row.
        limitCount = (to.toLong() - from + 1).coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
        return this
    }

    /**
     * Bring back the rows the table's soft-delete column marks, which every read
     * leaves out by default. A table that declares no such column is unaffected.
     */
    fun includeDeleted(): KizunaSyncSelectBuilder {
        includeDeletedRows = true
        return this
    }

    /** Answer each row without its null-valued keys. */
    fun stripNulls(): KizunaSyncSelectBuilder {
        isStrippingNulls = true
        return this
    }

    /** Identity: a local read makes no network attempt to retry. */
    @Suppress("UNUSED_PARAMETER")
    fun retry(enabled: Boolean): KizunaSyncSelectBuilder = this

    /**
     * Run the plan and answer with the decoded row array, or with a
     * `JSONObject` holding `rows` and `count` when `select` asked for a count
     * or [head][KizunaSyncTable.select].
     *
     * @throws KizunaSyncError.Engine `LOCAL_UNSUPPORTED` for a construct outside the
     * local subset and `UNKNOWN_TABLE` for a table the config never declared.
     */
    suspend fun execute(): Any = run("many")

    /**
     * Run the plan and answer with the one matching row.
     *
     * @throws KizunaSyncError.Engine `LOCAL_CONSTRAINT` when the plan matched
     * anything other than one row.
     */
    suspend fun single(): Any = run("single")

    /**
     * Run the plan and answer with the one matching row, or null when none matched.
     *
     * @throws KizunaSyncError.Engine `LOCAL_CONSTRAINT` when the plan matched more
     * than one row.
     */
    suspend fun maybeSingle(): Any = run("maybeSingle")

    /**
     * Run the plan and answer with the rows as CSV text: a header of the
     * selected columns in their order, or of every key the rows carry for `*`,
     * then one line per row. A field holding a quote, a comma, or a line break
     * is quoted per RFC 4180, null is an empty field, and an array or an object
     * is its JSON text. A `head` read answers an empty string.
     */
    suspend fun csv(): String {
        val rows = answer("many").first
        if (isHead) {
            return ""
        }
        val array = rows as? JSONArray ?: JSONArray()
        val objects = (0 until array.length()).mapNotNull { array.opt(it) as? JSONObject }
        val columns = projection?.let { names -> (0 until names.length()).map { names.getString(it) } }
        return KizunaSyncRowShaping.csv(objects, columns)
    }

    private suspend fun run(cardinality: String): Any {
        val (rows, count) = answer(cardinality)
        val shaped = if (isHead) JSONObject.NULL else if (isStrippingNulls) KizunaSyncRowShaping.stripNulls(rows) else rows
        if (!isCounted && !isHead) {
            return shaped
        }
        return JSONObject().put("rows", shaped).put("count", count)
    }

    /** The kernel's answer, and the count beside it when the plan asked for one. */
    private suspend fun answer(cardinality: String): Pair<Any, Any> {
        val answer = client.query(table, plan(cardinality))
        if (!isCounted || answer !is JSONObject) {
            return answer to JSONObject.NULL
        }
        return answer.opt("rows") to answer.opt("count")
    }

    private fun plan(cardinality: String): JSONObject {
        refusal?.let { throw KizunaSyncError.Engine(KizunaSyncErrorCode.LOCAL_UNSUPPORTED, it) }
        val plan =
            KizunaSyncQuery.plan(
                filters = filters,
                order = if (orders.length() == 0) null else orders,
                limit = limitCount,
                projection = projection,
                cardinality = cardinality,
                includeDeleted = includeDeletedRows,
            )
        val offset = offsetCount
        if (offset != null) {
            plan.put("offset", offset)
        }
        if (isCounted) {
            plan.put("count", true)
        }
        return plan
    }

    /**
     * Keep the rows whose column matches the regular expression somewhere in
     * its text, Postgres `~`. A pattern with a backreference or lookaround
     * throws `LOCAL_UNSUPPORTED` naming it when the read runs.
     */
    fun regexMatch(column: String, pattern: String): KizunaSyncSelectBuilder = append(KizunaSyncOperatorNode.regex(column, pattern, false))

    /** Case-insensitive [regexMatch], Postgres `~*`. */
    fun regexIMatch(column: String, pattern: String): KizunaSyncSelectBuilder = append(KizunaSyncOperatorNode.regex(column, pattern, true))

    /** Keep the rows whose columns equal every value in [query]. An empty map keeps every row. */
    fun match(query: Map<String, Any?>): KizunaSyncSelectBuilder = append(KizunaSyncOperatorNode.match(query))

    /** Keep the rows whose column matches every `like` pattern. */
    fun likeAll(column: String, patterns: List<String>): KizunaSyncSelectBuilder = append(KizunaSyncOperatorNode.patterns("like", column, patterns, false))

    /** Keep the rows whose column matches any `like` pattern. */
    fun likeAny(column: String, patterns: List<String>): KizunaSyncSelectBuilder = append(KizunaSyncOperatorNode.patterns("like", column, patterns, true))

    /** Case-insensitive [likeAll]. */
    fun ilikeAll(column: String, patterns: List<String>): KizunaSyncSelectBuilder = append(KizunaSyncOperatorNode.patterns("ilike", column, patterns, false))

    /** Case-insensitive [likeAny]. */
    fun ilikeAny(column: String, patterns: List<String>): KizunaSyncSelectBuilder = append(KizunaSyncOperatorNode.patterns("ilike", column, patterns, true))

    /** Keep the rows whose column is distinct from [value], treating null as a value, SQL `IS DISTINCT FROM`. */
    fun isDistinct(column: String, value: Any?): KizunaSyncSelectBuilder = append(KizunaSyncOperatorNode.isDistinct(column, value))

    /** Keep the rows whose column is none of [values], SQL `NOT IN`. */
    fun notIn(column: String, values: List<Any?>): KizunaSyncSelectBuilder = append(KizunaSyncOperatorNode.notIn(column, values))

    /** Keep the rows whose array column shares an element with [values], Postgres `&&`. */
    fun overlaps(column: String, values: List<Any?>): KizunaSyncSelectBuilder = append(KizunaSyncOperatorNode.overlaps(column, values))

    /**
     * Keep the rows one PostgREST clause, `column.operator.value`, selects. The
     * operator is one of `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`,
     * `ilike`, `is`, and `in`, optionally behind `not.`. Anything else throws
     * `LOCAL_UNSUPPORTED` when the read runs.
     */
    fun filter(column: String, operator: String, value: String): KizunaSyncSelectBuilder =
        try {
            append(KizunaSyncFilterClause.node(column, operator, value))
        } catch (clause: KizunaSyncFilterClause.Refusal) {
            refuse("filter(\"$column\", \"$operator\", …): ${clause.reason}")
        }

    /** Refused when the read runs: there is no server transaction to roll back; local writes enter the outbox. */
    fun dryRun(): KizunaSyncSelectBuilder = refuse(KizunaSyncRefusal.DRY_RUN)

    /** Refused when the read runs: PostGIS output has no local representation. */
    fun geojson(): KizunaSyncSelectBuilder = refuse(KizunaSyncRefusal.GEOJSON)

    /** Refused when the read runs: EXPLAIN describes the server query planner. */
    @Suppress("UNUSED_PARAMETER")
    fun explain(
        analyze: Boolean = false,
        verbose: Boolean = false,
        settings: Boolean = false,
        buffers: Boolean = false,
        wal: Boolean = false,
        format: String = "text",
    ): KizunaSyncSelectBuilder = refuse(KizunaSyncRefusal.EXPLAIN)
}

/**
 * Fluent filter-targeted write over one table. It carries the comparison,
 * pattern, null, list, containment, clause-list, and negation operators;
 * `search` and `textSearch` stay on the read builder.
 */
class KizunaSyncWriteBuilder internal constructor(
    private val client: KizunaSyncClient,
    private val table: String,
    private val op: KizunaSyncOp,
    private val columns: Map<String, Any?>,
    private val transforms: Map<String, Any?>?,
    private val precondition: Map<String, Any?>?,
) {
    private val filters = JSONArray()
    private var maxAffectedRows: Int? = null
    private var refusal: String? = null

    private fun refuse(message: String): KizunaSyncWriteBuilder {
        refusal = refusal ?: message
        return this
    }

    private fun append(filter: JSONObject): KizunaSyncWriteBuilder {
        filters.put(filter)
        return this
    }

    /** Target the rows whose column equals [value]. */
    fun eq(column: String, value: Any?): KizunaSyncWriteBuilder {
        filters.put(KizunaSyncQuery.eq(column, value))
        return this
    }

    /** Target the rows whose column differs from [value]. */
    fun neq(column: String, value: Any?): KizunaSyncWriteBuilder {
        filters.put(KizunaSyncQuery.neq(column, value))
        return this
    }

    /** Target the rows whose column is greater than [value]. */
    fun gt(column: String, value: Any): KizunaSyncWriteBuilder {
        filters.put(KizunaSyncQuery.gt(column, value))
        return this
    }

    /** Target the rows whose column is greater than or equal to [value]. */
    fun gte(column: String, value: Any): KizunaSyncWriteBuilder {
        filters.put(KizunaSyncQuery.gte(column, value))
        return this
    }

    /** Target the rows whose column is less than [value]. */
    fun lt(column: String, value: Any): KizunaSyncWriteBuilder {
        filters.put(KizunaSyncQuery.lt(column, value))
        return this
    }

    /** Target the rows whose column is less than or equal to [value]. */
    fun lte(column: String, value: Any): KizunaSyncWriteBuilder {
        filters.put(KizunaSyncQuery.lte(column, value))
        return this
    }

    /** Target the rows whose column matches the case-sensitive pattern. */
    fun like(column: String, pattern: String): KizunaSyncWriteBuilder {
        filters.put(KizunaSyncQuery.like(column, pattern))
        return this
    }

    /** Target the rows whose column matches the case-insensitive pattern. */
    fun ilike(column: String, pattern: String): KizunaSyncWriteBuilder {
        filters.put(KizunaSyncQuery.ilike(column, pattern))
        return this
    }

    /** Target the rows whose column is null, true, or false. null is the null test. */
    fun isValue(column: String, value: Boolean?): KizunaSyncWriteBuilder {
        filters.put(KizunaSyncQuery.isValue(column, value))
        return this
    }

    /** Target the rows whose column is one of [values]. */
    fun inValues(column: String, values: Collection<Any?>): KizunaSyncWriteBuilder {
        filters.put(KizunaSyncQuery.inValues(column, values))
        return this
    }

    /** Target the rows whose column contains [value]. */
    fun contains(column: String, value: Any): KizunaSyncWriteBuilder {
        filters.put(KizunaSyncQuery.contains(column, value))
        return this
    }

    /** Target the rows whose column is contained by [value]. */
    fun containedBy(column: String, value: Any): KizunaSyncWriteBuilder {
        filters.put(KizunaSyncQuery.containedBy(column, value))
        return this
    }

    /** Target the rows at least one nested filter matches. */
    fun or(vararg filters: JSONObject): KizunaSyncWriteBuilder {
        this.filters.put(KizunaSyncQuery.or(*filters))
        return this
    }

    /** Target the rows every nested filter matches. */
    fun and(vararg filters: JSONObject): KizunaSyncWriteBuilder {
        this.filters.put(KizunaSyncQuery.and(*filters))
        return this
    }

    /** Target the rows the nested filter rejects. */
    fun not(filter: JSONObject): KizunaSyncWriteBuilder {
        filters.put(KizunaSyncQuery.not(filter))
        return this
    }

    /**
     * Queue one mutation per targeted row and answer with their primary keys.
     *
     * @throws KizunaSyncError.Engine `LOCAL_UNSUPPORTED` when no filter was chained,
     * because an unfiltered write would target the whole table, and
     * `LOCAL_CONSTRAINT` when the filters match more rows than [maxAffected] allows.
     */
    suspend fun execute(): List<String> = run(JSONObject())

    /** The write with the kernel options its terminal adds. */
    internal suspend fun run(options: JSONObject): List<String> {
        refusal?.let { throw KizunaSyncError.Engine(KizunaSyncErrorCode.LOCAL_UNSUPPORTED, it) }
        maxAffectedRows?.let { options.put("max_affected", it) }
        return client.applyWhere(table, op, filters, columns, transforms, precondition, options)
    }

    /** Target the rows whose column matches the regular expression, Postgres `~`. */
    fun regexMatch(column: String, pattern: String): KizunaSyncWriteBuilder = append(KizunaSyncOperatorNode.regex(column, pattern, false))

    /** Case-insensitive [regexMatch], Postgres `~*`. */
    fun regexIMatch(column: String, pattern: String): KizunaSyncWriteBuilder = append(KizunaSyncOperatorNode.regex(column, pattern, true))

    /** Target the rows whose columns equal every value in [query]. An empty map names no rows, so the write refuses it. */
    fun match(query: Map<String, Any?>): KizunaSyncWriteBuilder = append(KizunaSyncOperatorNode.match(query))

    /** Target the rows whose column matches every `like` pattern. */
    fun likeAll(column: String, patterns: List<String>): KizunaSyncWriteBuilder = append(KizunaSyncOperatorNode.patterns("like", column, patterns, false))

    /** Target the rows whose column matches any `like` pattern. */
    fun likeAny(column: String, patterns: List<String>): KizunaSyncWriteBuilder = append(KizunaSyncOperatorNode.patterns("like", column, patterns, true))

    /** Case-insensitive [likeAll]. */
    fun ilikeAll(column: String, patterns: List<String>): KizunaSyncWriteBuilder = append(KizunaSyncOperatorNode.patterns("ilike", column, patterns, false))

    /** Case-insensitive [likeAny]. */
    fun ilikeAny(column: String, patterns: List<String>): KizunaSyncWriteBuilder = append(KizunaSyncOperatorNode.patterns("ilike", column, patterns, true))

    /** Target the rows whose column is distinct from [value], SQL `IS DISTINCT FROM`. */
    fun isDistinct(column: String, value: Any?): KizunaSyncWriteBuilder = append(KizunaSyncOperatorNode.isDistinct(column, value))

    /** Target the rows whose column is none of [values], SQL `NOT IN`. */
    fun notIn(column: String, values: List<Any?>): KizunaSyncWriteBuilder = append(KizunaSyncOperatorNode.notIn(column, values))

    /** Target the rows whose array column shares an element with [values], Postgres `&&`. */
    fun overlaps(column: String, values: List<Any?>): KizunaSyncWriteBuilder = append(KizunaSyncOperatorNode.overlaps(column, values))

    /** Target the rows one PostgREST clause selects, with the grammar the read builder's [KizunaSyncSelectBuilder.filter] takes. */
    fun filter(column: String, operator: String, value: String): KizunaSyncWriteBuilder =
        try {
            append(KizunaSyncFilterClause.node(column, operator, value))
        } catch (clause: KizunaSyncFilterClause.Refusal) {
            refuse("filter(\"$column\", \"$operator\", …): ${clause.reason}")
        }

    /**
     * The most rows the write may reach. When the filters match more, nothing
     * is written and the write throws `LOCAL_CONSTRAINT` naming the match count
     * and the cap. A negative [value] throws `LOCAL_UNSUPPORTED` when the write runs.
     */
    fun maxAffected(value: Int): KizunaSyncWriteBuilder {
        if (value < 0) {
            return refuse("maxAffected($value): the cap must be a whole number from 0 to 4294967295")
        }
        maxAffectedRows = value
        return this
    }

    /** Identity: a local write makes no network attempt to retry. */
    @Suppress("UNUSED_PARAMETER")
    fun retry(enabled: Boolean): KizunaSyncWriteBuilder = this

    /** Refused when the write runs: there is no server transaction to roll back; local writes enter the outbox. */
    fun dryRun(): KizunaSyncWriteBuilder = refuse(KizunaSyncRefusal.DRY_RUN)

    /** Refused when the write runs: PostGIS output has no local representation. */
    fun geojson(): KizunaSyncWriteBuilder = refuse(KizunaSyncRefusal.GEOJSON)

    /** Refused when the write runs: EXPLAIN describes the server query planner. */
    @Suppress("UNUSED_PARAMETER")
    fun explain(
        analyze: Boolean = false,
        verbose: Boolean = false,
        settings: Boolean = false,
        buffers: Boolean = false,
        wal: Boolean = false,
        format: String = "text",
    ): KizunaSyncWriteBuilder = refuse(KizunaSyncRefusal.EXPLAIN)

    /**
     * Return the rows the write reaches, cut to [columns]: an update's as they
     * read after it, a delete's as they read before it. A relational embed or a
     * rename in [columns] throws `LOCAL_UNSUPPORTED` before anything is written.
     */
    fun select(columns: String = "*"): KizunaSyncWriteSelectBuilder {
        val returned = KizunaSyncRowShaping.returnedColumns(columns)
        returned.refusal?.let { refuse(it) }
        return KizunaSyncWriteSelectBuilder(this, returned.columns)
    }
}

/** An update or a delete chained with [KizunaSyncWriteBuilder.select]. */
class KizunaSyncWriteSelectBuilder internal constructor(
    private val write: KizunaSyncWriteBuilder,
    private val columns: List<String>?,
) {
    private var isStrippingNulls = false

    /** Answer each returned row without its null-valued keys. */
    fun stripNulls(): KizunaSyncWriteSelectBuilder {
        isStrippingNulls = true
        return this
    }

    /** Identity: a local write makes no network attempt to retry. */
    @Suppress("UNUSED_PARAMETER")
    fun retry(enabled: Boolean): KizunaSyncWriteSelectBuilder = this

    /** Run the write and answer with the rows it reached, in primary-key order. */
    suspend fun execute(): JSONArray = JSONArray(rows(JSONObject().put("returning", true)))

    /**
     * Run the write and answer with its one row. A write whose filters match
     * another count writes nothing and throws `LOCAL_CONSTRAINT` with the message
     * a read gives, `single() requires exactly one row; got N`.
     */
    suspend fun single(): JSONObject = rows(JSONObject().put("returning", true).put("cardinality", "single")).first()

    /**
     * Run the write and answer with its row, or `JSONObject.NULL` when none
     * matched. A write whose filters match more than one row writes nothing and
     * throws `LOCAL_CONSTRAINT`.
     */
    suspend fun maybeSingle(): Any = rows(JSONObject().put("returning", true).put("cardinality", "maybeSingle")).firstOrNull() ?: JSONObject.NULL

    private suspend fun rows(options: JSONObject): List<JSONObject> =
        write.run(options).map { json ->
            val projected = KizunaSyncRowShaping.project(JSONObject(json), columns)
            if (isStrippingNulls) KizunaSyncRowShaping.stripNulls(projected) else projected
        }
}

/** The filter nodes the operators past the core set build; the core ones come from [KizunaSyncQuery]. */
internal object KizunaSyncOperatorNode {
    fun regex(column: String, pattern: String, caseInsensitive: Boolean): JSONObject =
        JSONObject().put("kind", if (caseInsensitive) "regexIMatch" else "regexMatch").put("column", column).put("pattern", pattern)

    /** `eq` on every key, sorted so the node does not depend on map order. */
    fun match(query: Map<String, Any?>): JSONObject =
        KizunaSyncQuery.and(*query.keys.sorted().map { KizunaSyncQuery.eq(it, query[it]) }.toTypedArray())

    fun patterns(kind: String, column: String, patterns: List<String>, any: Boolean): JSONObject {
        val nodes = patterns.map { JSONObject().put("kind", kind).put("column", column).put("pattern", it) }.toTypedArray()
        return if (any) KizunaSyncQuery.or(*nodes) else KizunaSyncQuery.and(*nodes)
    }

    fun isDistinct(column: String, value: Any?): JSONObject =
        JSONObject().put("kind", "isDistinct").put("column", column).put("value", value ?: JSONObject.NULL)

    fun notIn(column: String, values: List<Any?>): JSONObject = KizunaSyncQuery.not(KizunaSyncQuery.inValues(column, values))

    fun overlaps(column: String, values: List<Any?>): JSONObject =
        JSONObject().put("kind", "overlaps").put("column", column).put("value", JSONArray(values.map { it ?: JSONObject.NULL }))
}

/** Why each supabase-kt method with no local meaning is refused. */
internal object KizunaSyncRefusal {
    const val DRY_RUN = "dryRun(): there is no server transaction to roll back; local writes enter the outbox"
    const val GEOJSON = "geojson(): PostGIS output has no local representation"
    const val EXPLAIN = "explain(): EXPLAIN describes the server query planner"
}

private fun projection(columns: String): JSONArray? {
    val trimmed = columns.trim()
    if (trimmed.isEmpty() || trimmed == "*") {
        return null
    }
    val array = JSONArray()
    for (part in trimmed.split(",")) {
        val column = part.trim()
        if (column.isNotEmpty()) {
            array.put(column)
        }
    }
    return array
}
