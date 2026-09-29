import '@/runtime/tag-manager'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from '@/app'
import '@/globals.css'

const root = document.getElementById('root')

if (root === null) {
  throw new Error('missing #root element')
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
