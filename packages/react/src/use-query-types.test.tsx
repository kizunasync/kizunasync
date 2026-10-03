// MARK: - useQuery takes its row type from the build

/**
 * A build typed with `returns()`, `overrideTypes()`, `single<T>()`, or
 * `maybeSingle<T>()` hands its row type to `data` without a type argument on
 * `useQuery`, and an explicit `useQuery<T>` still types an untyped build. The
 * runtime test proves the retyped build reads the same rows.
 */

import '../happydom'
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { render, waitFor } from '@testing-library/react'
import { createKizunaSync, defineConfig, type IKizunaSync, type IProtocolRemote } from '@kizunasync/core'
import { useQuery } from './use-query'

interface IUser {
  id: string
  first_name: string
}

const ADA: IUser = { id: '00000000-0000-4000-8000-00000000a0da', first_name: 'Ada' }

/** These tests never sync; the remote exists only because the app client takes one. */
const idleRemote: IProtocolRemote = {
  pull: () => Promise.resolve({ cursor: '0', has_more: false, rows: [], signal: null, tombstones: [] }),
  push: () => Promise.resolve({ verdicts: [] }),
}

function TypedProbe({ client, onNames }: { client: IKizunaSync; onNames: (names: string[]) => void }): React.ReactElement {
  const result = useQuery((kizunasync) => kizunasync.from('users').select('id, first_name').returns<IUser[]>(), { client })
  const names: string[] = result.data.map((user) => user.first_name)

  onNames(names)

  return React.createElement('p', null, names.join(','))
}

describe('useQuery with a typed build', () => {
  test('reads the rows the untyped build reads', async () => {
    const client = createKizunaSync({ databasePath: null }, idleRemote, defineConfig({ tables: { users: { sync: 'read-write' } } }))
    let latest: string[] = []

    await client.from('users').insert({ ...ADA })
    const view = render(React.createElement(TypedProbe, { client, onNames: (names) => {
      latest = names
    } }))

    await waitFor(() => expect(latest).toEqual(['Ada']))
    view.unmount()
    client.dispose()
  })
})

// MARK: - Types

/**
 * Compiled by `bun run type-check` and never called, since a hook needs a
 * render. Each `@ts-expect-error` fails the type check when its line compiles.
 */
function checkInferredTypes(client: IKizunaSync): void {
  const list = useQuery((kizunasync) => kizunasync.from('users').select().returns<IUser[]>(), { client })
  const one = useQuery((kizunasync) => kizunasync.from('users').select().eq('id', ADA.id).single<IUser>(), { client })
  const maybeOne = useQuery((kizunasync) => kizunasync.from('users').select().maybeSingle<IUser>(), { client })
  const merged = useQuery((kizunasync) => kizunasync.from('users').select().returns<IUser[]>().overrideTypes<{ nick: string }[]>(), { client })
  const explicit = useQuery<IUser>((kizunasync) => kizunasync.from('users').select(), { client })
  const untyped = useQuery((kizunasync) => kizunasync.from('users').select(), { client })
  const users: IUser[] = list.data
  const user: IUser | null = one.data
  const maybeUser: IUser | null = maybeOne.data
  const nick: string | undefined = merged.data[0]?.nick
  const explicitUsers: IUser[] = explicit.data
  const cell: unknown = untyped.data[0]?.first_name
  // @ts-expect-error a list build never yields one row
  const listAsRow: IUser | null = list.data
  // @ts-expect-error a one-row build never yields a list
  const oneAsList: IUser[] = one.data
  // @ts-expect-error the inferred row type has no such column
  const missing: string = list.data[0]!.last_name
  // @ts-expect-error a head read has no rows to render
  const head = useQuery((kizunasync) => kizunasync.from('users').select('*', { head: true }), { client })

  void [users, user, maybeUser, nick, explicitUsers, cell, listAsRow, oneAsList, missing, head]
}

void checkInferredTypes
