import { Asset } from 'expo-asset'

declare function require(id: string): unknown

/**
 * Metro serves the engine binary as an asset once `wasm` is in the app's
 * `resolver.assetExts`; the static require registers it. The worker cannot read
 * `import.meta.url` under Metro, so the web driver calls this when the worker
 * spawns and posts the URL it answers.
 */
export function resolveWasmAssetUrl(): string {
  const registered = require('@kizunasync/web/wasm/kizunasync_wasm_bg.wasm')

  if (typeof registered !== 'number' && typeof registered !== 'string') {
    throw new Error(
      '@kizunasync/expo: Metro did not register kizunasync_wasm_bg.wasm as an asset; add "wasm" to resolver.assetExts in metro.config.js',
    )
  }
  return new URL(Asset.fromModule(registered).uri, globalThis.location.href).href
}
