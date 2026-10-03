/**
 * Shared fixtures for the example round-trip and wrapper-integration tests.
 *
 * makeUuid and makeTodosConfig come from `@kizunasync/utilities/testing`, shared
 * with the React and Vue examples; only the server-side row shape below is
 * local to this example's fake backend.
 *
 * The round-trip suite runs on the Rust engine through the N-API addon, so build
 * it first with `bun run cargo:napi` from the repository root. A missing addon
 * fails the suite loudly, because `createKizunaSync` has no other engine to run.
 */

export { makeTodosConfig, makeUuid } from '@kizunasync/utilities/testing'

/** Server-side row shape shared by both test suites. */
export type TServerRow = {
  id: string
  user_id: string
  title: string
  done: boolean
  image_path: string | null
  updated_at: string
  deleted_at: string | null
}
