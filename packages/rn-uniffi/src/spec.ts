/**
 * The UniFFI / ubrn Turbo Module spec for `kizunasync-ffi`: the native engine's
 * TypeScript shape plus the loader that resolves it.
 *
 * `tryLoadUniffiNativeEngine()` is the capability probe.
 * `requireUniffiNativeEngine()` fails loud when the module is not linked.
 */

/**
 * One engine event, mirroring the generated `FfiEngineEvent` union: `tag` names
 * the variant and `inner` carries its fields. The generated module spells the
 * tags as a TypeScript enum, which this repository does not use, so they are
 * string literals here; the runtime values are the same strings.
 */
export type TKizunaSyncEngineEvent =
  | { tag: 'LocalChanged' }
  | { tag: 'MutationRejected'; inner: { mutationId: string; reason: string } }
  | { tag: 'QueueDepth'; inner: { depth: number } }
  | { tag: 'ResetRequired'; inner: { reason?: string } }
  | { tag: 'CheckpointExpired' }
  | { tag: 'BatchAborted'; inner: { offenderMutationId: string; reason: string } }
  | { tag: 'DeadLetter'; inner: { mutationId: string; reason: string } }
  | {
      tag: 'ColumnOverwritten'
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
 * delivery thread, in emission order, so a handler may call back into the
 * engine; a slow handler delays the events after it.
 */
export type TKizunaSyncEventObserver = {
  onEvent(event: TKizunaSyncEngineEvent): void
}

/**
 * Shape `createKizunaSync` drives: `create`, the JSON-RPC pair `call` and
 * `callAsync`, the event subscription the app client's `on()` is fed from, and
 * the `shutdown` that releases the engine's store and runtime on dispose.
 * Generated ubrn also exposes the typed methods (`apply`, `query`,
 * `applyWhere`, …); the JavaScript host reaches all of them through
 * `callAsync`, so they are not declared here.
 */
export type TKizunaSyncNativeEngine = {
  create(configJson: string): void
  call(method: string, paramsJson: string): string

  /** `call` answered by the engine thread without blocking the JavaScript thread. */
  callAsync(method: string, paramsJson: string): Promise<string>

  /** The subscription id `unsubscribe` takes back. */
  subscribe(observer: TKizunaSyncEventObserver): bigint

  unsubscribe(subscriptionId: bigint): void
  shutdown(): void
}

/** True when an instance can back `createRustUniffiEngine`. */
export function isUniffiHandle(value: unknown): value is TKizunaSyncNativeEngine {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const engine = value as Record<string, unknown>

  return (
    typeof engine.create === 'function' &&
    typeof engine.call === 'function' &&
    typeof engine.callAsync === 'function' &&
    typeof engine.subscribe === 'function' &&
    typeof engine.unsubscribe === 'function' &&
    typeof engine.shutdown === 'function'
  )
}

export type TKizunaSyncNativeEngineCtor = new () => TKizunaSyncNativeEngine

export type TKizunaSyncNativeEngineModule = {
  KizunaSyncEngine: TKizunaSyncNativeEngineCtor
}

export type TUniffiLoadFailureReason = 'not_linked' | 'invalid_module'

export type TUniffiLoadResult =
  | { ok: true; engine: TKizunaSyncNativeEngine }
  | { ok: false; reason: TUniffiLoadFailureReason }

const GENERATED_MODULE = './generated/index'

/**
 * Soft probe: the generated entry registers the Turbo Module with the host, so
 * it throws wherever no native binary carries it (a Bun process, a browser).
 *
 * `require(GENERATED_MODULE)` runs that registration through the generated
 * entry's `TurboModuleRegistry.getEnforcing('RnUniffi')`, which throws in
 * exactly that case. Metro's runtime reports a throw from a top-level require
 * as a FATAL error through `global.ErrorUtils.reportFatalError`, not to this
 * function's catch, whenever the require runs outside an already-guarded
 * Metro load, which is true of this package's async callers (a client's
 * boot). Checking the registry first with the non-throwing
 * `TurboModuleRegistry.get` keeps that require from ever running against an
 * unlinked binary, so the fatal report never fires.
 */
function isRnUniffiTurboModuleRegistered(): boolean {
  try {
    const rn = require('react-native')

    if (typeof rn.TurboModuleRegistry?.get !== 'function') {
      return false
    }
    const handle = rn.TurboModuleRegistry.get('RnUniffi')

    return handle !== null && handle !== undefined
  } catch {
    return false
  }
}

function tryRequireGenerated(): Partial<TKizunaSyncNativeEngineModule> | null {
  if (!isRnUniffiTurboModuleRegistered()) {
    return null
  }
  try {
    return require(GENERATED_MODULE) as Partial<TKizunaSyncNativeEngineModule>
  } catch {
    return null
  }
}

export function isUniffiNativeAvailable(): boolean {
  const mod = tryRequireGenerated()

  return typeof mod?.KizunaSyncEngine === 'function'
}

export function tryLoadUniffiNativeEngine(): TUniffiLoadResult {
  const mod = tryRequireGenerated()

  if (mod === null) {
    return { ok: false, reason: 'not_linked' }
  }
  if (typeof mod.KizunaSyncEngine !== 'function') {
    return { ok: false, reason: 'invalid_module' }
  }
  const engine = new mod.KizunaSyncEngine()

  if (!isUniffiHandle(engine)) {
    return { ok: false, reason: 'invalid_module' }
  }
  return { ok: true, engine }
}

export function loadUniffiNativeEngine(): TKizunaSyncNativeEngine | null {
  const result = tryLoadUniffiNativeEngine()

  return result.ok ? result.engine : null
}

const LOAD_FAILURE_MESSAGE: Record<TUniffiLoadFailureReason, string> = {
  not_linked:
    "Kizuna's native engine is not in this binary: Expo Go and any build without @kizunasync/rn-uniffi cannot load it. " +
    'Build a development client (`npx expo run:ios` or `npx expo run:android`) and open the app from it; a ' +
    'JavaScript reload cannot add a native module.',
  invalid_module:
    'Kizuna UniFFI Turbo Module does not export a KizunaSyncEngine with create, call, callAsync, subscribe, unsubscribe and shutdown. Rebuild the native app against a matching @kizunasync/rn-uniffi.',
}

/** The actionable message for a load failure, shared by `requireUniffiNativeEngine` and `selectEngine`. */
export function describeUniffiLoadFailure(reason: TUniffiLoadFailureReason): string {
  return LOAD_FAILURE_MESSAGE[reason]
}

export function requireUniffiNativeEngine(): TKizunaSyncNativeEngine {
  const result = tryLoadUniffiNativeEngine()

  if (!result.ok) {
    throw new Error(describeUniffiLoadFailure(result.reason))
  }
  return result.engine
}
