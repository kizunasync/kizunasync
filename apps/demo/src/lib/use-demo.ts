import { useEffect, useState } from 'react'
import { createCaptchaGate, messageOf } from '@kizunasync/utilities'
import { runConflictScenario, runEditAndSoftDeleteScenario, type IRunConflictParams } from '@/lib/conflict'
import { stageForeignRow } from '@/lib/rls-probe'
import { followPaneSession, signInPane } from '@/lib/session'
import { openPaneKizunaSync, type IPaneClient } from '@/runtime/kizunasync'
import { TURNSTILE_SITE_KEY } from '@/runtime/demo-config'
import { createWireLog, type IWireLog } from '@/runtime/wire-log'

export interface IDemo {
  paneA: IPaneClient
  paneB: IPaneClient
  wireLog: IWireLog
}

export interface IUseDemoResult {
  demo: IDemo | null
  bootError: string | null
  status: string
  runningScenario: boolean
  onStatus: (message: string) => void
  runConflict: () => void
  runEditAndSoftDelete: () => void
}

/**
 * Memoize the boot so a re-invoked mount (React StrictMode double-invokes the
 * effect in dev) never builds a SECOND client per pane: the second loses the
 * leader election to the first and becomes its follower, a second client over
 * the one engine. Sharing one promise keeps it to one client per pane.
 */
let demoPromise: Promise<IDemo> | null = null

/** One demo per page, same reasoning as `demoPromise`: one captcha gate to match. */
export const captchaGate = createCaptchaGate()

const openDemo = (): Promise<IDemo> => {
  demoPromise ??= openDemoOnce()

  return demoPromise
}

const openDemoOnce = async (): Promise<IDemo> => {
  const wireLog = createWireLog()
  const paneA = openPaneKizunaSync('A', wireLog)
  const paneB = openPaneKizunaSync('B', wireLog)

  await signInPane(paneA, TURNSTILE_SITE_KEY === '' ? {} : { captchaToken: () => captchaGate.request() })
  await followPaneSession({ owner: paneA, follower: paneB, wireLog })
  await stageForeignRow(wireLog)
  await Promise.all([paneA.sync(), paneB.sync()])

  return { paneA, paneB, wireLog }
}

/**
 * Owns the demo boot (two kizunasync clients racing to open against one Supabase
 * project) and the two scripted scenarios that drive both panes at once
 * (@CONVENTIONS.md UI composition: state concerns live in the hook, region
 * components stay presentational).
 */
export function useDemo(): IUseDemoResult {
  const [demo, setDemo] = useState<IDemo | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)
  const [status, setStatus] = useState('Two databases, one server. Type in either pane and watch the wire.')
  const [runningScenario, setRunningScenario] = useState(false)

  useEffect(() => {
    let isLive = true

    void openDemo()
      .then((opened) => {
        if (isLive) {
          setDemo(opened)
        }
      })
      .catch((cause: unknown) => {
        if (isLive) {
          setBootError(messageOf(cause))
        }
      })

    return () => {
      isLive = false
    }
  }, [])

  // Both scripted scenarios drive BOTH panes, so they share one in-flight flag: running them concurrently would interleave two offline windows and make the wire log unreadable.
  async function runScenario(scenario: (params: IRunConflictParams) => Promise<void>): Promise<void> {
    if (demo === null) {
      return
    }
    setRunningScenario(true)

    try {
      await scenario({
        paneA: demo.paneA,
        paneB: demo.paneB,
        wireLog: demo.wireLog,
        onStatus: setStatus,
      })
    } catch (cause) {
      setStatus(messageOf(cause))
    } finally {
      setRunningScenario(false)
    }
  }

  return {
    demo,
    bootError,
    status,
    runningScenario,
    onStatus: setStatus,
    runConflict: () => void runScenario(runConflictScenario),
    runEditAndSoftDelete: () => void runScenario(runEditAndSoftDeleteScenario),
  }
}
