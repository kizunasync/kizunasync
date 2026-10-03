import 'react-native-url-polyfill/auto'
/**
 * Tailwind entry compiled by Uniwind, heroui-native reads its theme from these
 * CSS variables, so the import must come before any heroui component mounts.
 */
import '../global.css'
import { createContext, useContext, useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { StatusBar } from 'expo-status-bar'
import { Stack } from 'expo-router'
import { HeroUINativeProvider } from 'heroui-native'
import { SPACING } from '@kizunasync/ui'
import type { IKizunaSync } from '@kizunasync/core'
import { KizunaSyncProvider } from '@kizunasync/react'
import { recordEngineEvent } from '../src/engine-events'
import { CaptchaModal } from '../src/components/captcha-modal'
import { VerdictToasts } from '../src/components/verdict-toasts'
import { IS_PUBLIC_DEMO } from '../src/lib/public-demo'
import { MAX_FONT_SCALE } from '../src/layout-constants'
import { EThemeColor } from '../src/theme'
import { getBootNotice, getClient, isLiveSyncEnabled, isOfflineSimulated, setLiveSync as setLiveSyncShim, setOfflineSimulated, whenReady } from '../src/kizunasync-shim'

// MARK: - Session context

/**
 * The first-sync gate (`ready`) depends on the client-swap lifecycle this root
 * owns, so it lives here and flows down via context. Everything else (account
 * switcher, myId, message) stays the screen's local state, unchanged.
 */
interface ISession {
  ready: boolean
}

const SessionContext = createContext<ISession>({ ready: false })

export function useSession(): ISession {
  return useContext(SessionContext)
}

// MARK: - Settings context

/**
 * The Settings screen owns the toggles; the TODO screen reads them. `editAnyone`
 * (rendered as "Test non-owner edit") lifts the local guard on the registered
 * users' rows only, to exercise RLS reconciliation; it grants no server write
 * access. Every other row on the shared board is already writable. `live`
 * mirrors the shim's live-sync master switch (default ON) and `offline` mirrors
 * the shim's offlineSimulated flag; both setters write through so the shim and
 * the UI agree on one source of truth.
 */

/**
 * The board order the Cache tab's read-test buttons drive. `orderBy` is the sort
 * column (created_at), `ascending` its direction, and `mineFirst` floats the
 * current account's rows to the top (client-sorted). Default = created_at desc.
 */
export interface IBoardOrder {
  orderBy: 'created_at'
  ascending: boolean
  mineFirst: boolean
}

interface ISettings {
  editAnyone: boolean
  setEditAnyone: (value: boolean) => void
  live: boolean
  setLive: (value: boolean) => void
  offline: boolean
  setOffline: (value: boolean) => void
  boardOrder: IBoardOrder
  setBoardOrder: (value: IBoardOrder) => void
}

const DEFAULT_BOARD_ORDER: IBoardOrder = { orderBy: 'created_at', ascending: false, mineFirst: false }

const SettingsContext = createContext<ISettings>({
  editAnyone: false,
  setEditAnyone: () => {},
  live: true,
  setLive: () => {},
  offline: false,
  setOffline: () => {},
  boardOrder: DEFAULT_BOARD_ORDER,
  setBoardOrder: () => {},
})

export function useSettings(): ISettings {
  return useContext(SettingsContext)
}

// MARK: - Root

/**
 * The shim builds its client synchronously when the module loads, so
 * getClient() already returns it, or the booting placeholder when that boot
 * failed. whenReady resolves with the booted client on the next microtask.
 * Holding the client in state and keying the Provider on its identity
 * re-mounts the tree when that client differs from the first render's (a Fast
 * Refresh re-run), so the hooks re-subscribe to it.
 */
export default function RootLayout() {
  const [client, setClient] = useState<IKizunaSync>(getClient)
  const [ready, setReady] = useState(false)
  // Non-null once `whenReady()` resolves with the boot notice still set: the local database never came up (for example `ENGINE_UNAVAILABLE` in Expo Go), so the tree below never mounts. `boot()` in `kizunasync-shim.ts` never throws; it swaps in a booting placeholder and leaves the notice in place instead, which is what this reads.
  const [bootError, setBootError] = useState<string | null>(null)
  const [editAnyone, setEditAnyone] = useState(false)
  const [live, setLiveState] = useState<boolean>(isLiveSyncEnabled)
  const [offline, setOfflineState] = useState<boolean>(isOfflineSimulated)
  const [boardOrder, setBoardOrder] = useState<IBoardOrder>(DEFAULT_BOARD_ORDER)

  useEffect(() => {
    let active = true

    void whenReady().then((live) => {
      if (active) {
        setClient(() => live)
        const notice = getBootNotice()

        setReady(notice === null)
        setBootError(notice)
      }
    })

    return () => {
      active = false
    }
  }, [])

  // Every engine event, verdict or not, lands in the Cache tab's ring. The events are fire-and-forget, so this shell subscription is the only chance to record one; a screen mounted later would miss everything before it.
  useEffect(() => client.on(recordEngineEvent), [client])

  const setLive = (value: boolean): void => {
    setLiveSyncShim(value)
    setLiveState(value)
  }

  const setOffline = (value: boolean): void => {
    setOfflineSimulated(value)
    setOfflineState(value)
  }

  if (bootError !== null) {
    return (
      <GestureHandlerRootView style={styles.root}>
        <SafeAreaProvider>
          <View style={styles.bootErrorScreen}>
            <Text style={styles.bootErrorTitle}>Kizuna could not start</Text>
            <Text style={styles.bootErrorMessage}>{bootError}</Text>
          </View>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    )
  }

  // Provider stack, outermost first: gesture -> safe area -> heroui-native -> session -> settings -> kizunasync -> navigation GestureHandlerRootView is outermost because a gesture must be recognized before anything below can claim it; heroui's swipe-to-dismiss toast is the consumer. HeroUINativeProvider sits INSIDE the safe-area provider (it feeds insets to Uniwind through SafeAreaListener) and OUTSIDE navigation, so its toast portal survives every screen transition. KizunaSyncProvider is innermost of the app providers and keyed on client identity: when the booting placeholder swaps for the live client, the tree below remounts and the hooks re-subscribe.
  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <HeroUINativeProvider
          config={{
            textProps: { maxFontSizeMultiplier: MAX_FONT_SCALE },
            toast: { defaultProps: { placement: 'top' } },
          }}
        >
          <StatusBar style="light" />
          <SessionContext.Provider value={{ ready }}>
            <SettingsContext.Provider
              value={{ editAnyone, setEditAnyone, live, setLive, offline, setOffline, boardOrder, setBoardOrder }}
            >
              <KizunaSyncProvider key={clientKey(client)} client={client}>
                <VerdictToasts client={client} />
                {IS_PUBLIC_DEMO ? <CaptchaModal /> : null}
                <Stack screenOptions={{ headerShown: false }}>
                  <Stack.Screen name="(tabs)" />
                </Stack>
              </KizunaSyncProvider>
            </SettingsContext.Provider>
          </SessionContext.Provider>
        </HeroUINativeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  bootErrorScreen: {
    flex: 1,
    backgroundColor: EThemeColor.background,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING[6],
    gap: SPACING[2],
  },
  bootErrorTitle: { color: EThemeColor.text, fontSize: 17, fontWeight: '700', textAlign: 'center' },
  bootErrorMessage: { color: EThemeColor.muted, fontSize: 13, lineHeight: 19, textAlign: 'center', maxWidth: 320 },
})

let clientSeq = 0
const clientIds = new WeakMap<IKizunaSync, number>()

const clientKey = (client: IKizunaSync): number => {
  const existing = clientIds.get(client)

  if (existing !== undefined) {
    return existing
  }
  clientSeq += 1
  clientIds.set(client, clientSeq)

  return clientSeq
}
