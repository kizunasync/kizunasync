import { StyleSheet, Text, View } from 'react-native'
import { Button } from 'heroui-native'
import { SPACING } from '@kizunasync/ui'
import type { IBoardOrder } from '../../app/_layout'
import { sharedStyles } from '../shared-styles'
import { MAX_FONT_SCALE } from '../layout-constants'
import { PRESS_FEEDBACK } from '../press-feedback'

// MARK: - Actions block

/**
 * The read actions run an actual ordered SELECT through the query API, log it,
 * and set the shared board-order state so the visible list re-sorts; the write actions
 * (delete/create/edit all) go through the same mutate path as add/toggle so they
 * queue, sync, reconcile, and show in the Cache tab. "mine first" client-sorts
 * the current account's rows ahead of the rest (the query API has no per-row
 * ordering). Predefined todos stamp created_at locally so they sort newest-first.
 */
export interface IReadAction {
  label: string
  order: IBoardOrder
}

const READ_ACTIONS: IReadAction[] = [
  { label: 'Fetch all', order: { orderBy: 'created_at', ascending: false, mineFirst: false } },
  { label: 'Sort created ASC', order: { orderBy: 'created_at', ascending: true, mineFirst: false } },
  { label: 'Sort created DESC', order: { orderBy: 'created_at', ascending: false, mineFirst: false } },
  { label: 'Sort mine first', order: { orderBy: 'created_at', ascending: false, mineFirst: true } },
]

const ACTIONS_TITLE = 'Actions'

export function ActionsBlock({
  onRead,
  onDeleteAll,
  onCreatePredefined,
  onEditAll,
}: {
  onRead: (action: IReadAction) => void
  onDeleteAll: () => void
  onCreatePredefined: () => void
  onEditAll: () => void
}) {
  return (
    <View style={sharedStyles.sectionBlock}>
      <Text style={sharedStyles.sectionTitle} maxFontSizeMultiplier={MAX_FONT_SCALE}>
        {ACTIONS_TITLE}
      </Text>
      <View style={styles.actionsRow}>
        {READ_ACTIONS.map((action) => (
          <ActionButton key={action.label} label={action.label} onPress={() => onRead(action)} />
        ))}
        <ActionButton label="Create predefined" onPress={onCreatePredefined} />
        <ActionButton label="Edit all" onPress={onEditAll} />
        <ActionButton label="Delete all" danger onPress={onDeleteAll} />
      </View>
    </View>
  )
}

// MARK: - Pieces

/**
 * heroui's Button takes the same label-plus-onPress contract as a plain
 * Pressable, drawn by the library instead of hand-rolled markup. The
 * destructive action takes the library's own danger variant rather than
 * recoloring a neutral button's text.
 */
function ActionButton({ label, danger, onPress }: { label: string; danger?: boolean; onPress: () => void }) {
  return (
    <Button
      variant={danger === true ? 'danger-soft' : 'outline'}
      size="sm"
      feedbackVariant={PRESS_FEEDBACK}
      onPress={onPress}
      accessibilityLabel={label}
    >
      <Button.Label>{label}</Button.Label>
    </Button>
  )
}

const styles = StyleSheet.create({
  actionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING[2] },
})
