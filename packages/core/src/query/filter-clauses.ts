// MARK: - PostgREST clause parser

/**
 * JS-host adapter for the PostgREST clause grammar. supabase-js passes `.or()`
 * and `.and()` as flat strings (`column.op.value,…`). PostgREST decodes them
 * server-side; Kizuna never reaches PostgREST for local reads, so this file
 * decodes them into `TQueryFilter` nodes the Rust kernel consumes.
 *
 * Evaluation lives entirely in Rust (`kizunasync-query`). Swift and Kotlin
 * build structured filter nodes directly and never call this parser.
 *
 * Only double quotes quote, as in PostgREST: inside them `\"` is a double quote
 * and `\\` a backslash, and a single quote is an ordinary character. The
 * scanner (`splitTopLevelCommas`) tracks double quotes and parentheses so
 * `in.(a,b)` and `title.eq."a,b"` split correctly, and it throws on an unclosed
 * quote or an unbalanced parenthesis, naming the clause, instead of guessing
 * where a clause ends.
 *
 * A clause negates itself with a `not.` prefix on its operator
 * (`title.not.like.works*`), as PostgREST reads it. Nesting
 * `and()`/`or()`/`not()` inside the clause string is refused here on purpose;
 * PostgREST encodes it, but this parser does not. Chain the builder methods or
 * use `.not()` instead; the kernel already accepts nested filter nodes.
 *
 * Malformed clauses and unknown operators throw; no silent fallback
 * (@../../../../CONVENTIONS.md).
 */

import type { TColumnValue, TQueryCompareOp, TQueryFilter } from '../wire/types'

/**
 * The nodes the grammar produces are the plan's own nodes, declared once in the
 * wire contracts beside `ISyncEngine`.
 */
export type { TContainsValue } from '../wire/types'

const FILTER_OPS = new Set([
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in'
])

function isColumnValue(value: unknown): value is TColumnValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
}

/**
 * A value that is one double-quoted string, its `\"` and `\\` escapes decoded.
 * A backslash before any other character stays in the value. `undefined` when
 * the value does not open with a quote or does not end at the quote that
 * closes it, so it is read as written.
 */
function unquote(value: string): string | undefined {
  if (!value.startsWith('"')) {
    return undefined
  }
  let decoded = ''

  for (let index = 1; index < value.length; index += 1) {
    const ch = value[index]!
    const next = value[index + 1]

    if (ch === '\\' && (next === '"' || next === '\\')) {
      decoded += next
      index += 1
    } else if (ch === '"') {
      return index === value.length - 1 ? decoded : undefined
    } else {
      decoded += ch
    }
  }
  return undefined
}

/** A bare numeric token that prints back as itself, so `007`, `1.50` and an integer past double precision stay text. */
function isRoundTripNumber(token: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(token) && String(Number(token)) === token
}

function parseScalar(raw: string): TColumnValue {
  const trimmed = raw.trim()
  const quoted = unquote(trimmed)

  if (quoted !== undefined) {
    return quoted
  }
  if (trimmed === 'null') {
    return null
  }
  if (trimmed === 'true') {
    return true
  }
  if (trimmed === 'false') {
    return false
  }
  if (isRoundTripNumber(trimmed)) {
    return Number(trimmed)
  }
  return trimmed
}

/**
 * A `like`/`ilike` value as the kernel reads it. The kernel takes every
 * unescaped `*` for `%`, and only a `*` outside double quotes is a wildcard,
 * so a quoted one travels escaped; a backslash pair the pattern already holds
 * stays as it is.
 */
function parsePattern(raw: string): string {
  const trimmed = raw.trim()
  const quoted = unquote(trimmed)

  if (quoted === undefined) {
    return trimmed
  }
  return quoted.replace(/\\[\s\S]|\*/g, (match) => (match === '*' ? '\\*' : match))
}

function parseInList(raw: string): TColumnValue[] {
  let body = raw.trim()

  if (body.startsWith('(') && body.endsWith(')')) {
    body = body.slice(1, -1)
  }
  if (body.length === 0) {
    return []
  }
  return splitTopLevelCommas(body).map((part) => parseScalar(part))
}

/** A clause's `column.op.value` parts, the operator already checked against the list and stripped of its `not.` prefix. */
type TClauseParts = {
  column: string
  op: string
  valueRaw: string
  isNegated: boolean
}

const NEGATION_PREFIX = 'not.'

function splitClause(clause: string): TClauseParts {
  const trimmed = clause.trim()

  if (trimmed.length === 0) {
    throw new Error('empty filter clause')
  }
  // Scanned for its quote and parenthesis checks: a broken clause throws here, named.
  scanTopLevel(trimmed)

  if (/^(and|or|not)\(/i.test(trimmed)) {
    throw new Error(
      `nested and()/or()/not() is not supported in a filter clause ("${clause}"). Chain the builders, or use not().`,
    )
  }
  // column.op.value: the value may hold dots (emails), so only the first two split.
  const firstDot = trimmed.indexOf('.')

  if (firstDot <= 0) {
    throw new Error(`invalid filter clause "${clause}" (expected column.op.value)`)
  }
  const column = trimmed.slice(0, firstDot)
  const isNegated = trimmed.startsWith(NEGATION_PREFIX, firstDot + 1)
  const rest = trimmed.slice(firstDot + 1 + (isNegated ? NEGATION_PREFIX.length : 0))
  const secondDot = rest.indexOf('.')

  if (secondDot <= 0) {
    throw new Error(`invalid filter clause "${clause}" (expected column.op.value)`)
  }
  const op = rest.slice(0, secondDot)
  const valueRaw = rest.slice(secondDot + 1)

  if (!FILTER_OPS.has(op)) {
    throw new Error(`unsupported filter operator "${op}" in "${clause}"`)
  }
  return { column, op, valueRaw, isNegated }
}

/** One clause as its filter node, wrapped in `not` when the operator carried the `not.` prefix. */
export function parseFilterClause(clause: string): TQueryFilter {
  const parts = splitClause(clause)
  const node = parseClauseParts(parts, clause)

  return parts.isNegated ? { kind: 'not', filter: node } : node
}

function parseClauseParts(parts: TClauseParts, clause: string): TQueryFilter {
  const { column, op, valueRaw } = parts

  if (op === 'in') {
    return { kind: 'in', column, values: parseInList(valueRaw) }
  }
  if (op === 'is') {
    const value = parseScalar(valueRaw)

    if (value !== null && typeof value !== 'boolean') {
      throw new Error(`is() value must be null|true|false in "${clause}"`)
    }
    return { kind: 'is', column, value: value as null | boolean }
  }
  if (op === 'like' || op === 'ilike') {
    return { kind: op, column, pattern: parsePattern(valueRaw) }
  }
  return { kind: op as TQueryCompareOp, column, value: parseScalar(valueRaw) }
}

/** Where {@link scanTopLevel} stands after each character. */
type TCommaScan = {
  input: string
  parts: string[]
  depth: number
  inQuote: boolean
  start: number
}

/** What makes a clause string structurally broken. */
type TClauseProblem = 'unclosed double quote' | 'unbalanced parenthesis'

function createClauseError(problem: TClauseProblem, clause: string): Error {
  return new Error(`${problem} in filter clause "${clause.trim()}"`)
}

/**
 * One character inside double quotes. Answers the index the scan resumes from:
 * a backslash consumes the character after it, so that one cannot close the quote.
 */
function scanQuoted(scan: TCommaScan, index: number): number {
  const ch = scan.input[index]!

  if (ch === '\\' && index + 1 < scan.input.length) {
    return index + 1
  }
  if (ch === '"') {
    scan.inQuote = false
  }
  return index
}

/** One character outside double quotes: opens a quote, moves the paren depth, or ends a top-level part. */
function scanUnquoted(scan: TCommaScan, index: number): void {
  const ch = scan.input[index]!

  if (ch === '"') {
    scan.inQuote = true
  } else if (ch === '(') {
    scan.depth += 1
  } else if (ch === ')') {
    if (scan.depth === 0) {
      throw createClauseError('unbalanced parenthesis', scan.input.slice(scan.start, index + 1))
    }
    scan.depth -= 1
  } else if (ch === ',' && scan.depth === 0) {
    scan.parts.push(scan.input.slice(scan.start, index))
    scan.start = index + 1
  }
}

/**
 * The parts of `input` between commas outside parentheses and double quotes.
 * Throws on an unclosed quote or an unbalanced parenthesis, naming the clause
 * it breaks: the text from that clause's start to the stray `)`, or to the end.
 */
function scanTopLevel(input: string): string[] {
  const scan: TCommaScan = { input, parts: [], depth: 0, inQuote: false, start: 0 }

  for (let index = 0; index < input.length; index += 1) {
    if (scan.inQuote) {
      index = scanQuoted(scan, index)
    } else {
      scanUnquoted(scan, index)
    }
  }
  if (scan.inQuote) {
    throw createClauseError('unclosed double quote', input.slice(scan.start))
  }
  if (scan.depth > 0) {
    throw createClauseError('unbalanced parenthesis', input.slice(scan.start))
  }
  scan.parts.push(input.slice(scan.start))

  return scan.parts
}

/**
 * Split on commas that are not inside parentheses or double quotes (for
 * `in.(a,b)` and quoted values that embed commas: `title.eq."a,b"`).
 */
export function splitTopLevelCommas(input: string): string[] {
  return scanTopLevel(input).map((part) => part.trim()).filter((part) => part.length > 0)
}

export function parseFilterList(expression: string): TQueryFilter[] {
  return splitTopLevelCommas(expression).map((clause) => parseFilterClause(clause))
}

/** A `not()` call's arguments, the operator already lowercased and checked against the list. */
type TNotArgs = {
  column: string
  op: string
  value: unknown
}

/** The list a negated `in` takes, every member checked to be a column value. */
function negatedInValues(value: unknown): TColumnValue[] {
  if (!Array.isArray(value)) {
    throw new Error('not(..., "in", value) expects an array')
  }
  if (!value.every(isColumnValue)) {
    throw new Error('not(..., "in", value) expects an array of null|boolean|number|string')
  }
  return value
}

/** The filter `not()` wraps, its value checked against the operator. */
function negatedFilter(args: TNotArgs): TQueryFilter {
  const { column, op, value } = args

  if (op === 'in') {
    return { kind: 'in', column, values: negatedInValues(value) }
  }
  if (op === 'is') {
    if (value !== null && typeof value !== 'boolean') {
      throw new Error('not(..., "is", value) expects null|boolean')
    }
    return { kind: 'is', column, value: value as null | boolean }
  }
  if (op === 'like' || op === 'ilike') {
    if (typeof value !== 'string') {
      throw new Error(`not(..., "${op}", value) expects a string pattern`)
    }
    return { kind: op, column, pattern: value }
  }
  if (!isColumnValue(value)) {
    throw new Error(`not(..., "${op}", value) expects null|boolean|number|string`)
  }
  return { kind: op as TQueryCompareOp, column, value }
}

export function parseNotArgs(column: string, operator: string, value: unknown): TQueryFilter {
  const op = operator.toLowerCase()

  if (!FILTER_OPS.has(op)) {
    throw new Error(`unsupported not() operator "${operator}"`)
  }
  return {
    kind: 'not',
    filter: negatedFilter({ column, op, value }),
  }
}
