/**
 * mime: the canonical MIME to file-extension mapping, both ways.
 *
 * One table shared by the attachment pipeline (engine) and the platform file
 * stores (expo/web), so the two directions cannot drift.
 */
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  pdf: 'application/pdf',
}

/** File extension for a content type (attachment naming). Unknown → 'bin'. */
export function extForMime(contentType: string | null): string {
  if (contentType === null) {
    return 'bin'
  }

  return EXT_BY_MIME[contentType] ?? 'bin'
}

/** Content type for a file extension (upload metadata). Unknown → null. */
export function mimeForExt(ext: string): string | null {
  return MIME_BY_EXT[ext] ?? null
}
