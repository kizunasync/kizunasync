/**
 * Bounds a COMMIT in the live-database tests by cancelling its backend from a
 * second session when it outlasts a budget.
 */

import type { SQL } from 'bun'

type TConn = Awaited<ReturnType<SQL['reserve']>>

const CANCEL_GRACE_MS = 10_000

/**
 * Commits on `conn` and fails the test when the commit outlasts `ms`. The
 * statement timeout is off while COMMIT runs the deferred stamp, so only a
 * cancel from another session bounds a stalled commit and frees its locks.
 */
export async function commitWithin(input: { conn: TConn; admin: SQL; pid: number; ms: number }): Promise<void> {
  const { conn, admin, pid, ms } = input
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = false
  const commit = conn`commit`.then(
    () => {
      settled = true
    },
    (error: unknown) => {
      settled = true

      throw error
    },
  )
  const expired = new Promise<'expired'>((resolve) => {
    timer = setTimeout(() => resolve('expired'), ms)
  })

  try {
    if ((await Promise.race([commit, expired])) !== 'expired') {
      return
    }
    await admin`select pg_cancel_backend(${pid})`
    await Promise.race([commit.catch(() => undefined), Bun.sleep(CANCEL_GRACE_MS)])

    if (!settled) {
      await admin`select pg_terminate_backend(${pid})`
    }
    throw new Error(`the commit did not finish within ${ms} ms, so its backend was cancelled`)
  } finally {
    clearTimeout(timer)
  }
}
