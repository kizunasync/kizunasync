/// <reference types="bun" />
/**
 * The follower pane mirrors the owner pane's session: every session the owner
 * publishes is adopted, and the owner signing out ends the follow. Fake panes
 * stand in for the two clients; only their auth surface, owner id, and sync
 * are under test.
 */

import { describe, expect, test } from 'bun:test'
import type { AuthChangeEvent, Session } from '@supabase/supabase-js'
import { EWireEntryKind } from 'kizunasync'
import { followPaneSession } from './session'
import { createWireLog } from '../runtime/wire-log'
import type { IPaneClient } from '../runtime/kizunasync'

const sessionFor = (userId: string, token: string): Session =>
  ({ access_token: token, refresh_token: `refresh-${token}`, user: { id: userId } }) as unknown as Session

type TAuthListener = (event: AuthChangeEvent, session: Session | null) => void

const makeOwner = (initial: Session) => {
  const listeners = new Set<TAuthListener>()
  let unsubscribed = 0
  const owner = {
    pane: 'A',
    supabase: {
      auth: {
        getSession: () => Promise.resolve({ data: { session: initial }, error: null }),
        onAuthStateChange: (listener: TAuthListener) => {
          listeners.add(listener)

          return {
            data: {
              subscription: {
                unsubscribe: () => {
                  unsubscribed += 1
                  listeners.delete(listener)
                },
              },
            },
          }
        },
      },
    },
  } as unknown as IPaneClient

  return {
    owner,
    emit: (event: AuthChangeEvent, session: Session | null) => {
      for (const listener of [...listeners]) {
        listener(event, session)
      }
    },
    unsubscribed: () => unsubscribed,
  }
}

const makeFollower = (signOutError: string | null = null) => {
  const adopted: string[] = []
  const ownerIds: Array<string | null> = []
  const signOuts: unknown[] = []
  const follower = {
    pane: 'B',
    supabase: {
      auth: {
        setSession: (tokens: { access_token: string }) => {
          adopted.push(tokens.access_token)

          return Promise.resolve({ error: null })
        },
        signOut: (options: unknown) => {
          signOuts.push(options)

          return Promise.resolve({ error: signOutError === null ? null : { message: signOutError } })
        },
      },
    },
    setOwnerId: (id: string | null) => {
      ownerIds.push(id)
    },
    sync: () => Promise.resolve(),
  } as unknown as IPaneClient

  return { follower, adopted, ownerIds, signOuts }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('followPaneSession', () => {
  test('the follower adopts the owner session and every session the owner publishes', async () => {
    const { owner, emit } = makeOwner(sessionFor('visitor', 'token-1'))
    const { follower, adopted, ownerIds } = makeFollower()
    const wireLog = createWireLog()

    await followPaneSession({ owner, follower, wireLog })
    emit('TOKEN_REFRESHED', sessionFor('visitor', 'token-2'))
    await settle()
    expect(adopted).toEqual(['token-1', 'token-2'])
    expect(ownerIds).toEqual(['visitor', 'visitor'])
  })

  test('the owner signing out signs the follower out locally, clears its owner id, and stops following', async () => {
    const { owner, emit, unsubscribed } = makeOwner(sessionFor('visitor', 'token-1'))
    const { follower, adopted, ownerIds, signOuts } = makeFollower()
    const wireLog = createWireLog()

    await followPaneSession({ owner, follower, wireLog })
    emit('SIGNED_OUT', null)
    await settle()
    expect(signOuts).toEqual([{ scope: 'local' }])
    expect(ownerIds.at(-1)).toBeNull()
    expect(unsubscribed()).toBe(1)
    expect(wireLog.entries().map((entry) => entry.pane)).toEqual(['B'])

    emit('SIGNED_IN', sessionFor('someone-else', 'token-9'))
    await settle()
    expect(adopted).toEqual(['token-1'])
  })

  test('a follower that cannot drop the session reports it on the wire', async () => {
    const { owner, emit } = makeOwner(sessionFor('visitor', 'token-1'))
    const { follower } = makeFollower('storage is locked')
    const wireLog = createWireLog()

    await followPaneSession({ owner, follower, wireLog })
    emit('SIGNED_OUT', null)
    await settle()
    const notes = wireLog.entries().flatMap((entry) => (entry.kind === EWireEntryKind.note ? [entry.text] : []))

    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('storage is locked')
  })
})
