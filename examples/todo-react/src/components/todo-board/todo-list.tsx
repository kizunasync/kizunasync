import { Input, TextField } from '@heroui/react'
import type { IKizunaSync } from '@kizunasync/core'
import { TODOS_TABLE, type TTodoStatusFilter } from '@kizunasync/utilities'
import { t } from '../../i18n'
import type { IKizunaSyncShim } from '../../kizunasync'
import { SegmentPill, SegmentPillGroup } from '../segment-pill-group'
import { SkeletonList } from '../skeleton'
import { TodoRow } from './todo-row'
import { STATUS_FILTER_LABELS, type ITodo } from './types'

// MARK: - Todo list

interface ILoggedMutateOptions {
  client: IKizunaSyncShim
  mutate: (fn: (kizunasync: IKizunaSync) => unknown) => Promise<void>
  op: 'UPDATE' | 'DELETE'
  label: string
  fn: (kizunasync: IKizunaSync) => unknown
}

/** toggleDone and deleteOne share this shape: mutate, then log the op with its elapsed time. */
function loggedMutate(options: ILoggedMutateOptions): void {
  const { client, mutate, op, label, fn } = options
  const startedAt = Date.now()

  void mutate(fn)
  client.queryLog.record({ op, label, rows: 1, ms: Date.now() - startedAt })
}

export interface ITodoListProps {
  client: IKizunaSyncShim
  mutate: (fn: (kizunasync: IKizunaSync) => unknown) => Promise<void>
  statusFilter: TTodoStatusFilter
  setStatusFilter: (value: TTodoStatusFilter) => void
  search: string
  setSearch: (value: string) => void
  queryLoading: boolean
  firstLoadPending: boolean
  todos: ITodo[]
  visibleTodos: ITodo[]
  myId: string | null
  editAnyone: boolean
  onEdit: (todo: ITodo) => void
}

/** The status/search filter row, then the skeleton, empty state, or the list. */
export function TodoList({
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
  onEdit,
}: ITodoListProps) {
  // The list is empty while the very first query is in flight, or once but not yet resolved on this account.
  const showSkeleton = todos.length === 0 && (queryLoading || firstLoadPending)

  function toggleDone(todo: ITodo): void {
    loggedMutate({
      client,
      mutate,
      op: 'UPDATE',
      label: 'todos · toggle done',
      fn: (k) => k.from(TODOS_TABLE).update({ done: !todo.done }).eq('id', todo.id),
    })
  }

  function deleteOne(todo: ITodo): void {
    loggedMutate({
      client,
      mutate,
      op: 'DELETE',
      label: 'todos · delete',
      fn: (k) => k.from(TODOS_TABLE).delete().eq('id', todo.id),
    })
  }

  return (
    <>
      <div className="filter-row">
        <SegmentPillGroup ariaLabel="Status filter">
          {(['all', 'active', 'done'] as const).map((filter) => (
            <SegmentPill key={filter} isActive={statusFilter === filter} onPress={() => setStatusFilter(filter)}>
              {STATUS_FILTER_LABELS[filter]}
            </SegmentPill>
          ))}
        </SegmentPillGroup>
        <TextField className="flex-1 min-w-0" fullWidth value={search} aria-label="Search todos" onChange={setSearch}>
          <Input placeholder="Search todos…" />
        </TextField>
      </div>

      {showSkeleton ? (
        <SkeletonList />
      ) : todos.length === 0 ? (
        <div className="empty">
          <span className="empty-glyph" aria-hidden="true">
            絆
          </span>
          <p className="empty-title">{t('empty.title')}</p>
          <p className="empty-hint">{t('empty.hint')}</p>
        </div>
      ) : visibleTodos.length === 0 ? (
        <p className="cache-empty">No todos match.</p>
      ) : (
        <ul className="list">
          {visibleTodos.map((todo) => (
            <TodoRow
              key={todo.id}
              todo={todo}
              myId={myId}
              editAnyone={editAnyone}
              onToggle={toggleDone}
              onEdit={onEdit}
              onDelete={deleteOne}
            />
          ))}
        </ul>
      )}
    </>
  )
}
