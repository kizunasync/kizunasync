/** Metro picks the `.web.ts` twin on web; on device the engine is the UniFFI module and no binary is fetched. */
export function resolveWasmAssetUrl(): string | undefined {
  return undefined
}
