import { useState } from 'react'
import { FlatList, StyleSheet } from 'react-native'
import { useKizunaSync, useMutation, useOverwrites, useRejections } from '@kizunasync/react'
import { SPACING } from '@kizunasync/ui'
import { EThemeColor } from '../../../src/theme'
import { SkeletonBoard } from '../../../src/components/skeleton'
import { BoardPlaceholder } from '../../../src/components/board-placeholder'
import { HomeHeader } from '../../../src/components/home/home-header'
import { HomeModals } from '../../../src/components/home/home-modals'
import { HomeTodoRow } from '../../../src/components/home/home-todo-row'
import { useAccountSwitch } from '../../../src/hooks/use-account-switch'
import { useBoardActions } from '../../../src/hooks/use-board-actions'
import { useBoardFilter } from '../../../src/hooks/use-board-filter'
import { usePendingWrites } from '../../../src/hooks/use-pending-writes'
import { useTodoComposer } from '../../../src/hooks/use-todo-composer'
import { useSession, useSettings } from '../../_layout'

/**
 * Normal todo CRUD goes through the kizunasync wrapper; the board's own state is
 * split across five hooks: `useAccountSwitch` (identity + the switch guard),
 * `useBoardFilter` (the ordered query + segment/search), `usePendingWrites`
 * (sync status + the manual sync/reset actions), `useBoardActions` (every
 * write the board issues), and `useTodoComposer` (add + edit). This screen
 * composes them and renders the three home regions: `HomeHeader`,
 * `HomeTodoRow` (per FlatList row), and `HomeModals` (@CONVENTIONS.md).
 */
// MARK: - TODO screen

export default function TodoScreen() {
  // MARK: - Variables
  const { ready } = useSession()
  const { editAnyone, offline, setOffline, boardOrder, setBoardOrder } = useSettings()
  const client = useKizunaSync()
  const { mutate } = useMutation()
  const { rejections, dismiss: dismissRejection } = useRejections()
  const { overwrites, dismiss: dismissOverwrite } = useOverwrites()

  const [rejectionsOpen, setRejectionsOpen] = useState(false)
  const [overwritesOpen, setOverwritesOpen] = useState(false)

  const pendingWrites = usePendingWrites()
  const accountSwitch = useAccountSwitch({
    ready,
    offline,
    outboxDepth: pendingWrites.syncStatus.outboxDepth,
    runSync: pendingWrites.runSync,
    onMessage: pendingWrites.setMessage,
  })
  const boardFilter = useBoardFilter({ boardOrder, myId: accountSwitch.myId })
  const boardActions = useBoardActions({
    todos: boardFilter.todos,
    myId: accountSwitch.myId,
    editAnyone,
    mutate,
    client,
    setBoardOrder,
  })
  const composer = useTodoComposer({ myId: accountSwitch.myId, mutate, client })

  // MARK: - Render

  if (!ready) {
    return <SkeletonBoard />
  }

  const showSkeleton = boardFilter.isLoading || accountSwitch.firstLoadPending

  // The screen lives in one centered, max-width column on web (the FlatList is the scroll container, so header + footer ride along instead of nesting a VirtualizedList inside a ScrollView). On native the column fills width.
  return (
    <>
      <FlatList
        data={boardFilter.visibleTodos}
        keyExtractor={(todo) => todo.id}
        style={styles.root}
        contentContainerStyle={styles.scroll}
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <HomeHeader
            pendingWrites={pendingWrites}
            accountSwitch={accountSwitch}
            boardFilter={boardFilter}
            boardActions={boardActions}
            composer={composer}
            offline={offline}
            onToggleOffline={() => setOffline(!offline)}
            rejectionsCount={rejections.length}
            onOpenRejections={() => setRejectionsOpen(true)}
            overwritesCount={overwrites.length}
            onOpenOverwrites={() => setOverwritesOpen(true)}
          />
        }
        renderItem={({ item }) => (
          <HomeTodoRow
            todo={item}
            myId={accountSwitch.myId}
            editAnyone={editAnyone}
            onToggle={boardActions.toggleTodo}
            onEdit={composer.setEditing}
            onDelete={boardActions.deleteTodo}
          />
        )}
        ListEmptyComponent={<BoardPlaceholder showSkeleton={showSkeleton} boardEmpty={boardFilter.todos.length === 0} />}
      />
      <HomeModals
        pendingSwitch={accountSwitch.pendingSwitch}
        onSyncNow={() => void accountSwitch.syncThenSwitch()}
        onSwitchAnyway={accountSwitch.switchAnyway}
        onCancelSwitch={accountSwitch.cancelSwitch}
        editing={composer.editing}
        onSaveEdit={(edit) => void composer.saveEdit(edit)}
        onCancelEdit={() => composer.setEditing(null)}
        rejectionsOpen={rejectionsOpen}
        rejections={rejections}
        onDismissRejection={(mutationId) => void dismissRejection(mutationId)}
        onCloseRejections={() => setRejectionsOpen(false)}
        overwritesOpen={overwritesOpen}
        overwrites={overwrites}
        onDismissOverwrite={(id) => void dismissOverwrite(id)}
        onCloseOverwrites={() => setOverwritesOpen(false)}
      />
    </>
  )
}

// MARK: - Styles

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: EThemeColor.background },
  scroll: { paddingBottom: SPACING[6] },
})
