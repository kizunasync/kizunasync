'use client'

import { DataTable, type IDataTableColumn } from '@/components/data-table'
import { InspectorPanel } from '@/components/inspector-panel'
import { MONO_CELL, MONO_NUM_CELL } from '@/components/panels/cell-styles'
import { PanelState } from '@/components/panel-state'
import { TimeCell } from '@/components/time-cell'
import { formatCount } from '@/lib/formatters'
import { type IReapStateRow, type ITombstoneTableCount, type TPanelState } from '@/lib/inspector-data'
import { ESECTION_ID } from '@/lib/section-defs'
import { useNow } from '@/lib/use-now'

function tombstoneTableColumns(): IDataTableColumn<ITombstoneTableCount>[] {
  return [
    { key: 'table', header: 'table', cellClassName: MONO_CELL, render: (row) => row.table_name },
    {
      key: 'count',
      header: 'tombstones',
      cellClassName: MONO_NUM_CELL,
      sortValue: (row) => row.count,
      render: (row) => formatCount(row.count),
    },
  ]
}

function ReapWatermark({ state, now }: { state: TPanelState<IReapStateRow>; now: number | null }) {
  if (state.kind !== 'rows') {
    return null
  }
  const row = state.rows[0]

  if (row === undefined) {
    return null
  }
  return (
    <div className="text-site-muted flex flex-wrap items-center gap-x-4 gap-y-1 px-3 pt-2 pb-1 font-mono text-xs">
      <span>watermark seq {row.reaped_seq}</span>
      <span>
        last reap {row.reaped_at === null ? 'never' : <TimeCell iso={row.reaped_at} now={now} />}
      </span>
    </div>
  )
}

export function RetentionPanel({
  reapState,
  tombstonesByTable,
  changelogRowCount,
}: {
  reapState: TPanelState<IReapStateRow>
  tombstonesByTable: TPanelState<ITombstoneTableCount>
  changelogRowCount: number | null
}) {
  const now = useNow()
  const meta =
    tombstonesByTable.kind === 'rows'
      ? `${tombstonesByTable.count ?? tombstonesByTable.rows.length} tables · ${
          changelogRowCount === null ? 'n/a' : formatCount(changelogRowCount)
        } changelog rows`
      : undefined

  return (
    <InspectorPanel id={ESECTION_ID.RETENTION} title="Retention" meta={meta}>
      <ReapWatermark state={reapState} now={now} />
      <PanelState
        state={tombstonesByTable}
        notExposedRegistry="the retention registry"
        empty="No tombstones recorded yet. A delete on a synced table lands here until it is reaped."
      >
        {(rows) => (
          <DataTable
            label="Tombstones by table"
            rows={rows}
            columns={tombstoneTableColumns()}
            rowKey={(row) => row.table_name}
          />
        )}
      </PanelState>
    </InspectorPanel>
  )
}
