import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './App'
import { applyAppearance } from './lib/appearance'

// Apply text size, accent, density and motion before the first paint. The value
// arrived through the preload, so React never renders at the wrong scale.
applyAppearance(window.ncc.initialAppearance)

const container = document.getElementById('root')
if (!container) throw new Error('missing #root')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
