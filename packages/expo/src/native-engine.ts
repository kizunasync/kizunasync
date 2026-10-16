import type { TNativeEngineLoadResult, TUniffiEngineEvent, TUniffiEventObserver, TUniffiHandle } from '@kizunasync/core'
import { getNativeModule } from './native-module'
import type { IKizunaExpoModule } from './native-module.types'

const unavailable =
  'KizunaSyncExpo is not linked. Rebuild the native app with Expo SDK 58; Expo Go does not include the Kizuna engine.'

/** Resolve the existing SQLite directory without opening another SQL engine. */
export function expoDatabasePath(name: string): string {
  const module = getNativeModule()

  if (module === null) {
    throw new Error(unavailable)
  }
  const path = module.databasePath(name)

  if (typeof path !== 'string' || path.length === 0) {
    throw new Error(
      `KizunaSyncExpo did not report a database path for "${name}"`,
    )
  }
  return path
}

/** Load the Expo Modules API 2.0 adapter for the shared UniFFI engine. */
export function loadExpoNativeEngine(): TNativeEngineLoadResult {
  try {
    const module = getNativeModule()

    return module === null
      ? { ok: false, message: unavailable }
      : { ok: true, handle: createExpoEngineHandle(module) }
  } catch (error) {
    return { ok: false, message: `${unavailable} ${String(error)}` }
  }
}

/** Adapt the native module without narrowing 64-bit observer ids to JS numbers. */
export function createExpoEngineHandle(module: IKizunaExpoModule): TUniffiHandle {
  return new TExpoEngineHandle(module)
}

/** One engine owns its listener and waits for its native initialization. */
class TExpoEngineHandle implements TUniffiHandle {
  private readonly id: string
  private readonly observers = new Map<bigint, TUniffiEventObserver>()
  private nextObserver = 1n
  private opening: Promise<void> | null = null
  private ready = false
  private closed = false
  private subscription: { remove(): void } | null = null

  constructor(private readonly module: IKizunaExpoModule) {
    this.id = module.newEngineId()
  }

  create(configJson: string): void {
    if (this.closed || this.opening !== null) {
      throw new Error('ENGINE_UNAVAILABLE: Expo engine has already been created or closed')
    }
    this.subscription = this.module.addListener('engineEvent', (payload) => this.deliver(payload))

    try {
      this.opening = this.module.createEngine(this.id, configJson).then(() => { this.ready = true })
      void this.opening.catch(() => undefined)
    } catch (error) {
      this.subscription.remove()
      this.subscription = null

      throw error
    }
  }

  private deliver(payload: string): void {
    try {
      const value = JSON.parse(payload) as { id?: unknown; event?: TUniffiEngineEvent }

      if (this.closed || value.id !== this.id || typeof value.event?.tag !== 'string') return

      for (const observer of [...this.observers.values()]) {
        try { observer.onEvent(value.event) } catch {
          // One observer must not prevent delivery to later observers.
        }
      }
    } catch {
      // Decoding failures must not cross the JSI delivery boundary.
    }
  }

  call(method: string, paramsJson: string): string {
    if (!this.ready || this.closed) {
      throw new Error('ENGINE_UNAVAILABLE: synchronous call before Expo engine readiness')
    }
    return this.module.call(this.id, method, paramsJson)
  }

  async callAsync(method: string, paramsJson: string): Promise<string> {
    if (this.closed || this.opening === null) throw new Error('ENGINE_UNAVAILABLE: Expo engine is not open')
    await this.opening

    if (this.closed) throw new Error('ENGINE_UNAVAILABLE: Expo engine is closed')

    return this.module.callAsync(this.id, method, paramsJson)
  }

  subscribe(observer: TUniffiEventObserver): bigint {
    if (this.closed) throw new Error('ENGINE_UNAVAILABLE: Expo engine is closed')
    const observerId = this.nextObserver++

    this.observers.set(observerId, observer)

    return observerId
  }

  unsubscribe(observerId: bigint): void {
    this.observers.delete(observerId)
  }

  shutdown(): void {
    if (this.closed) return
    this.closed = true
    this.observers.clear()
    this.subscription?.remove()
    this.subscription = null

    if (this.opening !== null) {
      void this.opening.then(() => this.module.closeEngine(this.id)).catch(() => undefined)
    }
  }
}
