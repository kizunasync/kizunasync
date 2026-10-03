import { InspectorShell } from '@/components/inspector-shell'
import { AttachmentsPanel } from '@/components/panels/attachments-panel'
import { ChangelogPanel } from '@/components/panels/changelog-panel'
import { ClientsPanel } from '@/components/panels/clients-panel'
import { ConflictJournalPanel } from '@/components/panels/conflict-journal-panel'
import { JobsPanel } from '@/components/panels/jobs-panel'
import { RejectedVerdictsPanel } from '@/components/panels/rejected-verdicts-panel'
import { RetentionPanel } from '@/components/panels/retention-panel'
import { SettingsPanel } from '@/components/panels/settings-panel'
import { TodosPanel } from '@/components/panels/todos-panel'
import { MissingKeyCard, StackDownAlert } from '@/components/setup-state'
import { StatusStrip } from '@/components/status-strip'
import { loadInspectorData, mergeChangelogFeed, summarizeInspectorData } from '@/lib/inspector-data'
import { ESECTION_ID } from '@/lib/section-defs'
import { createInspectorClient } from '@/lib/supabase-inspector'

// MARK: - Page

export const dynamic = 'force-dynamic'

export default async function InspectorHome() {
  const supabase = createInspectorClient()

  if (supabase === null) {
    return (
      <InspectorShell>
        <MissingKeyCard />
      </InspectorShell>
    )
  }

  const data = await loadInspectorData(supabase)

  return (
    <InspectorShell>
      {data.todos.kind === 'unreachable' ? (
        <StackDownAlert detail={data.todos.detail} />
      ) : null}
      <div className="grid gap-4">
        <StatusStrip summary={summarizeInspectorData(data)} />
        <TodosPanel state={data.todos} />
        <div id={ESECTION_ID.SYNC_INTERNALS} className="grid gap-4 xl:grid-cols-2">
          <ChangelogPanel state={mergeChangelogFeed(data.changelog, data.tombstones)} />
          <ClientsPanel state={data.clients} />
        </div>
        <RejectedVerdictsPanel state={data.rejectedVerdicts} />
        <SettingsPanel state={data.settings} />
        <JobsPanel state={data.jobs} />
        <RetentionPanel
          reapState={data.reapState}
          tombstonesByTable={data.tombstonesByTable}
          changelogRowCount={data.changelogRowCount}
        />
        <ConflictJournalPanel state={data.conflictJournal} />
        <AttachmentsPanel state={data.attachments} />
      </div>
    </InspectorShell>
  )
}
