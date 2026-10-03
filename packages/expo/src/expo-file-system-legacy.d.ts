/**
 * Ambient types for expo-file-system/legacy (optional peer).
 *
 * expo-file-system is an OPTIONAL peer (attachments-only), so it is not
 * installed in this package's own type-check. Declares the MINIMAL legacy
 * surface file-store.ts calls, enough to keep it fully typed standalone; the
 * real module resolves in the consuming app. Mirrors expo-file-system's legacy
 * d.ts (SDK 54+); widen only if the file store starts using more of the API.
 */
declare module 'expo-file-system/legacy' {
  export const EncodingType: {
    readonly UTF8: 'utf8'
    readonly Base64: 'base64'
  }

  export const documentDirectory: string | null

  export interface IFileInfo {
    exists: boolean
    uri?: string
    size?: number
    modificationTime?: number
    isDirectory?: boolean
  }

  export function getInfoAsync(fileUri: string, options?: { md5?: boolean }): Promise<IFileInfo>

  export function readAsStringAsync(
    fileUri: string,
    options?: { encoding?: 'utf8' | 'base64'; position?: number; length?: number },
  ): Promise<string>

  export function writeAsStringAsync(
    fileUri: string,
    contents: string,
    options?: { encoding?: 'utf8' | 'base64' },
  ): Promise<void>

  export function deleteAsync(fileUri: string, options?: { idempotent?: boolean }): Promise<void>

  export function makeDirectoryAsync(
    fileUri: string,
    options?: { intermediates?: boolean },
  ): Promise<void>

  export function readDirectoryAsync(fileUri: string): Promise<string[]>

  export function copyAsync(options: { from: string; to: string }): Promise<void>

  export function moveAsync(options: { from: string; to: string }): Promise<void>
}
