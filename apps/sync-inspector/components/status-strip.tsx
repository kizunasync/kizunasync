'use client'

import type { ReactNode } from 'react'
import type { TIconName } from '@kizunasync/ui'
import { Icon } from '@/components/icon'
import { LiveRefresh } from '@/components/live-refresh'
import { StatusPill } from '@/components/status-pill'
import { formatCount, formatRelativeTime } from '@/lib/formatters'
import type { IStatusSummary } from '@/lib/inspector-data'
import { useNow } from '@/lib/use-now'

// MARK: - Status strip

/**
 * Every number here is counted server-side over the full table, never inferred
 * from the page of rows a panel happens to show. A metric whose query did not
 * come back reads "n/a": a zero would be a claim the inspector cannot make.
 *
 * The props are the rendered scalars and nothing else, so no panel's rows
 * serialize into this island's payload a second time.
 */
export function StatusStrip({ summary }: { summary: IStatusSummary }) {
  // MARK: - Variables
  const now = useNow()

  // MARK: - render

  return (
    <div className="border-site-border/70 bg-site-surface/60 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border px-3 py-2 text-xs">
      <Metric icon="check" label="pack" value={versionText(summary.packVersion)} />

      <Metric
        icon="database"
        label="tables"
        value={countText(summary.syncedTables)}
        title={summary.syncedTableNames?.join(', ')}
      />

      <Metric icon="cloud" label="clients" value={countText(summary.clients)}>
        {summary.fleet === null ? null : (
          <span className="flex items-center gap-1">
            <StatusPill tone="ok">{formatCount(summary.fleet.fresh)} fresh</StatusPill>
            <StatusPill tone="muted">{formatCount(summary.fleet.idle)} idle</StatusPill>
            <StatusPill tone="danger">{formatCount(summary.fleet.gone)} gone</StatusPill>
          </span>
        )}
      </Metric>

      <Metric icon="databaseSync" label="step" value={stepText(summary.latestStep)} />
      <Metric icon="lightningBolt" label="changes" value={countText(summary.changes)} />

      <span className="ml-auto flex items-center gap-2">
        <span className="text-site-muted flex items-center gap-1.5">
          <Icon name="restore" className="text-site-faint" />
          <span>updated {now === null ? 'n/a' : formatRelativeTime(summary.fetchedAt, now)}</span>
        </span>
        <LiveRefresh />
      </span>
    </div>
  )
}

// MARK: - Pieces

function Metric({
  icon,
  label,
  value,
  title,
  children,
}: {
  icon: TIconName
  label: string
  value: string
  title?: string
  children?: ReactNode
}) {
  return (
    <span className="flex items-center gap-1.5" title={title}>
      <Icon name={icon} className="text-site-faint" />
      <span className="text-site-muted">{label}</span>
      <span className="text-site-text font-mono tabular-nums">{value}</span>
      {children}
    </span>
  )
}

// MARK: - internal

function countText(count: number | null): string {
  return count === null ? 'n/a' : formatCount(count)
}

/**
 * A step is an identifier, not a quantity, so it carries no thousands
 * separator, unlike every other number in the strip.
 */
function stepText(step: number | null): string {
  return step === null ? 'n/a' : `#${String(step)}`
}

function versionText(version: string | null): string {
  return version ?? 'n/a'
}
