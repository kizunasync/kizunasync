import { EEngineEventType, ERejectReason, type TEngineEvent, type TRejectReason } from '../wire/types'

// MARK: - Verdict → human message

/**
 * Maps an engine event to a user-facing toast message, or null for the events
 * that are not verdicts: LOCAL_CHANGED and QUEUE_DEPTH are internal
 * observability signals. Centralized so the React/Vue bindings and every
 * example app word verdicts identically instead of duplicating the mapping.
 */

/**
 * How loudly a verdict reads. A write that died is `'error'`; a column a peer
 * replaced is `'warning'`, because the write landed and only one of its values
 * lost. The bindings narrow on this: only `'error'` becomes `lastError`.
 */
export const EVerdictLevel = {
  error: 'error',
  warning: 'warning',
} as const
export type TVerdictLevel = (typeof EVerdictLevel)[keyof typeof EVerdictLevel]

export interface IVerdictMessage {
  level: TVerdictLevel
  title: string
  message: string
}

const REJECT_TEXT: Record<TRejectReason, string> = {
  [ERejectReason.RLS_DENIED]: 'You do not have permission to write this row.',
  [ERejectReason.PRECONDITION]: 'The row changed on the server first, so your edit was reverted.',
  [ERejectReason.CONSTRAINT]: 'A database constraint rejected the write.',
  [ERejectReason.DELETE_WINS]: 'The row was deleted on the server, so your edit was dropped.',
  [ERejectReason.SUPERSEDED]: 'A newer write won, so your change was superseded.',
  [ERejectReason.COLUMN_DENIED]: 'The server refused this write: your role cannot change one of the columns it touched.',
}

function reasonText(reason: string): string {
  return REJECT_TEXT[reason as TRejectReason] ?? `Reason: ${reason}`
}

/**
 * How long a losing value may run before it stops being a message and starts
 * being the payload. A title or a note is worth naming; a base64 blob is not.
 */
const LOSER_VALUE_MAX_LENGTH = 40

/**
 * The value this device lost, rendered for a user-facing sentence. A column
 * holds any JSON, so a non-string is JSON-stringified, and a value longer than
 * LOSER_VALUE_MAX_LENGTH is named instead of shown.
 */
function describeLoser(value: unknown): string {
  if (value === null || value === undefined) {
    return 'your empty value'
  }
  const rendered = typeof value === 'string' ? value : JSON.stringify(value)

  if (rendered === undefined || rendered.length > LOSER_VALUE_MAX_LENGTH) {
    return 'your value'
  }
  return `your "${rendered}"`
}

/**
 * Exhaustiveness guard (@../../../../CONVENTIONS.md): every branch below is
 * listed explicitly. A future `TEngineEvent` variant without a matching case
 * fails to narrow to `never`: a compile error, not a silently absorbed null.
 */
function assertNever(value: never): never {
  throw new Error(`verdictToMessage: unhandled engine event type ${JSON.stringify(value)}`)
}

export function verdictToMessage(event: TEngineEvent): IVerdictMessage | null {
  switch (event.type) {
    case EEngineEventType.MUTATION_REJECTED:
      return { level: EVerdictLevel.error, title: 'Write rejected', message: reasonText(event.reason) }
    case EEngineEventType.BATCH_ABORTED:
      return { level: EVerdictLevel.error, title: 'Batch aborted', message: reasonText(event.reason) }
    case EEngineEventType.DEAD_LETTER:
      return { level: EVerdictLevel.error, title: 'Sync gave up', message: `Permanent failure: ${event.reason}` }
    case EEngineEventType.CHECKPOINT_EXPIRED:
      return {
        level: EVerdictLevel.error,
        title: 'Checkpoint expired',
        message: 'The cursor fell behind the server, so the next sync rehydrates the local database.',
      }
    case EEngineEventType.RESET_REQUIRED:
      return {
        level: EVerdictLevel.error,
        title: 'Reset required',
        message: 'The server refused this client, so sync is blocked until reset() runs.',
      }
    case EEngineEventType.COLUMN_OVERWRITTEN:
      return {
        level: EVerdictLevel.warning,
        title: 'Column overwritten',
        message: `Another device won ${event.table}.${event.column}, so ${describeLoser(event.loserValue)} was replaced.`,
      }
    case EEngineEventType.LOCAL_CHANGED:
    case EEngineEventType.QUEUE_DEPTH:
      return null // internal or observability signals, never a user-facing verdict
    default:
      return assertNever(event)
  }
}

/**
 * Subscribe a platform toast presenter to every verdict event. Returns the
 * unsubscribe. The client only needs `.on`, which keeps this independent of
 * the full IKizunaSync surface so any binding or app can wire it.
 */
export function subscribeVerdictToasts(
  client: { on(listener: (event: TEngineEvent) => void): () => void },
  present: (message: IVerdictMessage) => void,
): () => void {
  return client.on((event) => {
    const message = verdictToMessage(event)

    if (message !== null) {
      present(message)
    }
  })
}
