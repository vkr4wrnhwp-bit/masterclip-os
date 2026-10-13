import {readFileSync} from 'node:fs'
import {describe,expect,it} from 'vitest'
const css=readFileSync('apps/web/src/styles.css','utf8')
const app=readFileSync('apps/web/src/App.tsx','utf8')
const shell=readFileSync('apps/web/src/views/motion-shell.tsx','utf8')
describe('MOTION mobile create and editor usability',()=>{
 it('defaults sidebar closed on phones and gives film editor full width',()=>{
  expect(app).toContain('mobileNavOpen')
  expect(app).toContain('aria-expanded={mobileNavOpen}')
  expect(css).toContain('.app > .sidebar.is-mobile-open')
  expect(css).toContain('.app > .main { width:100%;')
 })
 it('keeps dialog within visual viewport and avoids iOS input auto zoom',()=>{
  expect(css).toContain('max-height:calc(var(--mo-vv-height, 100dvh)')
  expect(css).toContain('width:calc(var(--mo-vv-width, 100vw) - 24px)')
  expect(css).toContain('env(safe-area-inset-bottom, 0px)')
  expect(shell).toContain("window.visualViewport")
  expect(shell).toContain('onFocusCapture={onFormFocus}')
  expect(css).toContain('font-size:16px')
  expect(css).toContain('.mo-dialog .mo-audio-consent input[type="checkbox"]')
 })
 it('reports visible pending create and audio upload progress',()=>{
  expect(shell).toContain('role="status" aria-live="polite"')
  expect(shell).toContain('Creating film…')
  expect(shell).toContain('Uploading recording…')
  expect(shell).toContain('submittingRef.current')
 })
})
