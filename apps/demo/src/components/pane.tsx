import { KizunaSyncProvider } from '@kizunasync/react'
import type { IPaneClient } from '@/runtime/kizunasync'
import { PANE_DB_FILES } from '@/runtime/demo-config'
import { PaneControls } from '@/components/pane-controls'
import { PaneTag } from '@/components/pane-tag'
import { StatusStrip } from '@/components/status-strip'
import { TodoBoard } from '@/components/todo-board'
import type { IWireLog } from '@/runtime/wire-log'

// MARK: - One pane

/**
 * Its own KizunaSyncProvider subtree, so every hook inside resolves to THIS pane's
 * client. The two panes share no React state at all: what they share is the
 * Supabase project underneath them.
 */
interface IPaneProps {
  client: IPaneClient
  wireLog: IWireLog
  onStatus: (message: string) => void
}

export function Pane({ client, wireLog, onStatus }: IPaneProps) {
  return (
    <KizunaSyncProvider client={client}>
      <section
        className="flex min-w-0 flex-col gap-3 rounded-2xl border border-site-border bg-site-surface p-4"
        aria-label={`Pane ${client.pane}`}
      >
        <header className="flex items-center gap-2">
          <PaneTag pane={client.pane} />
          <span className="font-mono text-xs text-site-muted">{PANE_DB_FILES[client.pane]}</span>
        </header>
        <StatusStrip client={client} />
        <TodoBoard client={client} />
        <PaneControls client={client} wireLog={wireLog} onStatus={onStatus} />
      </section>
    </KizunaSyncProvider>
  )
}
