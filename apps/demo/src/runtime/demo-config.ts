import { defineConfig, type TKizunaSyncConfig } from 'kizunasync'
import type { TTodoDatabase } from '@kizunasync/utilities'

// MARK: - Types

/**
 * The two panes are the demo's only identity axis: one label, one OPFS file,
 * one supabase-js client, one engine each.
 */
export type TPaneId = 'A' | 'B'

// MARK: - Constants

export const TODOS_TABLE = 'todos'

/**
 * Empty means no captcha widget: the local stack and the CI demo lane never set
 * this key. The public demo project refuses an anonymous sign-in without a
 * token, so that decision belongs to the server, never to this constant.
 */
export const TURNSTILE_SITE_KEY: string = import.meta.env.VITE_DEMO_TURNSTILE_SITE_KEY ?? ''

export const TURNSTILE_ACTION = 'demo-visitor-v1'

/** Google Tag Manager container. Empty loads no tags, which is the case for the local stack and the CI demo lane. */
export const GTM_ID: string = import.meta.env.VITE_DEMO_GTM_ID ?? ''

/**
 * One OPFS database per pane. Two engines sharing a file would be one device
 * with two windows.
 */
export const PANE_DB_FILES: Readonly<Record<TPaneId, string>> = {
  A: 'demo-pane-a.db',
  B: 'demo-pane-b.db',
}

/**
 * The pane that owns the visitor's session: it mints the anonymous user and is
 * the only client refreshing the token. The other pane adopts it: one visitor,
 * two devices (see lib/session.ts).
 */
export const SESSION_OWNER_PANE: TPaneId = 'A'

/**
 * The two scripted scenarios each contest one row, kept separate so neither
 * overwrites the other's evidence. The role NAMES live here; the pks do not:
 * each is derived per visitor from the signed-in uid (lib/scenario-row-id.ts),
 * which keeps the button repeatable for one visitor without ever putting two
 * visitors on the same pk.
 */
export const EScenarioRole = {
  conflict: 'conflict',
  softDelete: 'soft-delete',
} as const

export type TScenarioRole = (typeof EScenarioRole)[keyof typeof EScenarioRole]

export const CONFLICT_TITLE_PREFIX = 'Contested row:'

export const SOFT_DELETE_TITLE = 'Edited by A, archived by B: both survive'

/**
 * The row neither pane may write. Owned by the seeded REGISTERED demo user
 * mary@kizunasync.local: the fixture UPDATE policy is `using (user_id = auth.uid())`,
 * so no visitor may touch it, while the SELECT policy keeps a registered owner's
 * rows readable by everyone so the demo has a row the server will refuse.
 * Staged by a throwaway supabase-js client: the demo's own panes are the
 * identities that cannot create it.
 */
export const FOREIGN_ROW_ID = 'bbbbbbbb-0000-4000-8000-000000000002'

export const FOREIGN_ROW_TITLE = "Mary's row: you may read it, not write it"

/**
 * Local-dev fixture credentials seeded by packages/supabase-pack migration
 * 0002_example.sql. They exist on no other stack (@../../../CONVENTIONS.md).
 */
export const FOREIGN_OWNER = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'mary@kizunasync.local',
  password: 'kizunasync-demo',
} as const

// MARK: - Config

/**
 * No bucket, so a pull returns every row RLS permits: this visitor's todos plus
 * mary's. Both panes share one board without seeing everyone else.
 *
 * `0002_example.sql` provisions todos WITHOUT a bucket column, so an empty
 * bucket asks for every RLS-visible row and for its deletes. That is how
 * `FOREIGN_ROW_ID` arrives, so `lib/rls-probe.ts` can show the server refusing a
 * write the client already issued. `bucket: byOwner('user_id')` would hide that
 * row and the RLS scenario would write to nothing. A table provisioned WITH a
 * bucket column refuses an unscoped pull with `KZL01`.
 *
 * image_path stays undeclared: declaring it as an attachment() would demand the
 * fileStore + transfer ports for bytes this demo never writes.
 */
export const demoConfig: TKizunaSyncConfig = defineConfig<TTodoDatabase>({
  tables: {
    todos: {
      sync: 'read-write',
    },
  },
})
