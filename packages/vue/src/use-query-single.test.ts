/// <reference types="bun" />
/**
 * A build that ends in `.single()` or `.maybeSingle()` yields one row or `null`
 * rather than a list: `data` starts as `null`, a matching row lands as that row
 * object, and a `single()` that matches nothing leaves `null` beside a
 * LOCAL_CONSTRAINT error. These run on a real in-memory app client, so the shape
 * the composable reads is the one the core builder carries.
 */
// MARK: - useQuery with a one-row build

import { describe, expect, test } from 'bun:test'
import { effectScope, ref, type Ref } from 'vue'
import { createKizunaSync, defineConfig, EEngineErrorCode, type IKizunaSync, type ILocalSelectBuilder, type IProtocolRemote } from '@kizunasync/core'
import { useQuery } from './use-query'

interface IUser {
  id: string
  first_name: string
  last_name: string
}

interface ISnapshotRefs {
  data: Ref<unknown>
  error: Ref<Error | null>
  isLoading: Ref<boolean>
}

const AUTH_USER_ID = 'auth-ada'
const ADA: IUser = { id: '00000000-0000-4000-8000-00000000a0da', first_name: 'Ada', last_name: 'Lovelace' }
const WAIT_STEP_MS = 10
const WAIT_STEPS = 200

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

/** The engine answers off the main thread, so a read settles after an unknown number of ticks. */
const until = async (isDone: () => boolean): Promise<void> => {
  for (let step = 0; step < WAIT_STEPS && !isDone(); step += 1) {
    await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS))
  }
}

const snapshot = (refs: ISnapshotRefs): { data: unknown; error: Error | null; isLoading: boolean } => ({
  data: refs.data.value,
  error: refs.error.value,
  isLoading: refs.isLoading.value,
})

describe('useQuery one-row builds', () => {
  test('single() with one matching row: null while loading, then that row object', async () => {
    const client = await openClient(true)
    const scope = effectScope()
    const result = scope.run(() => useQuery<IUser>((kizunasync) => selectUser(kizunasync, AUTH_USER_ID).single(), { client }))!

    expect(snapshot(result)).toEqual({ data: null, error: null, isLoading: true })

    await until(() => !result.isLoading.value)
    expect(snapshot(result)).toEqual({ data: ADA, error: null, isLoading: false })
    scope.stop()
    client.dispose()
  })

  test('single() with no matching row: data stays null and error is LOCAL_CONSTRAINT', async () => {
    const client = await openClient(false)
    const scope = effectScope()
    const result = scope.run(() => useQuery<IUser>((kizunasync) => selectUser(kizunasync, AUTH_USER_ID).single(), { client }))!

    await until(() => !result.isLoading.value)
    expect(result.data.value).toBeNull()
    expect(result.error.value).toMatchObject({ code: EEngineErrorCode.LOCAL_CONSTRAINT })
    scope.stop()
    client.dispose()
  })

  test('maybeSingle() with no matching row: data is null and there is no error', async () => {
    const client = await openClient(false)
    const scope = effectScope()
    const result = scope.run(() => useQuery<IUser>((kizunasync) => selectUser(kizunasync, AUTH_USER_ID).maybeSingle(), { client }))!

    expect(result.data.value).toBeNull()

    await until(() => !result.isLoading.value)
    expect(snapshot(result)).toEqual({ data: null, error: null, isLoading: false })
    scope.stop()
    client.dispose()
  })

  test('maybeSingle() with one matching row: that row object', async () => {
    const client = await openClient(true)
    const scope = effectScope()
    const result = scope.run(() => useQuery<IUser>((kizunasync) => selectUser(kizunasync, AUTH_USER_ID).maybeSingle(), { client }))!

    await until(() => !result.isLoading.value)
    expect(snapshot(result)).toEqual({ data: ADA, error: null, isLoading: false })
    scope.stop()
    client.dispose()
  })

  test('a list build is unchanged: [] while loading, then the rows', async () => {
    const client = await openClient(true)
    const scope = effectScope()
    const result = scope.run(() => useQuery<IUser>((kizunasync) => selectUser(kizunasync, AUTH_USER_ID), { client }))!

    expect(snapshot(result)).toEqual({ data: [], error: null, isLoading: true })

    await until(() => !result.isLoading.value)
    expect(snapshot(result)).toEqual({ data: [ADA], error: null, isLoading: false })
    scope.stop()
    client.dispose()
  })

  test('deps that switch the build from a list to one row switch data from rows to that row, and back', async () => {
    const client = await openClient(true)
    const isSingle = ref(false)
    const scope = effectScope()
    const build = (kizunasync: IKizunaSync) => (isSingle.value ? selectUser(kizunasync, AUTH_USER_ID).single() : selectUser(kizunasync, AUTH_USER_ID))
    // Neither overload takes a build that returns both shapes; the shape each read reports is what this test observes.
    const result: ISnapshotRefs = scope.run(() => useQuery(build as (kizunasync: IKizunaSync) => ILocalSelectBuilder, { client, deps: [isSingle] }))!

    await until(() => !result.isLoading.value)
    expect(result.data.value).toEqual([ADA])

    isSingle.value = true
    await until(() => !Array.isArray(result.data.value))
    expect(result.data.value).toEqual(ADA)
    expect(result.error.value).toBeNull()

    isSingle.value = false
    await until(() => Array.isArray(result.data.value))
    expect(result.data.value).toEqual([ADA])
    scope.stop()
    client.dispose()
  })

  test('a failed read after a switch to one row does not keep the list', async () => {
    const client = await openClient(true)
    const isSingle = ref(false)
    const authUserId = ref(AUTH_USER_ID)
    const scope = effectScope()
    const build = (kizunasync: IKizunaSync) => (isSingle.value ? selectUser(kizunasync, authUserId.value).single() : selectUser(kizunasync, authUserId.value))
    // Neither overload takes a build that returns both shapes; the shape each read reports is what this test observes.
    const result: ISnapshotRefs = scope.run(() => useQuery(build as (kizunasync: IKizunaSync) => ILocalSelectBuilder, { client, deps: [isSingle, authUserId] }))!

    await until(() => !result.isLoading.value)
    expect(result.data.value).toEqual([ADA])

    isSingle.value = true
    authUserId.value = 'auth-nobody'
    await until(() => result.error.value !== null)
    expect(result.error.value).toMatchObject({ code: EEngineErrorCode.LOCAL_CONSTRAINT })
    expect(result.data.value).toBeNull()
    scope.stop()
    client.dispose()
  })
})

// MARK: - Types

/**
 * Compiled by `bun run type-check` and never called, since a composable needs
 * an owning scope. Each `@ts-expect-error` fails the type check when its line
 * compiles, so `data` can be neither `any` nor the other shape.
 */
function checkDataTypes(client: IKizunaSync): void {
  const one = useQuery<IUser>((kizunasync) => selectUser(kizunasync, AUTH_USER_ID).single(), { client })
  const maybeOne = useQuery<IUser>((kizunasync) => selectUser(kizunasync, AUTH_USER_ID).maybeSingle(), { client })
  const many = useQuery<IUser>((kizunasync) => selectUser(kizunasync, AUTH_USER_ID), { client })
  const row: IUser | null = one.data.value
  const maybeRow: IUser | null = maybeOne.data.value
  const rows: IUser[] = many.data.value
  // @ts-expect-error a one-row build never yields a list
  const oneAsRows: IUser[] = one.data.value
  // @ts-expect-error a maybeSingle build never yields a list
  const maybeOneAsRows: IUser[] = maybeOne.data.value
  // @ts-expect-error a list build never yields one row
  const manyAsRow: IUser | null = many.data.value

  void [row, maybeRow, rows, oneAsRows, maybeOneAsRows, manyAsRow]
}
