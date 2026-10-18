import React from 'react'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { User } from '../apps/web/src/api.js'
import { Overview } from '../apps/web/src/views/Overview.jsx'
import { ProjectView, REFERENCE_ACCEPT, REFERENCE_HINT, REFERENCE_MAX_MB } from '../apps/web/src/views/Project.jsx'
import { modeById, referencesUploadPath, START_MODES } from '../apps/web/src/views/overview-model.js'
import { LESSONS } from '../apps/web/src/learning/motion-lessons.js'

/**
 * The picture door (owner, 2026-10-18: "motion doesn't have an image
 * uploader"). It did, as a bare file input on the References tab that the
 * front door never pointed at. These tests hold the fourth starting point,
 * the References control it leads to, and the lesson that explains it.
 */

const h = React.createElement
const USER: User = { userId: 'u1', orgId: 'o1', email: 'director@example.com', displayName: 'A Director', orgRole: 'owner' }

const overview = readFileSync('apps/web/src/views/Overview.tsx', 'utf8')
const shell = readFileSync('apps/web/src/views/motion-shell.tsx', 'utf8')
const project = readFileSync('apps/web/src/views/Project.tsx', 'utf8')
const app = readFileSync('apps/web/src/App.tsx', 'utf8')
const css = readFileSync('apps/web/src/styles.css', 'utf8')
const server = readFileSync('apps/api/src/server.ts', 'utf8')
const assetsRoute = readFileSync('apps/api/src/routes/assets.ts', 'utf8')

describe('the fourth starting point: Upload a picture or reference', () => {
  const markup = renderToStaticMarkup(h(Overview, { user: USER, onSignOut: () => undefined }))
  const picture = modeById('picture')

  it('is a real card in the same group and style as the other three', () => {
    expect(START_MODES).toHaveLength(4)
    expect(START_MODES[3]!.id).toBe('picture')
    expect(picture.title).toBe('Upload a picture or reference')
    expect(picture.actionLabel).toBe('Start a film with a picture or reference')
    expect(markup.match(/<button type="button" class="mo-mode"/g)).toHaveLength(4)
    expect(markup).toContain('Upload a picture or reference')
    expect(markup).toContain(`aria-label="${picture.actionLabel}"`)
    // Its own icon, not the template fallback.
    expect(overview).toContain("if (id === 'picture')")
  })

  it('goes to the current film\'s References tab with the file button focused, or the New film flow first', () => {
    expect(referencesUploadPath('film-1')).toBe('/project/film-1?tab=assets&focus=upload')
    expect(overview).toContain("if (selected.id === 'picture' && newest !== null)")
    expect(overview).toContain('navigate(referencesUploadPath(newest.id))')
    expect(overview).toContain('setDialogMode(selected)')
    // The dialog route, used when there is no film yet, lands on the same place.
    expect(shell).toContain("if (mode.id === 'picture') navigate(referencesUploadPath(filmId))")
    expect(picture.next).toContain('References')
    expect(app).toContain("focusUpload={route.params.focus === 'upload'}")
    expect(project).toContain('if (focusUpload) pickRef.current?.focus()')
  })

  it('lays four cards in one row on wide screens, two on laptops, one on phones', () => {
    expect(css).toContain('.mo-cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 20px; }')
    expect(css).toMatch(/@media \(max-width: 1280px\) \{\s*\.mo-cards \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/)
    expect(css).toMatch(/@media \(max-width: 767px\) \{[\s\S]*?\.mo-cards \{ grid-template-columns: 1fr; gap: 12px; \}/)
  })
})

describe('the References upload control', () => {
  const markup = renderToStaticMarkup(h(ProjectView, { projectId: 'film-1', initialTab: 'assets' }))

  it('is a 44px button with plain words, a hint, and the hidden input the browser needs', () => {
    expect(markup).toContain('class="mo-reference-pick"')
    expect(markup).toContain('Choose a picture, video or audio file')
    expect(markup).toContain('aria-describedby="mo-reference-hint"')
    expect(markup).toContain(`id="mo-reference-hint" class="mo-reference-hint">${REFERENCE_HINT}<`)
    expect(markup).toContain(`class="mo-reference-file" type="file" tabindex="-1" aria-hidden="true"`)
    expect(markup).toContain(`accept="${REFERENCE_ACCEPT}"`)
    expect(css).toMatch(/\.mo-reference-pick \{[^}]*min-height: 44px;/)
    expect(css).toContain('.mo-reference-pick:focus-visible { outline: 2px solid var(--mo-cyan);')
    expect(css).toContain('.mo-reference-file { display: none; }')
    expect(css).toMatch(/@media \(max-width: 767px\) \{\s*\.mo-reference-pick \{ width: 100%; \}/)
  })

  it('keeps the same accept list and the same upload handler, and the error callout', () => {
    expect(REFERENCE_ACCEPT).toBe('image/png,image/jpeg,image/webp,video/mp4,video/quicktime,audio/wav,audio/mpeg')
    for (const mime of REFERENCE_ACCEPT.split(',')) expect(assetsRoute).toContain(`['${mime}', {`)
    expect(project).toContain('onChange={(e) => void upload(e)}')
    expect(project).toContain('onClick={() => fileRef.current?.click()}')
    expect(project).toContain('await api.uploadAsset(projectId, form)')
    expect(project).toContain('{error && <Callout tone="danger">{error}</Callout>}')
  })

  it('tells the truth about what it takes and how big, from the API', () => {
    expect(REFERENCE_HINT).toBe('Takes PNG, JPG and WebP pictures, MP4 and MOV video, and WAV and MP3 audio, up to 512 MB each.')
    expect(server).toContain(`fileSize: ${REFERENCE_MAX_MB} * 1024 * 1024`)
  })

  it('shows a visible busy state while the upload runs', () => {
    expect(project).toContain("{busy ? 'Uploading…' : 'Choose a picture, video or audio file'}")
    expect(project).toContain('aria-busy={busy}')
    expect(project).toContain('<p className="mo-reference-busy" role="status" aria-live="polite">')
    expect(project).toContain('Uploading your file to this film.')
  })

  it('keeps the rights owner and consent fields above the control', () => {
    const fields = markup.indexOf('Rights owner')
    const consent = markup.indexOf('Authorized for identity work')
    const button = markup.indexOf('class="mo-reference-pick"')
    expect(fields).toBeGreaterThan(-1)
    expect(consent).toBeGreaterThan(fields)
    expect(button).toBeGreaterThan(consent)
  })

  it('uses Motion tokens, no monospace, and nothing under the 12px floor', () => {
    const start = css.indexOf('.mo-reference-door {')
    const end = css.indexOf('.mo-reference-pick { width: 100%; }')
    const block = css.slice(start, end)
    expect(start).toBeGreaterThan(-1)
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(block).not.toContain('monospace')
    for (const size of block.match(/font-size: (\d+)px/g) ?? []) expect(Number(size.replace(/\D/g, ''))).toBeGreaterThanOrEqual(12)
    expect(block).toContain('var(--mo-paper)')
    expect(block).toContain('var(--mo-muted)')
  })
})

describe('the Learn MOTION lesson for References', () => {
  it('points at the new button and says what it does in plain words', () => {
    const step = LESSONS.references.steps.find((s) => s.target === '.mo-reference-pick')
    expect(step).toBeDefined()
    expect(step!.happening).toContain('Choose a picture, video or audio file')
    expect(step!.use).toContain('PNG, JPG, WebP, MP4, MOV, WAV or MP3')
    expect(step!.use).toContain('512 MB')
    expect(LESSONS.references.steps.map((s) => s.target)).toEqual(['.tabs', '.field-row', '.mo-reference-pick', '.card'])
    expect(LESSONS.dashboard.steps.some((s) => s.title === 'Four honest starting points')).toBe(true)
  })
})
