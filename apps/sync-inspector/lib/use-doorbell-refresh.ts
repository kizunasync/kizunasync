import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@supabase/supabase-js'

/**
 * The inspector is a `force-dynamic` server component holding a service-role
 * Supabase client: that key must NEVER reach the browser, so we can't query
 * from the client. Instead this hook re-runs the server render via
 * router.refresh(): Next streams fresh server-fetched data into the existing
 * tree (no full reload, no key exposure, client state preserved).
 *
 * Refresh is event-driven. The DB rings a contentless doorbell on every synced
 * row change: kizunasync.track_change and kizunasync.track_delete call
 * realtime.send on the private topic `kizunasync:<table>`, event `changed`, and on
 * every client registration, where kizunasync._register_client rings
 * `kizunasync:clients`. All three live in the pack's single migration,
 * 0001_kizuna_init.sql. We subscribe to both topics with a publishable-key
 * browser client and refresh on each hint. Receiving the private channels needs
 * an authenticated session, so we sign in anonymously first (config.toml
 * enables it). The publishable key is public and safe in the browser: the
 * service role stays server-side. A slow poll backstops missed doorbells; both
 * pause on a backgrounded tab.
 *
 * When signInAnonymously fails, live doorbell updates are unavailable and the
 * caller surfaces that state; the backstop poll still runs.
 */

/**
 * Local-dev default when no URL override is set.
 * Override via NEXT_PUBLIC_INSPECTOR_SUPABASE_URL (see the repo-root
 * `.env.example`). The publishable key has no default: it is per-stack, so a
 * missing NEXT_PUBLIC_INSPECTOR_SUPABASE_PUBLISHABLE_KEY fails loud rather
 * than authenticating with a key that does not match this stack.
 */
const LOCAL_SUPABASE_URL = 'http://127.0.0.1:55321'

const DOORBELL_CHANNELS = ['kizunasync:todos', 'kizunasync:clients'] as const

export type TDoorbellState = 'active' | 'paused' | 'auth-failed'

export interface IUseDoorbellRefreshResult {
  doorbellState: TDoorbellState
  toggle: () => void
}

/**
 * A missing publishable key fails loud rather than falling back to a key that
 * would not match the reader's stack. Read once at module scope through a typed
 * return so every closure below sees a narrowed `string`, not the raw
 * `string | undefined` env lookup: NEXT_PUBLIC_* vars are inlined at build
 * time, so this is a build-time fact, not a runtime race.
 */
function requirePublishableKey(): string {
  const key =
    process.env.NEXT_PUBLIC_INSPECTOR_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_INSPECTOR_SUPABASE_ANON_KEY

  if (key === undefined) {
    throw new Error(
      'NEXT_PUBLIC_INSPECTOR_SUPABASE_PUBLISHABLE_KEY is not set. Copy the repo-root .env.example to .env and paste the publishable key `bun run db:status` prints.',
    )
  }
  return key
}
const publishableKey = requirePublishableKey()

/** Owns the realtime doorbell subscription and its slow-poll backstop; `intervalMs` is the backstop's poll period. */
export function useDoorbellRefresh(intervalMs: number): IUseDoorbellRefreshResult {
  const router = useRouter()
  const [doorbellState, setDoorbellState] = useState<TDoorbellState>('active')

  const paused = doorbellState === 'paused'

  // MARK: - Realtime doorbell
  useEffect(() => {
    if (paused) {
      return
    }
    const url = process.env.NEXT_PUBLIC_INSPECTOR_SUPABASE_URL ?? LOCAL_SUPABASE_URL
    const supabase = createClient(url, publishableKey)

    const refresh = () => {
      if (document.visibilityState === 'visible') {
        router.refresh()
      }
    }

    const channels = DOORBELL_CHANNELS.map((name) =>
      supabase.channel(name, { config: { private: true } }),
    )

    // Private broadcast channels need the JWT on the realtime socket BEFORE they join: subscribing straight after sign-in races the auth and the doorbells silently never arrive. So set the realtime auth first, then subscribe, and refresh once on SUBSCRIBED to catch any change that landed during connect.
    void supabase.auth
      .signInAnonymously()
      .then(async ({ data, error }) => {
        if (error !== null) {
          setDoorbellState('auth-failed')

          return
        }
        const token = data.session?.access_token

        if (token !== undefined) {
          await supabase.realtime.setAuth(token)
        }
        for (const channel of channels) {
          channel.on('broadcast', { event: 'changed' }, refresh).subscribe((status) => {
            if (status === 'SUBSCRIBED') {
              refresh()
            }
          })
        }
      })
      .catch(() => {
        setDoorbellState('auth-failed')
      })

    return () => {
      for (const channel of channels) {
        void supabase.removeChannel(channel)
      }
    }
  }, [router, paused])

  // MARK: - Slow poll backstop
  useEffect(() => {
    if (paused) {
      return
    }
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        router.refresh()
      }
    }, intervalMs)

    return () => window.clearInterval(id)
  }, [router, intervalMs, paused])

  return {
    doorbellState,
    toggle: () => setDoorbellState((state) => (state === 'paused' ? 'active' : 'paused')),
  }
}
