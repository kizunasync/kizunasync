/**
 * Normal todo CRUD goes through the kizunasync wrapper (kizunasync.from('todos')); the
 * conflict lab deliberately makes one out-of-band Supabase update. useQuery
 * drives the list, useSyncStatus the bar, and useMutation the writes. This
 * screen reads editAnyone and offline from the shared settings context;
 * Settings owns the non-owner-edit and live-sync toggles. The account catalog
 * and the switch/recover flows live in lib/account.ts. State concerns split
 * into the hooks under ./todo-board/; each render region is its own
 * component there too.
 */

import { useState } from 'react'
import { useMutation, useQuery, useSyncStatus } from 'kizunasync/react'
import { TODOS_TABLE } from '@kizunasync/utilities'
import type { IKizunaSyncShim } from '../kizunasync'
import { useSettings } from './settings-context'
import { ResetBanner } from './reset-banner'
import { ConnectionBar } from './todo-board/connection-bar'
import { EditModalRegion } from './todo-board/edit-modal-region'
import { QuickActions } from './todo-board/quick-actions'
import { SwitchGuardRegion } from './todo-board/switch-guard-region'
import { TodosSection } from './todo-board/todos-section'
import { toTodo } from './todo-board/types'
import { useAccountSwitch } from './todo-board/use-account-switch'
import { useBoardActions } from './todo-board/use-board-actions'
import { useBoardFilter } from './todo-board/use-board-filter'
import { useEditTodo } from './todo-board/use-edit-todo'
import { useIdentityRecovery } from './todo-board/use-identity-recovery'
import { usePendingWrites } from './todo-board/use-pending-writes'
import { useStatusNote } from './todo-board/use-status-note'
import { useTodoComposer } from './todo-board/use-todo-composer'

// MARK: - TodoBoard

export function TodoBoard({ client }: { client: IKizunaSyncShim }) {
  // MARK: - Variables
  const { editAnyone, offline, setOffline, boardOrder, setBoardOrder } = useSettings()
  // useQuery only re-reads on engine events, so a board-order change needs deps to re-run.
  const { data, error: queryError, isLoading: queryLoading } = useQuery(
    (kizunasync) => kizunasync.from(TODOS_TABLE).select().order(boardOrder.orderBy, { ascending: boardOrder.ascending }),
    { deps: [boardOrder.orderBy, boardOrder.ascending] },
  )
  const { mutate, error: writeError } = useMutation()
  const { outboxDepth, isSyncing, isOnline, lastError, needsReset, softBlockReason, health, syncNow } = useSyncStatus()

  const [message, setMessage] = useState<string | null>(null)
  const [firstLoadPending, setFirstLoadPending] = useState(true)

  const { account, myId, pendingSwitch, requestSwitch, confirmSyncThenSwitch, confirmSwitchAnyway, cancelSwitch } =
    useAccountSwitch({
      client,
      syncNow,
      isOnline,
      outboxDepth,
      onMessage: setMessage,
      onFirstLoadPending: setFirstLoadPending,
    })

  useIdentityRecovery({ client, syncNow, onMessage: setMessage })
  const pendingWrites = usePendingWrites(client, outboxDepth)
  const rows = data.map(toTodo)
  const { statusFilter, setStatusFilter, search, setSearch, todos, visibleTodos } = useBoardFilter({
    rows,
    boardOrder,
    myId,
  })
  const { runReadAction, deleteAll, createPredefined, editAll, rebuildLocalDatabase, isResetting } = useBoardActions({
    client,
    mutate,
    todos,
    myId,
    editAnyone,
    syncNow,
    setBoardOrder,
    onMessage: setMessage,
  })
  const { title, setTitle, addImageUri, setAddImageUri, submit } = useTodoComposer({ client, myId, mutate })
  const { editing, requestEdit, cancelEdit, saveEdit } = useEditTodo({ client, mutate, onMessage: setMessage })
  const note = useStatusNote({ message, queryError, writeError, lastError })

  // MARK: - render

  return (
    <div className="column">
      <ResetBanner
        needsReset={needsReset}
        softBlockReason={softBlockReason}
        outboxDepth={pendingWrites}
        isResetting={isResetting}
        onReset={() => void rebuildLocalDatabase()}
      />

      <ConnectionBar
        account={account}
        isOnline={isOnline}
        requestSwitch={requestSwitch}
        offline={offline}
        setOffline={setOffline}
        pendingWrites={pendingWrites}
        health={health}
        note={note}
        isSyncing={isSyncing}
        syncNow={syncNow}
      />

      <hr className="home-rule" />

      <QuickActions
        runReadAction={runReadAction}
        createPredefined={createPredefined}
        editAll={editAll}
        deleteAll={deleteAll}
      />

      <hr className="home-rule" />

      <TodosSection
        composer={{ title, setTitle, addImageUri, setAddImageUri, onSubmit: submit }}
        list={{
          client,
          mutate,
          statusFilter,
          setStatusFilter,
          search,
          setSearch,
          queryLoading,
          firstLoadPending,
          todos,
          visibleTodos,
          myId,
          editAnyone,
          onEdit: requestEdit,
        }}
      />

      <SwitchGuardRegion
        isPending={pendingSwitch !== null}
        isSyncing={isSyncing}
        onSyncThenSwitch={() => void confirmSyncThenSwitch()}
        onSwitchAnyway={confirmSwitchAnyway}
        onCancel={cancelSwitch}
      />

      <EditModalRegion editing={editing} onSave={saveEdit} onCancel={cancelEdit} />
    </div>
  )
}
