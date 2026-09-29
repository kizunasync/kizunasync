/// <reference types="bun" />
/**
 * The native twin: on device the engine is the UniFFI module, so it resolves
 * nothing. Metro picks `wasm-asset.web.ts` instead on the web target.
 */
import { describe, expect, test } from 'bun:test'
import { resolveWasmAssetUrl } from './wasm-asset'

describe('resolveWasmAssetUrl (native)', () => {
  test('returns undefined', () => {
    expect(resolveWasmAssetUrl()).toBeUndefined()
  })
})
