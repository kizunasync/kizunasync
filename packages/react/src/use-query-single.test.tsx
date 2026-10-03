// MARK: - useQuery with a one-row build

/**
 * A build that ends in `.single()` or `.maybeSingle()` yields one row or `null`
 * rather than a list: `data` starts as `null`, a matching row lands as that row
 * object, and a `single()` that matches nothing leaves `null` beside a
 * LOCAL_CONSTRAINT error. These run on a real in-memory app client, so the shape
 * the hook reads is the one the core builder carries.
 */

import '../happydom'
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { render, waitFor } from '@testing-library/react'
import { createKizunaSync, defineConfig, EEngineErrorCode, type IKizunaSync, type ILocalSelectBuilder, type IProtocolRemote } from '@kizunasync/core'
import { useQuery } from './use-query'

interface IUser {
  id: string
  first_name: string
  last_name: string
}

interface ISnapshot {
  data: unknown
  error: Error | null
  isLoading: boolean
}

const AUTH_USER_ID = 'auth-ada'
const ADA: IUser = { id: '00000000-0000-4000-8000-00000000a0da', first_name: 'Ada', last_name: 'Lovelace' }

/** These tests never sync; the remote exists only because the app client takes one. */
const idleRemote: IProtocolRemote = {
  pull: () => Promise.resolve({ cursor: '0', has_more: false, rows: [], signal: null, tombstones: [] }),
  push: () => Promise.resolve({ verdicts: [] }),
}

const openClient = async (withAda: boolean): Promise<IKizunaSync> => {
  const client = createKizunaSync({ databasePath: null }, idleRemote, defineConfig({ tables: { users: { sync: 'read-write' } } }))

  if (withAda) {
    await client.from('users').insert({ ...ADA, auth_user_id: AUTH_USER_ID })
  }
  return client
}

const selectUser = (kizunasync: IKizunaSync, authUserId: string): ILocalSelectBuilder =>
  kizunasync.from('users').select('id, first_name, last_name').eq('auth_user_id', authUserId)

function SingleProbe({ client, onResult }: { client: IKizunaSync; onResult: (result: ISnapshot) => void }): React.ReactElement {
  const result = useQuery<IUser>((kizunasync) => selectUser(kizunasync, AUTH_USER_ID).single(), { client })

  onResult(result)

  return React.createElement('p', null, result.data?.first_name ?? 'none')
}

function MaybeSingleProbe({ client, onResult }: { client: IKizunaSync; onResult: (result: ISnapshot) => void }): React.ReactElement {
  const result = useQuery<IUser>((kizunasync) => selectUser(kizunasync, AUTH_USER_ID).maybeSingle(), { client })

  onResult(result)

  return React.createElement('p', null, result.data?.first_name ?? 'none')
}

function ListProbe({ client, onResult }: { client: IKizunaSync; onResult: (result: ISnapshot) => void }): React.ReactElement {
  const result = useQuery<IUser>((kizunasync) => selectUser(kizunasync, AUTH_USER_ID), { client })

  onResult(result)

  return React.createElement('p', null, String(result.data.length))
}

function ThrowingProbe({ client, onResult }: { client: IKizunaSync; onResult: (result: ISnapshot) => void }): React.ReactElement {
  const result = useQuery((): ILocalSelectBuilder => {
    throw new Error('boom')
  }, { client })

  onResult(result)

  return React.createElement('p', null, String(result.data.length))
}

interface ISwitchProbeProps {
  client: IKizunaSync
  isSingle: boolean
  authUserId: string
  onResult: (result: ISnapshot) => void
}

function SwitchProbe({ client, isSingle, authUserId, onResult }: ISwitchProbeProps): React.ReactElement {
  const build = (kizunasync: IKizunaSync) => (isSingle ? selectUser(kizunasync, authUserId).single() : selectUser(kizunasync, authUserId))
  // Neither overload takes a build that returns both shapes; the shape each read reports is what this probe observes.
  const result = useQuery(build as (kizunasync: IKizunaSync) => ILocalSelectBuilder, { client, deps: [isSingle, authUserId] })

  onResult(result)

  return React.createElement('p', null, isSingle ? 'one' : 'many')
}

const recorder = (): { latest: () => ISnapshot; onResult: (result: ISnapshot) => void } => {
  let latest: ISnapshot = { data: undefined, error: null, isLoading: true }

  return {
    latest: () => latest,
    onResult: (result) => {
      latest = result
    },
  }
}

describe('useQuery one-row builds', () => {
  test('single() with one matching row: null while loading, then that row object', async () => {
    const client = await openClient(true)
    const { latest, onResult } = recorder()
    const view = render(React.createElement(SingleProbe, { client, onResult }))

    expect(latest()).toEqual({ data: null, error: null, isLoading: true })

    await waitFor(() => expect(latest().isLoading).toBe(false))
    expect(latest()).toEqual({ data: ADA, error: null, isLoading: false })
    view.unmount()
    client.dispose()
  })

  test('single() with no matching row: data stays null and error is LOCAL_CONSTRAINT', async () => {
    const client = await openClient(false)
    const { latest, onResult } = recorder()
    const view = render(React.createElement(SingleProbe, { client, onResult }))

    await waitFor(() => expect(latest().isLoading).toBe(false))
    expect(latest().data).toBeNull()
    expect(latest().error).toMatchObject({ code: EEngineErrorCode.LOCAL_CONSTRAINT })
    view.unmount()
    client.dispose()
  })

  test('maybeSingle() with no matching row: data is null and there is no error', async () => {
    const client = await openClient(false)
    const { latest, onResult } = recorder()
    const view = render(React.createElement(MaybeSingleProbe, { client, onResult }))

    expect(latest().data).toBeNull()

    await waitFor(() => expect(latest().isLoading).toBe(false))
    expect(latest()).toEqual({ data: null, error: null, isLoading: false })
    view.unmount()
    client.dispose()
  })

  test('maybeSingle() with one matching row: that row object', async () => {
    const client = await openClient(true)
    const { latest, onResult } = recorder()
    const view = render(React.createElement(MaybeSingleProbe, { client, onResult }))

    await waitFor(() => expect(latest().isLoading).toBe(false))
    expect(latest()).toEqual({ data: ADA, error: null, isLoading: false })
    view.unmount()
    client.dispose()
  })

  test('a list build is unchanged: [] while loading, then the rows', async () => {
    const client = await openClient(true)
    const { latest, onResult } = recorder()
    const view = render(React.createElement(ListProbe, { client, onResult }))

    expect(latest()).toEqual({ data: [], error: null, isLoading: true })

    await waitFor(() => expect(latest().isLoading).toBe(false))
    expect(latest()).toEqual({ data: [ADA], error: null, isLoading: false })
    view.unmount()
    client.dispose()
  })

  test('a build that throws before it names a shape reads as a list and reports the throw', async () => {
    const client = await openClient(false)
    const { latest, onResult } = recorder()
    const view = render(React.createElement(ThrowingProbe, { client, onResult }))

    expect(latest()).toEqual({ data: [], error: null, isLoading: true })

    await waitFor(() => expect(latest().isLoading).toBe(false))
    expect(latest().data).toEqual([])
    expect(latest().error?.message).toBe('boom')
    view.unmount()
    client.dispose()
  })

  test('deps that switch the build from a list to one row switch data from rows to that row, and back', async () => {
    const client = await openClient(true)
    const { latest, onResult } = recorder()
    const view = render(React.createElement(SwitchProbe, { client, isSingle: false, authUserId: AUTH_USER_ID, onResult }))

    await waitFor(() => expect(latest().data).toEqual([ADA]))

    view.rerender(React.createElement(SwitchProbe, { client, isSingle: true, authUserId: AUTH_USER_ID, onResult }))
    await waitFor(() => expect(latest().data).toEqual(ADA))
    expect(latest().error).toBeNull()

    view.rerender(React.createElement(SwitchProbe, { client, isSingle: false, authUserId: AUTH_USER_ID, onResult }))
    await waitFor(() => expect(latest().data).toEqual([ADA]))
    view.unmount()
    client.dispose()
  })

  test('a failed read after a switch to one row does not keep the list', async () => {
    const client = await openClient(true)
    const { latest, onResult } = recorder()
    const view = render(React.createElement(SwitchProbe, { client, isSingle: false, authUserId: AUTH_USER_ID, onResult }))

    await waitFor(() => expect(latest().data).toEqual([ADA]))

    view.rerender(React.createElement(SwitchProbe, { client, isSingle: true, authUserId: 'auth-nobody', onResult }))
    await waitFor(() => expect(latest().error).toMatchObject({ code: EEngineErrorCode.LOCAL_CONSTRAINT }))
    expect(latest().data).toBeNull()
    view.unmount()
    client.dispose()
  })
})

// MARK: - Types

/**
 * Compiled by `bun run type-check` and never called, since a hook runs only
 * inside a component. Each `@ts-expect-error` fails the type check when its line
 * compiles, so `data` can be neither `any` nor the other shape.
 */
function checkDataTypes(client: IKizunaSync): void {
  const one = useQuery<IUser>((kizunasync) => selectUser(kizunasync, AUTH_USER_ID).single(), { client })
  const maybeOne = useQuery<IUser>((kizunasync) => selectUser(kizunasync, AUTH_USER_ID).maybeSingle(), { client })
  const many = useQuery<IUser>((kizunasync) => selectUser(kizunasync, AUTH_USER_ID), { client })
  const row: IUser | null = one.data
  const maybeRow: IUser | null = maybeOne.data
  const rows: IUser[] = many.data
  // @ts-expect-error a one-row build never yields a list
  const oneAsRows: IUser[] = one.data
  // @ts-expect-error a maybeSingle build never yields a list
  const maybeOneAsRows: IUser[] = maybeOne.data
  // @ts-expect-error a list build never yields one row
  const manyAsRow: IUser | null = many.data

  void [row, maybeRow, rows, oneAsRows, maybeOneAsRows, manyAsRow]
}
