/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import { toTodo } from './todos'

describe('toTodo', () => {
  test('keeps archived_at as the timestamp string', () => {
    expect(toTodo({ archived_at: '2026-10-02T10:00:00.000Z' }).archived_at).toBe('2026-10-02T10:00:00.000Z')
  })

  test('narrows a null, missing, or non-string archived_at to null', () => {
    expect(toTodo({ archived_at: null }).archived_at).toBeNull()
    expect(toTodo({}).archived_at).toBeNull()
    expect(toTodo({ archived_at: 1 }).archived_at).toBeNull()
    expect(toTodo({ archived_at: true }).archived_at).toBeNull()
  })

  test('narrows the other fields', () => {
    expect(toTodo({ id: 'a', user_id: 'u', title: 'T', done: true, image_path: 'p.png' })).toEqual({
      id: 'a',
      user_id: 'u',
      title: 'T',
      done: true,
      image_path: 'p.png',
      archived_at: null,
    })
    expect(toTodo({ id: 1, user_id: null, title: 2, done: 'yes', image_path: 3 })).toEqual({
      id: '',
      user_id: '',
      title: '',
      done: false,
      image_path: null,
      archived_at: null,
    })
  })
})
