/// <reference types="bun" />
/**
 * The ring buffer the examples' Cache tab reads: newest last, capped, and every
 * mutation notifies the subscribers the tab re-renders from.
 */

import { describe, expect, test } from 'bun:test'
import { createQueryLog } from './query-log'

describe('createQueryLog', () => {
  test('numbers entries from one and keeps them in order', () => {
    const log = createQueryLog()

    log.record({ op: 'SELECT', label: 'select todos' })
    log.record({ op: 'INSERT', label: 'insert todo', rows: 1, ms: 4 })

    expect(log.entries()).toEqual([
      { seq: 1, op: 'SELECT', label: 'select todos', rows: null, ms: 0 },
      { seq: 2, op: 'INSERT', label: 'insert todo', rows: 1, ms: 4 },
    ])
  })

  test('the buffer is capped and drops the oldest entry', () => {
    const log = createQueryLog(2)

    for (const label of ['one', 'two', 'three']) {
      log.record({ op: 'SELECT', label })
    }

    expect(log.entries().map((entry) => entry.label)).toEqual(['two', 'three'])
    expect(log.entries().map((entry) => entry.seq)).toEqual([2, 3])
  })

  test('a subscriber hears every record and every clear until it unsubscribes', () => {
    const log = createQueryLog()
    let notified = 0
    const unsubscribe = log.subscribe(() => {
      notified += 1
    })

    log.record({ op: 'UPDATE', label: 'toggle todo' })
    log.clear()

    expect(notified).toBe(2)
    expect(log.entries()).toEqual([])

    unsubscribe()
    log.record({ op: 'DELETE', label: 'delete todo' })

    expect(notified).toBe(2)
  })
})
