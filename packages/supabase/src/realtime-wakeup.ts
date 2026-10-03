import { noopLogger, type ILogger, type IWakeup } from '@kizunasync/core'
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'

/**
 * Options for {@link createRealtimeWakeup}.
 *
 * `tables` are the synced tables to listen on; each gets its own channel.
 * `topicPrefix` namespaces the channel (default 'kizunasync') and MUST match the
 * `kizunasync:` prefix the DB triggers broadcast on (0001_kizuna_init.sql). `private`
 * gates the channel behind the realtime.messages RLS policy (default true).
 */
export interface IRealtimeWakeupOptions {
  tables: readonly string[]
  topicPrefix?: string
  private?: boolean

  /** Diagnostics sink for channel lifecycle transitions. Absent ⇒ silent. */
  logger?: ILogger

  /**
   * Injectable timer pair (testability); defaults to the platform timers. The
   * handle is opaque: it is only ever round-tripped to clearTimer.
   */
  setTimer?: (callback: () => void, delayMs: number) => unknown

  clearTimer?: (handle: unknown) => void
}

// MARK: - Reconnect tuning

/**
 * First re-subscribe delay after a channel drops; doubles per consecutive
 * failure up to RECONNECT_MAX_MS.
 */
const RECONNECT_BASE_MS = 1_000

/**
 * Ceiling for the re-subscribe backoff, so a channel that keeps failing (an
 * RLS policy the signed-in user no longer satisfies) retries forever at a
 * bounded rate instead of either giving up or hammering.
 */
const RECONNECT_MAX_MS = 30_000

/**
 * The subscribe statuses that mean this channel is delivering nothing and will
 * not recover on its own. `CLOSED` is included: a server-side close after a
 * token expiry leaves the channel parked, not rejoining.
 */
const DEAD_STATUSES: ReadonlySet<string> = new Set(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'])

// MARK: - Doorbell

/** The adapter's options with their defaults resolved. The injected timers are always called bare. */
interface IDoorbellConfig {
  readonly client: SupabaseClient
  readonly options: IRealtimeWakeupOptions
  readonly prefix: string
  readonly isPrivate: boolean
  readonly logger: ILogger
  readonly setTimer: NonNullable<IRealtimeWakeupOptions['setTimer']>
  readonly clearTimer: NonNullable<IRealtimeWakeupOptions['clearTimer']>
}

/** One `subscribe` call's channels and retry bookkeeping, shared by the functions below. */
interface IDoorbellSubscription {
  readonly config: IDoorbellConfig
  readonly onSignal: () => void
  disposed: boolean
  readonly channels: Map<string, RealtimeChannel>
  readonly retryTimers: Map<string, unknown>
  readonly failures: Map<string, number>
  authSubscription?: { unsubscribe: () => void }
}

/**
 * The Supabase Realtime DOORBELL adapter: a contentless wake signal, not a
 * data channel. Each table opens a broadcast channel `${prefix}:${table}`; the
 * DB's track_change/track_delete triggers fire a 'changed' broadcast on it.
 * DROP the payload entirely: the only allowed effect is calling onSignal(); the
 * engine then pulls.
 *
 * A doorbell that dies is invisible by construction: no signal looks exactly
 * like no change. This adapter watches its own subscribe status and
 * re-subscribes with capped backoff whenever a channel reports a terminal
 * state, reporting every transition through the logger. A session arriving
 * re-opens a dead channel at once, since a private channel that joined before
 * sign-in fails until it has the user's JWT; the backoff covers every other
 * drop. Freshness never depends on it: a missed signal only delays the next
 * poll. The engine's poll fallback, not this channel, is the correctness
 * backstop.
 */
export function createRealtimeWakeup(
  client: SupabaseClient,
  options: IRealtimeWakeupOptions,
): IWakeup {
  const config: IDoorbellConfig = {
    client,
    options,
    prefix: options.topicPrefix ?? 'kizunasync',
    isPrivate: options.private ?? true,
    logger: (options.logger ?? noopLogger).child('realtime'),
    setTimer: options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs)),
    clearTimer: options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
  }

  return {
    subscribe(onSignal: () => void): () => void {
      const subscription: IDoorbellSubscription = {
        config,
        onSignal,
        disposed: false,
        channels: new Map(),
        retryTimers: new Map(),
        failures: new Map(),
      }

      for (const table of options.tables) {
        openChannel(subscription, table)
      }
      subscription.authSubscription = watchSession(subscription)

      return () => {
        closeSubscription(subscription)
      }
    },
  }
}

// MARK: - Channels

function openChannel(subscription: IDoorbellSubscription, table: string): void {
  const { client, prefix, isPrivate, logger } = subscription.config
  const { channels, failures, onSignal } = subscription

  if (subscription.disposed) {
    return
  }
  // Drop the previous handle before re-joining: leaving it registered would leak a dead channel on the client's socket for every retry. Removing it makes supabase-js report a final status (often CLOSED) to that handle's own subscribe callback, so the callback below ignores any status once `channels` no longer points at the channel that received it.
  const previous = channels.get(table)

  if (previous !== undefined) {
    channels.delete(table)
    void client.removeChannel(previous)
  }
  const channel = client
    .channel(`${prefix}:${table}`, { config: { private: isPrivate } })
    // Drop the payload: it is a hint, never data (guardrail).
    .on('broadcast', { event: 'changed' }, () => {
      onSignal()
    })
    .subscribe((status: string, error?: Error) => {
      if (subscription.disposed || channels.get(table) !== channel) {
        return
      }
      if (status === 'SUBSCRIBED') {
        if ((failures.get(table) ?? 0) > 0) {
          logger.info('doorbell.recovered', { table, afterAttempts: failures.get(table) })
        }
        failures.set(table, 0)
        clearRetry(subscription, table)

        return
      }
      if (DEAD_STATUSES.has(status)) {
        logger.warn('doorbell.dropped', { table, status, error })
        scheduleReopen(subscription, table)
      }
    })

  channels.set(table, channel)
}

function scheduleReopen(subscription: IDoorbellSubscription, table: string): void {
  const { logger, setTimer } = subscription.config
  const { retryTimers, failures } = subscription

  if (subscription.disposed || retryTimers.has(table)) {
    return
  }
  const attempt = (failures.get(table) ?? 0) + 1

  failures.set(table, attempt)
  const delayMs = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS)

  logger.warn('doorbell.reconnecting', { table, attempt, delayMs })
  retryTimers.set(
    table,
    setTimer(() => {
      retryTimers.delete(table)
      openChannel(subscription, table)
    }, delayMs),
  )
}

const SESSION_EVENTS: ReadonlySet<string> = new Set(['INITIAL_SESSION', 'SIGNED_IN', 'TOKEN_REFRESHED'])

function watchSession(subscription: IDoorbellSubscription): { unsubscribe: () => void } {
  const { client, setTimer } = subscription.config
  const { data } = client.auth.onAuthStateChange((event, session) => {
    if (session !== null && SESSION_EVENTS.has(event)) {
      // Supabase warns against calling client methods inside this callback (auth lock deadlock), and joining a channel reads the session token.
      setTimer(() => {
        reopenDeadChannels(subscription)
      }, 0)
    }
  })

  return data.subscription
}

function reopenDeadChannels(subscription: IDoorbellSubscription): void {
  if (subscription.disposed) {
    return
  }
  const { logger } = subscription.config

  for (const table of [...subscription.retryTimers.keys()]) {
    clearRetry(subscription, table)
    logger.info('doorbell.reopening', { table, reason: 'session' })
    openChannel(subscription, table)
  }
}

function clearRetry(subscription: IDoorbellSubscription, table: string): void {
  const { clearTimer } = subscription.config
  const handle = subscription.retryTimers.get(table)

  if (handle !== undefined) {
    clearTimer(handle)
    subscription.retryTimers.delete(table)
  }
}

function closeSubscription(subscription: IDoorbellSubscription): void {
  const { client, options } = subscription.config

  subscription.disposed = true
  subscription.authSubscription?.unsubscribe()

  for (const table of options.tables) {
    clearRetry(subscription, table)
  }
  for (const channel of subscription.channels.values()) {
    void client.removeChannel(channel)
  }
  subscription.channels.clear()
}
