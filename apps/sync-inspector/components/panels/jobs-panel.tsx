'use client'

import { DataTable, type IDataTableColumn } from '@/components/data-table'
import { InspectorPanel } from '@/components/inspector-panel'
import { MONO_CELL, MONO_NUM_CELL } from '@/components/panels/cell-styles'
import { ScheduleLink } from '@/components/panels/schedule-link'
import { PanelState } from '@/components/panel-state'
import { StatusPill } from '@/components/status-pill'
import { TimeCell } from '@/components/time-cell'
import { crontabGuruUrl } from '@/lib/formatters'
import { type IJobRow, type TPanelState } from '@/lib/inspector-data'
import { ESECTION_ID } from '@/lib/section-defs'
import { useNow } from '@/lib/use-now'

function jobColumns(now: number | null): IDataTableColumn<IJobRow>[] {
  return [
    { key: 'job', header: 'job', cellClassName: MONO_CELL, render: (row) => row.jobname },
    {
      key: 'schedule',
      header: 'schedule',
      cellClassName: 'py-2 pr-3 font-mono text-xs',
      render: (row) => <ScheduleLink schedule={row.schedule} href={crontabGuruUrl(row.schedule)} />,
    },
    {
      key: 'active',
      header: 'active',
      cellClassName: 'py-2 pr-3',
      render: (row) =>
        row.active ? <StatusPill tone="ok">active</StatusPill> : <StatusPill tone="muted">paused</StatusPill>,
    },
    {
      key: 'last-start',
      header: 'last start',
      cellClassName: MONO_NUM_CELL,
      sortValue: (row) => row.last_start ?? '',
      render: (row) =>
        row.last_start === null ? (
          <span className="text-site-faint text-xs" aria-hidden="true" />
        ) : (
          <TimeCell iso={row.last_start} now={now} />
        ),
    },
    {
      key: 'status',
      header: 'status',
      cellClassName: 'py-2 pr-3',
      render: (row) =>
        row.last_status === null ? (
          <span className="text-site-faint text-xs" aria-hidden="true" />
        ) : (
          <StatusPill tone={row.last_status === 'succeeded' ? 'ok' : 'danger'}>{row.last_status}</StatusPill>
        ),
    },
    {
      key: 'message',
      header: 'message',
      cellClassName: 'text-site-muted py-2 pr-3 font-mono text-xs',
      render: (row) =>
        row.last_message === null ? (
          <span className="text-site-faint text-xs" aria-hidden="true" />
        ) : (
          <span className="block max-w-60 truncate" title={row.last_message}>
            {row.last_message}
          </span>
        ),
    },
  ]
}

export function JobsPanel({ state }: { state: TPanelState<IJobRow> }) {
  const now = useNow()
  const meta = state.kind === 'rows' ? `${state.count ?? state.rows.length} jobs` : undefined

  return (
    <InspectorPanel id={ESECTION_ID.JOBS} title="kizunasync.jobs_status()" meta={meta}>
      <PanelState
        state={state}
        notExposedRegistry="the job schedule"
        empty="No scheduled jobs yet. pg_cron is not installed on this stack, so kizunasync._schedule_jobs() has nothing to report."
      >
        {(rows) => (
          <DataTable
            label="Scheduled maintenance jobs"
            rows={rows}
            columns={jobColumns(now)}
            rowKey={(row) => row.jobname}
          />
        )}
      </PanelState>
    </InspectorPanel>
  )
}
