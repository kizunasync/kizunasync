'use client'

/**
 * The column defs carry render/sortValue functions, non-serializable props,
 * into the HeroUI client DataTable, so the panel must live on the client. The
 * server page only passes serializable `state` (fetched rows).
 */
import { DataTable, type IDataTableColumn } from '@/components/data-table'
import { InspectorPanel } from '@/components/inspector-panel'
import { MONO_NUM_CELL } from '@/components/panels/cell-styles'
import { PanelState } from '@/components/panel-state'
import { StatusPill } from '@/components/status-pill'
import { TimeCell } from '@/components/time-cell'
import { shortId } from '@/lib/formatters'
import { LATEST_LIMIT, type ITodoRow, type TPanelState } from '@/lib/inspector-data'
import { ESECTION_ID } from '@/lib/section-defs'
import { useNow } from '@/lib/use-now'

function todoColumns(now: number | null): IDataTableColumn<ITodoRow>[] {
  return [
    {
      key: 'title',
      header: 'title',
      cellClassName: 'py-2 pr-3 text-sm',
      sortValue: (row) => row.title.toLowerCase(),
      render: (row) => (
        <span
          className={`block max-w-80 truncate ${
            row.deleted_at !== null ? 'text-site-muted line-through' : 'text-site-text/90'
          }`}
        >
          {row.title}
        </span>
      ),
    },
    {
      key: 'done',
      header: 'status',
      cellClassName: 'py-2 pr-3',
      sortValue: (row) => (row.done ? 1 : 0),
      render: (row) =>
        row.done ? (
          <StatusPill tone="ok">done</StatusPill>
        ) : (
          <StatusPill tone="muted">open</StatusPill>
        ),
    },
    {
      key: 'updated',
      header: 'updated',
      cellClassName: MONO_NUM_CELL,
      sortValue: (row) => row.updated_at,
      render: (row) => <TimeCell iso={row.updated_at} now={now} />,
    },
    {
      key: 'owner',
      header: 'owner',
      cellClassName: 'text-site-muted py-2 pr-3 font-mono text-xs',
      render: (row) => shortId(row.user_id),
    },
    {
      key: 'image',
      header: 'img',
      cellClassName: 'py-2 pr-3',
      render: (row) =>
        row.image_path !== null ? (
          <StatusPill tone="gold">img</StatusPill>
        ) : (
          <span className="text-site-faint text-xs" aria-hidden="true" />
        ),
    },
  ]
}

export function TodosPanel({ state }: { state: TPanelState<ITodoRow> }) {
  const now = useNow()
  const meta =
    state.kind === 'rows'
      ? `${state.count ?? state.rows.length} rows · latest ${LATEST_LIMIT}`
      : undefined

  return (
    <InspectorPanel id={ESECTION_ID.TODOS} title="public.todos" meta={meta}>
      <PanelState
        state={state}
        notExposedRegistry="the synced-table configuration"
        empty={
          <span>
            No todos yet. Add one in the example app with{' '}
            <code className="font-mono">bun run dev</code>.
          </span>
        }
      >
        {(rows) => (
          <DataTable
            label="Latest public todos"
            rows={rows}
            columns={todoColumns(now)}
            rowKey={(row) => row.id}
          />
        )}
      </PanelState>
    </InspectorPanel>
  )
}
