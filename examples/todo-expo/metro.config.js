/**
 * Web support: Metro must treat the engine's `.wasm` build as an asset. No
 * cross-origin-isolation headers are set, because @kizunasync/web's worker persists
 * through OPFS access handles rather than a SharedArrayBuffer.
 */
const { getDefaultConfig } = require('expo/metro-config')
const { withUniwindConfig } = require('uniwind/metro')

const config = getDefaultConfig(__dirname)

config.resolver.assetExts.push('wasm')

/**
 * Uniwind compiles the Tailwind entry at build time and swaps Metro's transformer,
 * so it must wrap the finished config: it is what makes heroui-native's CSS
 * variables reach native styles. global.css carries the brand overrides; the
 * hexes there are the second encoding of KSYNC_PALETTE (React Native cannot read
 * CSS), and src/theme.test.ts fails if the two drift.
 */
module.exports = withUniwindConfig(config, { cssEntryFile: './global.css' })
