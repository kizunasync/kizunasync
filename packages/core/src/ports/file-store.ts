/**
 * Attachment bytes never cross the store locator: they live behind this port.
 * The adapters implemented in this tree are expo-file-system (`@kizunasync/expo`)
 * and OPFS (`@kizunasync/web`).
 */

// MARK: - FileStore port

export interface IFileStat {
  size: number
  modifiedAt: number
}

export interface IFileStoreCapabilities {
  atomicRename: boolean
  streams: boolean
  quota: boolean
  contentUris: boolean
}

export interface IFileStore {
  readonly capabilities: IFileStoreCapabilities

  /**
   * Write via temp file + rename, so a partial write is never observable
   * (a corrupt file would poison the content-addressed cache).
   */
  writeAtomic(path: string, data: ArrayBuffer): Promise<void>

  read(path: string): Promise<ArrayBuffer>

  /**
   * Read the byte range [offset, offset+length) for callers that implement
   * bounded-memory hashing or transfer. Only valid when capabilities.streams
   * is true; otherwise callers fall back to read() + slice. The current
   * Supabase transfer still buffers the file through read(), so this capability
   * is not itself a streaming-upload guarantee.
   */
  readRange(path: string, offset: number, length: number): Promise<ArrayBuffer>

  exists(path: string): Promise<boolean>
  stat(path: string): Promise<IFileStat | null>
  delete(path: string): Promise<void>
  list(prefix: string): Promise<string[]>

  /**
   * Hash a sandbox file at enqueue time. Implementations may stream or buffer
   * the bytes; this interface does not promise a memory bound.
   */
  sha256(path: string): Promise<string>

  /**
   * Import an externally-picked file (a `blob:`/`file:`/content URI) into the
   * content-addressed sandbox. It is the one platform-specific read (web
   * fetch, RN filesystem) kept behind the port so the queue stays
   * platform-free. Returns the sandbox path plus integrity metadata.
   */
  importFromUri(uri: string): Promise<{
    path: string
    sha256: string
    size: number
    contentType: string | null
  }>

  /**
   * A renderable URI for a sandbox path (web `blob:` object URL, RN `file:`),
   * for an immediate optimistic preview before/while bytes sync. The caller
   * must not assume the URI outlives the file.
   */
  toUri(path: string): Promise<string>
}

/** The content-addressed store path for a payload with hash `sha`. */
export function contentKey(sha: string): string {
  return `content/${sha}`
}
