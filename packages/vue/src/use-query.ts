/**
 * build(kizunasync) returns an ILocalSelectBuilder; local reads go through the async
 * driver SPI (a worker + OPFS on web), so the builder is awaited, not read
 * synchronously. Reactivity rides kizunasync.on: every engine event that can
 * change what a row read would return (`reReadsRows`) re-runs the build +
 * read, so committed local writes, pulled rows, and a rehydration flow into
 * the refs. A same-tick burst of such events is coalesced into one queued
 * read. A monotonic sequence counter discards stale resolutions: a slow read
 * must never overwrite a newer event-driven one. opts.deps adds the other
 * trigger: watch sources whose change re-runs the read, for an input the
 * engine never emits an event for. isLoading starts true and flips false on
 * the first resolve. A failed read keeps the last resolved data and reports
 * the failure in `error`. onScopeDispose unsubscribes and invalidates any
 * in-flight or queued read when the owning component or effect scope tears
 * down.
 */
// MARK: - useQuery

import { type Ref, type WatchSource, onScopeDispose, ref, watch } from 'vue'
import { reReadsRows, type IKizunaSync, type ILocalSelectBuilder, type TColumnValues } from '@kizunasync/core'
import { type IUseKizunaSyncOptions, useKizunaSync } from './provide'

export interface IUseQueryResult<T> {
  data: Ref<T[]>
  error: Ref<Error | null>
  isLoading: Ref<boolean>
}

export interface IUseQueryOptions extends IUseKizunaSyncOptions {
  /**
   * Re-run the query when any of these change: the inputs the build closure
   * reads (a filter, a route param). Data-driven updates already arrive on
   * engine events, so this is only for inputs the engine cannot see. Mirrors
   * the React binding's dependency array, as watch sources rather than values.
   */
  deps?: WatchSource<unknown>[]
}

export const useQuery = <T = TColumnValues>(
  build: (kizunasync: IKizunaSync) => ILocalSelectBuilder,
  opts?: IUseQueryOptions,
): IUseQueryResult<T> => {
  const client = useKizunaSync(opts)
  const data = ref<T[]>([]) as Ref<T[]>
  const error = ref<Error | null>(null)
  const isLoading = ref(true)
  let seq = 0
  let active = true
  let pending = false

  const run = (): void => {
    const current = (seq += 1)

    // Promise.resolve().then wraps a synchronous throw from build() (e.g. LOCAL_UNSUPPORTED) into a rejection so both paths land in .catch.
    Promise.resolve()
      .then(() => build(client))
      .then((result) => {
        if (current !== seq) return
        data.value = result.data as T[]
        error.value = null
        isLoading.value = false
      })
      .catch((caught) => {
        if (current !== seq) return
        // Keep the last resolved data: a failed re-read is not evidence the rows are gone.
        error.value = caught instanceof Error ? caught : new Error(String(caught))
        isLoading.value = false
      })
  }

  // Coalesces a same-tick burst of row-changing events (e.g. a multi-row pull) into one queued run; `active` stops a run already queued when teardown runs.
  const scheduleRun = (): void => {
    if (pending) {
      return
    }
    pending = true
    Promise.resolve().then(() => {
      pending = false

      if (active) {
        run()
      }
    })
  }

  run()
  const unsubscribe = client.on((event) => {
    if (reReadsRows(event)) {
      scheduleRun()
    }
  })
  const deps = opts?.deps ?? []

  // No stop handle: the watcher belongs to the active effect scope, which stops it on dispose.
  watch(deps, () => {
    run()
  })
  onScopeDispose(() => {
    active = false
    unsubscribe()
    seq += 1
  })

  return { data, error, isLoading }
}
