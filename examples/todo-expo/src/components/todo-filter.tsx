import { useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import { SPACING } from '@kizunasync/ui'
import { matchesTodoFilter } from '@kizunasync/utilities'
import type { ITodo } from '../kizunasync-shim'
import { EThemeColor } from '../theme'
import { sharedStyles } from '../shared-styles'
import { SegmentPill } from './segment-pill'

/**
 * Purely client-side narrowing over the rows already loaded by the query, no
 * second read, so the Actions block's sort still applies after filtering. The
 * segment filters on the done flag, the search on a case-insensitive title
 * substring, and the two combine.
 */
export const ETodoFilter = {
  all: 'all',
  active: 'active',
  done: 'done',
} as const

export type TTodoFilter = (typeof ETodoFilter)[keyof typeof ETodoFilter]

interface IFilterOption {
  value: TTodoFilter
  label: string
}

const FILTER_OPTIONS: IFilterOption[] = [
  { value: ETodoFilter.all, label: 'All' },
  { value: ETodoFilter.active, label: 'Active' },
  { value: ETodoFilter.done, label: 'Done' },
]

export function filterTodos(todos: ITodo[], { filter, search }: { filter: TTodoFilter; search: string }): ITodo[] {
  return todos.filter((todo) => matchesTodoFilter(todo, { status: filter, search }))
}

export function TodoFilter({
  filter,
  search,
  onChangeFilter,
  onChangeSearch,
}: {
  filter: TTodoFilter
  search: string
  onChangeFilter: (value: TTodoFilter) => void
  onChangeSearch: (value: string) => void
}) {
  const [focused, setFocused] = useState(false)

  return (
    <View style={styles.filterBlock}>
      <View style={styles.segment}>
        {FILTER_OPTIONS.map((option) => (
          <SegmentPill
            key={option.value}
            label={option.label}
            active={filter === option.value}
            onPress={() => onChangeFilter(option.value)}
          />
        ))}
      </View>
      <TextInput
        style={[sharedStyles.input, styles.searchInput, focused && sharedStyles.inputFocused]}
        accessibilityLabel="Search todos"
        placeholder="Search todos…"
        placeholderTextColor={EThemeColor.faint}
        value={search}
        onChangeText={onChangeSearch}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        autoCapitalize="none"
        autoCorrect={false}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  filterBlock: { gap: SPACING[2] },
  segment: { flexDirection: 'row', gap: SPACING[1] },
  searchInput: { paddingVertical: 10 },
})
