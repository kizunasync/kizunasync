import { createContext, useContext, type ReactNode } from 'react'

// MARK: - Settings context

/**
 * The TODO board and the Settings view share three flags: `editAnyone` (rendered
 * as "Test non-owner edit", which lifts the read-only guard on the registered
 * users' rows only), "Live sync" (the realtime master switch), and the lab's
 * simulated "offline". The toggles live in Settings; the board reads them
 * (the row-edit guard, the offline-blocked account switch, the SyncBar dot).
 * The Cache tab's read-test buttons also drive the board's visible order through
 * here so a "Sort created ASC/DESC/mine first" tap re-sorts the TODO list.
 */

/**
 * The board's current sort, written by the Cache read-test buttons and read by
 * the board. mineFirst is a client-side post-sort layering the current account's
 * rows on top of the created_at order.
 */
export interface IBoardOrder {
  orderBy: 'created_at'
  ascending: boolean
  mineFirst: boolean
}

export interface ISettings {
  editAnyone: boolean
  setEditAnyone: (value: boolean) => void
  live: boolean
  setLive: (value: boolean) => void
  offline: boolean
  setOffline: (value: boolean) => void
  boardOrder: IBoardOrder
  setBoardOrder: (value: IBoardOrder) => void
}

const SettingsContext = createContext<ISettings | null>(null)

export function SettingsProvider({
  value,
  children,
}: {
  value: ISettings
  children: ReactNode
}): ReactNode {
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

export function useSettings(): ISettings {
  const settings = useContext(SettingsContext)

  if (settings === null) {
    throw new Error('useSettings: wrap the tree in <SettingsProvider>')
  }
  return settings
}
