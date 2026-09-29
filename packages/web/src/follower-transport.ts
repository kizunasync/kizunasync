// MARK: - @kizunasync/web follower transport

/**
 * The `IEngineTransport` a tab that lost the election runs. Every call is posted to
 * the leader's channel and resolved by the envelope the leader posts back, so a
 * follower spawns no worker and opens no database, yet sees the same envelopes and
 * the same event stream as the tab that owns the engine.
 *
 * A call is re-posted when a new leader announces itself, but only while no leader
 * has taken it: an `accepted` call is waiting on a worker somewhere and re-posting
 * it would execute it twice. A call no leader takes within the call budget rejects
 * with `ENGINE_UNAVAILABLE` instead of hanging. A call a leader took waits for its
 * answer as long as the engine runs it, and fails with `ENGINE_UNAVAILABLE` only
 * when that leader says goodbye without answering, or when another leader has
 * announced itself and the hand-over budget passes with no answer. That is the
 * transport's own failure layer: there is no envelope to carry it
 * (`IEngineTransport`).
 */

import { EEngineErrorCode, TEngineError } from '@kizunasync/core'
import type { IEngineTransport } from '@kizunasync/core'
import { createTag, isLeaderMessage, SCOPE_PREFIX } from './leader-protocol'
import type { TLeaderRequest, TLeaderResponse } from './leader-protocol'

const DEFAULT_TIMEOUT_MS = 30_000

const CLOSED = 'the @kizunasync/web follower transport is closed'

/**
 * A leader that accepted a call and went away without answering it. Its tab ran no
 * close, so the call is neither answered nor safe to run again.
 */
export const LEADER_GONE = 'the leader tab went away before answering'

export interface IFollowerOptions {
  /** How long a call waits for a leader to take it before it fails. */
  timeoutMs?: number

  /**
   * How long a call a replaced leader took waits for its answer once another
   * leader has announced itself. Defaults to `timeoutMs`.
   */
  handOverMs?: number

  /**
   * Read when a call times out. A tab whose own promotion failed reports that too:
   * "nobody answered" would otherwise hide the reason nobody could.
   */
  describePromotionFailure?: () => string | undefined
}

/** A call this transport was carrying, handed to whoever runs the engine now. */
interface ITakenCall {
  method: string
  paramsJson: string
  resolve: (envelope: string) => void
  reject: (reason: Error) => void
}

export interface IFollowerTransport extends IEngineTransport {
  /**
   * Called the moment its tab starts running the engine itself. It stops handing
   * events to the page, which would otherwise see each event twice: once from its
   * worker and once as the rebroadcast it is now the one sending. A `leader-ready`
   * from then on is its own tab's: it re-posts the untaken calls there, keeps the
   * leader whose goodbye the hand-over waits for, and starts no hand-over budget
   * for a call this tab's own engine runs.
   */
  stopFollowing(): void

  /**
   * Returns the calls no leader ever accepted, so they can be re-issued on this
   * tab's own worker and still execute exactly once; the accepted ones stay here,
   * waiting for an answer that is already on its way.
   *
   * Only safe once this transport is idle or its leader has said goodbye. Before
   * that, `accepted` may not have been delivered yet, and handing over a call some
   * leader is already running would run it twice.
   */
  handOver(): ITakenCall[]

  /** Resolves once nothing is left in flight. */
  whenIdle(): Promise<void>

  /**
   * Resolves once the goodbye of the leader that announced itself last (of any
   * leader, before one has) has been processed, so every `accepted` and `result`
   * it sent has been too.
   */
  whenLeaderClosed(): Promise<void>

  /**
   * Fails everything still waiting with a reason this transport cannot know, then
   * closes. For calls whose leader went away without answering them.
   */
  abandon(reason: Error): void
}

interface IPendingCall {
  request: TLeaderRequest

  /** The leader whose `accepted` took the call: it is executing there, so it is never re-posted. */
  acceptedBy: string | null

  resolve: (envelope: string) => void
  reject: (reason: Error) => void

  /**
   * The call budget until a leader takes the call, then nothing while that leader
   * leads, then the hand-over budget once another leader has announced itself.
   */
  expiry: ReturnType<typeof setTimeout> | undefined
}

function unavailable(message: string): TEngineError {
  return new TEngineError(EEngineErrorCode.ENGINE_UNAVAILABLE, message)
}

/** The budget as the caller set it, so the message never claims a wait nobody made. */
function describeBudget(timeoutMs: number): string {
  return timeoutMs % 1_000 === 0 ? `${timeoutMs / 1_000} s` : `${timeoutMs} ms`
}

/** What one follower transport reads and mutates, shared by the functions below. */
interface IFollowerState {
  readonly timeoutMs: number
  readonly handOverMs: number
  readonly channel: BroadcastChannel
  readonly pending: Map<string, IPendingCall>
  readonly idleWaiters: Array<() => void>
  readonly closedWaiters: Array<() => void>

  /** Distinguishes this tab's request ids from every other follower's on one channel. */
  readonly tag: string

  counter: number
  closed: boolean

  /** False once its tab runs the engine itself (`stopFollowing`). */
  following: boolean

  /** The leader that announced itself last, or null before one has. */
  leader: string | null

  /** That leader has said goodbye. */
  leaderClosed: boolean

  readonly onEvent: (eventJson: string) => void
  readonly options: IFollowerOptions
}

export function createFollowerTransport(
  name: string,
  onEvent: (eventJson: string) => void,
  options: IFollowerOptions = {},
): IFollowerTransport {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const state: IFollowerState = {
    timeoutMs,
    handOverMs: options.handOverMs ?? timeoutMs,
    channel: new BroadcastChannel(SCOPE_PREFIX + name),
    pending: new Map(),
    idleWaiters: [],
    closedWaiters: [],
    tag: createTag(),
    counter: 0,
    closed: false,
    following: true,
    leader: null,
    leaderClosed: false,
    onEvent,
    options,
  }

  state.channel.addEventListener('message', (event: MessageEvent<unknown>) => {
    const message = event.data

    // A `call` is another follower's request; everything else came from a leader.
    if (!isLeaderMessage(message) || message.type === 'call') {
      return
    }
    receiveFromLeader(state, message)
  })

  return {
    stopFollowing: () => {
      state.following = false
    },
    handOver: () => handOverUntaken(state),
    whenIdle: () =>
      state.pending.size === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            state.idleWaiters.push(resolve)
          }),
    whenLeaderClosed: () =>
      state.leaderClosed
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            state.closedWaiters.push(resolve)
          }),
    abandon: (reason) => failAll(state, reason),
    call: (method, paramsJson) => postCall(state, { method, paramsJson }),
    close: () => failAll(state, unavailable(CLOSED)),
  }
}

// MARK: - Calls

type TCallRequest = {
  method: string
  paramsJson: string
}

function postCall(state: IFollowerState, call: TCallRequest): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (state.closed) {
      reject(unavailable(CLOSED))

      return
    }
    state.counter += 1
    const request: TLeaderRequest = {
      type: 'call',
      id: `${state.tag}:${state.counter}`,
      method: call.method,
      paramsJson: call.paramsJson,
    }
    const expiry = setTimeout(() => {
      failCall(state, request.id, unavailable(describeTimeout(state)))
    }, state.timeoutMs)

    state.pending.set(request.id, { request, acceptedBy: null, resolve, reject, expiry })
    state.channel.postMessage(request)
  })
}

function describeTimeout(state: IFollowerState): string {
  const unanswered = `no leader answered within ${describeBudget(state.timeoutMs)}`
  const promotion = state.options.describePromotionFailure?.()

  return promotion === undefined
    ? unanswered
    : `${unanswered}; this tab's own promotion failed: ${promotion}`
}

function handOverUntaken(state: IFollowerState): ITakenCall[] {
  const taken: ITakenCall[] = []

  for (const [id, entry] of state.pending) {
    if (entry.acceptedBy !== null) {
      continue
    }
    state.pending.delete(id)
    clearTimeout(entry.expiry)
    taken.push({
      method: entry.request.method,
      paramsJson: entry.request.paramsJson,
      resolve: entry.resolve,
      reject: entry.reject,
    })
  }
  notifyIfIdle(state)

  return taken
}

function failCall(state: IFollowerState, id: string, reason: Error): void {
  const entry = state.pending.get(id)

  if (entry === undefined) {
    return
  }
  state.pending.delete(id)
  clearTimeout(entry.expiry)
  entry.reject(reason)
  notifyIfIdle(state)
}

/** Starts the hand-over budget of a call a leader that no longer leads took, once. */
function awaitHandedOverAnswer(state: IFollowerState, id: string, entry: IPendingCall): void {
  if (entry.expiry !== undefined) {
    return
  }
  entry.expiry = setTimeout(() => {
    failCall(state, id, unavailable(LEADER_GONE))
  }, state.handOverMs)
}

function notifyIfIdle(state: IFollowerState): void {
  if (state.pending.size > 0) {
    return
  }
  for (const waiter of state.idleWaiters.splice(0)) {
    waiter()
  }
}

function failAll(state: IFollowerState, reason: Error): void {
  if (state.closed) {
    return
  }
  state.closed = true
  state.channel.close()

  for (const entry of state.pending.values()) {
    clearTimeout(entry.expiry)
    entry.reject(reason)
  }
  state.pending.clear()
  notifyIfIdle(state)
}

// MARK: - The leader's messages

function receiveFromLeader(state: IFollowerState, message: TLeaderResponse): void {
  const { onEvent } = state

  if (message.type === 'event') {
    if (state.following) {
      onEvent(message.eventJson)
    }
    return
  }
  if (message.type === 'leader-ready') {
    welcomeLeader(state, message.leader)

    return
  }
  if (message.type === 'leader-closed') {
    farewellLeader(state, message.leader)

    return
  }
  if (message.type === 'accepted') {
    markAccepted(state, message)

    return
  }
  settleCall(state, message)
}

/**
 * A new leader was not listening when the untaken calls were posted; it is now.
 * The calls the leader before it took may still be answered, within the
 * hand-over budget. Once its tab has taken over, the only announcement left is
 * that tab's own, and it changes nothing but the re-post.
 */
function welcomeLeader(state: IFollowerState, leader: string): void {
  if (state.following && leader !== state.leader) {
    state.leader = leader
    state.leaderClosed = false

    for (const [id, entry] of state.pending) {
      if (entry.acceptedBy !== null && entry.acceptedBy !== leader) {
        awaitHandedOverAnswer(state, id, entry)
      }
    }
  }
  for (const entry of state.pending.values()) {
    if (entry.acceptedBy === null) {
      state.channel.postMessage(entry.request)
    }
  }
}

/**
 * A leader posts its goodbye after every answer it owed, or on `pagehide`, where no
 * answer still owed will come: a call it took and did not answer fails. Only the
 * goodbye of the leader that announced itself last ends a hand-over; a replaced
 * leader's, arriving late, says nothing about the calls the current one took.
 */
function farewellLeader(state: IFollowerState, leader: string): void {
  for (const [id, entry] of state.pending) {
    if (entry.acceptedBy === leader) {
      failCall(state, id, unavailable(LEADER_GONE))
    }
  }
  if (state.leader !== null && state.leader !== leader) {
    return
  }
  state.leaderClosed = true

  for (const waiter of state.closedWaiters.splice(0)) {
    waiter()
  }
}

/** A taken call waits for its answer, not for the call budget, while its leader leads. */
function markAccepted(state: IFollowerState, message: Extract<TLeaderResponse, { type: 'accepted' }>): void {
  const entry = state.pending.get(message.id)

  if (entry === undefined) {
    return
  }
  entry.acceptedBy = message.leader
  clearTimeout(entry.expiry)
  entry.expiry = undefined

  if (state.following && state.leader !== null && state.leader !== message.leader) {
    awaitHandedOverAnswer(state, message.id, entry)
  }
}

function settleCall(state: IFollowerState, message: Extract<TLeaderResponse, { type: 'result' }>): void {
  const entry = state.pending.get(message.id)

  if (entry === undefined) {
    return
  }
  state.pending.delete(message.id)
  clearTimeout(entry.expiry)
  entry.resolve(message.envelope)
  notifyIfIdle(state)
}
