'use client'

import { DataTable, type IDataTableColumn } from '@/components/data-table'
import { InspectorPanel } from '@/components/inspector-panel'
import { MONO_CELL, MONO_NUM_CELL } from '@/components/panels/cell-styles'
import { PanelState } from '@/components/panel-state'
import { StatusPill } from '@/components/status-pill'
import { TimeCell } from '@/components/time-cell'
import { formatBytes } from '@/lib/formatters'
import { LATEST_LIMIT, type IAttachmentRow, type TPanelState } from '@/lib/inspector-data'
import { ESECTION_ID } from '@/lib/section-defs'
import { useNow } from '@/lib/use-now'

function attachmentColumns(now: number | null): IDataTableColumn<IAttachmentRow>[] {
  return [
    { key: 'bucket', header: 'bucket', cellClassName: MONO_CELL, render: (row) => row.bucket_id },
    {
      key: 'path',
      header: 'path',
      cellClassName: 'py-2 pr-3 font-mono text-xs',
      render: (row) => (
        <span className="block max-w-80 truncate" title={row.object_path}>
          {row.object_path}
        </span>
      ),
    },
    {
      key: 'size',
      header: 'size',
      cellClassName: MONO_NUM_CELL,
      sortValue: (row) => row.size ?? -1,
      render: (row) =>
        row.size === null ? <span className="text-site-faint text-xs" aria-hidden="true" /> : formatBytes(row.size),
    },
    {
      key: 'media-type',
      header: 'media type',
      cellClassName: 'text-site-muted py-2 pr-3 font-mono text-xs',
      render: (row) =>
        row.media_type ?? <span className="text-site-faint text-xs" aria-hidden="true" />,
    },
    {
      key: 'sha',
      header: 'sha',
      cellClassName: 'py-2 pr-3',
      render: (row) =>
        row.sha256 !== null ? (
          <StatusPill tone="ok">present</StatusPill>
        ) : (
          <span className="text-site-faint text-xs" aria-hidden="true" />
        ),
    },
    {
      key: 'created',
      header: 'created',
      cellClassName: MONO_NUM_CELL,
      sortValue: (row) => row.created_at,
      render: (row) => <TimeCell iso={row.created_at} now={now} />,
    },
    {
      key: 'updated',
      header: 'updated',
      cellClassName: MONO_NUM_CELL,
      sortValue: (row) => row.updated_at,
      render: (row) => <TimeCell iso={row.updated_at} now={now} />,
    },
  ]
}

export function AttachmentsPanel({ state }: { state: TPanelState<IAttachmentRow> }) {
  const now = useNow()
  const meta =
    state.kind === 'rows'
      ? `${state.count ?? state.rows.length} rows · latest ${LATEST_LIMIT}`
      : undefined

  return (
    <InspectorPanel id={ESECTION_ID.ATTACHMENTS} title="kizunasync.attachments" meta={meta}>
      <PanelState
        state={state}
        notExposedRegistry="the attachment registry"
        empty="No attachments confirmed yet. An upload appears here once attachment_confirm records it."
      >
        {(rows) => (
          <DataTable
            label="Confirmed attachments"
            rows={rows}
            columns={attachmentColumns(now)}
            rowKey={(row) => row.id}
          />
        )}
      </PanelState>
    </InspectorPanel>
  )
}
