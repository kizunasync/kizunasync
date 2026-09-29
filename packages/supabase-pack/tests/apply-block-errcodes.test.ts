/**
 * The decision layer reports a class-22 data exception and a P0001 raised while
 * applying one mutation as that mutation's `CONSTRAINT` verdict. A bare `raise
 * exception` inside the pack is P0001 too, so a pack-internal failure raised
 * without its own SQLSTATE would pass for an application's rejection of one
 * write. This file reads `0001_kizuna_init.sql`, follows every pack function
 * `_decide_mutation` and the change-capture triggers reach, and fails when one
 * of them raises without `using errcode`. It needs no database.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACK_SQL = readFileSync(join(PACK, 'supabase/migrations/0001_kizuna_init.sql'), 'utf8')

/** The decision entry point plus the triggers that fire on the application row while a mutation applies. */
const ROOTS = ['_decide_mutation', 'track_change', 'track_delete'] as const

/** Levels that report without raising; every other `raise` aborts the statement. */
const REPORTING_LEVELS = new Set(['debug', 'log', 'info', 'notice', 'warning'])

/** Every `kizunasync.<name>` function body in `sql`, keyed by name, with `--` comments stripped. */
function functionBodies(sql: string): Map<string, string> {
  const bodies = new Map<string, string>()

  for (const header of sql.matchAll(/create or replace function kizunasync\.(\w+)\s*\(/g)) {
    const rest = sql.slice((header.index ?? 0) + header[0].length)
    const body = rest.match(/\$([A-Za-z_]*)\$([\s\S]*?)\$\1\$/)

    if (header[1] !== undefined && body?.[2] !== undefined) {
      bodies.set(header[1], body[2].replace(/--[^\n]*/g, ''))
    }
  }
  return bodies
}

/** The functions `roots` reach through `kizunasync.<name>(` calls, the roots included. */
function reachableFunctions(bodies: Map<string, string>, roots: readonly string[]): Set<string> {
  const reached = new Set<string>()
  const pending = [...roots]

  while (pending.length > 0) {
    const name = pending.pop()

    if (name === undefined || reached.has(name) || !bodies.has(name)) {
      continue
    }
    reached.add(name)

    for (const call of (bodies.get(name) ?? '').matchAll(/kizunasync\.(\w+)\s*\(/g)) {
      if (call[1] !== undefined) {
        pending.push(call[1])
      }
    }
  }
  return reached
}

/** The `raise` statements in `body` that abort without naming a SQLSTATE. A bare `raise;` re-raises the caught error with its own code. */
function uncodedRaises(body: string): string[] {
  const statements = [...body.matchAll(/\braise\b([\s\S]*?);/gi)].map((match) => match[0])

  return statements.filter((statement) => {
    const level = statement.match(/^raise\s+(\w+)/i)?.[1]?.toLowerCase()

    if (/^raise\s*;$/i.test(statement) || (level !== undefined && REPORTING_LEVELS.has(level))) {
      return false
    }
    return !/\busing\b[\s\S]*\berrcode\b/i.test(statement)
  })
}

describe('pack internals reached while a mutation applies raise only coded errors', () => {
  const bodies = functionBodies(PACK_SQL)
  const reached = reachableFunctions(bodies, ROOTS)

  test('the walk reaches the apply helpers, so the check below cannot pass on an empty set', () => {
    for (const helper of [
      '_apply_upsert',
      '_apply_update_masked',
      '_apply_delete',
      '_apply_transforms',
      '_apply_increment',
      '_apply_array_union',
      '_apply_array_remove',
      '_apply_hlc',
      '_row_hlc_lock',
      '_row_hlc_merge',
      '_journal_overwrites',
      '_normalize_cell',
      '_render_user_row',
      '_lock_user_row',
    ]) {
      expect(reached.has(helper), helper).toBe(true)
    }
  })

  test('every raise in those functions carries using errcode', () => {
    const offenders = [...reached].flatMap((name) => uncodedRaises(bodies.get(name) ?? '').map((statement) => `${name}: ${statement}`))

    expect(offenders).toEqual([])
  })

  test('the check flags a raise that names no SQLSTATE and passes a coded one', () => {
    const body = `
      begin
        raise notice 'reports only';
        raise exception 'coded' using errcode = '23514';
        raise exception 'bare %', 1;
        raise 'default level';
        raise;
      end`

    expect(uncodedRaises(body)).toEqual(["raise exception 'bare %', 1;", "raise 'default level';"])
  })
})
