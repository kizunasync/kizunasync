/**
 * pg-safeupdate is loaded for every PostgREST session on Supabase and refuses a
 * DELETE or UPDATE with no WHERE clause (SQLSTATE 21000). The live suites connect
 * to Postgres directly, so only this static scan catches such a statement.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACK_SQL = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../supabase/migrations/0001_kizuna_init.sql'), 'utf8')

const WRITE_START = /(?<!do\s)\b(delete\s+from\s+[\w."%]+|update\s+[\w."%]+(?:\s+as\s+\w+)?\s+set\b)/gi
const WRITE_END = /;|\$q\$|'\s*[,);]/

/**
 * Finds every delete/update statement (plpgsql bodies and `execute format` strings
 * included) and returns the ones with no `where` before the statement ends.
 */
function findWritesWithoutWhere(sql: string): string[] {
  const stripped = sql.replace(/--[^\n]*/g, (comment) => ' '.repeat(comment.length))
  const offenders: string[] = []

  for (const match of stripped.matchAll(WRITE_START)) {
    const rest = stripped.slice(match.index)
    const end = rest.search(WRITE_END)
    const statement = end === -1 ? rest : rest.slice(0, end)

    if (!/\bwhere\b/i.test(statement)) {
      const line = stripped.slice(0, match.index).split('\n').length

      offenders.push(`line ${line}: ${statement.trim().split('\n')[0]}`)
    }
  }

  return offenders
}

describe('pack DELETE and UPDATE statements carry a WHERE clause', () => {
  test('0001_kizuna_init.sql has none without one', () => {
    expect(findWritesWithoutWhere(PACK_SQL)).toEqual([])
  })

  test('the scan flags a bare DELETE and a bare UPDATE', () => {
    const bare = 'begin\n  delete from kizunasync._stamp_marker;\n  update t set a = 1;\nend'

    expect(findWritesWithoutWhere(bare)).toEqual(['line 2: delete from kizunasync._stamp_marker', 'line 3: update t set a = 1'])
  })

  test('the scan ignores on-conflict upserts, comments and guarded statements', () => {
    const ok = [
      'insert into t values (1) on conflict (a) do update set a = 2;',
      '-- delete from t;',
      'delete from t where true;',
      "execute format('update %I as t set a = 1 where %s', x);",
    ].join('\n')

    expect(findWritesWithoutWhere(ok)).toEqual([])
  })
})
