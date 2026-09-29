package com.kizunasync.kizunasync

import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

/** Table-scoped fluent surface matching JavaScript `kizunasync.from(table)`. */
class KizunaSyncTable internal constructor(
    private val client: KizunaSyncClient,
    private val table: String,
) {
    /**
     * Queue one insert. A non-empty `String` under `"id"` is the row's primary
     * key; anything else leaves [columns] as given and mints a key beside it, so
     * the engine refuses the divergent identifier with `LOCAL_CONSTRAINT` rather
     * than discarding it.
     *
     * @throws KizunaSyncError.Engine `LOCAL_CONSTRAINT` for a divergent or duplicate
     * primary key and `UNKNOWN_TABLE` for a table the config never declared.
     */
    suspend fun insert(columns: Map<String, Any?>) {
        val existing = columns["id"] as? String
        val pk =
            if (existing.isNullOrEmpty()) {
                UUID.randomUUID().toString()
            } else {
                existing
            }
        client.apply(table = table, pk = pk, op = KizunaSyncOp.Insert, columns = columns)
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
     * Start a read. [columns] is a comma-separated projection; null and `"*"`
     * select every column. Relational embeds and renames are not part of the
     * local subset and the engine refuses them with `LOCAL_UNSUPPORTED`.
     */
    fun select(columns: String? = null): KizunaSyncSelectBuilder =
        KizunaSyncSelectBuilder(client, table, projection(columns))
}

/** Fluent read over one table. Every filter is the same AST [KizunaSyncQuery] builds. */
class KizunaSyncSelectBuilder internal constructor(
    private val client: KizunaSyncClient,
    private val table: String,
    private val projection: JSONArray?,
) {
    private val filters = JSONArray()
    private val orders = JSONArray()
    private var limitCount: Int? = null
    private var includeDeletedRows = false

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
     * Bring back the rows the table's soft-delete column marks, which every read
     * leaves out by default. A table that declares no such column is unaffected.
     */
    fun includeDeleted(): KizunaSyncSelectBuilder {
        includeDeletedRows = true
        return this
    }

    /**
     * Run the plan and answer with the decoded row array.
     *
     * @throws KizunaSyncError.Engine `LOCAL_UNSUPPORTED` for a construct outside the
     * local subset and `UNKNOWN_TABLE` for a table the config never declared.
     */
    suspend fun execute(): Any = client.query(table, plan("many"))

    /**
     * Run the plan and answer with the one matching row.
     *
     * @throws KizunaSyncError.Engine `LOCAL_CONSTRAINT` when the plan matched
     * anything other than one row.
     */
    suspend fun single(): Any = client.query(table, plan("single"))

    /**
     * Run the plan and answer with the one matching row, or null when none matched.
     *
     * @throws KizunaSyncError.Engine `LOCAL_CONSTRAINT` when the plan matched more
     * than one row.
     */
    suspend fun maybeSingle(): Any = client.query(table, plan("maybeSingle"))

    private fun plan(cardinality: String): JSONObject =
        KizunaSyncQuery.plan(
            filters = filters,
            order = if (orders.length() == 0) null else orders,
            limit = limitCount,
            projection = projection,
            cardinality = cardinality,
            includeDeleted = includeDeletedRows,
        )
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
     * because an unfiltered write would target the whole table.
     */
    suspend fun execute(): List<String> =
        client.applyWhere(
            table = table,
            op = op,
            filters = filters,
            columns = columns,
            transforms = transforms,
            precondition = precondition,
        )
}

private fun projection(columns: String?): JSONArray? {
    val trimmed = columns?.trim().orEmpty()
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
