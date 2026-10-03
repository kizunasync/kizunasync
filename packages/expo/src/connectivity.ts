import NetInfo, { type NetInfoState } from '@react-native-community/netinfo'
import type { IConnectivity } from '@kizunasync/core'

/**
 * Native connectivity adapter (@react-native-community/netinfo).
 *
 * The IConnectivity port for React Native / Expo. The engine uses it to keep
 * mutations queued while offline and to flush the outbox on the offline → online
 * transition. NetInfo's reachability probe can misreport: a false negative stops
 * every sync attempt with no signal to the user, while a false positive only
 * costs one backed-off request. The default gate therefore checks the radio
 * (`isConnected`) and lets a real request decide reachability; `'internet-reachable'`
 * stays available for apps that point NetInfo's probe at their own backend. A
 * single internal NetInfo subscription keeps a cached `online` flag fresh (so
 * isOnline() stays synchronous) and fans the transition out to every
 * caller-registered listener.
 */

/** Which NetInfo reading decides isOnline(). Defaults to 'connected'. */
export type TExpoConnectivityGate = 'connected' | 'internet-reachable'

export interface IExpoConnectivityOptions {
  /** Which NetInfo reading decides isOnline(). Defaults to 'connected'. */
  gate?: TExpoConnectivityGate
}

/**
 * Create the React Native connectivity adapter backed by NetInfo. Optimistic:
 * isOnline() returns true until the first reading arrives, matching the port's
 * "true when unknown" contract.
 */
export function createExpoConnectivity(options: IExpoConnectivityOptions = {}): IConnectivity {
  const gate = options.gate ?? 'connected'
  let online = true
  const listeners = new Set<(online: boolean) => void>()

  const apply = (next: boolean): void => {
    if (next === online) {
      return
    }
    online = next

    for (const listener of listeners) {
      listener(online)
    }
  }

  // One internal NetInfo subscription owns the cache + fan-out, kept alive only while there are caller listeners so an adapter whose listeners all detach (engine dispose) does not leak a permanent NetInfo subscription. NetInfo emits the current state on subscribe, seeding `online`; fetch() backs it up in case the initial emission is delayed (its rejection is swallowed, because an unknown reading keeps the optimistic default).
  let netInfoUnsub: (() => void) | null = null
  const ensureNetInfo = (): void => {
    if (netInfoUnsub !== null) {
      return
    }
    netInfoUnsub = NetInfo.addEventListener((state) => apply(isStateOnline(state, gate)))
    void NetInfo.fetch()
      .then((state) => apply(isStateOnline(state, gate)))
      .catch(() => undefined)
  }

  return {
    isOnline: () => online,
    subscribe: (onChange) => {
      ensureNetInfo()
      listeners.add(onChange)

      return () => {
        listeners.delete(onChange)

        if (listeners.size === 0 && netInfoUnsub !== null) {
          netInfoUnsub()
          netInfoUnsub = null
        }
      }
    },
  }
}

/**
 * Map a NetInfo reading to a boolean under the chosen gate. 'connected' trusts
 * the radio state alone (null/undefined is unknown, and unknown is optimistic
 * per the port contract); 'internet-reachable' prefers the reachability probe
 * once it has resolved and falls back to isConnected while it is null.
 */
function isStateOnline(state: NetInfoState, gate: TExpoConnectivityGate): boolean {
  if (gate === 'connected') {
    return state.isConnected !== false
  }
  if (state.isInternetReachable !== null && state.isInternetReachable !== undefined) {
    return state.isInternetReachable
  }
  return state.isConnected === true
}
