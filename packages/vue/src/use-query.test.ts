/// <reference types="bun" />
/**
 * Mirrors index.test.ts's effectScope pattern. The fake builder records the
 * value each read filtered on, so a re-run is observable as a second entry in
 * `reads` rather than as an equal-looking row set. Engine-driven recompute is
 * covered in index.test.ts; this file covers only opts.deps, the trigger for an
 * input the engine never emits an event for.
 */
// MARK: - useQuery opts.deps re-runs the read on a watch source change

import { describe, expect, test } from 'bun:test'
import { effectScope, ref } from 'vue'
import type { IKizunaSync, ILocalFromBuilder, ILocalSelectBuilder } from '@kizunasync/core'
import { useQuery } from './use-query'

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const makeFakeKizunaSync = (): { client: IKizunaSync; reads: string[] } => {
  const reads: string[] = []

  const selectBuilder = (): ILocalSelectBuilder => {
    let filter = 'none'
    const builder = {
      eq: (_column: string, value: string) => {
        filter = value

        return builder
      },
      then: (onfulfilled: unknown) => {
        reads.push(filter)

        return Promise.resolve({ data: [{ id: filter }], error: null }).then(onfulfilled as never)
      },
    } as unknown as ILocalSelectBuilder

    return builder
  }

  const client = {
    from: () => ({ select: selectBuilder }) as unknown as ILocalFromBuilder,
    on: () => () => undefined,
  } as unknown as IKizunaSync

  return { client, reads }
}

describe('useQuery opts.deps', () => {
  test('re-runs the read when a declared dep changes', async () => {
    const { client, reads } = makeFakeKizunaSync()
    const owner = ref('user-a')
    const scope = effectScope()
    let result!: ReturnType<typeof useQuery>

    scope.run(() => {
      result = useQuery((kizunasync) => kizunasync.from('todos').select().eq('user_id', owner.value), {
        client,
        deps: [owner],
      })
    })

    await flush()
    expect(result.data.value).toEqual([{ id: 'user-a' }])

    owner.value = 'user-b'
    await flush()
    expect(reads).toEqual(['user-a', 'user-b'])
    expect(result.data.value).toEqual([{ id: 'user-b' }])
    scope.stop()
  })

  test('a getter dep is watched the same way a ref is', async () => {
    const { client, reads } = makeFakeKizunaSync()
    const owner = ref('user-a')
    const scope = effectScope()

    scope.run(() => {
      useQuery((kizunasync) => kizunasync.from('todos').select().eq('user_id', owner.value), {
        client,
        deps: [() => owner.value],
      })
    })

    await flush()
    owner.value = 'user-b'
    await flush()
    expect(reads).toEqual(['user-a', 'user-b'])
    scope.stop()
  })

  test('an undeclared input does not re-run the read', async () => {
    const { client, reads } = makeFakeKizunaSync()
    const owner = ref('user-a')
    const scope = effectScope()

    scope.run(() => {
      useQuery((kizunasync) => kizunasync.from('todos').select().eq('user_id', owner.value), { client })
    })

    await flush()
    owner.value = 'user-b'
    await flush()
    expect(reads).toEqual(['user-a'])
    scope.stop()
  })

  test('a dep change after the scope is disposed reads nothing', async () => {
    const { client, reads } = makeFakeKizunaSync()
    const owner = ref('user-a')
    const scope = effectScope()

    scope.run(() => {
      useQuery((kizunasync) => kizunasync.from('todos').select().eq('user_id', owner.value), {
        client,
        deps: [owner],
      })
    })

    await flush()
    scope.stop()
    owner.value = 'user-b'
    await flush()
    expect(reads).toEqual(['user-a'])
  })
})
