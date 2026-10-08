import type { Session } from '@supabase/supabase-js'
import { EWireEntryKind } from 'kizunasync'
import { recoverAnonymousSession, type IRecoverAnonymousSessionOptions } from 'kizunasync/supabase'
import { messageOf } from '@kizunasync/utilities'
import type { IPaneClient } from '@/runtime/kizunasync'
import type { IWireLog } from '@/runtime/wire-log'

// MARK: - One visitor, one anonymous user, two devices

/**
 * Every policy on public.todos in the local fixture is `to authenticated`: the
 * anon role has no policy at all. Every visitor reads every row, an
 * anonymous-owned row is writable by any visitor, and a registered user's rows
 * are writable only by their owner. A pane needs a session, and BOTH panes must
 * carry the SAME one: they are two DEVICES of one visitor (two client_ids, two
 * OPFS databases), not two visitors. Anonymous sign-in gives that visitor a
 * throwaway identity with no accounts UI, and `0002_example.sql` makes it
 * temporary: a visitor's rows are reaped with its user once it has been idle
 * for a day.
 *
 * A persisted session is reused. A reload that minted a fresh uid would
 * orphan whatever a pane still has queued in its outbox, and those writes
 * would then be refused by the insert policy. On the public project, the
 * first sign-in of a visitor carries a Turnstile token; a persisted session
 * never re-prompts.
 */
export async function signInPane(pane: IPaneClient, options: IRecoverAnonymousSessionOptions = {}): Promise<string> {
  const recovered = await recoverAnonymousSession(pane.supabase.auth, options)
  const id = recovered?.id ?? null

  if (id === null) {
    throw new Error('anonymous sign-in returned no user')
  }
  pane.setOwnerId(id)

  return id
}

// MARK: - The follower pane adopts the owner pane's session

interface IFollowPaneSessionParams {
  owner: IPaneClient
  follower: IPaneClient
  wireLog: IWireLog
}

/**
 * Hand the owner pane's tokens to the follower, then keep handing them over on
 * every refresh. The follower's client has autoRefreshToken off (see
 * supabase-client.ts): only one of the two may rotate the shared refresh token,
 * or the loser ends up holding a revoked one. The owner signing out ends the
 * follow: the follower drops the session too and stops listening.
 */
export async function followPaneSession(params: IFollowPaneSessionParams): Promise<void> {
  const { owner, follower, wireLog } = params
  const { data, error } = await owner.supabase.auth.getSession()

  if (error !== null) {
    throw new Error(error.message)
  }
  const session = data.session

  if (session === null) {
    throw new Error(`pane ${owner.pane} has no session for pane ${follower.pane} to follow`)
  }
  const adoptError = await adoptSession(follower, session)

  if (adoptError !== null) {
    throw new Error(adoptError)
  }

  const { data: following } = owner.supabase.auth.onAuthStateChange((event, next) => {
    if (event === 'SIGNED_OUT') {
      following.subscription.unsubscribe()
      void dropSession(params)

      return
    }
    if (next === null) {
      return
    }
    void adoptSession(follower, next).then((failure) => {
      if (failure !== null) {
        wireLog.record(follower.pane, {
          kind: EWireEntryKind.note,
          text: `pane ${follower.pane} could not adopt the refreshed session. its writes will be refused (${failure})`,
        })

        return
      }
      void follower.sync().catch((cause: unknown) => {
        wireLog.record(follower.pane, {
          kind: EWireEntryKind.note,
          text: `pane ${follower.pane} could not sync after the session refresh (${messageOf(cause)})`,
        })
      })
    })
  })
}

// MARK: - internal

/**
 * The owner signed out, so the follower forgets the session it adopted. Local
 * scope discards only this pane's copy: the owner's sign-out decides what
 * happens to the session on the server. A failure is reported like a failed
 * adoption, since the pane keeps sending a token its owner no longer holds.
 */
async function dropSession(params: IFollowPaneSessionParams): Promise<void> {
  const { owner, follower, wireLog } = params

  follower.setOwnerId(null)
  const { error } = await follower.supabase.auth.signOut({ scope: 'local' })

  wireLog.record(follower.pane, {
    kind: EWireEntryKind.note,
    text:
      error === null
        ? `pane ${owner.pane} signed out, so pane ${follower.pane} dropped the session it followed`
        : `pane ${follower.pane} could not drop the session pane ${owner.pane} signed out of (${error.message})`,
  })
}

/**
 * Returns null on success, or the failure message. A refreshed token that never
 * reaches the follower silently 401s every later request, so the caller reports
 * it rather than dropping it.
 */
async function adoptSession(follower: IPaneClient, session: Session): Promise<string | null> {
  const { error } = await follower.supabase.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  })

  if (error !== null) {
    return error.message
  }
  follower.setOwnerId(session.user.id)

  return null
}
