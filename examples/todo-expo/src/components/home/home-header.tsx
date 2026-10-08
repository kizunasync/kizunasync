import { StyleSheet, Text, View } from 'react-native'
import { SPACING } from '@kizunasync/ui'
import { IS_PUBLIC_DEMO } from '../../lib/public-demo'
import { EThemeColor } from '../../theme'
import { sharedStyles } from '../../shared-styles'
import { ActionsBlock } from '../actions-block'
import { AddRow } from '../add-row'
import { ResetBanner } from '../reset-banner'
import { TodoFilter } from '../todo-filter'
import { UsersSection } from './users-section'
import type { IAccountSwitch } from '../../hooks/use-account-switch'
import type { IBoardActions } from '../../hooks/use-board-actions'
import type { IBoardFilter } from '../../hooks/use-board-filter'
import type { IPendingWrites } from '../../hooks/use-pending-writes'
import type { ITodoComposer } from '../../hooks/use-todo-composer'

/**
 * The board's `ListHeaderComponent`: the reset banner, the Users region, the
 * Actions block, and the todo-compose region (title + AddRow + TodoFilter).
 * Takes the board hooks' own results rather than flattened primitives, so
 * `TodoScreen`'s composition stays within the file's shape target
 * (@CONVENTIONS.md).
 */
export function HomeHeader({
  pendingWrites,
  accountSwitch,
  boardFilter,
  boardActions,
  composer,
  isOfflineSimulated,
  onToggleOffline,
  rejectionsCount,
  onOpenRejections,
  overwritesCount,
  onOpenOverwrites,
}: {
  pendingWrites: IPendingWrites
  accountSwitch: IAccountSwitch
  boardFilter: IBoardFilter
  boardActions: IBoardActions
  composer: ITodoComposer
  isOfflineSimulated: boolean
  onToggleOffline: () => void
  rejectionsCount: number
  onOpenRejections: () => void
  overwritesCount: number
  onOpenOverwrites: () => void
}) {
  return (
    <View style={sharedStyles.column}>
      {pendingWrites.syncStatus.needsReset ? (
        <ResetBanner
          softBlockReason={pendingWrites.syncStatus.softBlockReason}
          outboxDepth={pendingWrites.pendingWrites}
          isResetting={pendingWrites.isResetting}
          onReset={() => void pendingWrites.rebuildLocalDatabase()}
        />
      ) : null}

      <UsersSection
        rejectionsCount={rejectionsCount}
        onOpenRejections={onOpenRejections}
        overwritesCount={overwritesCount}
        onOpenOverwrites={onOpenOverwrites}
        account={accountSwitch.account}
        isOnline={pendingWrites.syncStatus.isOnline}
        isOfflineSimulated={isOfflineSimulated}
        onRequestSwitch={accountSwitch.requestSwitch}
        outboxDepth={pendingWrites.pendingWrites}
        note={pendingWrites.note}
        lastSyncAt={pendingWrites.lastSyncAt}
        syncing={pendingWrites.syncing}
        onSync={() => void pendingWrites.runSync()}
        onToggleOffline={onToggleOffline}
      />

      <View style={styles.divider} />

      <ActionsBlock
        onRead={(action) => void boardActions.runReadAction(action)}
        onDeleteAll={boardActions.deleteAll}
        onCreatePredefined={boardActions.createPredefined}
        onEditAll={boardActions.editAll}
      />

      <View style={styles.divider} />

      <View style={[sharedStyles.sectionBlock, styles.todosBlock]}>
        <Text style={sharedStyles.sectionTitle}>Todos</Text>

        <AddRow
          title={composer.title}
          hasImage={composer.imageUri !== null}
          onChangeTitle={composer.setTitle}
          onPickImage={IS_PUBLIC_DEMO ? undefined : () => void composer.pickImage()}
          onSubmit={() => void composer.submit()}
        />

        <TodoFilter
          filter={boardFilter.filter}
          search={boardFilter.search}
          onChangeFilter={boardFilter.setFilter}
          onChangeSearch={boardFilter.setSearch}
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  todosBlock: { marginBottom: SPACING[2] },
  divider: { height: 1, backgroundColor: EThemeColor.hairline, marginVertical: SPACING[3] },
})
