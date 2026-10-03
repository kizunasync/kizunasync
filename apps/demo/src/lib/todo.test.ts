/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import type { TColumnValues } from 'kizunasync'
import { toTodo } from './todo'

describe('toTodo', () => {
  test('reads the string columns and the null archivedAt as-is', () => {
    const columns: TColumnValues = { id: 'row-1', user_id: 'user-1', title: 'Buy milk', done: false, archived_at: null }

    expect(toTodo(columns)).toEqual({
      id: 'row-1',
      user_id: 'user-1',
      title: 'Buy milk',
      done: false,
      archivedAt: null,
    })
  })

  test('falls back to an empty string for a missing or non-string id, user_id, or title', () => {
    const todo = toTodo({ done: false, id: 1, user_id: null, title: true })

    expect(todo.id).toBe('')
    expect(todo.user_id).toBe('')
    expect(todo.title).toBe('')
  })

  test('done is true for both the boolean true and the SQLite integer 1', () => {
    expect(toTodo({ done: true }).done).toBe(true)
    expect(toTodo({ done: 1 }).done).toBe(true)
  })

  test('done is false for anything else, including 0 and a missing column', () => {
    expect(toTodo({ done: false }).done).toBe(false)
    expect(toTodo({ done: 0 }).done).toBe(false)
    expect(toTodo({}).done).toBe(false)
  })

  test('archivedAt carries the archived_at string when present', () => {
    expect(toTodo({ done: false, archived_at: '2026-01-05T00:00:00Z' }).archivedAt).toBe('2026-01-05T00:00:00Z')
  })

  test('archivedAt is null when archived_at is missing or not a string', () => {
    expect(toTodo({ done: false }).archivedAt).toBeNull()
    expect(toTodo({ done: false, archived_at: null }).archivedAt).toBeNull()
  })
})
