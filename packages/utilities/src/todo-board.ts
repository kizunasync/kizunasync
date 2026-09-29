/**
 * The todo board's pure predicates, shared by the three example apps: who owns a
 * row, who may edit it, which rows the status filter and search box keep, and the
 * "mine first" post-sort.
 *
 * All of it runs over rows already loaded by the query. None of it issues a
 * second read, so it composes with whatever order the board asked the engine for.
 */

import { REGISTERED_UIDS } from './demo-accounts'

// MARK: - Title

/**
 * Title length shared by the add form and the edit modal's title input across
 * every example.
 */
export const TITLE_MAX_LENGTH = 50

// MARK: - Row shapes

/** The ownership field every predicate here reads. */
export interface ITodoOwned {
  readonly user_id: string
}

/**
 * The fields the filter reads. The engine always returns `done` as a boolean;
 * the `number` alternative exists only for a caller that re-encodes a raw
 * SQLite `0`/`1` before calling in, so it is narrowed here instead of at each
 * call site.
 */
export interface ITodoFilterable extends ITodoOwned {
  readonly title: string
  readonly done: boolean | number
}

export type TTodoStatusFilter = 'all' | 'active' | 'done'

export interface ITodoFilter {
  status: TTodoStatusFilter
  search: string
}

// MARK: - Ownership

/**
 * Every example stamps `user_id` on insert, because the fixture's INSERT
 * policy requires it. An empty owner still reads as mine, not as someone
 * else's row the UI must lock, so a row that reaches this predicate unstamped
 * degrades gracefully instead of locking the user out of their own new row.
 */
export function isTodoMine(todo: ITodoOwned, myId: string | null): boolean {
  return todo.user_id === '' || todo.user_id === myId
}

/**
 * The board is shared: any visitor's row is editable by any visitor, and a
 * registered user's row only by that user. The `editAnyone` test flag lifts the
 * local guard on a registered user's row without granting server access: the
 * server returns RLS_DENIED and the engine reverts the optimistic edit.
 */
export function isTodoEditable(
  todo: ITodoOwned,
  { myId, editAnyone }: { myId: string | null; editAnyone: boolean },
): boolean {
  return isTodoMine(todo, myId) || !REGISTERED_UIDS.has(todo.user_id) || editAnyone
}

// MARK: - Filtering and ordering

function isTodoDone(todo: Pick<ITodoFilterable, 'done'>): boolean {
  return todo.done === true || todo.done === 1
}

/** The status segment and the case-insensitive title search, combined. */
export function matchesTodoFilter(todo: ITodoFilterable, { status, search }: ITodoFilter): boolean {
  const done = isTodoDone(todo)

  if (status === 'active' && done) {
    return false
  }
  if (status === 'done' && !done) {
    return false
  }
  const needle = search.trim().toLowerCase()

  return needle.length === 0 || todo.title.toLowerCase().includes(needle)
}

/**
 * Float the current account's rows ahead of the rest without disturbing the
 * order within either group, so the board's created_at ordering survives. A
 * signed-out visitor has nothing to float, so the list passes through.
 */
export function sortTodosMineFirst<TTodo extends ITodoOwned>(
  todos: readonly TTodo[],
  myId: string | null,
): TTodo[] {
  if (myId === null) {
    return [...todos]
  }
  return [...todos].sort((left, right) => Number(isTodoMine(right, myId)) - Number(isTodoMine(left, myId)))
}

// MARK: - Predefined todos

/**
 * The fixed set the board's "Create predefined" action inserts in one tap,
 * shared by every example so the demo data reads the same everywhere.
 */
export const PREDEFINED_TODO_TITLES = ['Buy milk', 'Walk the dog', '絆 Read the Kizuna docs', 'Ship the demo']

/**
 * Stamps each predefined title with a descending offset from `baseMs`, so the
 * whole set sorts newest-first immediately, matching the add flow's local
 * created_at stamp.
 */
export function predefinedTodoStamps(baseMs: number): { title: string; createdAt: string }[] {
  return PREDEFINED_TODO_TITLES.map((title, index) => ({
    title,
    createdAt: new Date(baseMs - index).toISOString(),
  }))
}

// MARK: - Edit all

/** Appended to every editable title by the board's "Edit all" bulk action. */
export const EDIT_ALL_SUFFIX = ' ❤️'

/**
 * Shortens `title` so the suffixed result never exceeds `TITLE_MAX_LENGTH`
 * code points. Counts with `Array.from` rather than `.length`, so a
 * multi-code-point character (an emoji, a combining mark) is never split.
 */
export function withEditAllSuffix(title: string): string {
  const suffixLength = Array.from(EDIT_ALL_SUFFIX).length
  const maxTitleLength = Math.max(0, TITLE_MAX_LENGTH - suffixLength)
  const clippedTitle = Array.from(title).slice(0, maxTitleLength).join('')

  return `${clippedTitle}${EDIT_ALL_SUFFIX}`
}
