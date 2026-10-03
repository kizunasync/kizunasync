'use client'

import { DataTable, type IDataTableColumn } from '@/components/data-table'
import { InspectorPanel } from '@/components/inspector-panel'
import { MONO_CELL, MONO_NUM_CELL } from '@/components/panels/cell-styles'
import { PanelState } from '@/components/panel-state'
import { StatusPill } from '@/components/status-pill'
import { TimeCell } from '@/components/time-cell'
import { shortId } from '@/lib/formatters'
import { LATEST_LIMIT, type IConflictJournalRow, type TPanelState } from '@/lib/inspector-data'
import { ESECTION_ID } from '@/lib/section-defs'
import { useNow } from '@/lib/use-now'

function conflictJournalColumns(now: number | null): IDataTableColumn<IConflictJournalRow>[] {
  return [
    { key: 'table', header: 'table', cellClassName: MONO_CELL, render: (row) => row.table_name },
    { key: 'pk', header: 'row', cellClassName: MONO_CELL, render: (row) => shortId(row.pk) },
    { key: 'column', header: 'column', cellClassName: MONO_CELL, render: (row) => row.column_name },
    {
      key: 'mode',
      header: 'mode',
      cellClassName: 'py-2 pr-3',
      render: (row) => (
        <StatusPill tone={row.conflict_mode === 'hlc' ? 'accent' : 'muted'}>{row.conflict_mode}</StatusPill>
      ),
    },
    {
      key: 'loser-value',
      header: 'loser value',
      cellClassName: 'text-site-muted py-2 pr-3 font-mono text-xs',
      render: (row) => {
        const text = JSON.stringify(row.loser_value)

        return (
          <span className="block max-w-60 truncate" title={text}>
            {text}
          </span>
        )
      },
    },
    { key: 'winner', header: 'winner mutation', cellClassName: MONO_CELL, render: (row) => shortId(row.winner_mutation_id) },
    {
      key: 'winner-seq',
      header: 'winner step',
      cellClassName: MONO_NUM_CELL,
      sortValue: (row) => row.winner_seq ?? -1,
      render: (row) =>
        row.winner_seq === null ? <span className="text-site-faint text-xs" aria-hidden="true" /> : row.winner_seq,
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

export function ConflictJournalPanel({ state }: { state: TPanelState<IConflictJournalRow> }) {
  const now = useNow()
  const meta =
    state.kind === 'rows'
      ? `${state.count ?? state.rows.length} rows · latest ${LATEST_LIMIT}`
      : undefined

  return (
    <InspectorPanel id={ESECTION_ID.CONFLICT_JOURNAL} title="kizunasync._conflict_journal" meta={meta}>
      <PanelState
        state={state}
        notExposedRegistry="the conflict journal"
        empty="No conflicts recorded yet. Enable _config.conflict_journal for a table, then a same-column overwrite lands here."
      >
        {(rows) => (
          <DataTable
            label="Conflict journal"
            rows={rows}
            columns={conflictJournalColumns(now)}
            rowKey={(row) => String(row.id)}
          />
        )}
      </PanelState>
    </InspectorPanel>
  )
}
