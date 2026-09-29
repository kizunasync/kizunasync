// MARK: - Tabs

/**
 * TODO / Cache / Settings, each with the glyph the Expo segment uses. The label
 * is fixed copy (the Expo nav is not localized); the active tab is reactive
 * state in App.vue.
 */
export type TTab = 'todo' | 'cache' | 'settings'

export interface ITabDef {
  key: TTab
  label: string
  glyph: string
}

export const TABS: ITabDef[] = [
  { key: 'todo', label: 'TODO', glyph: '✓' },
  { key: 'cache', label: 'Debug', glyph: '◉' },
  { key: 'settings', label: 'Settings', glyph: '⚙' },
]
