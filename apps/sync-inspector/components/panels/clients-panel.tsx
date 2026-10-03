'use client'

import { DataTable, type IDataTableColumn } from '@/components/data-table'
import { InspectorPanel } from '@/components/inspector-panel'
import { MONO_CELL, MONO_NUM_CELL } from '@/components/panels/cell-styles'
import { PanelState } from '@/components/panel-state'
import { StatusPill, type TPillTone } from '@/components/status-pill'
import { TimeCell } from '@/components/time-cell'
import { classifyFreshness, shortId, type TFreshness } from '@/lib/formatters'
import type { IClientRow, TPanelState } from '@/lib/inspector-data'
import { useNow } from '@/lib/use-now'

const FRESHNESS_TONE: Record<TFreshness, TPillTone> = {
  fresh: 'ok',
  idle: 'muted',
  gone: 'danger',
}

/**
 * Built per render rather than declared once: the freshness chip and the "3m
 * ago" cell both read the ticking clock, which only exists on the client.
 */
function clientColumns(now: number | null): IDataTableColumn<IClientRow>[] {
  return [
    {
      key: 'client',
      header: 'client',
      cellClassName: MONO_CELL,
      render: (row) => shortId(row.client_id),
    },
    {
      key: 'state',
      header: 'state',
      cellClassName: 'py-2 pr-3',
      sortValue: (row) => row.last_seen,
      render: (row) => {
        if (now === null) {
          return <span className="text-site-faint text-xs" aria-hidden="true" />
        }
        const freshness = classifyFreshness(row.last_seen, now)

        return <StatusPill tone={FRESHNESS_TONE[freshness]}>{freshness}</StatusPill>
      },
    },
    {
      key: 'user',
      header: 'user',
      cellClassName: 'text-site-muted py-2 pr-3 font-mono text-xs',
      render: (row) => shortId(row.user_id),
    },
    {
      key: 'cursor',
      header: 'cursor',
      cellClassName: 'py-2 pr-3 font-mono text-xs tabular-nums',
      sortValue: (row) => row.cursor,
      render: (row) => row.cursor,
    },
    {
      key: 'last-seen',
      header: 'last seen',
      cellClassName: MONO_NUM_CELL,
      sortValue: (row) => row.last_seen,
      render: (row) => <TimeCell iso={row.last_seen} now={now} />,
    },
  ]
}

export function ClientsPanel({ state }: { state: TPanelState<IClientRow> }) {
  const now = useNow()
  const meta =
    state.kind === 'rows' ? `${state.count ?? state.rows.length} devices` : undefined

  return (
    <InspectorPanel id="clients" title="kizunasync._clients" meta={meta}>
      <PanelState
        state={state}
        notExposedRegistry="the client registry"
        empty="No devices yet. A client registers here the moment it syncs through the kizunasync RPCs with registration enabled."
      >
        {(rows) => (
          <DataTable
            label="Registered sync clients"
            rows={rows}
            columns={clientColumns(now)}
            rowKey={(row) => row.client_id}
          />
        )}
      </PanelState>
    </InspectorPanel>
  )
}
