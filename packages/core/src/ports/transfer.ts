// MARK: - Transfer port

/**
 * Upload/download transport. Adapters can change (storage-js ≤6 MiB and TUS
 * >6 MiB) without touching the engine. A resumable adapter announces its
 * session token through `onSessionCreated` before the first byte moves, and the
 * queue persists it on the attachment row then. A later queue instance can
 * resume from that token when the database and remote session survive. This
 * contract is not a physical process- or device-loss guarantee.
 */

/**
 * Non-terminal transfer outcomes the queue branches on (set as `.code` on the
 * thrown Error by the adapter). notYetAvailable: a peer's download 404'd
 * because the bytes are not uploaded yet ⇒ re-queue, don't fail. expired: a
 * tus upload URL aged past 24h, or its offset probe was refused with another
 * client error ⇒ drop the session and restart from zero. timedOut: an
 * adapter-side deadline won the race against a hung network call ⇒ retryable,
 * like any other transient failure: the queue records `failed` and retries
 * on the next sync. A tus session survives a chunk timeout (the upload URL
 * stays valid for up to 24h). A later attempt resumes; it does not restart.
 *
 * A failure the host answered carries the status the host means as a numeric
 * `.status` (Supabase Storage names it in the body of an HTTP 400). The queue
 * releases a 401 without charging an attempt, because the next session can
 * succeed where this one could not; retries 403, 409, 423 and server errors
 * within the attachment budget; and stops the transfer for good on any other
 * client error. A removal refused with 401 or 403 ends as a local eviction.
 */
export const ETransferError = {
  notYetAvailable: 'ATTACHMENT_NOT_YET_AVAILABLE',
  expired: 'ATTACHMENT_UPLOAD_EXPIRED',
  timedOut: 'ATTACHMENT_TRANSFER_TIMEOUT',
} as const
export type TTransferErrorCode = (typeof ETransferError)[keyof typeof ETransferError]

export interface IUploadTarget {
  bucket: string
  path: string
  contentType: string
}

export interface IUploadHandle {
  /**
   * Whether this upload can resume from a persisted offset (tus, >6 MB).
   * storage-js single-shot uploads (<=6 MB) report false, and the queue then
   * treats a failure as a clean restart; it does not persist a fingerprint.
   */
  resumable: boolean

  /**
   * Opaque resumability token (e.g. tus URL + fingerprint), persisted by the
   * engine in the queue row. Empty string when resumable is false, and also
   * while a resumable session does not exist yet; read it through
   * `onSessionCreated`, which fires the moment it does.
   */
  fingerprint: string

  /**
   * Terminates on success, failure, AND abort. Success alone is not enough:
   * the consumer drains it before awaiting `done`. A progress iterable that
   * outlives a failed transfer stalls the queue forever.
   */
  progress: AsyncIterable<number>

  /**
   * The single error channel: rejects with the transfer failure (optionally
   * carrying an ETransferError `.code` and the HTTP `.status`).
   */
  done: Promise<void>

  abort(): Promise<void>

  /**
   * Register the resume-token listener. A resumable adapter calls it exactly
   * once, as soon as the session exists and before any byte moves (and
   * immediately on registration if the session already exists), so the queue
   * can persist the token while the transfer can still be interrupted.
   * Optional: adapters without a durable session omit it.
   */
  onSessionCreated?(listener: (fingerprint: string) => void): void
}

export interface ITransfer {
  createUpload(
    localPath: string,
    target: IUploadTarget,
    options: { resumeFingerprint?: string; sha256: string },
  ): Promise<IUploadHandle>

  /**
   * Download to a local path. When options.sha256 is given the adapter verifies
   * the bytes before the atomic rename and rejects on mismatch with the
   * `ATTACHMENT_HASH_MISMATCH` `.code`, so a corrupt transfer can never poison
   * the content-addressed cache.
   */
  download(
    target: { bucket: string; path: string },
    toLocalPath: string,
    options?: { sha256?: string },
  ): Promise<void>

  /**
   * Server-confirm that bytes landed (the attachment_confirm RPC): records the
   * object → sha256/size/content_type in kizunasync.attachments so peers can
   * verify their downloads. `table` is the synced table whose row carries the
   * reference. Idempotent server-side.
   */
  confirm(
    target: { bucket: string; path: string },
    meta: { sha256: string; size: number; contentType: string },
    table: string,
  ): Promise<void>

  /**
   * The expected integrity metadata for an object (a peer reads it before a
   * download to verify the bytes), or null if the server has no record yet.
   */
  metadata(target: { bucket: string; path: string }): Promise<{ sha256: string } | null>

  /**
   * Best-effort delete of a Storage object. The uploading device GCs its own
   * orphaned objects (unique-per-upload keys ⇒ one creator per object).
   */
  remove(target: { bucket: string; path: string }): Promise<void>
}
