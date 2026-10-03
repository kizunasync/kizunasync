/// <reference types="bun" />
/**
 * @kizunasync/web leader election: two tabs on one database, without a browser.
 *
 * What is asserted here is what the tabs agree on: one of them opens the engine
 * and the other reaches it over the channel, an event the engine emits is seen
 * once by each tab, a call spanning a handover is answered exactly once, the next
 * tab opens the database only after the outgoing worker is gone, and a tab whose
 * own promotion failed keeps working through the tab that leads. The worker
 * protocol underneath is worker-driver.test.ts's subject.
 *
 * `navigator.locks` and `BroadcastChannel` are installed on `globalThis` for the
 * duration of each test, the way that suite installs `Worker`.
 */

import { describe, expect, test } from 'bun:test'
import { createKizunaSync, defineConfig, EEngineErrorCode, parseFailureEnvelope, TEngineError } from '@kizunasync/core'
import type { IEngineTransport, IKizunaSync, IProtocolRemote } from '@kizunasync/core'
import { createFollowerTransport } from './follower-transport'
import { electLeader } from './leader'
import type { ILeaderFailure } from './leader'
import { isLeaderMessage } from './leader-protocol'
import type { TLeaderMessage } from './leader-protocol'
import { createEngineTransport, createWebWorkerDriver } from './worker-driver'
import type { IRoleTransport, IWebEngineDriver } from './worker-driver'
import type { TWorkerRequest, TWorkerResponse } from './worker-protocol'

const PONG = '{"ok":true,"value":"pong"}'

const BLOCKED = 'the worker constructor is blocked'

/**
 * What the wasm bridge answers a held OPFS store with, byte for byte: the code is
 * the point, since a follower must not be told the flat ENGINE_UNAVAILABLE.
 */
const BUSY_ENVELOPE = JSON.stringify({
  ok: false,
  error: {
    kind: 'store_busy',
    code: 'STORE_BUSY',
    name: 'todos.db',
    message: 'store: wasm store: OPFS store for "todos.db" is held by another browser context',
    retryable: true,
  },
})

type TLockCallback = () => unknown

/**
 * Web Locks, minus the browser: the first requester runs, the rest queue in order,
 * an aborted request leaves the queue, and the lock is handed on when the holder's
 * callback settles.
 */
class FakeLockManager {
  private readonly waiting = new Map<string, Array<() => void>>()
  private readonly held = new Set<string>()

  /** How many tabs are still waiting their turn on `name`. */
  queued(name: string): number {
    return this.waiting.get(name)?.length ?? 0
  }

  async request(
    name: string,
    options: { signal?: AbortSignal },
    callback: TLockCallback,
  ): Promise<void> {
    // The browser never grants a lock in the caller's own tick. A fake that did would close the window between a transport being built and its tab being promoted, which is exactly the window these tests are about.
    await Promise.resolve()

    if (this.held.has(name)) {
      await new Promise<void>((resolve, reject) => {
        const queue = this.waiting.get(name) ?? []

        queue.push(resolve)
        this.waiting.set(name, queue)
        options.signal?.addEventListener('abort', () => {
          const at = queue.indexOf(resolve)

          if (at >= 0) {
            queue.splice(at, 1)
            reject(new Error('the lock request was aborted'))
          }
        })
      })
    }
    this.held.add(name)

    try {
      await callback()
    } finally {
      const next = this.waiting.get(name)?.shift()

      if (next === undefined) {
        this.held.delete(name)
      } else {
        next()
      }
    }
  }
}

/**
 * BroadcastChannel, minus the browser: one bus per name, delivered to every other
 * open channel and never to the sender.
 */
class FakeBroadcastChannel {
  static readonly buses = new Map<string, Set<FakeBroadcastChannel>>()

  /**
   * Delivery delay. A lock grant and a channel message are different task sources
   * in a browser, and this is what lets a test put them in a real race.
   */
  static latencyMs = 0

  private readonly listeners: Array<(event: { data: unknown }) => void> = []
  private closed = false

  /** Has announced itself: a leader's channel, not a follower's. */
  private led = false

  /** The page holding this channel stopped executing: nothing more it posts lands. */
  private gone = false

  /** This leader's answers are lost, while everything else it says still arrives. */
  private answersLost = false

  /**
   * Models the tab currently leading going away, mid-close and mid-answer, while
   * every other tab on the bus keeps working.
   */
  static loseTheLeader(): void {
    FakeBroadcastChannel.forEachLeader((channel) => {
      channel.gone = true
    })
  }

  /**
   * Loses only the answers the tab currently leading owes, so it still says
   * goodbye. A later leader's answers are unaffected.
   */
  static loseTheLeadersAnswers(): void {
    FakeBroadcastChannel.forEachLeader((channel) => {
      channel.answersLost = true
    })
  }

  private static forEachLeader(mark: (channel: FakeBroadcastChannel) => void): void {
    for (const bus of FakeBroadcastChannel.buses.values()) {
      for (const channel of bus) {
        if (channel.led) {
          mark(channel)
        }
      }
    }
  }

  constructor(readonly name: string) {
    const bus = FakeBroadcastChannel.buses.get(name) ?? new Set<FakeBroadcastChannel>()

    bus.add(this)
    FakeBroadcastChannel.buses.set(name, bus)
  }

  addEventListener(type: string, callback: (event: { data: unknown }) => void): void {
    if (type === 'message') {
      this.listeners.push(callback)
    }
  }

  postMessage(data: unknown): void {
    if (this.closed) {
      throw new Error('the channel is closed')
    }
    if (isLeaderMessage(data) && data.type === 'leader-ready') {
      this.led = true
    }
    if (this.gone || (this.answersLost && isLeaderMessage(data) && data.type === 'result')) {
      return
    }
    const latencyMs = FakeBroadcastChannel.latencyMs

    for (const peer of FakeBroadcastChannel.buses.get(this.name) ?? []) {
      if (peer === this) {
        continue
      }
      const deliver = (): void => peer.deliver(data)

      if (latencyMs === 0) {
        queueMicrotask(deliver)
      } else {
        setTimeout(deliver, latencyMs)
      }
    }
  }

  close(): void {
    this.closed = true
    FakeBroadcastChannel.buses.get(this.name)?.delete(this)
  }

  private deliver(data: unknown): void {
    if (this.closed) {
      return
    }
    for (const listener of this.listeners) {
      listener({ data })
    }
  }
}

/**
 * A worker that opens instantly and answers every call with one canned envelope.
 * A test can watch what crosses the tabs, not the worker protocol. It can also
 * stall its answers, delay its close acknowledgement, refuse to be constructed,
 * and crash: the handover cases need each of those.
 */
class LeaderWorker {
  static readonly spawned: LeaderWorker[] = []

  /** Spawns and terminations in order, so a test can see which came first. */
  static readonly trace: string[] = []

  static failNextSpawn = false

  /**
   * Every worker born from now on stalls its calls, so a test can hold work that
   * starts before it has a handle on the worker.
   */
  static holdNewCalls = false

  /**
   * What every worker answers `store_kind` with, so a test can make the durability
   * probe unreadable and then readable.
   */
  static storeKind = PONG

  /**
   * When set, every call is refused with this string as the worker's own
   * `ok:false` error: the shape the engine uses for a failure it described.
   */
  static refuseCallsWith: string | null = null

  static executions(method: string): number {
    return LeaderWorker.spawned.flatMap((worker) => worker.methods).filter((name) => name === method)
      .length
  }

  readonly posted: TWorkerRequest[] = []
  readonly listeners: Record<string, Array<(event: { data: unknown }) => void>> = {
    message: [],
    error: [],
  }
  holdCalls = LeaderWorker.holdNewCalls
  closeDelayMs = 0
  private readonly stalled: TWorkerRequest[] = []

  constructor(_url: unknown, _options: unknown) {
    if (LeaderWorker.failNextSpawn) {
      LeaderWorker.failNextSpawn = false

      throw new Error(BLOCKED)
    }
    LeaderWorker.spawned.push(this)
    LeaderWorker.trace.push('spawn')
  }

  get methods(): string[] {
    return this.posted.filter((message) => message.type === 'call').map((message) => message.method)
  }

  addEventListener(type: string, callback: (event: { data: unknown }) => void): void {
    ;(this.listeners[type] ??= []).push(callback)
  }

  postMessage(message: TWorkerRequest): void {
    this.posted.push(message)

    if (message.type === 'remote-result') {
      return
    }
    if (message.type === 'close') {
      this.answer(message, this.closeDelayMs)

      return
    }
    if (message.type === 'call' && this.holdCalls) {
      this.stalled.push(message)

      return
    }
    this.answer(message, 0)
  }

  terminate(): void {
    LeaderWorker.trace.push('terminate')
  }

  /** Let the calls held back since `holdCalls` was set through. */
  releaseCalls(): void {
    this.holdCalls = false

    for (const message of this.stalled.splice(0)) {
      this.answer(message, 0)
    }
  }

  /** The engine's own event stream, as the worker forwards it to the page. */
  emitEvent(eventJson: string): void {
    this.emit({ type: 'event', eventJson })
  }

  /** An `error` event carries its text on `message`, not on `data`. */
  crash(message: string): void {
    for (const callback of this.listeners.error ?? []) {
      ;(callback as unknown as (event: { message: string }) => void)({ message })
    }
  }

  private answer(message: TWorkerRequest & { id: number }, delayMs: number): void {
    const value =
      message.type === 'call' && message.method === 'store_kind' ? LeaderWorker.storeKind : PONG
    const refusal = message.type === 'call' ? LeaderWorker.refuseCallsWith : null
    const respond = (): void =>
      this.emit(
        refusal === null
          ? { type: 'result', id: message.id, ok: true, value }
          : { type: 'result', id: message.id, ok: false, error: refusal },
      )

    if (delayMs === 0) {
      queueMicrotask(respond)
    } else {
      setTimeout(respond, delayMs)
    }
  }

  private emit(response: TWorkerResponse): void {
    for (const callback of this.listeners.message ?? []) {
      callback({ data: response })
    }
  }
}

const opened: IEngineTransport[] = []

let locks = new FakeLockManager()

const withTabs = async <T>(body: () => Promise<T>): Promise<T> => {
  const scope = globalThis as { BroadcastChannel?: unknown; Worker?: unknown }
  const previousChannel = scope.BroadcastChannel
  const previousWorker = scope.Worker

  scope.BroadcastChannel = FakeBroadcastChannel as unknown
  scope.Worker = LeaderWorker as unknown
  locks = new FakeLockManager()
  Object.defineProperty(navigator, 'locks', { value: locks, configurable: true })
  LeaderWorker.spawned.length = 0
  LeaderWorker.trace.length = 0
  LeaderWorker.failNextSpawn = false
  LeaderWorker.holdNewCalls = false
  LeaderWorker.storeKind = PONG
  LeaderWorker.refuseCallsWith = null
  FakeBroadcastChannel.buses.clear()
  FakeBroadcastChannel.latencyMs = 0
  opened.length = 0

  try {
    return await body()
  } finally {
    // Closed here, not in each body: a failing assertion would otherwise leak an open channel and a worker into the next test. Followers close on the same tick as the leader, so no promotion outlives the fakes.
    for (const transport of opened) {
      transport.close()
    }
    opened.length = 0
    scope.BroadcastChannel = previousChannel
    scope.Worker = previousWorker
    delete (navigator as { locks?: unknown }).locks
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const noRemote = async (): Promise<string> => '{"ok":true,"data":{}}'

const track = <T extends IEngineTransport>(transport: T): T => {
  opened.push(transport)

  return transport
}

interface ITab {
  driver: IWebEngineDriver
  transport: IEngineTransport
}

const openDriverTab = (
  name: string,
  onEvent: (eventJson: string) => void = () => {},
): ITab => {
  const driver = createWebWorkerDriver(name)
  const transport = track(
    driver.engineTransport('{"client_id":"c1"}', name, noRemote, noRemote, onEvent),
  )

  return { driver, transport }
}

const openTab = (
  name: string,
  onEvent: (eventJson: string) => void = () => {},
): IEngineTransport => openDriverTab(name, onEvent).transport

/** A tab whose close and hand-over budgets are short enough to watch elapse. */
const openImpatientTab = (
  name: string,
  closeTimeoutMs: number,
  onEvent: (eventJson: string) => void = () => {},
): IRoleTransport =>
  track(
    createEngineTransport({ name, onDurability: () => {}, closeTimeoutMs })(
      '{"client_id":"c1"}',
      name,
      noRemote,
      noRemote,
      onEvent,
    ),
  )

interface IWireWatch {
  readonly messages: TLeaderMessage[]

  /** What the tabs said about one call, in order. */
  about(id: string): string[]

  post(message: TLeaderMessage): void
  close(): void
}

/**
 * A silent extra tab on the bus. A test can read the wire itself, not infer it
 * from what the two ends happened to do.
 */
const watchWire = (name: string): IWireWatch => {
  const channel = new BroadcastChannel(`kizunasync:${name}`)
  const messages: TLeaderMessage[] = []

  channel.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (isLeaderMessage(event.data)) {
      messages.push(event.data)
    }
  })

  return {
    messages,
    about: (id) =>
      messages.filter((message) => 'id' in message && message.id === id).map(({ type }) => type),
    post: (message) => channel.postMessage(message),
    close: () => channel.close(),
  }
}

describe('leader election across tabs', () => {
  test('the first tab on a database opens the engine and the second does not', async () => {
    await withTabs(async () => {
      openTab('todos.db')
      openTab('todos.db')
      await flush()

      expect(LeaderWorker.spawned).toHaveLength(1)
      expect(LeaderWorker.spawned[0]?.posted[0]?.type).toBe('open')
    })
  })

  test("a follower's call is answered by the leader's worker", async () => {
    await withTabs(async () => {
      openTab('todos.db')
      const follower = openTab('todos.db')

      await flush()

      expect(await follower.call('ping', '{}')).toBe(PONG)
      expect(LeaderWorker.spawned).toHaveLength(1)
      expect(LeaderWorker.spawned[0]?.methods).toContain('ping')
    })
  })

  // The leader answers its followers, so a failure it saw typed must reach them typed: re-encoding it as `engine_unavailable` would lose `STORE_BUSY` on the page, so the leader re-posts the engine's own envelope.
  test("a follower is told the store code the leader's worker refused with", async () => {
    await withTabs(async () => {
      openTab('todos.db')
      const follower = openTab('todos.db')

      await flush()
      LeaderWorker.refuseCallsWith = BUSY_ENVELOPE

      const envelope = await follower.call('ping', '{}')
      const failure = parseFailureEnvelope(envelope)

      expect(failure).toBeInstanceOf(TEngineError)
      expect(failure?.code).toBe(EEngineErrorCode.STORE_BUSY)
      expect(failure?.retryable).toBe(true)
      expect(failure?.message).toContain('is held by another browser context')
    })
  })

  test('closing the leader promotes a follower onto its own worker', async () => {
    await withTabs(async () => {
      const leader = openTab('todos.db')
      const follower = openTab('todos.db')

      await flush()
      expect(LeaderWorker.spawned).toHaveLength(1)

      leader.close()
      await flush()
      expect(LeaderWorker.spawned).toHaveLength(2)

      expect(await follower.call('ping', '{}')).toBe(PONG)
      expect(LeaderWorker.spawned[1]?.methods).toContain('ping')
      expect(LeaderWorker.spawned[0]?.methods).not.toContain('ping')
    })
  })

  test('a follower call nobody answers fails with ENGINE_UNAVAILABLE', async () => {
    await withTabs(async () => {
      const orphan = track(createFollowerTransport('todos.db', () => {}, { timeoutMs: 20 }))
      const failure = await orphan.call('ping', '{}').then(
        () => null,
        (reason: unknown) => reason,
      )

      expect(failure).toBeInstanceOf(TEngineError)
      expect((failure as TEngineError).code).toBe(EEngineErrorCode.ENGINE_UNAVAILABLE)
      expect((failure as TEngineError).message).toBe('no leader answered within 20 ms')
    })
  })

  test('one engine event reaches the leader once and the follower once', async () => {
    await withTabs(async () => {
      const leading: string[] = []
      const following: string[] = []

      openTab('todos.db', (eventJson) => leading.push(eventJson))
      openTab('todos.db', (eventJson) => following.push(eventJson))
      await flush()

      LeaderWorker.spawned[0]?.emitEvent('{"type":"synced"}')
      await flush()

      expect(leading).toEqual(['{"type":"synced"}'])
      expect(following).toEqual(['{"type":"synced"}'])
    })
  })

  test('the next tab opens the database only after the old worker is terminated', async () => {
    await withTabs(async () => {
      const leader = openTab('todos.db')

      await flush()
      const worker = LeaderWorker.spawned[0]

      if (worker === undefined) {
        throw new Error('no worker was spawned')
      }
      // A worker that takes its time acknowledging the close is exactly the case the 5 s budget exists for; the next tab must still wait for it.
      worker.closeDelayMs = 30
      openTab('todos.db')
      await flush()

      leader.close()
      await flush()
      expect(LeaderWorker.spawned).toHaveLength(1)

      await sleep(60)
      expect(LeaderWorker.spawned).toHaveLength(2)
      expect(LeaderWorker.trace).toEqual(['spawn', 'terminate', 'spawn'])
    })
  })

  test('a call posted into the handover window is answered exactly once', async () => {
    await withTabs(async () => {
      const leader = openTab('todos.db')

      openTab('todos.db')
      const bystander = openTab('todos.db')

      await flush()

      leader.close()
      // Posted with the outgoing leader no longer serving and the next one not yet listening: nothing on the bus would ever answer it unaided.
      const answered = bystander.call('ping', '{}')

      expect(await answered).toBe(PONG)
      expect(LeaderWorker.executions('ping')).toBe(1)
    })
  })

  test('a tab that joins during a handover is answered exactly once', async () => {
    await withTabs(async () => {
      const leader = openTab('todos.db')

      openTab('todos.db')
      await flush()

      leader.close()
      const joiner = openTab('todos.db')

      expect(await joiner.call('ping', '{}')).toBe(PONG)
      expect(LeaderWorker.executions('ping')).toBe(1)
    })
  })

  test('a call the leader took is acknowledged and still answered as it closes', async () => {
    await withTabs(async () => {
      const leader = openTab('todos.db')
      const follower = openTab('todos.db')

      await flush()
      const worker = LeaderWorker.spawned[0]

      if (worker === undefined) {
        throw new Error('no worker was spawned')
      }
      const wire = watchWire('todos.db')

      worker.holdCalls = true
      worker.closeDelayMs = 30

      const answered = follower.call('ping', '{}')

      await flush()
      const posted = wire.messages.find((message) => message.type === 'call')

      expect(posted?.type).toBe('call')
      const id = posted !== undefined && 'id' in posted ? posted.id : ''

      expect(wire.about(id)).toEqual(['call', 'accepted'])

      leader.close()
      worker.releaseCalls()

      expect(await answered).toBe(PONG)
      expect(wire.about(id)).toEqual(['call', 'accepted', 'result'])
      expect(LeaderWorker.executions('ping')).toBe(1)
      wire.close()
    })
  })

  test('a follower re-posts only the calls no leader ever took', async () => {
    await withTabs(async () => {
      const follower = track(createFollowerTransport('todos.db', () => {}, { timeoutMs: 60 }))
      const wire = watchWire('todos.db')

      const taken = follower.call('taken', '{}').then(
        () => null,
        (reason: unknown) => reason,
      )
      const untaken = follower.call('untaken', '{}').then(
        () => null,
        (reason: unknown) => reason,
      )

      await flush()
      const first = wire.messages[0]

      expect(first?.type).toBe('call')
      const id = first !== undefined && 'id' in first ? first.id : ''

      // One call is taken by a leader that then goes away without answering it, so a re-post would run it a second time on the tab that takes over.
      wire.post({ type: 'accepted', id, leader: 'first' })
      await flush()
      wire.post({ type: 'leader-ready', leader: 'second' })
      await flush()

      const reposted = wire.messages.filter((message) => message.type === 'call')

      expect(reposted.map((message) => message.method)).toEqual(['taken', 'untaken', 'untaken'])

      await taken
      await untaken
      wire.close()
    })
  })

  test('a leader whose worker dies hands the database to the next tab', async () => {
    await withTabs(async () => {
      const leader = openTab('todos.db')
      const follower = openTab('todos.db')

      await flush()

      LeaderWorker.spawned[0]?.crash('the wasm module failed to load')
      await flush()

      expect(LeaderWorker.spawned).toHaveLength(2)
      expect(await follower.call('ping', '{}')).toBe(PONG)
      // The wounded tab fails with the real reason. It does not reconnect to a database it no longer owns.
      await expect(leader.call('ping', '{}')).rejects.toThrow('the wasm module failed to load')
    })
  })

  test('a call made before this tab is promoted runs on its own worker, once', async () => {
    await withTabs(async () => {
      const driver = createWebWorkerDriver('todos.db')
      const transport = track(
        driver.engineTransport('{"client_id":"c1"}', 'todos.db', noRemote, noRemote, () => {}),
      )
      // Issued in the same tick as the transport, before the lock resolves. On a single tab the leader that will answer it is this one, moments later.
      const answered = transport.call('ping', '{}')

      expect(await answered).toBe(PONG)
      expect(LeaderWorker.spawned).toHaveLength(1)
      expect(LeaderWorker.executions('ping')).toBe(1)
    })
  })

  test('a promotion inherits the untaken calls and lets the taken one drain', async () => {
    await withTabs(async () => {
      const leader = openTab('todos.db')
      const follower = openTab('todos.db')

      await flush()
      const first = LeaderWorker.spawned[0]

      if (first === undefined) {
        throw new Error('no worker was spawned')
      }
      first.holdCalls = true
      first.closeDelayMs = 30

      const taken = follower.call('taken', '{}')

      await flush()

      leader.close()
      // Posted after the outgoing leader stopped serving, so no leader ever takes it: it belongs to whichever tab ends up running the engine.
      const untaken = follower.call('untaken', '{}')

      first.releaseCalls()

      expect(await taken).toBe(PONG)
      expect(await untaken).toBe(PONG)
      expect(LeaderWorker.executions('taken')).toBe(1)
      expect(LeaderWorker.executions('untaken')).toBe(1)
      expect(LeaderWorker.spawned[0]?.methods).toContain('taken')
      expect(LeaderWorker.spawned[1]?.methods).toContain('untaken')
      expect(LeaderWorker.spawned[1]?.methods).not.toContain('taken')
    })
  })

  test('a call the leader took is never run again by the tab that takes over', async () => {
    for (const latencyMs of [0, 1, 4, 16]) {
      await withTabs(async () => {
        FakeBroadcastChannel.latencyMs = latencyMs
        const leader = openTab('todos.db')
        const follower = openTab('todos.db')

        await sleep(latencyMs * 3 + 4)

        const answered = follower.call('once', '{}')

        // Closed one delivery later, with the leader's `accepted` still on the wire: the lock grant that promotes the follower races it and, at every latency, wins.
        await sleep(latencyMs + 1)
        leader.close()

        expect(await answered).toBe(PONG)
        expect({ latencyMs, ran: LeaderWorker.executions('once') }).toEqual({ latencyMs, ran: 1 })
      })
    }
  })

  test('a fresh tab waits for its own slow first call rather than failing it', async () => {
    await withTabs(async () => {
      LeaderWorker.holdNewCalls = true
      const tab = openImpatientTab('todos.db', 40)
      const settled: string[] = []
      // Made before this tab is promoted, then still running on the worker it opens, long past the budget: the engine is slow, nobody has vanished.
      const slow = tab.call('slow', '{}').then((envelope) => {
        settled.push('slow')

        return envelope
      })

      await sleep(90)
      const after = tab.call('after', '{}').then((envelope) => {
        settled.push('after')

        return envelope
      })

      LeaderWorker.spawned[0]?.releaseCalls()

      expect(await slow).toBe(PONG)
      expect(await after).toBe(PONG)
      expect(settled).toEqual(['slow', 'after'])
      expect(LeaderWorker.executions('slow')).toBe(1)
      expect(LeaderWorker.executions('after')).toBe(1)
    })
  })

  test("an outgoing leader's goodbye ends the hand-over at once", async () => {
    await withTabs(async () => {
      const leader = openImpatientTab('todos.db', 300)
      const follower = openImpatientTab('todos.db', 300)

      await flush()
      const worker = LeaderWorker.spawned[0]

      if (worker === undefined) {
        throw new Error('no worker was spawned')
      }
      worker.holdCalls = true
      const stranded = follower.call('stranded', '{}').then(
        () => null,
        (reason: unknown) => reason,
      )

      await flush()

      // Taken by this leader, and its answer lost on the way back. Nothing will make that transport idle now, so only the goodbye can tell the promoted tab it has heard everything that leader was going to say.
      FakeBroadcastChannel.loseTheLeadersAnswers()
      worker.releaseCalls()
      leader.close()
      await flush()

      // Issued once the hand-over is under way. It waits on the hand-over; it is not answered over the channel. Its latency is the barrier's.
      const startedAt = Date.now()
      const gated = follower.call('after', '{}')

      expect(await gated).toBe(PONG)
      expect(Date.now() - startedAt).toBeLessThan(150)
      await stranded
    })
  })

  test('a leading tab reports its teardown only once its worker is gone', async () => {
    await withTabs(async () => {
      const tab = openImpatientTab('todos.db', 200)

      await flush()
      const worker = LeaderWorker.spawned[0]

      if (worker === undefined) {
        throw new Error('no worker was spawned')
      }
      worker.closeDelayMs = 40
      let torn = false

      void tab.whenClosed().then(() => {
        torn = true
      })

      tab.close()
      await sleep(15)
      expect(LeaderWorker.trace).toEqual(['spawn'])
      expect(torn).toBe(false)

      await sleep(60)
      expect(LeaderWorker.trace).toEqual(['spawn', 'terminate'])
      expect(torn).toBe(true)
    })
  })

  test('a leader that vanished without a goodbye is given up on, not replayed', async () => {
    await withTabs(async () => {
      const leader = openImpatientTab('todos.db', 40)
      const follower = openImpatientTab('todos.db', 40)

      await flush()
      const worker = LeaderWorker.spawned[0]

      if (worker === undefined) {
        throw new Error('no worker was spawned')
      }
      worker.holdCalls = true

      const stranded = follower.call('stranded', '{}').then(
        () => null,
        (reason: unknown) => reason,
      )

      await flush()
      expect(worker.methods).toContain('stranded')

      // The leader's page stops here: neither the answer it owes nor its goodbye will ever arrive, so the tab taking over has to decide alone.
      FakeBroadcastChannel.loseTheLeader()
      leader.close()
      const untaken = follower.call('untaken', '{}')

      await sleep(90)

      expect(LeaderWorker.spawned).toHaveLength(2)
      expect(await untaken).toBe(PONG)
      expect(LeaderWorker.executions('untaken')).toBe(1)

      const failure = await stranded

      expect(failure).toBeInstanceOf(TEngineError)
      expect((failure as TEngineError).code).toBe(EEngineErrorCode.ENGINE_UNAVAILABLE)
      expect((failure as TEngineError).message).toBe('the leader tab went away before answering')
    })
  })

  test('a tab promoted with a hand-over still open sees each event once', async () => {
    await withTabs(async () => {
      const seen: string[] = []
      const leader = openImpatientTab('todos.db', 80)
      const follower = openImpatientTab('todos.db', 80, (eventJson) => seen.push(eventJson))

      await flush()
      const first = LeaderWorker.spawned[0]

      if (first === undefined) {
        throw new Error('no worker was spawned')
      }
      // An accepted call nobody will answer keeps the hand-over open, which is the only window in which this tab both leads and still holds a follower.
      first.holdCalls = true
      const stranded = follower.call('stranded', '{}').then(
        () => null,
        (reason: unknown) => reason,
      )

      await flush()
      FakeBroadcastChannel.loseTheLeader()
      leader.close()
      await sleep(20)

      expect(LeaderWorker.spawned).toHaveLength(2)
      LeaderWorker.spawned[1]?.emitEvent('{"type":"synced"}')
      await flush()

      expect(seen).toEqual(['{"type":"synced"}'])
      await sleep(90)
      await stranded
    })
  })

  test('a call made during the hand-over runs once, behind the inherited ones', async () => {
    await withTabs(async () => {
      FakeBroadcastChannel.latencyMs = 16
      const leader = openTab('todos.db')
      const follower = openTab('todos.db')

      await sleep(60)

      leader.close()
      // Posted with nobody serving, so the tab taking over inherits it.
      const inherited = follower.call('inherited', '{}')

      await sleep(8)
      // Made while the hand-over is still waiting for the outgoing leader's goodbye: it queues, and joins the inherited call behind it.
      const during = follower.call('during', '{}')

      expect(await inherited).toBe(PONG)
      expect(await during).toBe(PONG)
      expect(LeaderWorker.executions('inherited')).toBe(1)
      expect(LeaderWorker.executions('during')).toBe(1)
      const promoted = LeaderWorker.spawned[1]?.methods ?? []

      expect(promoted.filter((method) => method !== 'store_kind')).toEqual([
        'inherited',
        'during',
      ])
    })
  })

  test('a hand-over takes the untaken calls and leaves the taken ones draining', async () => {
    await withTabs(async () => {
      const events: string[] = []
      const follower = track(
        createFollowerTransport('todos.db', (eventJson) => events.push(eventJson), {
          timeoutMs: 200,
        }),
      )
      const wire = watchWire('todos.db')

      const taken = follower.call('taken', '{}')
      const untaken = follower.call('untaken', '{}')

      await flush()
      const first = wire.messages[0]
      const id = first !== undefined && 'id' in first ? first.id : ''

      wire.post({ type: 'accepted', id, leader: 'outgoing' })
      await flush()

      follower.stopFollowing()
      const inherited = follower.handOver()

      expect(inherited.map((call) => call.method)).toEqual(['untaken'])

      let idle = false

      void follower.whenIdle().then(() => {
        idle = true
      })
      await flush()
      expect(idle).toBe(false)

      // Events stop at the hand-over: the promoted page reads them from its own worker, and this channel would hand it the same one a second time.
      wire.post({ type: 'event', eventJson: '{"type":"synced"}' })
      wire.post({ type: 'result', id, envelope: PONG })
      await flush()

      expect(events).toEqual([])
      expect(idle).toBe(true)
      expect(await taken).toBe(PONG)

      inherited[0]?.resolve(PONG)
      expect(await untaken).toBe(PONG)
      wire.close()
    })
  })

  test('a follower whose durability probe comes back unreadable asks again', async () => {
    await withTabs(async () => {
      // A leader standing down answers a durability probe with an `engine_unavailable` envelope, which carries no durability. Latching on it would leave this tab without the answer for good.
      LeaderWorker.storeKind = '{"ok":false,"error":{"kind":"engine_unavailable","message":"no"}}'
      openTab('todos.db')
      const follower = openDriverTab('todos.db')

      await flush()

      expect(await follower.transport.call('ping', '{}')).toBe(PONG)
      await flush()
      expect(follower.driver.durability).toBeUndefined()

      LeaderWorker.storeKind = '{"ok":true,"value":{"durability":"full"}}'
      expect(await follower.transport.call('ping', '{}')).toBe(PONG)
      await flush()

      expect(follower.driver.durability).toBe('full')
    })
  })

  test('a follower that closes before its turn leaves the queue', async () => {
    await withTabs(async () => {
      const leader = openTab('todos.db')
      const follower = openTab('todos.db')

      await flush()
      expect(locks.queued('kizunasync:todos.db')).toBe(1)

      follower.close()
      await flush()
      expect(locks.queued('kizunasync:todos.db')).toBe(0)

      leader.close()
      await sleep(20)
      expect(LeaderWorker.spawned).toHaveLength(1)
    })
  })

  test('a promotion that throws leaves the page a follower and frees the lock', async () => {
    await withTabs(async () => {
      const failures: ILeaderFailure[] = []
      const wounded = electLeader('todos.db', {
        onLeader: () => {
          throw new Error(BLOCKED)
        },
        onFollower: () => {},
        onLeaderFailed: (failure) => failures.push(failure),
      })

      await flush()

      expect(wounded.role).toBe('follower')
      expect((failures[0]?.error as Error).message).toBe(BLOCKED)
      expect(failures[0]?.canAnotherTabLead).toBe(true)

      let led = false
      const next = electLeader('todos.db', {
        onLeader: () => {
          led = true
        },
        onFollower: () => {},
        onLeaderFailed: () => {},
      })

      await flush()

      expect(next.role).toBe('leader')
      expect(led).toBe(true)
      await next.release()
    })
  })

  test('a tab whose promotion failed keeps calling through the tab that leads', async () => {
    await withTabs(async () => {
      LeaderWorker.failNextSpawn = true
      const wounded = openTab('todos.db')

      await flush()
      openTab('todos.db')
      await flush()

      expect(LeaderWorker.spawned).toHaveLength(1)
      expect(await wounded.call('ping', '{}')).toBe(PONG)
    })
  })

  test('a timeout on a tab that failed to lead says so', async () => {
    await withTabs(async () => {
      const orphan = track(
        createFollowerTransport('todos.db', () => {}, {
          timeoutMs: 20,
          describePromotionFailure: () => BLOCKED,
        }),
      )
      const failure = await orphan.call('ping', '{}').then(
        () => null,
        (reason: unknown) => reason,
      )

      expect((failure as TEngineError).code).toBe(EEngineErrorCode.ENGINE_UNAVAILABLE)
      expect((failure as TEngineError).message).toBe(
        `no leader answered within 20 ms; this tab's own promotion failed: ${BLOCKED}`,
      )
    })
  })

  test('the single-tab fallback reports a promotion that throws rather than throwing', async () => {
    // Deliberately outside `withTabs`: the path taken when the browser has no `navigator.locks` at all, which is how bun runs by default.
    expect((navigator as { locks?: unknown }).locks).toBeUndefined()
    const failures: ILeaderFailure[] = []
    const election = electLeader('todos.db', {
      onLeader: () => {
        throw new Error(BLOCKED)
      },
      onFollower: () => {},
      onLeaderFailed: (failure) => failures.push(failure),
    })

    await flush()

    expect((failures[0]?.error as Error).message).toBe(BLOCKED)
    expect(failures[0]?.canAnotherTabLead).toBe(false)
    expect(election.role).toBe('follower')
    await election.release()
  })

  test('the single-tab fallback fails a call at once rather than at the timeout', async () => {
    expect((navigator as { locks?: unknown }).locks).toBeUndefined()
    const scope = globalThis as { Worker?: unknown }
    const previous = scope.Worker

    scope.Worker = LeaderWorker as unknown
    LeaderWorker.failNextSpawn = true

    try {
      const driver = createWebWorkerDriver('todos.db')
      const transport = driver.engineTransport(
        '{"client_id":"c1"}',
        'todos.db',
        noRemote,
        noRemote,
        () => {},
      )

      // Issued in the same tick, with no timer advanced and not even a microtask: with no lock manager there is no second tab to wait for, so the reason has to be on the call that is already being made.
      const failure = await transport.call('ping', '{}').then(
        () => null,
        (reason: unknown) => reason,
      )

      expect(failure).toBeInstanceOf(TEngineError)
      expect((failure as TEngineError).code).toBe(EEngineErrorCode.ENGINE_UNAVAILABLE)
      expect((failure as TEngineError).message).toBe(`this tab's own promotion failed: ${BLOCKED}`)
      transport.close()
    } finally {
      scope.Worker = previous
      LeaderWorker.failNextSpawn = false
    }
  })

  test('a tab that joins never resets the uploads the leader has in flight', async () => {
    await withTabs(async () => {
      const leader = openTab('todos.db')

      await flush()
      const worker = LeaderWorker.spawned[0]

      if (worker === undefined) {
        throw new Error('no worker was spawned')
      }
      worker.holdCalls = true
      // The leader's upload holds its claim for as long as the transfer runs.
      const uploading = outcomeOf(leader.call('attachment_claim', '{"reference":"a","state":"uploading"}'))

      await flush()
      // Every client recovers crashed claims when it is built, a joining tab's included.
      const joiner = openTab('todos.db')

      await flush()
      const recoveries = [joiner, leader].map((tab) => outcomeOf(tab.call('attachment_recover', '{}')))

      await flush()
      expect(LeaderWorker.executions('attachment_recover')).toBe(0)

      worker.releaseCalls()
      expect(await Promise.all(recoveries)).toEqual(['{"ok":true,"value":null}', '{"ok":true,"value":null}'])
      expect(await uploading).toBe(PONG)
    })
  })

  test('malformed traffic on the channel is ignored by both sides', async () => {
    await withTabs(async () => {
      openTab('todos.db')
      const follower = openTab('todos.db')

      await flush()

      const noise = new BroadcastChannel('kizunasync:todos.db')

      for (const junk of [null, undefined, 'hello', 42, {}, { type: 'call' }, { type: 'result' }]) {
        noise.postMessage(junk)
      }
      await flush()

      expect(await follower.call('ping', '{}')).toBe(PONG)
      noise.close()
    })
  })
})

// MARK: - Calls a leader accepted

const LEADER_GONE = 'the leader tab went away before answering'

/** The id of the first call the wire carried. */
const firstCallId = (wire: IWireWatch): string => {
  const first = wire.messages.find((message) => message.type === 'call')

  return first !== undefined && 'id' in first ? first.id : ''
}

/** A call's envelope or failure, observed from the moment it is made, so a rejection is never unhandled. */
const outcomeOf = (call: Promise<string>): Promise<unknown> =>
  call.then(
    (envelope) => envelope,
    (reason: unknown) => reason,
  )

/** What an observed call has settled with so far, or `pending`. */
const settledSoFar = (outcome: Promise<unknown>): Promise<unknown> =>
  Promise.race([outcome, flush().then(() => 'pending')])

describe('calls a leader accepted', () => {
  test('ready, accepted and goodbye name the leading tab, and it is one id', async () => {
    await withTabs(async () => {
      const wire = watchWire('todos.db')
      const leader = openTab('todos.db')
      const follower = openTab('todos.db')

      await flush()
      expect(await follower.call('ping', '{}')).toBe(PONG)
      leader.close()
      await sleep(20)

      // Up to the outgoing leader's goodbye: the promoted tab announces itself under an id of its own after it.
      const goodbye = wire.messages.findIndex((message) => message.type === 'leader-closed')
      const named = wire.messages
        .slice(0, goodbye + 1)
        .flatMap((message) => ('leader' in message ? [{ type: message.type, leader: message.leader }] : []))

      expect(named.map(({ type }) => type)).toEqual(
        expect.arrayContaining(['leader-ready', 'accepted', 'leader-closed']),
      )
      expect(named[0]?.leader).toBeString()
      expect(new Set(named.map(({ leader }) => leader)).size).toBe(1)
      wire.close()
    })
  })

  test('an accepted call outlives the call timeout and settles on its answer', async () => {
    await withTabs(async () => {
      const follower = track(createFollowerTransport('todos.db', () => {}, { timeoutMs: 20 }))
      const wire = watchWire('todos.db')
      const answered = outcomeOf(follower.call('slow', '{}'))

      await flush()
      const id = firstCallId(wire)

      wire.post({ type: 'leader-ready', leader: 'only' })
      wire.post({ type: 'accepted', id, leader: 'only' })
      // Well past the 20 ms budget: that budget is for finding a leader, and one has taken the call and is running it.
      await sleep(60)
      wire.post({ type: 'result', id, envelope: PONG })

      expect(await answered).toBe(PONG)
      wire.close()
    })
  })

  test('an accepted call fails when the leader that took it says goodbye without answering', async () => {
    await withTabs(async () => {
      const follower = track(createFollowerTransport('todos.db', () => {}, { timeoutMs: 1_000 }))
      const wire = watchWire('todos.db')
      const answered = outcomeOf(follower.call('lost', '{}'))

      await flush()
      wire.post({ type: 'leader-ready', leader: 'only' })
      wire.post({ type: 'accepted', id: firstCallId(wire), leader: 'only' })
      await flush()
      wire.post({ type: 'leader-closed', leader: 'only' })
      await flush()

      const settled = await settledSoFar(answered)

      expect(settled).toBeInstanceOf(TEngineError)
      expect((settled as TEngineError).code).toBe(EEngineErrorCode.ENGINE_UNAVAILABLE)
      expect((settled as TEngineError).message).toBe(LEADER_GONE)
      wire.close()
    })
  })

  test("a replaced leader's goodbye neither ends the hand-over nor fails the current leader's calls", async () => {
    await withTabs(async () => {
      const follower = track(createFollowerTransport('todos.db', () => {}, { timeoutMs: 1_000 }))
      const wire = watchWire('todos.db')

      wire.post({ type: 'leader-ready', leader: 'first' })
      wire.post({ type: 'leader-closed', leader: 'first' })
      await flush()
      wire.post({ type: 'leader-ready', leader: 'second' })
      await flush()

      const answered = outcomeOf(follower.call('current', '{}'))

      await flush()
      const id = firstCallId(wire)

      wire.post({ type: 'accepted', id, leader: 'second' })
      let closed = false

      void follower.whenLeaderClosed().then(() => {
        closed = true
      })
      // The first leader's goodbye arriving again, late: its page posts one on pagehide as well.
      wire.post({ type: 'leader-closed', leader: 'first' })
      await flush()

      expect(closed).toBe(false)
      expect(await settledSoFar(answered)).toBe('pending')

      wire.post({ type: 'result', id, envelope: PONG })
      wire.post({ type: 'leader-closed', leader: 'second' })
      await flush()

      expect(await answered).toBe(PONG)
      expect(closed).toBe(true)
      wire.close()
    })
  })

  test('a call a replaced leader took fails once the hand-over budget passes without its answer', async () => {
    await withTabs(async () => {
      const follower = track(
        createFollowerTransport('todos.db', () => {}, { timeoutMs: 1_000, handOverMs: 30 }),
      )
      const wire = watchWire('todos.db')
      const stranded = outcomeOf(follower.call('stranded', '{}'))

      await flush()
      wire.post({ type: 'leader-ready', leader: 'first' })
      wire.post({ type: 'accepted', id: firstCallId(wire), leader: 'first' })
      await flush()
      // The first leader vanished without a goodbye, and another tab took the database over.
      wire.post({ type: 'leader-ready', leader: 'second' })
      await flush()

      expect(await settledSoFar(stranded)).toBe('pending')
      await sleep(60)

      const settled = await settledSoFar(stranded)

      expect(settled).toBeInstanceOf(TEngineError)
      expect((settled as TEngineError).code).toBe(EEngineErrorCode.ENGINE_UNAVAILABLE)
      expect((settled as TEngineError).message).toBe(LEADER_GONE)
      wire.close()
    })
  })

  test("a tab taking over still counts the old leader's goodbye when its own announcement lands first", async () => {
    await withTabs(async () => {
      const follower = track(createFollowerTransport('todos.db', () => {}, { timeoutMs: 1_000 }))
      const wire = watchWire('todos.db')
      const stranded = outcomeOf(follower.call('stranded', '{}'))

      await flush()
      wire.post({ type: 'leader-ready', leader: 'old' })
      wire.post({ type: 'accepted', id: firstCallId(wire), leader: 'old' })
      await flush()
      follower.stopFollowing()
      let closed = false

      void follower.whenLeaderClosed().then(() => {
        closed = true
      })
      // Two senders, no order between them: the taking-over tab's own announcement can land before the goodbye the old leader posted first.
      wire.post({ type: 'leader-ready', leader: 'own' })
      await flush()
      wire.post({ type: 'leader-closed', leader: 'old' })
      await flush()

      expect(closed).toBe(true)
      expect((await settledSoFar(stranded)) as TEngineError).toHaveProperty('message', LEADER_GONE)
      wire.close()
    })
  })

  test("a call the taking-over tab's own engine runs gets no hand-over budget", async () => {
    await withTabs(async () => {
      const follower = track(
        createFollowerTransport('todos.db', () => {}, { timeoutMs: 1_000, handOverMs: 20 }),
      )
      const wire = watchWire('todos.db')

      wire.post({ type: 'leader-ready', leader: 'old' })
      await flush()
      follower.stopFollowing()
      const mine = outcomeOf(follower.call('mine', '{}'))

      await flush()
      wire.post({ type: 'leader-ready', leader: 'own' })
      wire.post({ type: 'accepted', id: firstCallId(wire), leader: 'own' })
      // Past the 20 ms hand-over budget: this tab's own engine is running the call, however slowly.
      await sleep(50)
      expect(await settledSoFar(mine)).toBe('pending')

      wire.post({ type: 'result', id: firstCallId(wire), envelope: PONG })
      expect(await mine).toBe(PONG)
      wire.close()
    })
  })

  test('a call a replaced leader took still settles on an answer inside the hand-over budget', async () => {
    await withTabs(async () => {
      const follower = track(
        createFollowerTransport('todos.db', () => {}, { timeoutMs: 1_000, handOverMs: 200 }),
      )
      const wire = watchWire('todos.db')
      const answered = outcomeOf(follower.call('late', '{}'))

      await flush()
      const id = firstCallId(wire)

      wire.post({ type: 'leader-ready', leader: 'first' })
      wire.post({ type: 'accepted', id, leader: 'first' })
      await flush()
      wire.post({ type: 'leader-ready', leader: 'second' })
      await sleep(20)
      wire.post({ type: 'result', id, envelope: PONG })

      expect(await answered).toBe(PONG)
      wire.close()
    })
  })
})

// MARK: - The goodbye a closing page posts

/**
 * A tab that is closed, not disposed, runs no `close()`. The only thing that can
 * tell its followers the leadership is over is the `pagehide` the browser fires
 * on the way out. Without it a follower promoted by the Web Lock grant has to
 * wait out `closeTimeoutMs` before it can trust its own flags.
 */
const dispatchPageEvent = (type: string): void => {
  globalThis.dispatchEvent(new Event(type))
}

describe('leader pagehide', () => {
  test('a leading page posts leader-closed on pagehide, naming itself', async () => {
    await withTabs(async () => {
      const wire = watchWire('todos.db')

      openTab('todos.db')
      await flush()

      const heard: TLeaderMessage[] = []
      const listener = new BroadcastChannel('kizunasync:todos.db')

      listener.addEventListener('message', (event: MessageEvent<unknown>) => {
        if (isLeaderMessage(event.data)) {
          heard.push(event.data)
        }
      })

      dispatchPageEvent('pagehide')
      await flush()

      const ready = wire.messages.find((message) => message.type === 'leader-ready')
      const leader = ready !== undefined && 'leader' in ready ? ready.leader : 'no leader-ready was heard'

      expect(heard.find((message) => message.type === 'leader-closed')).toEqual({ type: 'leader-closed', leader })
      listener.close()
      wire.close()
    })
  })

  test('a visibilitychange to hidden is not a close', async () => {
    await withTabs(async () => {
      openTab('todos.db')
      await flush()

      const heard: TLeaderMessage[] = []
      const listener = new BroadcastChannel('kizunasync:todos.db')

      listener.addEventListener('message', (event: MessageEvent<unknown>) => {
        if (isLeaderMessage(event.data)) {
          heard.push(event.data)
        }
      })

      dispatchPageEvent('visibilitychange')
      await flush()

      expect(heard).toEqual([])
      listener.close()
    })
  })

  test('a follower stays silent: only the tab that leads says goodbye', async () => {
    await withTabs(async () => {
      const leader = openTab('todos.db')

      openTab('todos.db')
      await flush()
      leader.close()
      await flush()

      const heard: TLeaderMessage[] = []
      const listener = new BroadcastChannel('kizunasync:todos.db')

      listener.addEventListener('message', (event: MessageEvent<unknown>) => {
        if (isLeaderMessage(event.data)) {
          heard.push(event.data)
        }
      })

      // The tab that gave up the lock unregistered its listener, so the goodbye on this pagehide is the promoted tab's, once, not twice.
      dispatchPageEvent('pagehide')
      await flush()

      expect(heard.filter((message) => message.type === 'leader-closed')).toHaveLength(1)
      listener.close()
    })
  })
})

// MARK: - Leadership and the automatic loop

/**
 * The role transport says whether its tab leads the database, so the app client
 * above it drives the automatic sync loop only on the leading tab. A follower's
 * explicit `sync()` still reaches the leader's worker, and a follower promoted
 * to leader wakes its loop once.
 */
describe('the transport reports whether this tab leads', () => {
  test('a lone tab leads once its lock is granted, and its listener hears the promotion', async () => {
    await withTabs(async () => {
      const transport = openImpatientTab('todos.db', 50)
      const heard: boolean[] = []

      transport.leadership.subscribe((leader) => heard.push(leader))
      expect(transport.leadership.isLeader()).toBe(false)

      await flush()
      expect(transport.leadership.isLeader()).toBe(true)
      expect(heard).toEqual([true])
    })
  })

  test('a follower leads only once the tab before it closes', async () => {
    await withTabs(async () => {
      const leader = openImpatientTab('todos.db', 50)
      const follower = openImpatientTab('todos.db', 50)
      const heard: boolean[] = []

      follower.leadership.subscribe((isLeader) => heard.push(isLeader))
      await flush()
      expect(leader.leadership.isLeader()).toBe(true)
      expect(follower.leadership.isLeader()).toBe(false)

      leader.close()
      await flush()
      expect(follower.leadership.isLeader()).toBe(true)
      expect(heard).toEqual([true])
    })
  })

  test('a tab whose promotion throws never reports leading', async () => {
    await withTabs(async () => {
      LeaderWorker.failNextSpawn = true
      const wounded = openImpatientTab('todos.db', 50)
      const heard: boolean[] = []

      wounded.leadership.subscribe((isLeader) => heard.push(isLeader))
      await flush()

      expect(wounded.leadership.isLeader()).toBe(false)
      expect(heard).toEqual([])
    })
  })

  test('a leader whose worker dies stops leading', async () => {
    await withTabs(async () => {
      const leader = openImpatientTab('todos.db', 50)
      const heard: boolean[] = []

      await flush()
      leader.leadership.subscribe((isLeader) => heard.push(isLeader))
      LeaderWorker.spawned[0]?.crash('the wasm module failed to load')
      await flush()

      expect(leader.leadership.isLeader()).toBe(false)
      expect(heard).toEqual([false])
    })
  })
})

const clientConfig = defineConfig({ tables: { todos: { sync: 'read-write' } } })

const unusedRemote: IProtocolRemote = {
  pull: () => Promise.reject(new Error('the fake worker never calls the remote')),
  push: () => Promise.reject(new Error('the fake worker never calls the remote')),
}

type TClientTab = {
  client: IKizunaSync

  /** Rings the tab's wakeup port, as a realtime doorbell would. */
  ring: () => void

  /** Runs the timers the tab's scheduler armed so far. */
  fire: () => Promise<void>

  armed: () => number
}

/** A client over its own driver, with a wakeup port and a timer pair the test drives. */
const openClientTab = (name: string): TClientTab => {
  const driver = createWebWorkerDriver(name)
  const pending = new Map<number, () => void>()
  const listeners = new Set<() => void>()
  let nextHandle = 0
  const client = createKizunaSync(driver, unusedRemote, clientConfig, {
    inspector: false,
    pollIntervalMs: 0,
    wakeup: {
      subscribe: (onSignal) => {
        listeners.add(onSignal)

        return () => listeners.delete(onSignal)
      },
    },
    setTimer: (callback) => {
      nextHandle += 1
      pending.set(nextHandle, callback)

      return nextHandle
    },
    clearTimer: (handle) => {
      pending.delete(handle as number)
    },
  })

  return {
    client,
    ring: () => {
      for (const listener of listeners) {
        listener()
      }
    },
    fire: async () => {
      const due = [...pending.values()]

      pending.clear()

      for (const callback of due) {
        callback()
      }
      await flush()
    },
    armed: () => pending.size,
  }
}

describe('automatic sync runs on the leading tab only', () => {
  test('a client spawns no worker and joins no election before its first engine call', async () => {
    await withTabs(async () => {
      const tab = openClientTab('todos.db')

      await flush()
      expect(LeaderWorker.spawned).toHaveLength(0)
      expect(FakeBroadcastChannel.buses.size).toBe(0)
      expect(tab.armed()).toBe(0)

      tab.client.on(() => {})
      await flush()
      expect(LeaderWorker.spawned).toHaveLength(1)
      tab.client.dispose()
    })
  })

  test('a follower tab schedules no automatic attempt, and its explicit sync reaches the leader', async () => {
    await withTabs(async () => {
      const leading = openClientTab('todos.db')
      const following = openClientTab('todos.db')

      // The first engine call opens each client: its tab joins the election, and only the winner spawns a worker.
      leading.client.on(() => {})
      following.client.on(() => {})
      await flush()
      // The first tab takes its lock after its client subscribed, so it too is promoted, and wakes once.
      await leading.fire()
      expect(LeaderWorker.executions('sync')).toBe(1)

      following.ring()
      LeaderWorker.spawned[0]?.emitEvent('{"type":"QUEUE_DEPTH","depth":1}')
      await flush()
      expect(following.armed()).toBe(0)

      await following.fire()
      expect(LeaderWorker.executions('sync')).toBe(1)

      await following.client.sync()
      expect(LeaderWorker.executions('sync')).toBe(2)
      expect(LeaderWorker.spawned).toHaveLength(1)

      following.client.dispose()
      leading.client.dispose()
    })
  })

  test('a follower promoted to leader wakes its loop once, on its own worker', async () => {
    await withTabs(async () => {
      const leading = openClientTab('todos.db')
      const following = openClientTab('todos.db')

      leading.client.on(() => {})
      following.client.on(() => {})
      await flush()
      await leading.fire()
      leading.client.dispose()
      await flush()

      expect(LeaderWorker.spawned).toHaveLength(2)
      expect(following.armed()).toBe(1)

      await following.fire()
      expect(LeaderWorker.spawned[1]?.methods.filter((method) => method === 'sync')).toHaveLength(1)
      expect(following.armed()).toBe(0)
      following.client.dispose()
    })
  })
})
