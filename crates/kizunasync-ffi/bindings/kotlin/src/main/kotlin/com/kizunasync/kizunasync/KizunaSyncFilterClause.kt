package com.kizunasync.kizunasync

import java.math.BigDecimal
import java.math.MathContext
import java.math.RoundingMode
import org.json.JSONArray
import org.json.JSONObject

/**
 * One PostgREST clause, `column.operator.value`, as the filter node the kernel
 * reads: the grammar `filter(column, operator, value)` takes, the same one
 * `packages/core/src/query/filter-clauses.ts` decodes for JavaScript `.or()`
 * strings. The operator is one of ten, optionally behind a `not.` prefix, and
 * the value decodes as null, a boolean, a number that prints back as itself,
 * or text, with double quotes protecting commas and parentheses.
 */
internal object KizunaSyncFilterClause {
    private val OPERATORS = setOf("eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is", "in")
    private const val NEGATION = "not."
    private val NUMERIC = Regex("^-?\\d+(\\.\\d+)?$")

    /** Why a clause has no node, named in the `LOCAL_UNSUPPORTED` the read throws. */
    class Refusal(val reason: String) : Exception(reason)

    fun node(column: String, operator: String, value: String): JSONObject {
        val isNegated = operator.startsWith(NEGATION)
        val name = if (isNegated) operator.removePrefix(NEGATION) else operator
        if (name !in OPERATORS) {
            throw Refusal("unsupported filter operator \"$name\"")
        }
        topLevelParts(value)
        val node = leaf(column, name, value)
        return if (isNegated) JSONObject().put("kind", "not").put("filter", node) else node
    }

    private fun leaf(column: String, name: String, value: String): JSONObject =
        when (name) {
            "in" -> JSONObject().put("kind", "in").put("column", column).put("values", JSONArray(inList(value)))
            "is" -> {
                val operand = scalar(value)
                if (operand != JSONObject.NULL && operand !is Boolean) {
                    throw Refusal("is() value must be null|true|false")
                }
                JSONObject().put("kind", "is").put("column", column).put("value", operand)
            }
            "like", "ilike" -> JSONObject().put("kind", name).put("column", column).put("pattern", pattern(value))
            else -> JSONObject().put("kind", name).put("column", column).put("value", scalar(value))
        }

    /**
     * A value that is one double-quoted string, its `\"` and `\\` escapes
     * decoded, or null when it does not open with a quote and end at the quote
     * that closes it.
     */
    fun unquote(value: String): String? {
        if (!value.startsWith("\"")) {
            return null
        }
        val decoded = StringBuilder()
        var index = 1
        while (index < value.length) {
            val ch = value[index]
            val next = value.getOrNull(index + 1)
            if (ch == '\\' && (next == '"' || next == '\\')) {
                decoded.append(next)
                index += 2
                continue
            }
            if (ch == '"') {
                return if (index == value.length - 1) decoded.toString() else null
            }
            decoded.append(ch)
            index += 1
        }
        return null
    }

    fun scalar(raw: String): Any {
        val trimmed = raw.trim()
        unquote(trimmed)?.let { return it }
        return when (trimmed) {
            "null" -> JSONObject.NULL
            "true" -> true
            "false" -> false
            else -> roundTripNumber(trimmed) ?: trimmed
        }
    }

    /**
     * A `like` pattern: a `*` inside double quotes is a literal asterisk, so it
     * travels escaped; a backslash pair the pattern already holds stays.
     */
    fun pattern(raw: String): String {
        val trimmed = raw.trim()
        val quoted = unquote(trimmed) ?: return trimmed
        val escaped = StringBuilder()
        var index = 0
        while (index < quoted.length) {
            val ch = quoted[index]
            if (ch == '\\' && index + 1 < quoted.length) {
                escaped.append(ch).append(quoted[index + 1])
                index += 2
                continue
            }
            escaped.append(if (ch == '*') "\\*" else ch.toString())
            index += 1
        }
        return escaped.toString()
    }

    fun inList(raw: String): List<Any> {
        var body = raw.trim()
        if (body.startsWith("(") && body.endsWith(")")) {
            body = body.substring(1, body.length - 1)
        }
        return topLevelParts(body).map { it.trim() }.filter { it.isNotEmpty() }.map { scalar(it) }
    }

    /** The parts of [input] between commas outside double quotes and parentheses. */
    fun topLevelParts(input: String): List<String> {
        val parts = mutableListOf<String>()
        val current = StringBuilder()
        var depth = 0
        var inQuote = false
        var index = 0
        while (index < input.length) {
            val ch = input[index]
            current.append(ch)
            if (inQuote) {
                if (ch == '\\' && index + 1 < input.length) {
                    current.append(input[index + 1])
                    index += 2
                    continue
                }
                inQuote = ch != '"'
            } else if (ch == '"') {
                inQuote = true
            } else if (ch == '(') {
                depth += 1
            } else if (ch == ')') {
                if (depth == 0) {
                    throw Refusal("unbalanced parenthesis in filter clause \"$input\"")
                }
                depth -= 1
            } else if (ch == ',' && depth == 0) {
                parts.add(current.substring(0, current.length - 1))
                current.setLength(0)
            }
            index += 1
        }
        if (inQuote) {
            throw Refusal("unclosed double quote in filter clause \"$input\"")
        }
        if (depth > 0) {
            throw Refusal("unbalanced parenthesis in filter clause \"$input\"")
        }
        parts.add(current.toString())
        return parts
    }

    /**
     * A bare numeric token as a number when JavaScript prints that number back
     * as the same token, so `007`, `1.50` and an integer past double precision
     * stay text on every client.
     */
    fun roundTripNumber(token: String): Any? {
        if (!NUMERIC.matches(token) || token == "-0") {
            return null
        }
        val value = token.toDouble()
        if (Math.abs(value) >= 1e21) {
            return null
        }
        val unsigned = token.removePrefix("-")
        if (unsigned.length > 1 && unsigned.startsWith("0") && !unsigned.startsWith("0.")) {
            return null
        }
        // JavaScript prints a fraction with no trailing zero, and in exponent form below 1e-6.
        if (token.contains('.') && (token.endsWith("0") || Math.abs(value) < 1e-6)) {
            return null
        }
        if (shortestDigits(value) != trimmedDigits(token)) {
            return null
        }
        return if (value == Math.rint(value) && Math.abs(value) <= 9_007_199_254_740_992.0) value.toLong() else value
    }

    /** The significant digits of a decimal, trailing zeros dropped: JavaScript pads an integer with zeros past the digits it keeps. */
    private fun trimmedDigits(decimal: String): String = decimal.filter { it.isDigit() }.trimStart('0').trimEnd('0')

    /** The fewest significant digits that parse back to [value], the ones JavaScript prints. */
    private fun shortestDigits(value: Double): String {
        if (value == 0.0) {
            return ""
        }
        val exact = BigDecimal(value)
        for (precision in 1..17) {
            val candidate = exact.round(MathContext(precision, RoundingMode.HALF_EVEN))
            if (candidate.toDouble() == value) {
                return trimmedDigits(candidate.unscaledValue().abs().toString())
            }
        }
        return ""
    }
}
