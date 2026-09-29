import type { IInspectorSnapshot, IInspectorVerdict } from '@kizunasync/core'
import type { IQueryLogEntry, TQueryOp } from '@kizunasync/utilities'
import type { TLocaleKey } from '@kizunasync/ui'
import { t } from '../i18n'
import { EThemeColor } from '../theme'

/**
 * Everything the Cache screen shows that is not markup: the traffic-light op
 * colors, the render cap, and the tap-to-explain dialog copy.
 *
 * The screen has two renderings, @expo/ui on native and react-native-web in
 * the browser, and the words a stat explains must be the same in both, so
 * they live here rather than in either component.
 */
// MARK: - Cache screen presentation

/** How many log rows the screen draws at most; the ring behind it is longer. */
export const LOG_RENDER_CAP = 150

// MARK: - Traffic-light op colors

export const OP_COLOR: Record<TQueryOp, string> = {
  SELECT: EThemeColor.info,
  INSERT: EThemeColor.success,
  UPDATE: EThemeColor.warning,
  DELETE: EThemeColor.danger,
  PRAGMA: EThemeColor.faint,
  TX: EThemeColor.faint,
  OTHER: EThemeColor.faint,
}

export const QUEUE_OP_COLOR: Record<string, string> = {
  insert: EThemeColor.success,
  update: EThemeColor.warning,
  delete: EThemeColor.danger,
}

// MARK: - Dialog helpers

export type TStatKey = 'outbox depth' | 'cursor' | 'last mutation id'

/**
 * Every stat's title/body live in @kizunasync/ui's shared i18n dictionary (the
 * same words the React and Vue examples' Cache views show), so the three
 * examples never drift on what a stat explains; this maps the screen's own
 * TStatKey to that dictionary's keys.
 */
const STAT_TRANSLATION_KEYS: Record<TStatKey, { title: TLocaleKey; body: TLocaleKey }> = {
  'outbox depth': { title: 'cache.outboxDepth.title', body: 'cache.outboxDepth.body' },
  cursor: { title: 'cache.cursor.title', body: 'cache.cursor.body' },
  'last mutation id': { title: 'cache.lastMutationId.title', body: 'cache.lastMutationId.body' },
}

export function statTitle(key: TStatKey): string {
  return t(STAT_TRANSLATION_KEYS[key].title)
}

export function statMessage(label: TStatKey, value: string): string {
  return `Current value: ${value}\n\n${t(STAT_TRANSLATION_KEYS[label].body)}`
}

export function queuedMutationMessage(entry: IInspectorSnapshot['queued'][number]): string {
  return [
    `op: ${entry.op}`,
    `table: ${entry.table}`,
    `pk: ${entry.pk}`,
    `mutation id: ${entry.mutationId}`,
    `seq: ${String(entry.seq)}`,
    `created at: ${entry.createdAt}`,
    `in-flight: ${entry.inFlight ? 'yes' : 'no'}`,
    `batch id: ${entry.batchId ?? 'n/a'}`,
    `hlc: ${entry.hlc ?? 'n/a'}`,
    `columns: ${JSON.stringify(entry.columns)}`,
    `precondition: ${entry.precondition !== null ? JSON.stringify(entry.precondition) : 'n/a'}`,
  ].join('\n')
}

export function operationMessage(entry: IQueryLogEntry): string {
  return [
    `op: ${entry.op}`,
    `label: ${entry.label}`,
    `rows: ${entry.rows === null ? 'n/a' : String(entry.rows)}`,
    `duration: ${entry.ms}ms`,
    `seq: ${String(entry.seq)}`,
  ].join('\n')
}

export function formatInspectorVerdict(verdict: IInspectorVerdict): string {
  return [
    `kind: ${verdict.kind}`,
    `mutation id: ${verdict.mutationId}`,
    `reason: ${String(verdict.reason)}`,
    `at: ${verdict.at}`,
  ].join('\n')
}

// MARK: - Sorting

/** Newest-first by ISO createdAt (string compare is correct for ISO-8601). */
export function compareCreated(left: string, right: string): number {
  if (left === right) {
    return 0
  }
  return left > right ? -1 : 1
}
