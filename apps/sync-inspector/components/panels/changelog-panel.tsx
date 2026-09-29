'use client'

import { ChangelogLog } from '@/components/changelog-log'
import { InspectorPanel } from '@/components/inspector-panel'
import { PanelState } from '@/components/panel-state'
import { LATEST_LIMIT, type IChangelogRow, type TPanelState } from '@/lib/inspector-data'

export function ChangelogPanel({ state }: { state: TPanelState<IChangelogRow> }) {
  const meta =
    state.kind === 'rows'
      ? `${state.count ?? state.rows.length} entries · latest ${LATEST_LIMIT}`
      : undefined

  return (
    <InspectorPanel id="changelog" title="kizunasync._changelog" meta={meta}>
      <PanelState
        state={state}
        notExposedRegistry="the change-tracking registry"
        empty="No changes tracked yet. public.todos is provisioned with track triggers: write or sync a todo and it appears here."
      >
        {(rows) => <ChangelogLog rows={rows} />}
      </PanelState>
    </InspectorPanel>
  )
}
