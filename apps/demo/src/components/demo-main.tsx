import { Pane } from '@/components/pane'
import { WireViewer } from '@/components/wire-viewer'
import type { IDemo } from '@/lib/use-demo'

interface IDemoMainProps {
  demo: IDemo | null
  bootError: string | null
  onStatus: (message: string) => void
}

const BOOT_ERROR_HINT_DEV =
  'Check VITE_DEMO_SUPABASE_URL / VITE_DEMO_SUPABASE_PUBLISHABLE_KEY in the repo-root .env, and that the local stack is running.'
const BOOT_ERROR_HINT_PROD =
  'The demo could not start a session. Reload the page to try again; if it keeps failing, the demo is temporarily unavailable.'

/** The three states of the boot: a fatal error, a loading line while the two local databases open, or the live panes plus wire log once both are ready. */
export function DemoMain({ demo, bootError, onStatus }: IDemoMainProps) {
  return (
    <main className="grid w-full flex-1 gap-6 px-4 py-6 sm:px-6">
      {bootError !== null ? (
        <p className="m-0 rounded-lg border border-site-danger px-3 py-2 text-xs text-site-danger">
          {bootError}. {import.meta.env.DEV ? BOOT_ERROR_HINT_DEV : BOOT_ERROR_HINT_PROD}
        </p>
      ) : demo === null ? (
        <p className="m-0 py-4 text-center text-sm text-site-muted">Opening two local databases…</p>
      ) : (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <Pane client={demo.paneA} wireLog={demo.wireLog} onStatus={onStatus} />
            <Pane client={demo.paneB} wireLog={demo.wireLog} onStatus={onStatus} />
          </div>
          <WireViewer wireLog={demo.wireLog} />
        </>
      )}
    </main>
  )
}
