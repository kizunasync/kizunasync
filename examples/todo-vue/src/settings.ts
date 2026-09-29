import { reactive } from 'vue'

// MARK: - Shared settings

/**
 * TODO and Settings share three flags. Expo threads them through a React
 * context; Vue's equivalent is one module-scope reactive object both views
 * import. `live` (default on) is the realtime master switch, `editAnyone`
 * (default off) lifts the read-only guard on the registered users' rows,
 * `offline` (default off) is the Network section's simulated airplane mode.
 */
export interface ISettings {
  live: boolean
  editAnyone: boolean
  offline: boolean
}

export const settings = reactive<ISettings>({
  live: true,
  editAnyone: false,
  offline: false,
})

// MARK: - Board order

/**
 * The read-test buttons in the Cache tab issue real reads and set this shared
 * order so the TODO board visibly re-sorts. `mineFirst` is a client-side pass
 * applied after the column sort (the current account's rows float to the top).
 * Default = newest created first.
 */
export interface IBoardOrder {
  orderBy: 'created_at'
  ascending: boolean
  mineFirst: boolean
}

export const boardOrder = reactive<IBoardOrder>({
  orderBy: 'created_at',
  ascending: false,
  mineFirst: false,
})
