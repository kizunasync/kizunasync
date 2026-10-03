package com.kizunasync.kizunasync

import java.math.BigDecimal
import java.math.BigInteger
import org.json.JSONArray
import org.json.JSONObject

/**
 * What the builders do to rows the kernel already answered: the columns a
 * write's `select(columns)` keeps, `stripNulls()`, and `csv()`, by the rules
 * `packages/core/src/query/row-shaping.ts` applies for JavaScript. None of it
 * filters or orders; that stays in the kernel. The kernel writes every row's
 * keys in sorted order, so sorting them here gives `csv()` over every column
 * the header order JavaScript gives.
 */
internal object KizunaSyncRowShaping {
    /** The column list a write's `select(columns)` names, or the refusal an embed or a rename carries. */
    class Returned(val columns: List<String>?, val refusal: String?)

    fun returnedColumns(columns: String): Returned {
        val trimmed = columns.trim()
        if (trimmed.isEmpty() || trimmed == "*") {
            return Returned(null, null)
        }
        val entries = trimmed.split(",").map { it.trim() }.filter { it.isNotEmpty() }
        entries.firstOrNull { it.contains('(') }?.let {
            return Returned(
                null,
                "select(\"$it\"): relational embeds are not supported locally; the local store holds each synced table without foreign-key joins, so read related rows with a second query",
            )
        }
        entries.firstOrNull { it.contains(':') }?.let {
            return Returned(null, "select(\"$it\"): renames are not supported locally")
        }
        return Returned(entries, null)
    }

    /** [row] cut to [columns], in their order; a column the row lacks is null. */
    fun project(row: JSONObject, columns: List<String>?): JSONObject {
        if (columns == null) {
            return row
        }
        val projected = JSONObject()
        for (column in columns) {
            projected.put(column, if (row.has(column)) row.get(column) else JSONObject.NULL)
        }
        return projected
    }

    /** [row] without its null-valued keys. */
    fun stripNulls(row: JSONObject): JSONObject {
        val stripped = JSONObject()
        for (key in row.keys()) {
            val value = row.get(key)
            if (value != JSONObject.NULL) {
                stripped.put(key, value)
            }
        }
        return stripped
    }

    /** A read's answer without the null-valued keys of each row it holds. */
    fun stripNulls(answer: Any): Any =
        when (answer) {
            is JSONObject -> stripNulls(answer)
            is JSONArray -> JSONArray((0 until answer.length()).map { index -> (answer.opt(index) as? JSONObject)?.let(::stripNulls) ?: answer.opt(index) })
            else -> answer
        }

    /**
     * The rows as CSV text: a header line, then one line per row, separated by
     * `\n` with no trailing line break. A read that names no column and matches
     * no row is empty.
     */
    fun csv(rows: List<JSONObject>, projection: List<String>?): String {
        val columns = projection ?: orderedKeys(rows)
        if (columns.isEmpty()) {
            return ""
        }
        val header = columns.joinToString(",") { field(it) }
        val lines = rows.map { row -> columns.joinToString(",") { field(text(if (row.has(it)) row.get(it) else null)) } }
        return (listOf(header) + lines).joinToString("\n")
    }

    private fun orderedKeys(rows: List<JSONObject>): List<String> {
        val seen = LinkedHashSet<String>()
        for (row in rows) {
            seen.addAll(row.keys().asSequence().sorted())
        }
        return seen.toList()
    }

    /** A field quoted, with its quotes doubled, when it holds a quote, a comma, or a line break (RFC 4180). */
    private fun field(text: String): String =
        if (text.any { it == '"' || it == ',' || it == '\r' || it == '\n' }) "\"${text.replace("\"", "\"\"")}\"" else text

    /** A cell's text: empty for null, JSON for an array or an object, the value otherwise. */
    private fun text(value: Any?): String =
        when (value) {
            null, JSONObject.NULL -> ""
            is String -> value
            is JSONObject, is JSONArray -> json(value)
            else -> scalarText(value)
        }

    /** A number or a boolean as JavaScript prints it: an integral float without its fraction. */
    private fun scalarText(value: Any): String =
        when (value) {
            is Double, is Float -> {
                val number = (value as Number).toDouble()
                if (number == Math.rint(number) && Math.abs(number) < 1e15) number.toLong().toString() else BigDecimal.valueOf(number).stripTrailingZeros().toPlainString()
            }
            is BigDecimal -> value.stripTrailingZeros().toPlainString()
            is BigInteger -> value.toString()
            else -> value.toString()
        }

    /** JSON text with every object's keys sorted, the order the kernel writes them in. */
    private fun json(value: Any?): String =
        when (value) {
            null, JSONObject.NULL -> "null"
            is JSONObject -> value.keys().asSequence().sorted().joinToString(",", "{", "}") { "${JSONObject.quote(it)}:${json(value.get(it))}" }
            is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { json(value.get(it)) }
            is String -> JSONObject.quote(value)
            else -> scalarText(value)
        }
}
