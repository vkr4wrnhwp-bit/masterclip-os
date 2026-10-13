import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../App.jsx'
import { MotionGuide } from './MotionGuide.jsx'
import { SuiteFooter } from '../suite-footer.jsx'
import { installMotionPreviewTransport } from './preview-transport.js'
import '../styles.css'
import './motion-guide.css'

// No API server exists in the standalone static site. The real React views
// receive only fictional, immutable GET fixture responses from this shim.
installMotionPreviewTransport()
const root=document.getElementById('root')
if(!root)throw new Error('MOTION learning preview #root not found')
createRoot(root).render(
  <React.StrictMode>
    <App />
    <MotionGuide preview />
  </React.StrictMode>
)
const footer=document.getElementById('sb-footer')
if(footer)createRoot(footer).render(<SuiteFooter />)
