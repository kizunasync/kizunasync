/**
 * What the host does to rows the kernel already answered: the column list a
 * `select()` names, the projection of the rows a write returns, `stripNulls()`,
 * and `csv()`. None of it filters or orders; that stays in the kernel.
 */

import { NO_JOINS, unsupported } from './refusals'
import type { TColumnValues } from '../wire/types'

// MARK: - Projection

/**
 * `select()` and `select('*')` keep every column. Anything else is a column
 * list: an embed, a rename and an empty segment are the kernel's to judge on a
 * read, so the string is only split and trimmed here.
 */
export function parseProjection(columns?: string): string[] | null {
  if (columns === undefined || columns.trim() === '' || columns.trim() === '*') {
    return null
  }
  return columns.split(',').map((column) => column.trim())
}

/**
 * The column list a write's `select()` names, judged here because the kernel
 * never sees it: the host projects the rows the write returns. An embed and a
 * rename throw LOCAL_UNSUPPORTED as a read's projection does; an empty entry is
 * dropped.
 */
export function parseReturnedColumns(columns?: string): string[] | null {
  const projection = parseProjection(columns)

  for (const entry of projection ?? []) {
    if (entry.includes('(')) {
      throw unsupported(`select("${entry}") (relational embeds are not supported locally; ${NO_JOINS})`)
    }
    if (entry.includes(':')) {
      throw unsupported(`select("${entry}") (renames are not supported locally)`)
    }
  }
  return projection?.filter((entry) => entry.length > 0) ?? null
}

/** `row` cut to `columns`, in their order; a column the row lacks projects as null, as the kernel's projection does. */
export function projectRow(row: TColumnValues, columns: readonly string[] | null): TColumnValues {
  if (columns === null) {
    return row
  }
  return Object.fromEntries(columns.map((column) => [column, row[column] ?? null]))
}

// MARK: - stripNulls

/** `row` without the keys whose value is null, as PostgREST's `nulls=stripped` answers it. */
export function stripNullValues(row: TColumnValues): TColumnValues {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null))
}

// MARK: - CSV

/** A header or a cell as one CSV field: quoted, with its quotes doubled, when it holds a quote, a comma, or a line break (RFC 4180). */
function toCsvField(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/** One cell's text: empty for null or absent, JSON for an array or an object, and the value itself otherwise. */
function toCsvText(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'object') {
    return JSON.stringify(value)
  }
  return String(value)
}

/** The CSV header: the projected columns in their order, or every key the rows carry in the order it first appears. */
function csvColumns(rows: readonly TColumnValues[], projection: readonly string[] | null): string[] {
  if (projection !== null) {
    return projection.filter((column) => column.length > 0)
  }
  const seen = new Set<string>()

  for (const row of rows) {
    Object.keys(row).forEach((key) => seen.add(key))
  }
  return [...seen]
}

/**
 * `rows` as the CSV text PostgREST answers `csv()` with: a header line, then
 * one line per row, separated by `\n` with no trailing line break. A read that
 * names no columns and matches no row has no header to write, so it is empty.
 */
export function toCsv(rows: readonly TColumnValues[], projection: readonly string[] | null): string {
  const columns = csvColumns(rows, projection)

  if (columns.length === 0) {
    return ''
  }
  const lines = rows.map((row) => columns.map((column) => toCsvField(toCsvText(row[column]))).join(','))

  return [columns.map(toCsvField).join(','), ...lines].join('\n')
}
