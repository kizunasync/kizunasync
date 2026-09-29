// MARK: - Optional UniFFI probe

/**
 * React Native registers a loadable `KizunaSyncEngine` via `@kizunasync/rn-uniffi`.
 * Web and Node must never import that package: its generated entry calls
 * TurboModuleRegistry. This probe is a dynamic require, guarded to RN.
 */

import type { TUniffiHandle } from './rust-uniffi-engine'

/**
 * Metro injects CommonJS `require` into RN modules. Browser/Node ESM type-check
 * (and Vite app tsconfigs that pin `types: ['vite/client']`) have no `require`.
 */
declare function require(moduleId: string): unknown

const isReactNative = (): boolean =>
  typeof navigator !== 'undefined' &&
  (navigator as { product?: string }).product === 'ReactNative'

/**
 * One `@kizunasync/rn-uniffi` probe: the handle when it loaded, and the actionable
 * message `selectEngine` reports for `ENGINE_UNAVAILABLE` when it did not.
 * `probeUniffiHandle` and `probeUniffiFailureMessage` are two views over this
 * so neither caller re-requires the package.
 */
interface IUniffiProbeOutcome {
  handle: TUniffiHandle | null
  failureMessage: string | null
}

const NOT_REACT_NATIVE: IUniffiProbeOutcome = { handle: null, failureMessage: null }

function probeUniffi(): IUniffiProbeOutcome {
  if (!isReactNative()) {
    return NOT_REACT_NATIVE
  }
  try {
    const mod = require('@kizunasync/rn-uniffi') as {
      tryLoadUniffiNativeEngine: () =>
        | { ok: true; engine: TUniffiHandle }
        | { ok: false; reason: string }
      describeUniffiLoadFailure: (reason: string) => string
    }
    const result = mod.tryLoadUniffiNativeEngine()

    if (result.ok) {
      return { handle: result.engine, failureMessage: null }
    }
    return { handle: null, failureMessage: mod.describeUniffiLoadFailure(result.reason) }
  } catch {
    return { handle: null, failureMessage: null }
  }
}

export const probeUniffiHandle = (): TUniffiHandle | null => probeUniffi().handle

/**
 * The message `@kizunasync/rn-uniffi` gives for why it did not load (`not_linked` or
 * `invalid_module`), or `null` when a handle loaded, this process is not React
 * Native, or `@kizunasync/rn-uniffi` itself did not resolve.
 */
export const probeUniffiFailureMessage = (): string | null => probeUniffi().failureMessage
