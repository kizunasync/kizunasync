import { expect, test } from '@playwright/test'
import { callEngine, openEngine, PAGE_PATH } from './harness'

// MARK: - One engine per database, not per tab

/**
 * Two pages on one database name. The first wins the Web Lock and runs the engine
 * in its own worker; the second spawns none and its calls are answered over the
 * leader's channel. When the leading page goes away the follower is promoted, which
 * is observable twice over: it spawns a worker of its own, and `ping` keeps
 * answering although no other tab is left to answer it.
 *
 * The store is `:memory:` on purpose: what is under test is the election and the
 * follower channel, not which VFS the engine picked.
 */

/** Both pages open this one; the test's browser context is fresh either way. */
const DATABASE = 'multi-tab'

const HANDOVER_TIMEOUT_MS = 60_000

test('a follower calls through the leader and takes over when it closes', async ({ context }) => {
  const leader = await context.newPage()

  await leader.goto(PAGE_PATH)
  await openEngine(leader, { name: DATABASE, databasePath: ':memory:' })
  await expect.poll(() => leader.workers().length).toBe(1)
  expect(await callEngine(leader, 'ping')).toBe('pong')

  const follower = await context.newPage()

  await follower.goto(PAGE_PATH)
  await openEngine(follower, { name: DATABASE, databasePath: ':memory:' })
  expect(follower.workers()).toEqual([])
  expect(await callEngine(follower, 'ping')).toBe('pong')

  const promoted = follower.waitForEvent('worker', { timeout: HANDOVER_TIMEOUT_MS })

  await leader.close()
  await promoted

  expect(await callEngine(follower, 'ping')).toBe('pong')
  expect(follower.workers().length).toBe(1)
})

/**
 * A tab the user closes runs no `close()`. The driver's own goodbye never fires.
 * What the outgoing page posts on `pagehide` is the only thing that tells a
 * follower the leadership is over on that path. Without it a promoted tab has to
 * wait out its hand-over budget before it can trust which of its calls were
 * taken.
 *
 * Both halves are asserted: the follower hears `leader-closed` on the shared
 * channel, and it is serving its own engine well inside that budget.
 */

/**
 * `CLOSE_TIMEOUT_MS` in `packages/web/src/worker-driver.ts`: the wait the
 * goodbye exists to remove.
 */
const HAND_OVER_BUDGET_MS = 5_000

test('a closing leader says goodbye, so a follower promotes without waiting out the budget', async ({
  context,
}) => {
  const leader = await context.newPage()

  await leader.goto(PAGE_PATH)
  await openEngine(leader, { name: DATABASE, databasePath: ':memory:' })
  await expect.poll(() => leader.workers().length).toBe(1)

  const follower = await context.newPage()

  await follower.goto(PAGE_PATH)
  await openEngine(follower, { name: DATABASE, databasePath: ':memory:' })
  expect(follower.workers()).toEqual([])

  // Listened for from the follower's page, on the same channel name the tabs of one database share. What is observed is the real message, not a timing proxy for it.
  await follower.evaluate((name) => {
    const heard: string[] = []

    Object.assign(window, { __heard: heard })
    const channel = new BroadcastChannel(`kizunasync:${name}`)

    channel.addEventListener('message', (event: MessageEvent<unknown>) => {
      const message = event.data as { type?: unknown }

      if (typeof message?.type === 'string') {
        heard.push(message.type)
      }
    })
  }, DATABASE)

  const promoted = follower.waitForEvent('worker', { timeout: HANDOVER_TIMEOUT_MS })
  const startedAt = Date.now()

  await leader.close()
  await promoted
  const elapsedMs = Date.now() - startedAt

  const heard = await follower.evaluate(() => (window as unknown as { __heard: string[] }).__heard)

  expect(heard).toContain('leader-closed')
  expect(elapsedMs).toBeLessThan(HAND_OVER_BUDGET_MS)
  expect(await callEngine(follower, 'ping')).toBe('pong')
  expect(follower.workers().length).toBe(1)
})
