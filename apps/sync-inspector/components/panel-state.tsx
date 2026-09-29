import type { ReactNode } from 'react'
import { EmptyState } from '@heroui/react/empty-state'
import type { TPanelState } from '@/lib/inspector-data'

// MARK: - State frame

/**
 * A shared, on-brand container for every non-row panel state: a calm dashed
 * hairline box with muted copy, so empty / unreachable / error / not-exposed
 * all read as one coherent family rather than stray paragraphs.
 */
function StateFrame({ children }: { children: ReactNode }) {
  return (
    <div className="border-site-border/60 bg-site-raised/15 text-site-muted m-2 flex min-h-24 flex-col items-start justify-center gap-1 rounded-lg border border-dashed px-4 py-5 text-sm leading-relaxed">
      {children}
    </div>
  )
}

// MARK: - Component

export function PanelState<TRow>({
  state,
  empty,
  notExposedRegistry,
  children,
}: {
  state: TPanelState<TRow>
  empty: ReactNode
  notExposedRegistry: string
  children: (rows: TRow[]) => ReactNode
}) {
  if (state.kind === 'not-exposed') {
    return (
      <StateFrame>
        <span className="text-site-text/80 font-medium">Schema not API-exposed</span>
        <span>
          PostgREST answered <code className="font-mono">PGRST106</code>, so {notExposedRegistry}{' '}
          cannot be read. Add <code className="font-mono">kizunasync</code> to{' '}
          <code className="font-mono">[api].schemas</code> in{' '}
          <code className="font-mono">supabase/config.toml</code>, then push the config to the
          project (or restart the local stack) and this panel fills in.
        </span>
      </StateFrame>
    )
  }

  if (state.kind === 'unreachable') {
    return (
      <StateFrame>
        <span className="text-site-text/80 font-medium">Local Supabase unreachable</span>
        <span>See the alert above to start the stack, then it refreshes on its own.</span>
      </StateFrame>
    )
  }

  if (state.kind === 'error') {
    return (
      <StateFrame>
        <span className="text-site-text/80 font-medium">Query failed</span>
        <code className="text-site-muted font-mono text-xs">{state.detail}</code>
      </StateFrame>
    )
  }

  if (state.rows.length === 0) {
    return (
      <EmptyState className="text-site-muted m-2 min-h-24 items-start justify-center text-sm leading-relaxed">
        {empty}
      </EmptyState>
    )
  }

  return children(state.rows)
}
