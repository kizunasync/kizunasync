/**
 * App-became-visible adapter (`AppState`).
 *
 * A backgrounded app has its timers throttled, so the poll loop is not a
 * reliable JWT-refresh path. Returning to `active` is the recovery signal:
 * createSupabaseKizunaSync refreshes the session then wakes the scheduler.
 */

import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native'
import type { IForeground } from '@kizunasync/core'

const STATUSES: ReadonlySet<string> = new Set(['inactive', 'background', 'active', 'extension', 'unknown'])

/**
 * RN 0.87 types `currentState` as `string | null | undefined` until the native
 * module seeds it; the change listener already delivers `AppStateStatus`.
 */
const asStatus = (value: string | null | undefined): AppStateStatus =>
  value !== null && value !== undefined && STATUSES.has(value) ? (value as AppStateStatus) : 'unknown'

export function createExpoForeground(): IForeground {
  return {
    subscribe: (onForeground) => {
      let current = asStatus(AppState.currentState)
      const sub: NativeEventSubscription = AppState.addEventListener('change', (next) => {
        const wasBackground = current !== 'active'

        current = next

        if (wasBackground && next === 'active') {
          onForeground()
        }
      })

      return () => {
        sub.remove()
      }
    },
  }
}
