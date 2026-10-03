import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// MARK: - Vite config

/**
 * No driver-specific bundler configuration is needed: @kizunasync/web spawns its
 * worker through `new URL('./worker.ts', import.meta.url)` and the worker loads
 * its wasm the same way, both of which Vite emits as real chunks on its own. The
 * engine runs in that worker over OPFS, so no COOP or COEP headers are required.
 */
export default defineConfig({
  plugins: [vue()],
  envDir: fileURLToPath(new URL('../..', import.meta.url)),
  envPrefix: 'VITE_TODO_VUE_',
})
