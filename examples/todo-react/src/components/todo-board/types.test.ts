import { describe, expect, test } from 'bun:test'
import { toTodo } from './types'

describe('toTodo', () => {
  test('keeps archived_at as the timestamp string', () => {
    expect(toTodo({ archived_at: '2026-10-02T10:00:00.000Z' }).archived_at).toBe('2026-10-02T10:00:00.000Z')
  })

  test('maps null, undefined, and non-string archived_at to null', () => {
    expect(toTodo({ archived_at: null }).archived_at).toBeNull()
    expect(toTodo({}).archived_at).toBeNull()
    expect(toTodo({ archived_at: 1 }).archived_at).toBeNull()
  })

  test('narrows the other fields', () => {
    expect(toTodo({ id: 'a', user_id: 'u', title: 't', done: 1, image_path: 'p.png' })).toEqual({
      id: 'a',
      user_id: 'u',
      title: 't',
      done: true,
      image_path: 'p.png',
      archived_at: null,
    })
    expect(toTodo({ id: 1, user_id: null, title: 2, done: 0, image_path: 3 })).toEqual({
      id: '',
      user_id: '',
      title: '',
      done: false,
      image_path: null,
      archived_at: null,
    })
  })
})
