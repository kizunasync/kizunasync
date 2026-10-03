/**
 * The status strip reads only this summary, so the honesty rule is pinned
 * here: a metric whose query failed stays null and renders "n/a", never 0.
 */

import { describe, expect, test } from 'bun:test'
import { mergeChangelogFeed, reconcileTombstoneCounts, settingsFieldRows, summarizeInspectorData, toJobRow, toVerdictRow, type IChangelogRow, type IInspectorData, type ITombstoneRow } from './inspector-data'

// MARK: - Helpers

const CHANGELOG_ROWS: IChangelogRow[] = [
  { seq: 8733, table_name: 'todos', pk: 'f4a473af', op: 'upsert', arrived_at: '2026-08-06T08:15:34Z' },
  { seq: 8732, table_name: 'todos', pk: 'bbbbbbbb', op: 'upsert', arrived_at: '2026-08-06T08:15:30Z' },
]

const HEALTHY: IInspectorData = {
  todos: { kind: 'rows', rows: [], count: 3 },
  clients: { kind: 'rows', rows: [], count: 4 },
  changelog: { kind: 'rows', rows: CHANGELOG_ROWS, count: 114 },
  tombstones: { kind: 'rows', rows: [], count: 0 },
  rejectedVerdicts: { kind: 'rows', rows: [], count: 0 },
  config: { kind: 'rows', rows: [{ table_name: 'todos', sync_mode: 'read-write', conflict_mode: 'arrival' }], count: 1 },
  fleet: { fresh: 2, idle: 0, gone: 2 },
  packVersion: '0.2.6-alpha.2',
  settings: { kind: 'rows', rows: [], count: 1 },
  jobs: { kind: 'rows', rows: [], count: 3 },
  reapState: { kind: 'rows', rows: [], count: 1 },
  tombstonesByTable: { kind: 'rows', rows: [], count: 0 },
  changelogRowCount: 114,
  conflictJournal: { kind: 'rows', rows: [], count: 0 },
  attachments: { kind: 'rows', rows: [], count: 0 },
  fetchedAt: '2026-08-06T08:16:00Z',
}

// MARK: - Summary

describe('summarizeInspectorData', () => {
  test('reads the counts, the newest step and the pack version off a healthy snapshot', () => {
    const summary = summarizeInspectorData(HEALTHY)

    expect(summary).toEqual({
      packVersion: '0.2.6-alpha.2',
      syncedTables: 1,
      syncedTableNames: ['todos'],
      clients: 4,
      fleet: { fresh: 2, idle: 0, gone: 2 },
      latestStep: 8733,
      changes: 114,
      fetchedAt: '2026-08-06T08:16:00Z',
    })
  })

  test('a failed query stays null rather than collapsing to zero', () => {
    const summary = summarizeInspectorData({
      ...HEALTHY,
      changelog: { kind: 'error', detail: '42501: permission denied' },
      config: { kind: 'not-exposed' },
      clients: { kind: 'unreachable', detail: 'fetch failed' },
      fleet: null,
      packVersion: null,
    })

    expect(summary.changes).toBeNull()
    expect(summary.latestStep).toBeNull()
    expect(summary.syncedTables).toBeNull()
    expect(summary.syncedTableNames).toBeNull()
    expect(summary.clients).toBeNull()
    expect(summary.fleet).toBeNull()
    expect(summary.packVersion).toBeNull()
  })

  test('an empty changelog has no newest step to report', () => {
    const summary = summarizeInspectorData({
      ...HEALTHY,
      changelog: { kind: 'rows', rows: [], count: 0 },
    })

    expect(summary.latestStep).toBeNull()
    expect(summary.changes).toBe(0)
  })
})

// MARK: - Changelog + tombstone merge

const TOMBSTONE_ROWS: ITombstoneRow[] = [
  { table_name: 'todos', pk: 'cccccccc', seq: 8734, deleted_at: '2026-08-06T08:15:36Z' },
  { table_name: 'todos', pk: 'dddddddd', seq: 8700, deleted_at: '2026-08-06T08:10:00Z' },
]

describe('mergeChangelogFeed', () => {
  test('interleaves tombstone deletes with changelog upserts, newest first', () => {
    const merged = mergeChangelogFeed(
      { kind: 'rows', rows: CHANGELOG_ROWS, count: 2 },
      { kind: 'rows', rows: TOMBSTONE_ROWS, count: 2 },
    )

    expect(merged).toEqual({
      kind: 'rows',
      count: 4,
      rows: [
        { seq: 8734, table_name: 'todos', pk: 'cccccccc', op: 'delete', arrived_at: '2026-08-06T08:15:36Z' },
        { seq: 8733, table_name: 'todos', pk: 'f4a473af', op: 'upsert', arrived_at: '2026-08-06T08:15:34Z' },
        { seq: 8732, table_name: 'todos', pk: 'bbbbbbbb', op: 'upsert', arrived_at: '2026-08-06T08:15:30Z' },
        { seq: 8700, table_name: 'todos', pk: 'dddddddd', op: 'delete', arrived_at: '2026-08-06T08:10:00Z' },
      ],
    })
  })

  test('a changelog failure is surfaced rather than dropping tombstones silently', () => {
    const merged = mergeChangelogFeed(
      { kind: 'error', detail: '42501: permission denied' },
      { kind: 'rows', rows: TOMBSTONE_ROWS, count: 2 },
    )

    expect(merged).toEqual({ kind: 'error', detail: '42501: permission denied' })
  })

  test('a tombstone failure is surfaced even when the changelog itself is healthy', () => {
    const merged = mergeChangelogFeed({ kind: 'rows', rows: CHANGELOG_ROWS, count: 2 }, { kind: 'not-exposed' })

    expect(merged).toEqual({ kind: 'not-exposed' })
  })
})

// MARK: - Verdict row narrowing

describe('toVerdictRow', () => {
  test('a rejected verdict whose reason carries a server row reads as present, though the ledger stores none', () => {
    const row = toVerdictRow({
      mutation_id: 'a1a1a1a1-0000-0000-0000-000000000000',
      recorded_at: '2026-08-06T08:17:00Z',
      verdict: { verdict: 'rejected', reason: 'PRECONDITION', server_row: null },
    })

    expect(row).toEqual({
      mutation_id: 'a1a1a1a1-0000-0000-0000-000000000000',
      recorded_at: '2026-08-06T08:17:00Z',
      reason: 'PRECONDITION',
      hasServerRow: true,
    })
  })

  test('every reason but DELETE_WINS carries a server row', () => {
    const presence = ['PRECONDITION', 'RLS_DENIED', 'COLUMN_DENIED', 'CONSTRAINT', 'SUPERSEDED', 'DELETE_WINS'].map((reason) => [
      reason,
      toVerdictRow({
        mutation_id: 'b2b2b2b2-0000-0000-0000-000000000000',
        recorded_at: '2026-08-06T08:18:00Z',
        verdict: { verdict: 'rejected', reason, server_row: null },
      }).hasServerRow,
    ])

    expect(presence).toEqual([
      ['PRECONDITION', true],
      ['RLS_DENIED', true],
      ['COLUMN_DENIED', true],
      ['CONSTRAINT', true],
      ['SUPERSEDED', true],
      ['DELETE_WINS', false],
    ])
  })

  test('a reason outside the closed union reads as absent, whatever the stored row', () => {
    const row = toVerdictRow({
      mutation_id: 'b2b2b2b2-0000-0000-0000-000000000000',
      recorded_at: '2026-08-06T08:18:00Z',
      verdict: { verdict: 'rejected', reason: 'unknown table', server_row: { id: '1', title: 'x' } },
    })

    expect(row.hasServerRow).toBe(false)
    expect(row.reason).toBe('unknown table')
  })

  test('an unrecognized verdict shape degrades to a row with no reason, never throws', () => {
    const row = toVerdictRow({
      mutation_id: 'c3c3c3c3-0000-0000-0000-000000000000',
      recorded_at: '2026-08-06T08:19:00Z',
      verdict: { verdict: 'applied' },
    })

    expect(row.reason).toBeNull()
    expect(row.hasServerRow).toBe(false)
  })
})

// MARK: - Settings transpose

describe('settingsFieldRows', () => {
  test('carries every column, schedules with a crontab.guru href', () => {
    const rows = settingsFieldRows({
      id: true,
      max_batch_size: 200,
      require_atomic: true,
      reap_schedule: '16 3 * * *',
      compact_schedule: '47 3 * * *',
      client_prune_schedule: '31 3 * * *',
      client_ttl_days: 90,
      hlc_max_skew_ms: 5000,
      tombstone_ttl_days: 30,
      max_pull_scan: 5000,
    })

    expect(rows).toEqual([
      { field: 'id', value: 'true' },
      { field: 'max_batch_size', value: '200' },
      { field: 'require_atomic', value: 'true' },
      { field: 'reap_schedule', value: '16 3 * * *', href: 'https://crontab.guru/#16_3_*_*_*' },
      { field: 'compact_schedule', value: '47 3 * * *', href: 'https://crontab.guru/#47_3_*_*_*' },
      { field: 'client_prune_schedule', value: '31 3 * * *', href: 'https://crontab.guru/#31_3_*_*_*' },
      { field: 'client_ttl_days', value: '90 days' },
      { field: 'hlc_max_skew_ms', value: '5000 ms' },
      { field: 'tombstone_ttl_days', value: '30 days' },
      { field: 'max_pull_scan', value: '5,000 candidates' },
    ])
  })

  test('an unset max_batch_size reads as unlimited, not zero or blank', () => {
    const rows = settingsFieldRows({
      id: true,
      max_batch_size: null,
      require_atomic: false,
      reap_schedule: '16 3 * * *',
      compact_schedule: '47 3 * * *',
      client_prune_schedule: '31 3 * * *',
      client_ttl_days: 90,
      hlc_max_skew_ms: 5000,
      tombstone_ttl_days: 30,
      max_pull_scan: 5000,
    })

    expect(rows.find((row) => row.field === 'max_batch_size')?.value).toBe('unlimited')
  })
})

// MARK: - Jobs

describe('toJobRow', () => {
  test('carries every column jobs_status() returns', () => {
    const row = toJobRow({
      jobname: 'kizunasync-reap-tombstones',
      schedule: '16 3 * * *',
      active: true,
      last_start: '2026-09-11T03:16:00Z',
      last_status: 'succeeded',
      last_message: 'reaped 0 tombstones',
    })

    expect(row).toEqual({
      jobname: 'kizunasync-reap-tombstones',
      schedule: '16 3 * * *',
      active: true,
      last_start: '2026-09-11T03:16:00Z',
      last_status: 'succeeded',
      last_message: 'reaped 0 tombstones',
    })
  })

  test('a job that has never run carries null run fields, not fabricated ones', () => {
    const row = toJobRow({
      jobname: 'kizunasync-prune-clients',
      schedule: '31 3 * * *',
      active: true,
      last_start: null,
      last_status: null,
      last_message: null,
    })

    expect(row.last_start).toBeNull()
    expect(row.last_status).toBeNull()
    expect(row.last_message).toBeNull()
  })
})

// MARK: - Retention: tombstones reconciled by table

describe('reconcileTombstoneCounts', () => {
  test('drops a zero-count table rather than showing an empty row', () => {
    const rows = reconcileTombstoneCounts(5, [
      { table_name: 'todos', count: 5 },
      { table_name: 'notes', count: 0 },
    ])

    expect(rows).toEqual([{ table_name: 'todos', count: 5 }])
  })

  test('sorts by count descending, ties broken by table name', () => {
    const rows = reconcileTombstoneCounts(7, [
      { table_name: 'todos', count: 3 },
      { table_name: 'attachments', count: 3 },
      { table_name: 'notes', count: 1 },
    ])

    expect(rows).toEqual([
      { table_name: 'attachments', count: 3 },
      { table_name: 'todos', count: 3 },
      { table_name: 'notes', count: 1 },
    ])
  })

  test('a tombstone whose table left _config is never silently dropped', () => {
    const rows = reconcileTombstoneCounts(9, [{ table_name: 'todos', count: 5 }])

    expect(rows).toEqual([
      { table_name: 'todos', count: 5 },
      { table_name: '(unconfigured tables)', count: 4 },
    ])
  })

  test('an exact match between the total and the known tables adds no remainder row', () => {
    const rows = reconcileTombstoneCounts(5, [{ table_name: 'todos', count: 5 }])

    expect(rows).toEqual([{ table_name: 'todos', count: 5 }])
  })
})
