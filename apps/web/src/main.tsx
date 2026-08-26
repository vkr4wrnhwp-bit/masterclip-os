import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.jsx'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// The app shell is cached so a show survives a reload with no network — a
// crash mid-show at a venue is exactly when the application has to load. The
// worker never caches /api/, so online data stays live and the app's own
// offline fallbacks keep deciding. Registered after render so it never delays
// first paint, and failure is not fatal: without it the app simply needs a
// network to start, which is how it behaved before.
// Production only: in development Vite serves modules it expects to replace,
// and a cache in front of that breaks hot reload.
const isProduction = (import.meta as unknown as { env?: { PROD?: boolean } }).env?.PROD === true
if ('serviceWorker' in navigator && isProduction) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined)
  })
}
