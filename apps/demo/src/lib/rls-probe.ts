import { EWireEntryKind } from 'kizunasync'
import { FOREIGN_OWNER, FOREIGN_ROW_ID, FOREIGN_ROW_TITLE, TODOS_TABLE } from '@/runtime/demo-config'
import type { IPaneClient } from '@/runtime/kizunasync'
import { createPlainSupabaseClient } from '@/runtime/supabase-client'
import type { IWireLog } from '@/runtime/wire-log'

// MARK: - The RLS refusal demo

/**
 * The local fixture's UPDATE policy on public.todos is
 *
 *   using (user_id = (select auth.uid()))
 *
 * so a row is writable by its owner and by nobody else. The panes carry the
 * visitor's anonymous uid, and the row below is owned by the seeded user
 * mary@kizunasync.local: the write leaves the client optimistically, the server
 * refuses it, and the engine reverts the local row and journals the rejection.
 * The SELECT policy still admits a REGISTERED owner's rows, so the panes can see
 * the row they are being refused.
 *
 * Neither pane can create that row: they are exactly the identities forbidden
 * from owning it, so it is staged once by a throwaway client signed in as Mary.
 * That client is deliberately NOT wire-tapped: the setup is scaffolding, and
 * putting it on the wire would suggest a pane did it.
 */
const STAGING_STORAGE_SUFFIX = 'foreign-owner'

/**
 * Writes the un-writable row on a fixed pk only when it is missing or its title
 * drifted, so re-running the demo re-uses it. A blind re-upsert would not be
 * free: `public.todos` stamps `updated_at` from a BEFORE UPDATE trigger, so a
 * same-value write still changes the row, and every visit would hand every
 * client a changelog row and a pull for a row nobody edited.
 */
export async function stageForeignRow(wireLog: IWireLog): Promise<void> {
  const staging = createPlainSupabaseClient(STAGING_STORAGE_SUFFIX)

  try {
    const { error: signInError } = await staging.auth.signInWithPassword({
      email: FOREIGN_OWNER.email,
      password: FOREIGN_OWNER.password,
    })

    if (signInError !== null) {
      throw new Error(signInError.message)
    }
    const { data, error: readError } = await staging
      .from(TODOS_TABLE)
      .select('title')
      .eq('id', FOREIGN_ROW_ID)
      .maybeSingle()

    if (readError !== null) {
      throw new Error(readError.message)
    }
    const existing: { title?: unknown } | null = data

    if (existing === null || existing.title !== FOREIGN_ROW_TITLE) {
      const { error: upsertError } = await staging.from(TODOS_TABLE).upsert({
        id: FOREIGN_ROW_ID,
        user_id: FOREIGN_OWNER.id,
        title: FOREIGN_ROW_TITLE,
        done: false,
      })

      if (upsertError !== null) {
        throw new Error(upsertError.message)
      }
    }
    wireLog.record('A', {
      kind: EWireEntryKind.note,
      text: `staged ${FOREIGN_OWNER.email}'s row. readable by both panes, writable by neither`,
    })
  } catch {
    // Hosted demo applies 0001_public_demo_hardening.sql, which nulls Mary's password. The seed row is already in public.todos; boot must not throw.
    wireLog.record('A', {
      kind: EWireEntryKind.note,
      text: "could not stage mary's row: expected on the public demo, where sign-in as the seed owner is disabled",
    })
  } finally {
    await staging.auth.signOut({ scope: 'local' }).catch(() => null)
  }
}

/**
 * Attempt the forbidden write from one pane and sync it, so the viewer shows the
 * full round trip: the optimistic local change, the push, the server's
 * RLS_DENIED verdict, and the engine's revert. Resolves once the round trip is
 * complete; the rejection itself surfaces through the wire log and
 * useRejections, not through this promise: a refused write is the expected
 * outcome here, not an error.
 */
export async function attemptForeignWrite(pane: IPaneClient, wireLog: IWireLog): Promise<void> {
  wireLog.record(pane.pane, {
    kind: EWireEntryKind.note,
    text: `pane ${pane.pane} is trying to rename a row it does not own`,
  })
  await pane
    .from(TODOS_TABLE)
    .update({ title: `Pane ${pane.pane} tried to rename this` })
    .eq('id', FOREIGN_ROW_ID)
  await pane.sync()
}
