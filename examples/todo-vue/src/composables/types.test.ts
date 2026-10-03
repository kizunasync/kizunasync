/// <reference types="bun" />
// MARK: - toTodo

import { describe, expect, test } from 'bun:test'
import { toTodo } from './types'

const ROW = {
  id: 'todo-a',
  user_id: 'user-a',
  title: 'buy ink',
  done: 1,
  image_path: 'a/b.png',
  created_at: '2026-01-01T00:00:00.000Z',
}

describe('toTodo archived_at', () => {
  test('keeps a string timestamp', () => {
    expect(toTodo({ ...ROW, archived_at: '2026-02-02T00:00:00.000Z' }).archived_at).toBe('2026-02-02T00:00:00.000Z')
  })

  test('maps null, undefined and non-string values to null', () => {
    expect(toTodo({ ...ROW, archived_at: null }).archived_at).toBeNull()
    expect(toTodo({ ...ROW }).archived_at).toBeNull()
    expect(toTodo({ ...ROW, archived_at: 5 }).archived_at).toBeNull()
  })

  test('leaves the other fields unchanged', () => {
    expect(toTodo({ ...ROW, archived_at: null })).toEqual({ ...ROW, done: true, archived_at: null })
  })
})
