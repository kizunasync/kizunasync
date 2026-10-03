// MARK: - Section definitions

/**
 * The inspector's top-level sections, in page order. One anchor per scroll
 * target, owned here so the page's layout and the nav that spies on it can
 * never drift apart. Changelog and Clients share a row from xl up, and a spy
 * that tracks whichever panel sits nearest the top cannot tell two panels on
 * the same row apart, so the row is one section. Both panels keep their own
 * ids for deep links; those are not scroll-spy targets.
 */
interface ISectionDef {
  id: string
  label: string
}

export const ESECTION_ID = {
  TODOS: 'todos',
  SYNC_INTERNALS: 'sync-internals',
  VERDICTS: 'verdicts',
  SETTINGS: 'settings',
  JOBS: 'jobs',
  RETENTION: 'retention',
  CONFLICT_JOURNAL: 'conflict-journal',
  ATTACHMENTS: 'attachments',
} as const

export const INSPECTOR_SECTIONS = [
  { id: ESECTION_ID.TODOS, label: 'Todos' },
  { id: ESECTION_ID.SYNC_INTERNALS, label: 'Sync internals' },
  { id: ESECTION_ID.VERDICTS, label: 'Verdicts' },
  { id: ESECTION_ID.SETTINGS, label: 'Settings' },
  { id: ESECTION_ID.JOBS, label: 'Jobs' },
  { id: ESECTION_ID.RETENTION, label: 'Retention' },
  { id: ESECTION_ID.CONFLICT_JOURNAL, label: 'Conflict journal' },
  { id: ESECTION_ID.ATTACHMENTS, label: 'Attachments' },
] as const satisfies readonly ISectionDef[]
