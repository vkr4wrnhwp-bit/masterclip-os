import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.jsx'
import { SuiteFooter } from './suite-footer.jsx'
import { MotionGuide } from './learning/MotionGuide.jsx'
import './learning/motion-guide.css'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')
createRoot(container).render(
  <React.StrictMode>
    <App />
    <MotionGuide />
  </React.StrictMode>,
)

// The suite footer sits under the app, in its own root, so every view has it.
const footer = document.getElementById('sb-footer')
if (footer) createRoot(footer).render(<SuiteFooter />)
