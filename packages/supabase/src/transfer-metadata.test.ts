// MARK: - createSupabaseTransfer.metadata error vs absent

/**
 * metadata() returns null to mean "no server record yet"; the attachment queue
 * then SKIPS sha256 verification. A real lookup error must NOT collapse to null
 * (that silently disables integrity checking on a transient failure). It must
 * propagate so the download retries.
 *
 * The lookup goes through the definer RPC `kizunasync.attachment_metadata`,
 * never the `attachments` table: a client role holds no SELECT on it, and the
 * RPC is what checks the caller can read the owning row. The fake below records
 * the call so the argument names stay pinned to the SQL signature.
 */

import { describe, expect, test } from 'bun:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { IFileStore } from '@kizunasync/core'
import { createSupabaseTransfer } from './transfer-supabase'

type TMaybeSingle = { data: unknown; error: { message: string } | null }

type TRpcCall = { name: string; args: Record<string, unknown> }

const clientWith = (
  result: TMaybeSingle,
): { client: SupabaseClient; calls: TRpcCall[]; tableReads: number } => {
  const calls: TRpcCall[] = []
  const state = { tableReads: 0 }
  const chain = {
    abortSignal: () => chain,
    maybeSingle: async () => result,
  }
  const client = {
    schema: () => ({
      from: () => {
        state.tableReads += 1

        return {
          select: () => chain,
          eq: () => chain,
          abortSignal: () => chain,
          maybeSingle: async () => result,
        }
      },
      rpc: (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args })

        return chain
      },
    }),
    storage: { from: () => ({}) },
  } as unknown as SupabaseClient

  return {
    client,
    calls,
    get tableReads(): number {
      return state.tableReads
    },
  }
}

const noFileStore = {} as unknown as IFileStore

describe('createSupabaseTransfer metadata', () => {
  test('a lookup error propagates (does not silently disable sha256 verification)', async () => {
    const { client } = clientWith({ data: null, error: { message: 'timeout' } })
    const transfer = createSupabaseTransfer({ client, fileStore: noFileStore })

    await expect(transfer.metadata({ bucket: 'b', path: 'o/p/u.jpg' })).rejects.toThrow()
  })

  test('a genuinely absent record returns null', async () => {
    const { client } = clientWith({ data: null, error: null })
    const transfer = createSupabaseTransfer({ client, fileStore: noFileStore })

    expect(await transfer.metadata({ bucket: 'b', path: 'o/p/u.jpg' })).toBeNull()
  })

  test('a present record returns its sha256', async () => {
    const { client } = clientWith({ data: { sha256: 'abc' }, error: null })
    const transfer = createSupabaseTransfer({ client, fileStore: noFileStore })

    expect(await transfer.metadata({ bucket: 'b', path: 'o/p/u.jpg' })).toEqual({ sha256: 'abc' })
  })

  test('the lookup is the definer RPC, with the SQL argument names', async () => {
    const fake = clientWith({ data: { sha256: 'abc' }, error: null })
    const transfer = createSupabaseTransfer({ client: fake.client, fileStore: noFileStore })

    await transfer.metadata({ bucket: 'media', path: 'u1/p1/up-1.png' })

    expect(fake.calls).toEqual([
      { name: 'attachment_metadata', args: { p_bucket_id: 'media', p_object_path: 'u1/p1/up-1.png' } },
    ])
    // A client role holds no SELECT on kizunasync.attachments, so this must not read it.
    expect(fake.tableReads).toBe(0)
  })
})
