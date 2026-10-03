/// <reference path="./expo-fetch.d.ts" />
/**
 * @kizunasync/expo Supabase download decorator: the native override for
 * ITransfer['download'] (iOS/Android).
 *
 * Upload/confirm/metadata/remove need no native override (an ArrayBuffer
 * upload works on RN), so the app composes this decorator's download with
 * those four methods from @kizunasync/supabase's createSupabaseTransfer. DOWNLOAD
 * alone needs a native implementation: supabase-js download(), and RN's
 * global fetch().blob() with it, build a Blob from an ArrayBuffer, which
 * React Native forbids ("Creating blobs from ArrayBuffer/ArrayBufferView is
 * not supported"). Expo's fetch (expo/fetch) is a WHATWG-compliant client
 * with real binary support, so response.arrayBuffer() yields the bytes
 * directly, with no Blob. Reads over a short-lived signed URL (honors RLS
 * for public + private buckets).
 *
 * Both network waits are bounded, matching the policy the Supabase transfer
 * applies to the same two calls: the signed-URL request is a control request
 * under `DEFAULT_TRANSFER_CONTROL_TIMEOUT_MS`, and the fetch that carries the
 * bytes is under `DEFAULT_TRANSFER_BYTES_TIMEOUT_MS` (both from `@kizunasync/core`),
 * with a real AbortSignal so a hung socket is dropped, not merely left un-awaited.
 * A blown deadline rejects with `ETransferError.timedOut`, which the
 * attachment queue already treats as retryable. The download itself is
 * `@kizunasync/core`'s `createSignedUrlDownload`, the one the Supabase transfer
 * runs too; this decorator hands it Expo's fetch.
 */

import { fetch as expoFetch } from 'expo/fetch'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createSignedUrlDownload, type IFileStore, type ILogger, type ITransfer } from '@kizunasync/core'

export function createExpoSupabaseDownload(options: {
  client: SupabaseClient
  fileStore: IFileStore
  logger?: ILogger

  /**
   * Deadline for the signed-URL request. `<= 0` disables it. Defaults to
   * `DEFAULT_TRANSFER_CONTROL_TIMEOUT_MS` from `@kizunasync/core`.
   */
  controlTimeoutMs?: number

  /**
   * Deadline for the request that carries the bytes. `<= 0` disables it.
   * Defaults to `DEFAULT_TRANSFER_BYTES_TIMEOUT_MS` from `@kizunasync/core`.
   */
  bytesTimeoutMs?: number

  /**
   * Injectable timer pair (testability): defaults to the platform
   * setTimeout/clearTimeout. Threaded into both deadlines.
   */
  setTimer?: (callback: () => void, delayMs: number) => unknown

  clearTimer?: (handle: unknown) => void
}): ITransfer['download'] {
  return createSignedUrlDownload({ ...options, fetchBytes: (url, signal) => expoFetch(url, { signal }) })
}
