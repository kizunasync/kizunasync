/**
 * Maps one kizunasync._changelog row to ONE sentence teaching what the entry
 * MEANS for the fleet: the changelog is the pull feed, so an entry always
 * answers "who sees this, and when". The row and its arrival time have their
 * own columns and are never restated here.
 *
 * The row records neither who wrote it nor which columns moved, so no sentence
 * claims either.
 */

import type { IChangelogRow } from '@/lib/inspector-data'

// MARK: - Changelog row → plain-English explanation

export const ECHANGE_OP = {
  UPSERT: 'upsert',
  DELETE: 'delete',
} as const

export type TChangeOp = (typeof ECHANGE_OP)[keyof typeof ECHANGE_OP]

/**
 * `op` crosses the wire as a plain string; the pack's CHECK constraint is the
 * only thing keeping it to two values, so it is narrowed, never asserted.
 */
function isChangeOp(op: string): op is TChangeOp {
  return op === ECHANGE_OP.UPSERT || op === ECHANGE_OP.DELETE
}

export function describeChange(row: IChangelogRow): string {
  const table = row.table_name
  const step = String(row.seq)

  if (!isChangeOp(row.op)) {
    return `an unrecognized operation "${row.op}" landed on ${table}: clients see it once their cursor passes step ${step}`
  }

  switch (row.op) {
    case ECHANGE_OP.UPSERT:
      return `a write landed on ${table}: clients pull it once their cursor passes step ${step}`
    case ECHANGE_OP.DELETE:
      return `a delete landed on ${table}: clients drop the row when their cursor passes step ${step}`
    default:
      return assertNeverOp(row.op)
  }
}

// MARK: - Exhaustiveness guard

function assertNeverOp(value: never): never {
  throw new Error(`describeChange: unhandled changelog op ${JSON.stringify(value)}`)
}
