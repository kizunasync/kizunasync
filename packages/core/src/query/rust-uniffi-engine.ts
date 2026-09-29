// MARK: - UniFFI backend for createRustEngine

/**
 * Builds the same `IAppClientEngine` as NAPI, over `KizunaSyncEngine.call`.
 * Transport on this path is `kizunasync-remote-http` via `nativeHttpRemote`
 * (same pull/push RPCs as `createRpcRemote`). A missing remote is `CONFIG_INVALID`. Callback remotes stay on NAPI.
 *
 * Never send `attachment_root`: React Native keeps the TypeScript attachment
 * queue. A present root would attach `TusTransfer` and double-drive bytes.
 */

import { isJsonObject, parseEngineJson, readEngineJson } from './engine-envelope'
import { createRustEngine, type IRustEngineOptions } from './rust-engine'
import type { IEngineTransport, TEngineTransportFactory } from '../ports/engine-transport'
import type { IAppClientEngine } from './select-engine'
import { EEngineErrorCode, EEngineEventType, TEngineError, type TEngineDeps } from '../wire/types'

/**
 * One engine event as the Turbo Module delivers it, mirroring the generated
 * `FfiEngineEvent` union: `tag` names the variant and `inner` carries its
 * fields. Declared here because `@kizunasync/core` imports no adapter, so the shape
 * the bridge hands over is written down on both sides of it.
 */
export const EUniffiEngineEventTag = {
  LocalChanged: 'LocalChanged',
  MutationRejected: 'MutationRejected',
  QueueDepth: 'QueueDepth',
  ResetRequired: 'ResetRequired',
  CheckpointExpired: 'CheckpointExpired',
  BatchAborted: 'BatchAborted',
  DeadLetter: 'DeadLetter',
  ColumnOverwritten: 'ColumnOverwritten',
} as const
export type TUniffiEngineEventTag = (typeof EUniffiEngineEventTag)[keyof typeof EUniffiEngineEventTag]

export type TUniffiEngineEvent =
  | { tag: typeof EUniffiEngineEventTag.LocalChanged }
  | { tag: typeof EUniffiEngineEventTag.MutationRejected; inner: { mutationId: string; reason: string } }
  | { tag: typeof EUniffiEngineEventTag.QueueDepth; inner: { depth: number } }
  | { tag: typeof EUniffiEngineEventTag.ResetRequired; inner: { reason?: string } }
  | { tag: typeof EUniffiEngineEventTag.CheckpointExpired }
  | { tag: typeof EUniffiEngineEventTag.BatchAborted; inner: { offenderMutationId: string; reason: string } }
  | { tag: typeof EUniffiEngineEventTag.DeadLetter; inner: { mutationId: string; reason: string } }
  | {
      tag: typeof EUniffiEngineEventTag.ColumnOverwritten
      inner: {
        table: string
        pk: string
        column: string
        loserValueJson: string
        winnerMutationId: string
        conflictMode: string
      }
    }

/**
 * What `subscribe` registers. The engine calls `onEvent` from the handle's
 * delivery thread, in emission order, so the observer may call back into the
 * engine.
 */
export type TUniffiEventObserver = {
  onEvent(event: TUniffiEngineEvent): void
}

/**
 * The Turbo Module handle `@kizunasync/rn-uniffi` loads, and the whole contract a
 * host injecting one through `TEngineDeps.uniffiHandle` takes on: the app client
 * runs every engine call through `callAsync`, subscribes to every engine event
 * through it, and releases the engine's store and runtime through it.
 * `isUniffiHandle` requires the same six members.
 */
export type TUniffiHandle = {
  create(configJson: string): void
  call(method: string, paramsJson: string): string

  /** `call` answered by the engine thread, so the JavaScript thread never waits on the engine. */
  callAsync(method: string, paramsJson: string): Promise<string>

  /** The subscription id `unsubscribe` takes back. */
  subscribe(observer: TUniffiEventObserver): bigint

  unsubscribe(subscriptionId: bigint): void
  shutdown(): void
}

type TUniffiEngineOptions = Omit<
  IRustEngineOptions,
  'addon' | 'native' | 'engineFactory'
> & {
  handle: TUniffiHandle
}

/**
 * Exhaustiveness guard (@../../../../CONVENTIONS.md). A bridge variant without a
 * case here fails to narrow to `never`: compile error instead of a dropped
 * runtime event.
 */
function assertNever(value: never): never {
  throw new Error(`uniffi observer: unhandled engine event ${JSON.stringify(value)}`)
}

/**
 * Render one bridge event as the tagged JSON every backend hands `onEvent`.
 * `loserValueJson` is the engine's own `serde_json` rendering of the value, so
 * it is parsed back into the position the NAPI and worker bridges deliver.
 */
function toTaggedEventJson(event: TUniffiEngineEvent): string {
  switch (event.tag) {
    case EUniffiEngineEventTag.LocalChanged:
      return JSON.stringify({ type: EEngineEventType.LOCAL_CHANGED })
    case EUniffiEngineEventTag.ResetRequired:
      return JSON.stringify({ type: EEngineEventType.RESET_REQUIRED, reason: event.inner.reason })
    case EUniffiEngineEventTag.CheckpointExpired:
      return JSON.stringify({ type: EEngineEventType.CHECKPOINT_EXPIRED })
    case EUniffiEngineEventTag.QueueDepth:
      return JSON.stringify({ type: EEngineEventType.QUEUE_DEPTH, depth: event.inner.depth })
    case EUniffiEngineEventTag.MutationRejected:
      return JSON.stringify({
        type: EEngineEventType.MUTATION_REJECTED,
        mutation_id: event.inner.mutationId,
        reason: event.inner.reason,
      })
    case EUniffiEngineEventTag.DeadLetter:
      return JSON.stringify({
        type: EEngineEventType.DEAD_LETTER,
        mutation_id: event.inner.mutationId,
        reason: event.inner.reason,
      })
    case EUniffiEngineEventTag.BatchAborted:
      return JSON.stringify({
        type: EEngineEventType.BATCH_ABORTED,
        offender_mutation_id: event.inner.offenderMutationId,
        reason: event.inner.reason,
      })
    case EUniffiEngineEventTag.ColumnOverwritten:
      return JSON.stringify({
        type: EEngineEventType.COLUMN_OVERWRITTEN,
        table: event.inner.table,
        pk: event.inner.pk,
        column: event.inner.column,
        loser_value: parseEngineJson(event.inner.loserValueJson),
        winner_mutation_id: event.inner.winnerMutationId,
        conflict_mode: event.inner.conflictMode,
      })
    default:
      return assertNever(event)
  }
}

interface ICreateJsonOptions {
  configJson: string
  databasePath: string | null
  http: NonNullable<TEngineDeps['nativeHttpRemote']>
}

/**
 * The JSON `create` takes: the app client's engine config with the resolved
 * database path and the kernel's own HTTP remote merged in.
 */
export function toCreateJson({ configJson, databasePath, http }: ICreateJsonOptions): string {
  const publishableKey = http.publishableKey ?? http.anonKey

  return JSON.stringify({
    ...readEngineJson(configJson, isJsonObject),
    database_path: databasePath,
    remote: {
      url: http.url,
      ...(publishableKey === undefined || publishableKey === ''
        ? {}
        : { publishable_key: publishableKey }),
      ...(http.accessToken === undefined ? {} : { access_token: http.accessToken }),
    },
  })
}

export const createRustUniffiEngine = (options: TUniffiEngineOptions): IAppClientEngine => {
  const { handle, logger } = options
  let subscriptionId: bigint | null = null
  let closed = false

  // The engine is opened through the factory rather than handed over ready, so the observer can forward events to the `onEvent` `createRustEngine` fans out to `kizunasync.on()`. The remote is Rust's own: `pull` and `push` stay unused because this path speaks HTTP inside the kernel.
  // eslint-disable-next-line max-params -- mirrors the N-API engine constructor argument for argument
  const engineFactory: TEngineTransportFactory = (configJson, databasePath, _pull, _push, onEvent): IEngineTransport => {
    const http = options.deps.nativeHttpRemote

    if (http === undefined) {
      throw new TEngineError(
        EEngineErrorCode.CONFIG_INVALID,
        'UniFFI create needs nativeHttpRemote (url and publishable key). Use createSupabaseKizunaSync, or pass nativeHttpRemote.',
      )
    }
    handle.create(toCreateJson({ configJson, databasePath, http }))
    subscriptionId = handle.subscribe({
      onEvent: (event) => {
        try {
          onEvent(toTaggedEventJson(event))
        } catch {
          // A throw here would cross the FFI into the delivery thread as a callback failure, so an event this build cannot render is logged and dropped, as the NAPI bridge does with one it cannot read.
          logger.debug('dropped an unreadable engine event')
        }
      },
    })

    return {
      call: async (method, paramsJson) => handle.callAsync(method, paramsJson),
      close: () => {
        if (closed) {
          return
        }
        closed = true

        if (subscriptionId !== null) {
          handle.unsubscribe(subscriptionId)
          subscriptionId = null
        }
        handle.shutdown()
      },
    }
  }

  return createRustEngine({ ...options, engineFactory })
}
