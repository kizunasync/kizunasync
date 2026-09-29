/**
 * Local reads go through the async driver SPI (a worker + OPFS on web), so the
 * builder is awaited, not read synchronously. On mount AND on every engine
 * event that can change what a row read would return (`reReadsRows`), run the
 * (async) build + read and commit the result when it resolves. A burst of such
 * events in the same microtask (a pull committing several rows, a local write
 * riding alongside its own QUEUE_DEPTH) is coalesced into one queued read. A
 * monotonic sequence counter discards stale resolutions: a slow read must
 * never overwrite a newer event-driven one. First render is
 * { data: [], error: null, isLoading: true }; isLoading flips false on the
 * first resolve. Errors thrown/rejected by the builder (LOCAL_UNSUPPORTED,
 * etc.) are captured into { error } instead of crashing the render, and the
 * last resolved data stays rather than being cleared.
 */
// MARK: - useQuery

import { useCallback, useEffect, useRef, useState } from 'react'
import { reReadsRows, type ILocalSelectBuilder, type IKizunaSync, type TColumnValues } from '@kizunasync/core'
import { useKizunaSync, type IClientOption } from './provider'

export interface IQueryResult<T> {
  data: T[]
  error: Error | null
  isLoading: boolean
}

interface IQueryState<T> {
  data: T[]
  error: Error | null
  isLoading: boolean
}

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause))

export interface IQueryOption extends IClientOption {
  /**
   * Re-run the query when any of these change: the inputs the build closure
   * captures (a filter, a route param). Data-driven updates already arrive via
   * engine events; this is only for external inputs. Keep the array length
   * stable across renders (React's deps rule).
   */
  deps?: readonly unknown[]
}

export const useQuery = <T = TColumnValues>(
  build: (kizunasync: IKizunaSync) => ILocalSelectBuilder,
  opts?: IQueryOption,
): IQueryResult<T> => {
  const client = useKizunaSync(opts)

  const [state, setState] = useState<IQueryState<T>>({
    data: [],
    error: null,
    isLoading: true,
  })

  // Monotonic across renders so an in-flight read survives an effect re-run and can still be discarded by a newer one (or by teardown, which bumps it).
  const seqRef = useRef(0)

  // Latest build WITHOUT re-subscribing. An inline build (the common pattern) has a fresh identity every render, so depending on it would spin an unbounded render→effect→read→setState loop. Read it through a ref instead; the effect keys off [client] + the caller's declared deps only.
  const buildRef = useRef(build)

  buildRef.current = build

  const read = useCallback((): void => {
    const seq = (seqRef.current += 1)

    // Promise.resolve().then wraps a synchronous throw from build() (e.g. LOCAL_UNSUPPORTED) into a rejection so both paths land in .catch.
    Promise.resolve()
      .then(() => buildRef.current(client))
      .then((result) => {
        if (seq !== seqRef.current) return
        setState({ data: result.data as T[], error: null, isLoading: false })
      })
      .catch((cause) => {
        if (seq !== seqRef.current) return
        // Keep the last resolved data: a failed re-read is not evidence the rows are gone.
        setState((prev) => ({ data: prev.data, error: toError(cause), isLoading: false }))
      })
  }, [client])

  // Coalesces a same-tick burst of row-changing events (e.g. a multi-row pull) into one queued read; activeRef stops a read already queued when teardown runs.
  const pendingRef = useRef(false)
  const activeRef = useRef(true)

  const scheduleRead = useCallback((): void => {
    if (pendingRef.current) {
      return
    }
    pendingRef.current = true
    Promise.resolve().then(() => {
      pendingRef.current = false

      if (activeRef.current) {
        read()
      }
    })
  }, [read])

  const extraDeps = opts?.deps ?? []

  useEffect(() => {
    activeRef.current = true
    read()
    const unsubscribe = client.on((event) => {
      if (reReadsRows(event)) {
        scheduleRead()
      }
    })

    return () => {
      activeRef.current = false
      unsubscribe()
      // Invalidate any in-flight read so it cannot setState after teardown.
      seqRef.current += 1
    }
    // read is stable ([client]); extraDeps re-run the query on input change.
  }, [client, read, scheduleRead, ...extraDeps])

  return state
}
