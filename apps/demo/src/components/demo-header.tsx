import { Button } from '@/components/button'
import { Tip } from '@/components/tip'

interface IDemoHeaderProps {
  disabled: boolean
  runningScenario: boolean
  status: string
  onRunConflict: () => void
  onRunEditAndSoftDelete: () => void
}

/** Brand mark, the two scripted scenario buttons, and the shared status line both panes and scenarios write to. */
export function DemoHeader({ disabled, runningScenario, status, onRunConflict, onRunEditAndSoftDelete }: IDemoHeaderProps) {
  return (
    <header className="border-b border-site-border bg-site-surface px-4 pt-4 pb-3 sm:px-6">
      <div className="flex w-full flex-wrap items-center gap-4">
        <span className="text-3xl leading-none text-site-accent" aria-hidden="true">
          絆
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="m-0 text-base font-bold">Kizuna Sync » live demo</h1>
          <p className="mt-1 mb-0 text-sm text-site-muted">
            Two browser databases, one Supabase. Every byte that crosses between them is on this page. Your todos are
            shared with every other visitor and are deleted a few hours after you leave.
          </p>
        </div>
        <div className="flex w-full flex-wrap justify-start gap-2 sm:w-auto sm:shrink-0 sm:justify-end">
          <Tip text="Both panes race one column offline: whichever write reaches the server second wins">
            <Button tone="accent" type="button" disabled={disabled} onClick={onRunConflict}>
              {runningScenario ? 'Running…' : 'Simulate conflict'}
            </Button>
          </Tip>
          <Tip text="Both panes edit different columns offline: column-LWW keeps both writes, no contest">
            <Button type="button" disabled={disabled} onClick={onRunEditAndSoftDelete}>
              Simulate edit + soft delete
            </Button>
          </Tip>
        </div>
      </div>
      <p
        className="mt-3 w-full rounded-lg border border-site-border bg-site-background px-3 py-2 text-xs text-site-muted"
        role="status"
      >
        {status}
      </p>
    </header>
  )
}
