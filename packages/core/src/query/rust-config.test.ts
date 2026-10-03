/// <reference types="bun" />
/**
 * The engine config the bridge hands to Rust. Every per-table contract Rust
 * enforces has to cross in it, and an absent key is the kernel's own default,
 * so these pin which keys the mapping emits and which it leaves out.
 */

import { describe, expect, test } from 'bun:test'
import { toRustConfig } from './rust-engine'
import { EConflictMode, type TEngineConfig } from '../wire/types'

const CLIENT_ID = '00000000-0000-4000-8000-000000000001'

const tableEntry = (config: TEngineConfig, table: string): Record<string, unknown> => {
  const tables = toRustConfig(config, CLIENT_ID).tables as Record<string, Record<string, unknown>>

  return tables[table]!
}

describe('toRustConfig conflict mode', () => {
  test('an hlc table forwards conflict_mode so Rust mints the origin stamp', () => {
    const entry = tableEntry(
      {
        tables: { todos: { bucketColumn: 'user_id', conflictMode: EConflictMode.hlc } },
        schemaVersion: 1,
      },
      'todos',
    )

    expect(entry.conflict_mode).toBe(EConflictMode.hlc)
  })

  test('an arrival table forwards conflict_mode explicitly', () => {
    const entry = tableEntry(
      {
        tables: { todos: { bucketColumn: 'user_id', conflictMode: EConflictMode.arrival } },
        schemaVersion: 1,
      },
      'todos',
    )

    expect(entry.conflict_mode).toBe(EConflictMode.arrival)
  })

  test('a table without a conflict mode omits the key so Rust reads its default', () => {
    const entry = tableEntry(
      { tables: { todos: { bucketColumn: 'user_id' } }, schemaVersion: 1 },
      'todos',
    )

    expect('conflict_mode' in entry).toBe(false)
  })
})

describe('toRustConfig bucket owner', () => {
  test('an owner-bucketed table forwards bucket_owner so the engine fills its bucket with the store owner', () => {
    const entry = tableEntry(
      { tables: { todos: { bucketColumn: 'user_id', bucketParams: { user_id: '' }, bucketOwner: true } }, schemaVersion: 1 },
      'todos',
    )

    expect(entry.bucket_owner).toBe(true)
  })

  test('a table without the flag omits the key so Rust reads it as false', () => {
    const entry = tableEntry(
      { tables: { todos: { bucketColumn: 'team_id', bucketParams: { team_id: '' } } }, schemaVersion: 1 },
      'todos',
    )

    expect('bucket_owner' in entry).toBe(false)
  })
})

describe('toRustConfig key', () => {
  test('a table with its own key forwards it so Rust derives each pk from those columns', () => {
    const entry = tableEntry(
      { tables: { seats: { bucketColumn: '', bucketParams: {}, key: ['hall', 'seat'] } }, schemaVersion: 1 },
      'seats',
    )

    expect(entry.key).toEqual(['hall', 'seat'])
  })

  test('a table without a key omits it so Rust reads the id default', () => {
    const entry = tableEntry({ tables: { todos: { bucketColumn: '', bucketParams: {} } }, schemaVersion: 1 }, 'todos')

    expect('key' in entry).toBe(false)
  })
})
