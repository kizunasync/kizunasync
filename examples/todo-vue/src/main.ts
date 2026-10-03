import { createApp } from 'vue'
import App from './App.vue'
import { KSYNC_THEME_VARS } from '@kizunasync/ui/theme-vars'
import './globals.css'

/**
 * Apply the shared KSYNC_PALETTE as :root custom properties before mount so the
 * brand colors globals.css styles against are sourced from @kizunasync/ui, never
 * hand-copied hexes.
 */
const documentRoot = document.documentElement

for (const [name, value] of Object.entries(KSYNC_THEME_VARS)) {
  documentRoot.style.setProperty(name, value)
}

const root = document.getElementById('app')

if (root === null) {
  throw new Error('missing #app element')
}

createApp(App).mount(root)
