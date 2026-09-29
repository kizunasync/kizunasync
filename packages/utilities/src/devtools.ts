/**
 * Examples devtools: the shim-level pieces every example app built for itself,
 * the live-sync gate and the connectivity and doorbell wrappers it drives.
 *
 * None of this touches `@kizunasync/core`. The gate is a pair of flags an example's
 * settings UI flips; the engine only ever sees a normal `IConnectivity`, a
 * normal `IWakeup`, and the gate's `isActive` as its `shouldSyncAutomatically`
 * switch, so an example can suspend live sync without the engine knowing a lab
 * exists.
 */

import type { IConnectivity, IWakeup } from '@kizunasync/core'

// MARK: - Live-sync gate

export interface ILiveSyncGate {
  /**
   * Effective live sync: the toggle AND not the simulated-offline switch.
   * Offline always wins, so a stale live-sync=on can never wake a client the
   * user has put in airplane mode.
   */
  isActive(): boolean

  isLiveSyncEnabled(): boolean
  isOfflineSimulated(): boolean
  setLiveSync(enabled: boolean): void
  setOffline(value: boolean): void

  /**
   * Notified with the resulting online value whenever the simulated-offline
   * switch flips, so a connectivity wrapper can push the synthetic transition
   * the engine's auto-flush needs.
   */
  subscribeOnline(listener: (online: boolean) => void): () => void

  /**
   * Notified whenever either flag flips, so derived live state (the realtime
   * doorbell channel) can reconcile itself.
   */
  subscribeActive(listener: () => void): () => void
}

export const createLiveSyncGate = (): ILiveSyncGate => {
  let liveSyncEnabled = true
  let offlineSimulated = false
  const onlineListeners = new Set<(online: boolean) => void>()
  const activeListeners = new Set<() => void>()

  const notifyActive = (): void => {
    for (const listener of activeListeners) {
      listener()
    }
  }

  return {
    isActive: () => liveSyncEnabled && !offlineSimulated,
    isLiveSyncEnabled: () => liveSyncEnabled,
    isOfflineSimulated: () => offlineSimulated,
    setLiveSync: (enabled) => {
      if (liveSyncEnabled === enabled) {
        return
      }
      liveSyncEnabled = enabled
      notifyActive()
    },
    setOffline: (value) => {
      if (offlineSimulated === value) {
        return
      }
      offlineSimulated = value

      for (const listener of onlineListeners) {
        listener(!value)
      }
      notifyActive()
    },
    subscribeOnline: (listener) => {
      onlineListeners.add(listener)

      return () => {
        onlineListeners.delete(listener)
      }
    },
    subscribeActive: (listener) => {
      activeListeners.add(listener)

      return () => {
        activeListeners.delete(listener)
      }
    },
  }
}

// MARK: - Connectivity gate

export interface IConnectivityGateOptions {
  /** The platform connectivity the example would have handed the engine. */
  inner: IConnectivity

  gate: ILiveSyncGate
}

/**
 * The connectivity the engine sees, wrapped with the gate's two overrides.
 *
 * `isOnline()` is false whenever simulated-offline is on, so the engine keeps
 * mutations queued and the status dot flips. Real transitions reach the engine
 * only while live sync is active: the engine auto-flushes on false→true, and
 * swallowing transitions while live sync is off keeps that from firing. Flipping
 * the switch emits its own transition, reporting the same value `isOnline()`
 * would, so releasing simulated-offline over a dead network does not claim the
 * device is back. Turning live sync back on reports that value once too: it
 * stands in for the transitions held back while live sync was off, and it is
 * what wakes the engine.
 */
export const createConnectivityGate = ({ inner, gate }: IConnectivityGateOptions): IConnectivity => {
  const isOnline = (): boolean => !gate.isOfflineSimulated() && inner.isOnline()

  return {
    isOnline,
    subscribe: (onChange) => {
      let wasLive = gate.isLiveSyncEnabled()
      const stopGate = gate.subscribeOnline(() => {
        onChange(isOnline())
      })
      const stopLive = gate.subscribeActive(() => {
        const isLive = gate.isLiveSyncEnabled()

        // Only the live-sync switch turning on reports here: the offline switch reports through its own listener above.
        if (isLive && !wasLive && gate.isActive()) {
          onChange(isOnline())
        }
        wasLive = isLive
      })
      const stopInner = inner.subscribe((online) => {
        if (gate.isActive()) {
          onChange(online)
        }
      })

      return () => {
        stopGate()
        stopLive()
        stopInner()
      }
    },
  }
}

// MARK: - Wakeup gate

export interface IWakeupGateOptions {
  /**
   * The doorbell the example would have handed the engine, normally
   * `createRealtimeWakeup` from `@kizunasync/supabase`.
   */
  inner: IWakeup

  gate: ILiveSyncGate
}

/**
 * The realtime doorbell, bound to effective live sync with a REAL teardown.
 *
 * The engine subscribes once at boot, so dropping signals alone would leave the
 * socket open and the client still woken. The inner subscription is deferred:
 * the channel exists only while the gate is active, and going offline (or off
 * the live-sync toggle) unsubscribes it. An offline client stops receiving wake
 * hints until it comes back and re-subscribes. A missed signal only delays the
 * next poll, so the teardown costs no correctness.
 */
export const createGatedWakeup = ({ inner, gate }: IWakeupGateOptions): IWakeup => ({
  subscribe(onSignal) {
    let stopInner: (() => void) | null = null

    const open = (): void => {
      if (stopInner !== null) {
        return
      }
      stopInner = inner.subscribe(() => {
        if (gate.isActive()) {
          onSignal()
        }
      })
    }

    const close = (): void => {
      if (stopInner === null) {
        return
      }
      stopInner()
      stopInner = null
    }

    const reconcile = (): void => {
      if (gate.isActive()) {
        open()
      } else {
        close()
      }
    }

    reconcile()
    const stopReconcile = gate.subscribeActive(reconcile)

    return () => {
      stopReconcile()
      close()
    }
  },
})
