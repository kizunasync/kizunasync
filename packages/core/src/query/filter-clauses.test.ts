/// <reference types="bun" />
// MARK: - PostgREST clause parser unit tests

/**
 * The grammar is pure string work, so it is pinned without an engine: quoting,
 * `in.(…)` lists, dotted values, and every refusal. What a parsed node matches is
 * the kernel's contract and is pinned by the parity vectors instead.
 */

import { describe, expect, test } from 'bun:test'
import { EEngineErrorCode, TEngineError } from '../wire/types'
import { parseFilterClause, parseFilterList, parseNotArgs, splitTopLevelCommas } from './filter-clauses'
import { createFilterMethods } from './filter-methods'

const refusalOf = (call: () => unknown): TEngineError => {
  try {
    call()
  } catch (error) {
    if (error instanceof TEngineError) {
      return error
    }
    throw error
  }
  throw new Error('expected a TEngineError')
}

describe('PostgREST clause parser', () => {
  test('parseFilterClause scalars and ops', () => {
    expect(parseFilterClause('rank.eq.2')).toEqual({ kind: 'eq', column: 'rank', value: 2 })
    expect(parseFilterClause('done.eq.false')).toEqual({
      kind: 'eq',
      column: 'done',
      value: false,
    })
    expect(parseFilterClause('note.is.null')).toEqual({
      kind: 'is',
      column: 'note',
      value: null,
    })
    expect(parseFilterClause('title.ilike.%a%')).toEqual({
      kind: 'ilike',
      column: 'title',
      pattern: '%a%',
    })
    expect(parseFilterClause('email.eq.a.b@c.d')).toEqual({
      kind: 'eq',
      column: 'email',
      value: 'a.b@c.d',
    })
  })

  test('in.(…) list', () => {
    expect(parseFilterClause('id.in.(p1,p3)')).toEqual({
      kind: 'in',
      column: 'id',
      values: ['p1', 'p3'],
    })
  })

  test('in.(…) list keeps a quoted comma inside one value', () => {
    expect(parseFilterClause('tag.in.("a,b",c)')).toEqual({
      kind: 'in',
      column: 'tag',
      values: ['a,b', 'c'],
    })
  })

  test('splitTopLevelCommas respects parens and double quotes', () => {
    expect(splitTopLevelCommas('id.in.(p1,p3),rank.eq.1')).toEqual([
      'id.in.(p1,p3)',
      'rank.eq.1',
    ])
    expect(splitTopLevelCommas('title.eq."a,b",rank.eq.1')).toEqual([
      'title.eq."a,b"',
      'rank.eq.1',
    ])
    expect(parseFilterList('title.eq."(a,b",note.eq."x)"')).toEqual([
      { kind: 'eq', column: 'title', value: '(a,b' },
      { kind: 'eq', column: 'note', value: 'x)' },
    ])
  })

  test('a single quote is an ordinary character', () => {
    expect(splitTopLevelCommas("title.eq.'x,y',done.eq.true")).toEqual([
      "title.eq.'x",
      "y'",
      'done.eq.true',
    ])
    expect(parseFilterClause("title.eq.'x'")).toEqual({ kind: 'eq', column: 'title', value: "'x'" })
    expect(parseFilterList("title.eq.it's,done.eq.true")).toEqual([
      { kind: 'eq', column: 'title', value: "it's" },
      { kind: 'eq', column: 'done', value: true },
    ])
    expect(() => parseFilterList("title.eq.'x,y'")).toThrow(`invalid filter clause "y'" (expected column.op.value)`)
  })

  test('inside double quotes a backslash escapes a double quote or a backslash', () => {
    expect(parseFilterClause('title.eq."say \\"hi\\""')).toEqual({
      kind: 'eq',
      column: 'title',
      value: 'say "hi"',
    })
    expect(parseFilterClause('path.eq."C:\\\\temp"')).toEqual({
      kind: 'eq',
      column: 'path',
      value: 'C:\\temp',
    })
    expect(parseFilterClause('path.eq."a\\b"')).toEqual({ kind: 'eq', column: 'path', value: 'a\\b' })
    expect(parseFilterList('title.eq."a\\",b",rank.eq.1')).toEqual([
      { kind: 'eq', column: 'title', value: 'a",b' },
      { kind: 'eq', column: 'rank', value: 1 },
    ])
    expect(parseFilterClause('tag.in.("a\\"b",c)')).toEqual({
      kind: 'in',
      column: 'tag',
      values: ['a"b', 'c'],
    })
  })

  test('a value that only starts with a double quote stays as written', () => {
    expect(parseFilterClause('title.eq."a"b')).toEqual({ kind: 'eq', column: 'title', value: '"a"b' })
  })

  test('an unclosed double quote or an unbalanced parenthesis throws naming the clause', () => {
    expect(() => parseFilterList('rank.eq.1,title.eq."abc')).toThrow(
      'unclosed double quote in filter clause "title.eq."abc"',
    )
    expect(() => parseFilterList('title.eq."a\\"')).toThrow(
      'unclosed double quote in filter clause "title.eq."a\\""',
    )
    expect(() => parseFilterList('rank.eq.1,id.in.(p1,p2')).toThrow(
      'unbalanced parenthesis in filter clause "id.in.(p1,p2"',
    )
    expect(() => parseFilterList('title.eq.x),rank.eq.1')).toThrow(
      'unbalanced parenthesis in filter clause "title.eq.x)"',
    )
    expect(() => parseFilterClause('title.eq."abc')).toThrow(/unclosed double quote/)
    expect(() => parseFilterClause('id.in.(p1')).toThrow(/unbalanced parenthesis/)
    expect(() => splitTopLevelCommas('title.eq.x)')).toThrow(/unbalanced parenthesis/)
  })

  test('the builder refuses an unbalanced clause list with LOCAL_UNSUPPORTED naming the clause', () => {
    const methods = createFilterMethods<'SELF'>([], () => 'SELF')
    const refusals = [
      { call: () => methods.or('title.eq."abc'), clause: 'title.eq."abc' },
      { call: () => methods.and('id.in.(p1,p2'), clause: 'id.in.(p1,p2' },
      { call: () => methods.or('title.eq.x),rank.eq.1'), clause: 'title.eq.x)' },
    ]

    for (const { call, clause } of refusals) {
      const error = refusalOf(call)

      expect(error.code).toBe(EEngineErrorCode.LOCAL_UNSUPPORTED)
      expect(error.message).toContain(`in filter clause "${clause}"`)
    }
  })

  test('a bare number decodes only when it prints back as the same token', () => {
    expect(parseFilterClause('rank.eq.-3')).toEqual({ kind: 'eq', column: 'rank', value: -3 })
    expect(parseFilterClause('rank.eq.1.5')).toEqual({ kind: 'eq', column: 'rank', value: 1.5 })
    expect(parseFilterClause('rank.eq.0')).toEqual({ kind: 'eq', column: 'rank', value: 0 })
    expect(parseFilterClause('code.eq.007')).toEqual({ kind: 'eq', column: 'code', value: '007' })
    expect(parseFilterClause('rank.eq.1.50')).toEqual({ kind: 'eq', column: 'rank', value: '1.50' })
    expect(parseFilterClause('rank.eq.1.0')).toEqual({ kind: 'eq', column: 'rank', value: '1.0' })
    expect(parseFilterClause('rank.eq.-0')).toEqual({ kind: 'eq', column: 'rank', value: '-0' })
    expect(parseFilterClause('big.gt.12345678901234567890')).toEqual({
      kind: 'gt',
      column: 'big',
      value: '12345678901234567890',
    })
    expect(parseFilterClause('code.in.(007,7)')).toEqual({ kind: 'in', column: 'code', values: ['007', 7] })
    expect(parseFilterClause('code.like.007')).toEqual({ kind: 'like', column: 'code', pattern: '007' })
  })

  test('a * inside double quotes stays a literal asterisk in a like pattern', () => {
    expect(parseFilterClause('title.like.*plane*')).toEqual({
      kind: 'like',
      column: 'title',
      pattern: '*plane*',
    })
    expect(parseFilterClause('title.ilike."5*3,*"')).toEqual({
      kind: 'ilike',
      column: 'title',
      pattern: '5\\*3,\\*',
    })
    expect(parseFilterClause('title.like."a\\\\*"')).toEqual({
      kind: 'like',
      column: 'title',
      pattern: 'a\\*',
    })
    expect(parseFilterClause('title.like."%a,b%"')).toEqual({
      kind: 'like',
      column: 'title',
      pattern: '%a,b%',
    })
    expect(parseFilterClause('title.eq."a*"')).toEqual({ kind: 'eq', column: 'title', value: 'a*' })
  })

  test('parseFilterList + quoted comma values', () => {
    const filters = parseFilterList('title.eq."hello,world",rank.gt.1')

    expect(filters).toEqual([
      { kind: 'eq', column: 'title', value: 'hello,world' },
      { kind: 'gt', column: 'rank', value: 1 },
    ])
  })

  test('invalid clauses throw', () => {
    expect(() => parseFilterClause('')).toThrow()
    expect(() => parseFilterClause('nope')).toThrow()
    expect(() => parseFilterClause('col.foo.1')).toThrow(/unsupported filter operator/)
    expect(() => parseFilterClause('col.is.maybe')).toThrow(/null\|true\|false/)
    expect(() => parseFilterClause('and(title.eq.x,done.eq.true)')).toThrow(/nested and\(\)\/or\(\)\/not\(\)/)
    expect(() => parseFilterClause('or(title.eq.x,done.eq.true)')).toThrow(/nested and\(\)\/or\(\)\/not\(\)/)
    expect(() => parseFilterClause('not(title.eq.x)')).toThrow(/nested and\(\)\/or\(\)\/not\(\)/)
  })

  test('a not. prefix on the operator negates the clause, as PostgREST reads it', () => {
    expect(parseFilterClause('title.not.eq.x')).toEqual({ kind: 'not', filter: { kind: 'eq', column: 'title', value: 'x' } })
    expect(parseFilterList('rank.not.in.(1,2),title.not.like.works*,done.is.true')).toEqual([
      { kind: 'not', filter: { kind: 'in', column: 'rank', values: [1, 2] } },
      { kind: 'not', filter: { kind: 'like', column: 'title', pattern: 'works*' } },
      { kind: 'is', column: 'done', value: true },
    ])
    expect(parseFilterClause('email.not.eq.a.b@c.d')).toEqual({ kind: 'not', filter: { kind: 'eq', column: 'email', value: 'a.b@c.d' } })
  })

  test('a not. prefix takes one operator of the ten, and nesting stays refused', () => {
    expect(() => parseFilterClause('title.not.not.eq.x')).toThrow(/unsupported filter operator "not"/)
    expect(() => parseFilterClause('title.not.cs.x')).toThrow(/unsupported filter operator "cs"/)
    expect(() => parseFilterClause('title.not.x')).toThrow(/expected column.op.value/)
    expect(() => parseFilterClause('not(title.eq.x)')).toThrow(/nested and\(\)\/or\(\)\/not\(\)/)
  })

  test('parseNotArgs', () => {
    expect(parseNotArgs('rank', 'eq', 2)).toEqual({
      kind: 'not',
      filter: { kind: 'eq', column: 'rank', value: 2 },
    })
    expect(parseNotArgs('id', 'in', ['p2'])).toEqual({
      kind: 'not',
      filter: { kind: 'in', column: 'id', values: ['p2'] },
    })
    expect(() => parseNotArgs('rank', 'contains', 1)).toThrow()
    expect(() => parseNotArgs('id', 'in', 'nope')).toThrow()
    expect(() => parseNotArgs('rank', 'eq', { x: 1 })).toThrow()
  })
})
