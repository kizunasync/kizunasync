// MARK: - @kizunasync/web leader protocol

/**
 * The messages the tabs of one database exchange. A database is opened once per
 * origin, not once per tab: the tab holding its Web Lock runs the engine in its
 * worker, and every other tab is a follower whose engine calls travel over this
 * channel and are answered from the leader's worker.
 *
 * `id` correlates a follower's `call` with the leader's `result`. The follower
 * mints it as `<clientTag>:<counter>` (two followers on one channel cannot
 * collide) and the leader echoes it untouched. Events travel one way only: the
 * leader rebroadcasts what its worker emits; a follower rebroadcasts nothing.
 *
 * `accepted` and `leader-ready` exist because a channel buffers nothing. A call
 * posted while no tab is listening (the window between one leader closing and the
 * next registering) would stall until it timed out. A new leader announces
 * itself, and a follower re-posts only the calls no leader ever took. A call that
 * was accepted is never executed twice.
 *
 * `leader-closed` makes the `accepted` flag trustworthy. A tab is promoted by a
 * Web Locks grant, a different task source from this channel, with no ordering
 * against it. A promoted tab reading `accepted` could be reading it before the
 * message that would have set it. A channel does guarantee that messages from a
 * single sender arrive in the order they were sent. An outgoing leader posts
 * `leader-closed` last, after every answer it owed: a follower that has processed
 * it has already processed every `accepted` and every `result` that leader will
 * ever send.
 *
 * `leader-ready`, `accepted` and `leader-closed` carry the id the leading tab
 * mints when it wins the lock. Two leaders' messages have no order between them,
 * so a goodbye ends a hand-over only when it comes from the leader that announced
 * itself last, and a call a leader accepted and never answered fails on that
 * leader's goodbye.
 *
 * Both directions share one channel name. A second follower also sees the first
 * follower's requests; each side ignores the messages that are not addressed to
 * it.
 */

/** The lock and the channel are named after the database, in one namespace. */
export const SCOPE_PREFIX = 'kizunasync:'

/** A random id: a follower's request-id prefix, or a leader's instance id. */
export function createTag(): string {
  const scope = globalThis as { crypto?: { randomUUID?: () => string } }

  return scope.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
}

export type TLeaderRequest = { type: 'call'; id: string; method: string; paramsJson: string }

export type TLeaderResponse =
  | { type: 'accepted'; id: string; leader: string }
  | { type: 'result'; id: string; envelope: string }
  | { type: 'event'; eventJson: string }
  | { type: 'leader-ready'; leader: string }
  | { type: 'leader-closed'; leader: string }

/** What either side may read off the channel, before it discriminates. */
export type TLeaderMessage = TLeaderRequest | TLeaderResponse

/** Each named field of `message` holds a string, checked in the order given. */
function hasStringFields(message: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof message[key] === 'string')
}

/**
 * The channel is same-origin, not trusted: anything else on the origin may use
 * this name, and an unchecked payload would throw inside the listener.
 */
export function isLeaderMessage(data: unknown): data is TLeaderMessage {
  if (typeof data !== 'object' || data === null) {
    return false
  }
  const message = data as Record<string, unknown>

  switch (message.type) {
    case 'call':
      return hasStringFields(message, ['id', 'method', 'paramsJson'])
    case 'accepted':
      return hasStringFields(message, ['id', 'leader'])
    case 'result':
      return hasStringFields(message, ['id', 'envelope'])
    case 'event':
      return hasStringFields(message, ['eventJson'])
    case 'leader-ready':
    case 'leader-closed':
      return hasStringFields(message, ['leader'])
    default:
      return false
  }
}
