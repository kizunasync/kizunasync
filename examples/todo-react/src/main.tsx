import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './app'
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

const root = document.getElementById('root')

if (root === null) {
  throw new Error('missing #root element')
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
