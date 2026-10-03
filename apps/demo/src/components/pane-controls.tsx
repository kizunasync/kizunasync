import { Button } from '@/components/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PaneJournal } from '@/components/pane-journal'
import { Tip } from '@/components/tip'
import { usePaneControls } from '@/lib/use-pane-controls'
import type { IPaneClient } from '@/runtime/kizunasync'
import type { IWireLog } from '@/runtime/wire-log'

/** "Simulate conflict" is deliberately absent here: it drives both panes, so it lives on the shared header instead. */
interface IPaneControlsProps {
  client: IPaneClient
  wireLog: IWireLog
  onStatus: (message: string) => void
}

export function PaneControls({ client, wireLog, onStatus }: IPaneControlsProps) {
  const { offline, isBusy, isConfirmingWipe, toggleOffline, tryForeignWrite, requestWipe, onWipeOpenChange, confirmWipe } =
    usePaneControls(client, wireLog, onStatus)

  return (
    <div className="flex flex-wrap gap-2 border-t border-site-border pt-3">
      <Tip text="Cut this pane's network, writes keep landing locally">
        <Button tone={offline ? 'active' : 'default'} type="button" aria-pressed={offline} onClick={toggleOffline}>
          {offline ? 'Go online' : 'Go offline'}
        </Button>
      </Tip>
      <Tip text="Writes a row you don't own. RLS refuses it and the write reverts">
        <Button type="button" disabled={isBusy} onClick={tryForeignWrite}>
          Try to write someone else&apos;s row
        </Button>
      </Tip>
      <Tip text="Deletes the local database, a fresh pull rebuilds it from the server">
        <Button type="button" disabled={isBusy} onClick={requestWipe}>
          Wipe &amp; rehydrate
        </Button>
      </Tip>
      <ConfirmDialog
        isOpen={isConfirmingWipe}
        title={`Wipe pane ${client.pane}?`}
        detail={`This deletes pane ${client.pane}'s local database. A fresh pull rebuilds its board from the server, and nothing on the server changes.`}
        confirmLabel="Wipe & rehydrate"
        onOpenChange={onWipeOpenChange}
        onConfirm={confirmWipe}
      />
      <PaneJournal />
    </div>
  )
}
