import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AbPlayer } from '../../../apps/web/src/song-lab/components.js'

type Track = { id: string; label: string; url: string | null; gainDb?: number }
let root: Root | null = null
let container: HTMLDivElement | null = null

const harness = {
  mount(tracks: Track[]) {
    root?.unmount()
    container?.remove()
    container = document.createElement('div')
    container.id = 'ab-actual-player'
    document.body.appendChild(container)
    root = createRoot(container)
    root.render(React.createElement(AbPlayer, { tracks }))
  },
  unmount() {
    root?.unmount()
    container?.remove()
    root = null
    container = null
  },
}

declare global {
  interface Window {
    __songABTest: typeof harness
  }
}

window.__songABTest = harness
