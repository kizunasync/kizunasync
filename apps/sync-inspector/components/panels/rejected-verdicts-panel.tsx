'use client'

import { DataTable, type IDataTableColumn } from '@/components/data-table'
import { InspectorPanel } from '@/components/inspector-panel'
import { MONO_CELL, MONO_NUM_CELL } from '@/components/panels/cell-styles'
import { PanelState } from '@/components/panel-state'
import { StatusPill } from '@/components/status-pill'
import { TimeCell } from '@/components/time-cell'
import { shortId } from '@/lib/formatters'
import { LATEST_LIMIT, type IVerdictRow, type TPanelState } from '@/lib/inspector-data'
import { ESECTION_ID } from '@/lib/section-defs'
import { useNow } from '@/lib/use-now'

function verdictColumns(now: number | null): IDataTableColumn<IVerdictRow>[] {
  return [
    {
      key: 'mutation',
      header: 'mutation',
      cellClassName: MONO_CELL,
      render: (row) => shortId(row.mutation_id),
    },
    {
      key: 'reason',
      header: 'reason',
      cellClassName: 'py-2 pr-3 text-sm',
      render: (row) =>
        row.reason === null ? <span className="text-site-faint text-xs" aria-hidden="true" /> : row.reason,
    },
    {
      key: 'server-row',
      header: 'server row',
      cellClassName: 'py-2 pr-3',
      render: (row) =>
        row.hasServerRow ? (
          <StatusPill tone="gold">present</StatusPill>
        ) : (
          <span className="text-site-faint text-xs" aria-hidden="true" />
        ),
    },
    {
      key: 'recorded',
      header: 'recorded',
      cellClassName: MONO_NUM_CELL,
      sortValue: (row) => row.recorded_at,
      render: (row) => <TimeCell iso={row.recorded_at} now={now} />,
    },
  ]
}

export function RejectedVerdictsPanel({ state }: { state: TPanelState<IVerdictRow> }) {
  const now = useNow()
  const meta =
    state.kind === 'rows'
      ? `${state.count ?? state.rows.length} rejected · latest ${LATEST_LIMIT}`
      : undefined

  return (
    <InspectorPanel id={ESECTION_ID.VERDICTS} title="kizunasync._verdicts: rejected" meta={meta}>
      <PanelState state={state} notExposedRegistry="the verdict ledger" empty="No rejected verdicts.">
        {(rows) => (
          <DataTable
            label="Rejected mutation verdicts"
            rows={rows}
            columns={verdictColumns(now)}
            rowKey={(row) => row.mutation_id}
          />
        )}
      </PanelState>
    </InspectorPanel>
  )
}
