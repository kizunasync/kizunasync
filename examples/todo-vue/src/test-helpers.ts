/**
 * Shared fixtures for the example round-trip test.
 *
 * makeUuid and makeTodosConfig come from `@kizunasync/utilities/testing`, shared
 * with the React example; only the server-side row shape below is local,
 * since it mirrors todo-vue's actual todos table (kizunasync.ts's TTodoRow) plus
 * the sync-protocol columns, including created_at.
 *
 * The suite runs on the Rust engine through the N-API addon, so build it first
 * with `bun run cargo:napi` from the repository root. A missing addon fails the
 * suite loudly, because `createKizunaSync` has no other engine to run.
 */

export { makeTodosConfig, makeUuid } from '@kizunasync/utilities/testing'

/**
 * Server-side row shape the test suite validates against: mirrors todo-vue's
 * actual todos table (kizunasync.ts's TTodoRow) plus the sync-protocol columns.
 */
export type TServerRow = {
  id: string
  user_id: string
  title: string
  done: boolean
  image_path: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}
