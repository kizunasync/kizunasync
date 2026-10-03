import { useState, type ComponentType } from 'react'
import { Pressable, StyleSheet, Text, View, type ViewProps } from 'react-native'
import { RADIUS, SPACING, type TRowIconName } from '@kizunasync/ui'
import { isTodoArchived } from '@kizunasync/utilities'
import type { ITodo } from '../kizunasync-shim'
import { EThemeColor } from '../theme'
import { RowIcon } from './row-icon'
import { TodoThumb } from './todo-thumb'
import { t } from '../i18n'

/**
 * react-native's shipped types omit the web-only hover handlers
 * react-native-web implements on View; this local type and one cast restore
 * them instead of losing hover feedback on web.
 */
type TWebViewProps = ViewProps & { onMouseEnter?: () => void; onMouseLeave?: () => void }
const HoverView = View as ComponentType<TWebViewProps>

export function TodoRow({
  todo,
  mine,
  ownerLabel,
  editable,
  onToggle,
  onEdit,
  onArchive,
  onRestore,
  onDelete,
}: {
  todo: ITodo
  mine: boolean
  ownerLabel: string
  editable: boolean
  onToggle: () => void
  onEdit: () => void
  onArchive: () => void
  onRestore: () => void
  onDelete: () => void
}) {
  const done = todo.done
  const archived = isTodoArchived(todo)
  const [hovered, setHovered] = useState(false)

  // Any visitor may write another visitor's row on the RPC path; a registered user's rows are hers alone, so a non-owner toggle/delete on one is RLS-rejected. Those rows are read-only here until the `editAnyone` test control in Settings lifts the guard, so a non-owner write reaches the server, which returns RLS_DENIED with the current row as server_row; the engine reverts the optimistic edit instead of vanishing the row. The badge still tracks ownership (`mine`), independent of editability.
  return (
    <HoverView
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={rowContainerStyle({ hovered, editable, archived })}
    >
      <Pressable style={styles.rowMain} onPress={editable ? onToggle : undefined} disabled={!editable}>
        <Checkbox done={done} />
        <TodoThumb imagePath={todo.image_path} />
        <Text style={[styles.rowTitle, done && styles.rowTitleDone]} numberOfLines={1}>
          {todo.title}
        </Text>
        <View style={[styles.ownerBadge, mine && styles.ownerBadgeMine]}>
          <Text style={[styles.ownerBadgeText, mine && styles.ownerBadgeTextMine]}>{ownerLabel}</Text>
        </View>
        {archived ? (
          <View style={styles.ownerBadge}>
            <Text style={styles.ownerBadgeText}>{t('item.archived')}</Text>
          </View>
        ) : null}
      </Pressable>
      {editable ? (
        <View style={styles.rowActions}>
          <RowIconButton icon="edit" label="Edit" onPress={onEdit} />
          {archived ? (
            <RowIconButton icon="restore" label={t('item.restore')} onPress={onRestore} />
          ) : (
            <RowIconButton icon="archive" label={t('item.archive')} onPress={onArchive} />
          )}
          <RowIconButton icon="deleteForever" label={t('item.delete')} danger onPress={onDelete} />
        </View>
      ) : null}
    </HoverView>
  )
}

// MARK: - Pieces

function Checkbox({ done }: { done: boolean }) {
  return (
    <View style={[styles.checkbox, done && styles.checkboxChecked]}>
      {done ? <Text style={styles.checkMark}>✓</Text> : null}
    </View>
  )
}

function RowIconButton({
  icon,
  label,
  danger,
  onPress,
}: {
  icon: TRowIconName
  label: string
  danger?: boolean
  onPress: () => void
}) {
  const [hovered, setHovered] = useState(false)

  return (
    <Pressable
      accessibilityLabel={label}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={onPress}
      hitSlop={6}
      style={[styles.rowIconButton, hovered && (danger === true ? styles.rowIconButtonDanger : styles.rowIconButtonHover)]}
    >
      <RowIcon name={icon} size={18} color={hovered ? EThemeColor.accent : EThemeColor.muted} />
    </Pressable>
  )
}

// MARK: - internal

function rowContainerStyle({ hovered, editable, archived }: { hovered: boolean; editable: boolean; archived: boolean }) {
  return [styles.row, hovered && editable && styles.rowHover, archived && styles.rowArchived, !editable && styles.rowReadonly]
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
    backgroundColor: EThemeColor.surfaceElevated,
    borderWidth: 1,
    borderColor: EThemeColor.hairline,
    borderRadius: RADIUS.xl,
    padding: 13,
    gap: 10,
    marginBottom: SPACING[2],
  },
  rowHover: { borderColor: EThemeColor.border, transform: [{ translateY: -1 }] },
  rowArchived: { borderStyle: 'dashed', backgroundColor: EThemeColor.background, opacity: 0.7 },
  rowReadonly: { opacity: 0.62 },
  rowMain: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 11 },
  checkbox: {
    width: 21,
    height: 21,
    borderRadius: RADIUS.md,
    borderWidth: 1.5,
    borderColor: EThemeColor.border,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: { backgroundColor: EThemeColor.accent, borderColor: EThemeColor.accent },
  checkMark: { color: EThemeColor.accentForeground, fontSize: 13, fontWeight: '800', lineHeight: 15 },
  rowTitle: { color: EThemeColor.text, flex: 1, flexShrink: 1, minWidth: 0, fontSize: 14, lineHeight: 19 },
  rowTitleDone: { color: EThemeColor.muted, textDecorationLine: 'line-through' },
  ownerBadge: {
    borderWidth: 1,
    borderColor: EThemeColor.hairline,
    borderRadius: RADIUS.full,
    paddingHorizontal: SPACING[2],
    paddingVertical: 2,
    flexShrink: 0,
  },
  ownerBadgeMine: { borderColor: EThemeColor.accent, backgroundColor: EThemeColor.accentSoft },
  ownerBadgeText: { color: EThemeColor.muted, fontSize: 10, fontWeight: '700' },
  ownerBadgeTextMine: { color: EThemeColor.accent },
  rowActions: { flexDirection: 'row', gap: 6 },
  rowIconButton: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: EThemeColor.border,
    borderRadius: RADIUS.lg,
    borderCurve: 'continuous',
    backgroundColor: 'transparent',
  },
  rowIconButtonHover: { borderColor: EThemeColor.accent, backgroundColor: EThemeColor.accentSoft },
  rowIconButtonDanger: { borderColor: EThemeColor.accent, backgroundColor: EThemeColor.accentSoft },
})
