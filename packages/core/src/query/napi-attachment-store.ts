// MARK: - IAttachmentStore over the NAPI bridge

/**
 * The attachment queue is not reimplemented for the Rust engine. The
 * TypeScript queue in `host/attachment-queue.ts` keeps driving the bytes:
 * that is where the app injected `IFileStore` and `ITransfer`, and where the
 * Expo / web / Supabase adapters already work. Its durable rows move here,
 * into the Rust `_kizunasync_attachments`.
 *
 * A second queue writing its own copy of the table would give one client two
 * claim owners and two orphan sets: a superseded object could be uploaded by
 * one and GC'd by the other. With the Rust store as the single writer, the
 * pull-apply and the push verdicts (which orphan or evict the refs they drop
 * and schedule peer downloads inside their transaction) and the queue see one
 * queue.
 *
 * Every method is one RPC. The wire is snake_case and calls the object key
 * `reference`; the camelCase `ref` shape below is what the queue speaks.
 */

import type { IAttachmentStore, TAttachmentEntry, TAttachmentInsert, TAttachmentPatch } from '../host/attachment-queue'
import type { TAttachmentState, TColumnValues } from '../wire/types'

// MARK: - Wire shapes

type TRustAttachmentEntry = {
  reference: string
  upload_id: string
  table: string
  pk: string
  column: string
  bucket: string
  owner: string
  sha256: string | null
  content_type: string | null
  size: number | null
  local_path: string | null
  direction: string
  state: string
  in_flight: boolean
  fingerprint: string | null
  progress: number
  attempts: number
  permanent: boolean
  error: string | null
  error_code: string | null
  created_at: string
  updated_at: string
}

const toEntry = (raw: TRustAttachmentEntry): TAttachmentEntry => ({
  ref: raw.reference,
  uploadId: raw.upload_id,
  table: raw.table,
  pk: raw.pk,
  column: raw.column,
  bucket: raw.bucket,
  owner: raw.owner,
  sha256: raw.sha256,
  contentType: raw.content_type,
  size: raw.size,
  localPath: raw.local_path,
  direction: raw.direction === 'download' ? 'download' : 'upload',
  state: raw.state as TAttachmentState,
  inFlight: raw.in_flight,
  fingerprint: raw.fingerprint,
  progress: raw.progress,
  attempts: raw.attempts,
  permanent: raw.permanent,
  error: raw.error,
  errorCode: raw.error_code,
  createdAt: raw.created_at,
  updatedAt: raw.updated_at,
})

/**
 * Patch fields the store may set, keyed by the COLUMN the Rust store patches.
 * An `undefined` field is omitted (left untouched); an explicit `null` clears
 * the column, the same distinction `updateAttachment` draws in
 * `host/attachment-queue.ts`.
 */
const toPatchColumns = (patch: TAttachmentPatch): Record<string, unknown> => {
  const columns: Record<string, unknown> = {}
  const assignments: [string, unknown][] = [
    ['state', patch.state],
    ['progress', patch.progress],
    ['fingerprint', patch.fingerprint],
    ['sha256', patch.sha256],
    ['size', patch.size],
    ['content_type', patch.contentType],
    ['local_path', patch.localPath],
    ['error', patch.error],
    ['error_code', patch.errorCode],
    ['attempts', patch.attempts],
    ['in_flight', patch.inFlight],
    ['permanent', patch.permanent],
  ]

  for (const [column, value] of assignments) {
    if (value !== undefined) {
      columns[column] = value
    }
  }
  return columns
}

// MARK: - Factory

export type TEngineCall = (method: string, params?: Record<string, unknown>) => Promise<unknown>

/**
 * `now` is NOT forwarded: every `call` already carries the engine's injected
 * clock (`createRustEngine` stamps it on the envelope), and the Rust store reads
 * that pinned value. Forwarding the queue's copy as well would let the two
 * disagree on a frozen-clock test. That is also why
 * `recoverInFlightAttachments` ignores its `now` argument.
 */
export const createNapiAttachmentStore = (call: TEngineCall): IAttachmentStore => ({
  getRow: async (table, pk) => {
    const row = (await call('read', { table, pk })) as { columns: TColumnValues } | null

    return row === null ? null : row.columns
  },
  hasTombstone: async (table, pk) => (await call('has_tombstone', { table, pk })) as boolean,
  enqueueAttachment: async (entry: TAttachmentInsert) => {
    await call('attachment_put', {
      reference: entry.ref,
      upload_id: entry.uploadId,
      table: entry.table,
      pk: entry.pk,
      column: entry.column,
      bucket: entry.bucket,
      owner: entry.owner,
      sha256: entry.sha256 ?? null,
      content_type: entry.contentType ?? null,
      size: entry.size ?? null,
      local_path: entry.localPath ?? null,
      direction: entry.direction,
      state: entry.state,
      created_at: entry.createdAt,
    })
  },
  getAttachment: async (ref) => {
    const raw = (await call('attachment_get', { reference: ref })) as TRustAttachmentEntry | null

    return raw === null ? null : toEntry(raw)
  },
  pendingAttachments: async (direction) => {
    const raw = (await call('attachment_pending', { direction })) as TRustAttachmentEntry[]

    return raw.map(toEntry)
  },
  claimAttachment: async (ref, state) =>
    (await call('attachment_claim', { reference: ref, state })) as boolean,
  updateAttachment: async (ref, patch) => {
    await call('attachment_patch', { reference: ref, patch: toPatchColumns(patch) })
  },
  markAttachmentOrphaned: async (ref) => {
    await call('attachment_orphan', { reference: ref })
  },
  orphanedAttachments: async () => {
    const raw = (await call('attachment_orphaned')) as TRustAttachmentEntry[]

    return raw.map(toEntry)
  },
  purgeAttachment: async (ref) => {
    await call('attachment_purge', { reference: ref })
  },
  retryAttachment: async (ref) =>
    (await call('attachment_retry', { reference: ref })) as boolean,
  cancelAttachment: async (ref) =>
    (await call('attachment_cancel', { reference: ref })) as boolean,
  removeAttachment: async (ref) =>
    (await call('attachment_remove', { reference: ref })) as string | null,
  recoverInFlightAttachments: async () => {
    await call('attachment_recover')
  },
  countLiveAttachmentsAtLocalPath: async (localPath, excludingRef) =>
    (await call('attachment_count_at_path', {
      local_path: localPath,
      excluding_reference: excludingRef ?? null,
    })) as number,
})
