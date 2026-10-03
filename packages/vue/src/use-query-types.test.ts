/// <reference types="bun" />
/**
 * A build typed with `returns()`, `overrideTypes()`, `single<T>()`, or
 * `maybeSingle<T>()` hands its row type to `data` without a type argument on
 * `useQuery`, and an explicit `useQuery<T>` still types an untyped build. The
 * runtime test proves the retyped build reads the same rows.
 */
// MARK: - useQuery takes its row type from the build

import { describe, expect, test } from 'bun:test'
import { effectScope } from 'vue'
import { createKizunaSync, defineConfig, type IKizunaSync, type IProtocolRemote } from '@kizunasync/core'
import { useQuery } from './use-query'

interface IUser {
  id: string
  first_name: string
}

const ADA: IUser = { id: '00000000-0000-4000-8000-00000000a0da', first_name: 'Ada' }
const WAIT_STEP_MS = 10
const WAIT_STEPS = 200

/** These tests never sync; the remote exists only because the app client takes one. */
const idleRemote: IProtocolRemote = {
  pull: () => Promise.resolve({ cursor: '0', has_more: false, rows: [], signal: null, tombstones: [] }),
  push: () => Promise.resolve({ verdicts: [] }),
}

/** The engine answers off the main thread, so a read settles after an unknown number of ticks. */
const until = async (isDone: () => boolean): Promise<void> => {
  for (let step = 0; step < WAIT_STEPS && !isDone(); step += 1) {
    await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS))
  }
}

describe('useQuery with a typed build', () => {
  test('reads the rows the untyped build reads', async () => {
    const client = createKizunaSync({ databasePath: null }, idleRemote, defineConfig({ tables: { users: { sync: 'read-write' } } }))
    const scope = effectScope()

    await client.from('users').insert({ ...ADA })
    const result = scope.run(() => useQuery((kizunasync) => kizunasync.from('users').select('id, first_name').returns<IUser[]>(), { client }))!

    await until(() => !result.isLoading.value)
    const names: string[] = result.data.value.map((user) => user.first_name)

    expect(names).toEqual(['Ada'])
    scope.stop()
    client.dispose()
  })
})

// MARK: - Types

/**
 * Compiled by `bun run type-check` and never called, since a composable needs
 * an owning scope. Each `@ts-expect-error` fails the type check when its line
 * compiles.
 */
function checkInferredTypes(client: IKizunaSync): void {
  const list = useQuery((kizunasync) => kizunasync.from('users').select().returns<IUser[]>(), { client })
  const one = useQuery((kizunasync) => kizunasync.from('users').select().eq('id', ADA.id).single<IUser>(), { client })
  const maybeOne = useQuery((kizunasync) => kizunasync.from('users').select().maybeSingle<IUser>(), { client })
  const merged = useQuery((kizunasync) => kizunasync.from('users').select().returns<IUser[]>().overrideTypes<{ nick: string }[]>(), { client })
  const explicit = useQuery<IUser>((kizunasync) => kizunasync.from('users').select(), { client })
  const untyped = useQuery((kizunasync) => kizunasync.from('users').select(), { client })
  const users: IUser[] = list.data.value
  const user: IUser | null = one.data.value
  const maybeUser: IUser | null = maybeOne.data.value
  const nick: string | undefined = merged.data.value[0]?.nick
  const explicitUsers: IUser[] = explicit.data.value
  const cell: unknown = untyped.data.value[0]?.first_name
  // @ts-expect-error a list build never yields one row
  const listAsRow: IUser | null = list.data.value
  // @ts-expect-error a one-row build never yields a list
  const oneAsList: IUser[] = one.data.value
  // @ts-expect-error the inferred row type has no such column
  const missing: string = list.data.value[0]!.last_name
  // @ts-expect-error a head read has no rows to render
  const head = useQuery((kizunasync) => kizunasync.from('users').select('*', { head: true }), { client })

  void [users, user, maybeUser, nick, explicitUsers, cell, listAsRow, oneAsList, missing, head]
}

void checkInferredTypes
