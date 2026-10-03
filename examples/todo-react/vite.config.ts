/**
 * No driver-specific bundler configuration is needed: @kizunasync/web spawns its
 * worker through `new URL('./worker.ts', import.meta.url)` and the worker loads
 * its wasm the same way, both of which Vite emits as real chunks on its own. The
 * engine runs in that worker over OPFS, so no COOP or COEP headers are required.
 * tailwindcss() is the CSS-first Tailwind v4 plugin (no tailwind.config.js).
 * HeroUI's component styles are layered through globals.css's `@import
 * 'tailwindcss'`.
 */

import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// MARK: - Vite config

export default defineConfig({
  plugins: [react(), tailwindcss()],
  envDir: fileURLToPath(new URL('../..', import.meta.url)),
  envPrefix: 'VITE_TODO_REACT_',
})
