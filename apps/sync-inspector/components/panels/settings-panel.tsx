'use client'

import { DataTable, type IDataTableColumn } from '@/components/data-table'
import { InspectorPanel } from '@/components/inspector-panel'
import { MONO_CELL } from '@/components/panels/cell-styles'
import { ScheduleLink } from '@/components/panels/schedule-link'
import { PanelState } from '@/components/panel-state'
import { type ISettingsFieldRow, type ISettingsRow, settingsFieldRows, type TPanelState } from '@/lib/inspector-data'
import { ESECTION_ID } from '@/lib/section-defs'

function settingsColumns(): IDataTableColumn<ISettingsFieldRow>[] {
  return [
    { key: 'field', header: 'setting', cellClassName: MONO_CELL, render: (row) => row.field },
    {
      key: 'value',
      header: 'value',
      cellClassName: 'py-2 pr-3 font-mono text-xs',
      render: (row) => (row.href !== undefined ? <ScheduleLink schedule={row.value} href={row.href} /> : row.value),
    },
  ]
}

export function SettingsPanel({ state }: { state: TPanelState<ISettingsRow> }) {
  return (
    <InspectorPanel id={ESECTION_ID.SETTINGS} title="kizunasync._settings">
      <PanelState
        state={state}
        notExposedRegistry="the deployment settings"
        empty="No settings row yet. kizunasync init writes it on the first provision."
      >
        {(rows) => {
          const settings = rows[0]

          if (settings === undefined) {
            return null
          }
          return (
            <DataTable
              label="Deployment settings"
              rows={settingsFieldRows(settings)}
              columns={settingsColumns()}
              rowKey={(row) => row.field}
            />
          )
        }}
      </PanelState>
    </InspectorPanel>
  )
}
