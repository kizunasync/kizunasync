import { useEffect, useState } from 'react'
import { messageOf } from '@kizunasync/utilities'
import { attemptForeignWrite } from '@/lib/rls-probe'
import type { IPaneClient } from '@/runtime/kizunasync'
import type { IWireLog } from '@/runtime/wire-log'

export interface IUsePaneControlsResult {
  offline: boolean
  isBusy: boolean
  isConfirmingWipe: boolean
  toggleOffline: () => void
  tryForeignWrite: () => void
  requestWipe: () => void
  onWipeOpenChange: (isOpen: boolean) => void
  confirmWipe: () => void
}

/** Owns the three switches that belong to one pane: its network, its forbidden write, and its local wipe. */
export function usePaneControls(
  client: IPaneClient,
  wireLog: IWireLog,
  onStatus: (message: string) => void,
): IUsePaneControlsResult {
  const [offline, setOfflineState] = useState(() => client.isOffline())
  const [isBusy, setIsBusy] = useState(false)
  const [isConfirmingWipe, setIsConfirmingWipe] = useState(false)

  useEffect(() => client.subscribeOffline(setOfflineState), [client])

  function toggleOffline(): void {
    const next = !offline

    client.setOffline(next)
    onStatus(
      next
        ? `Pane ${client.pane} is offline: writes queue in its outbox.`
        : `Pane ${client.pane} is back online: the outbox drains on the next sync.`,
    )

    if (!next) {
      void client.sync().catch((cause: unknown) => {
        onStatus(`Pane ${client.pane} could not sync after going online: ${messageOf(cause)}`)
      })
    }
  }

  async function tryForeignWriteAsync(): Promise<void> {
    setIsBusy(true)
    onStatus(`Pane ${client.pane} is writing a row it does not own…`)

    try {
      await attemptForeignWrite(client, wireLog)
      onStatus(`The server refused pane ${client.pane}'s write. The row reverted; the rejection is journalled.`)
    } catch (cause) {
      onStatus(messageOf(cause))
    } finally {
      setIsBusy(false)
    }
  }

  async function wipeAndRehydrate(): Promise<void> {
    setIsConfirmingWipe(false)
    setIsBusy(true)
    onStatus(`Wiping pane ${client.pane}…`)

    try {
      await client.resetLocal()
      await client.sync()
      onStatus(`Pane ${client.pane} rebuilt its whole board from the server.`)
    } catch (cause) {
      onStatus(messageOf(cause))
    } finally {
      setIsBusy(false)
    }
  }

  return {
    offline,
    isBusy,
    isConfirmingWipe,
    toggleOffline,
    tryForeignWrite: () => void tryForeignWriteAsync(),
    requestWipe: () => setIsConfirmingWipe(true),
    onWipeOpenChange: setIsConfirmingWipe,
    confirmWipe: () => void wipeAndRehydrate(),
  }
}
