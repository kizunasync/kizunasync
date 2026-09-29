/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import { EDIT_ALL_SUFFIX, isTodoEditable, isTodoMine, matchesTodoFilter, PREDEFINED_TODO_TITLES, predefinedTodoStamps, sortTodosMineFirst, TITLE_MAX_LENGTH, withEditAllSuffix } from './todo-board'

const MARY = '11111111-1111-4111-8111-111111111111'
const VISITOR = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const PEER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

const row = (user_id: string, title = 'row', done: boolean | number = false) => ({ user_id, title, done })

describe('isTodoMine', () => {
  test('an unstamped local row reads as mine', () => {
    expect(isTodoMine(row(''), VISITOR)).toBe(true)
    expect(isTodoMine(row(''), null)).toBe(true)
  })

  test('a stamped row matches only its owner', () => {
    expect(isTodoMine(row(VISITOR), VISITOR)).toBe(true)
    expect(isTodoMine(row(MARY), VISITOR)).toBe(false)
    expect(isTodoMine(row(MARY), null)).toBe(false)
  })
})

describe('isTodoEditable', () => {
  test('my own and other anonymous rows are editable', () => {
    expect(isTodoEditable(row(VISITOR), { myId: VISITOR, editAnyone: false })).toBe(true)
    expect(isTodoEditable(row(''), { myId: VISITOR, editAnyone: false })).toBe(true)
    expect(isTodoEditable(row(PEER), { myId: VISITOR, editAnyone: false })).toBe(true)
  })

  test("a registered user's row is locked until the test flag lifts the guard", () => {
    expect(isTodoEditable(row(MARY), { myId: VISITOR, editAnyone: false })).toBe(false)
    expect(isTodoEditable(row(MARY), { myId: VISITOR, editAnyone: true })).toBe(true)
  })

  test('a registered user editing their own row needs no flag', () => {
    expect(isTodoEditable(row(MARY), { myId: MARY, editAnyone: false })).toBe(true)
  })
})

describe('matchesTodoFilter', () => {
  const active = row(VISITOR, 'Buy milk', false)
  const done = row(VISITOR, 'Walk the dog', 1)

  // Both encodings of `done` go through the same private predicate, so the filter is where the boolean and the SQLite integer are pinned.
  test('the status segment reads both the boolean and the SQLite encoding', () => {
    expect(matchesTodoFilter(row(VISITOR, 'Walk the dog', true), { status: 'done', search: '' })).toBe(true)
    expect(matchesTodoFilter(row(VISITOR, 'Buy milk', 0), { status: 'active', search: '' })).toBe(true)
  })

  test('the all filter keeps both states', () => {
    expect(matchesTodoFilter(active, { status: 'all', search: '' })).toBe(true)
    expect(matchesTodoFilter(done, { status: 'all', search: '' })).toBe(true)
  })

  test('the status segment narrows by the done flag', () => {
    expect(matchesTodoFilter(active, { status: 'active', search: '' })).toBe(true)
    expect(matchesTodoFilter(done, { status: 'active', search: '' })).toBe(false)
    expect(matchesTodoFilter(done, { status: 'done', search: '' })).toBe(true)
    expect(matchesTodoFilter(active, { status: 'done', search: '' })).toBe(false)
  })

  test('the search is a trimmed case-insensitive title substring', () => {
    expect(matchesTodoFilter(active, { status: 'all', search: '  MILK ' })).toBe(true)
    expect(matchesTodoFilter(active, { status: 'all', search: 'bread' })).toBe(false)
    expect(matchesTodoFilter(active, { status: 'all', search: '   ' })).toBe(true)
  })

  test('status and search combine', () => {
    expect(matchesTodoFilter(done, { status: 'active', search: 'dog' })).toBe(false)
    expect(matchesTodoFilter(done, { status: 'done', search: 'dog' })).toBe(true)
  })
})

describe('sortTodosMineFirst', () => {
  test('floats my rows without disturbing either group', () => {
    const rows = [row(MARY, 'a'), row(VISITOR, 'b'), row(MARY, 'c'), row('', 'd')]

    expect(sortTodosMineFirst(rows, VISITOR).map((todo) => todo.title)).toEqual(['b', 'd', 'a', 'c'])
  })

  test('a signed-out visitor leaves the order alone', () => {
    const rows = [row(MARY, 'a'), row(VISITOR, 'b')]

    expect(sortTodosMineFirst(rows, null).map((todo) => todo.title)).toEqual(['a', 'b'])
  })

  test('never mutates the caller-owned list', () => {
    const rows = [row(MARY, 'a'), row(VISITOR, 'b')]

    sortTodosMineFirst(rows, VISITOR)
    expect(rows.map((todo) => todo.title)).toEqual(['a', 'b'])
  })
})

describe('predefinedTodoStamps', () => {
  test('pairs every predefined title with a descending offset from baseMs', () => {
    const base = 1_900_000_000_000
    const stamps = predefinedTodoStamps(base)

    expect(stamps.map((stamp) => stamp.title)).toEqual(PREDEFINED_TODO_TITLES)
    expect(stamps.map((stamp) => stamp.createdAt)).toEqual(
      PREDEFINED_TODO_TITLES.map((_, index) => new Date(base - index).toISOString()),
    )
  })

  test('the set sorts newest first by created_at', () => {
    const stamps = predefinedTodoStamps(1_900_000_000_000)
    const createdAt = stamps.map((stamp) => stamp.createdAt)
    const sortedDescending = [...createdAt].sort((left, right) => (left < right ? 1 : -1))

    expect(createdAt).toEqual(sortedDescending)
  })
})

describe('withEditAllSuffix', () => {
  test('appends the heart suffix once', () => {
    expect(withEditAllSuffix('Buy milk')).toBe('Buy milk ❤️')
  })

  test('a repeated call keeps stacking the suffix, like the board\'s repeated taps', () => {
    expect(withEditAllSuffix(withEditAllSuffix('Buy milk'))).toBe('Buy milk ❤️ ❤️')
  })

  test('a short title is left untouched before the suffix', () => {
    const title = 'Ship the demo'

    expect(withEditAllSuffix(title)).toBe(`${title}${EDIT_ALL_SUFFIX}`)
  })

  test('a title at the limit is shortened so the suffixed result stays within TITLE_MAX_LENGTH code points', () => {
    const suffixLength = Array.from(EDIT_ALL_SUFFIX).length
    const title = 'a'.repeat(TITLE_MAX_LENGTH)
    const result = withEditAllSuffix(title)

    expect(Array.from(result).length).toBe(TITLE_MAX_LENGTH)
    expect(result).toBe(`${'a'.repeat(TITLE_MAX_LENGTH - suffixLength)}${EDIT_ALL_SUFFIX}`)
  })

  test('a multi-code-point title is shortened by code point, never mid-character', () => {
    const suffixLength = Array.from(EDIT_ALL_SUFFIX).length
    const title = '😀'.repeat(TITLE_MAX_LENGTH)
    const result = withEditAllSuffix(title)

    expect(Array.from(result).length).toBe(TITLE_MAX_LENGTH)
    expect(result).toBe(`${'😀'.repeat(TITLE_MAX_LENGTH - suffixLength)}${EDIT_ALL_SUFFIX}`)
  })
})
