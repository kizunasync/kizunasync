/**
 * No driver-specific bundler configuration. @kizunasync/web spawns its worker
 * through `new URL('./worker.ts', import.meta.url)`, and the worker loads
 * its wasm with `import.meta.url` as well. Vite emits both as real chunks.
 * The engine runs in that worker over OPFS: COOP and COEP headers are not
 * required. This demo opens two databases, so it runs two workers in one
 * page, elected on separate database names. They never contend for the store
 * (`packages/web/conformance/two-databases.spec.ts`). A reload racing the
 * departing page's busy access-handle pool is retried and fails; it does not
 * fall back to IndexedDB. The reload keeps the database it wrote.
 * tailwindcss() is the CSS-first Tailwind v4 plugin (no tailwind.config.js);
 * the shared theme tokens arrive through globals.css's
 * `@import '@kizunasync/ui/theme.css'`.
 */

import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// MARK: - Vite config

export default defineConfig({
  /**
   * `@kizunasync/core` probes the React Native Turbo Module with a static `require`
   * that only runs on React Native. Vite's dependency scan still tries to
   * resolve the specifier and, failing, skips pre-bundling for the whole app;
   * excluding it keeps the scan intact.
   */
  optimizeDeps: {
    exclude: ['@kizunasync/rn-uniffi'],
  },
  plugins: [react(), tailwindcss()],
  envDir: fileURLToPath(new URL('../..', import.meta.url)),
  envPrefix: 'VITE_DEMO_',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
