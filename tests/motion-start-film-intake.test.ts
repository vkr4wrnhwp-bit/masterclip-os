import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { emptyShot, validateShot } from '@masterclip/shot-schema'
import { StartDialog } from '../apps/web/src/views/motion-shell.js'
import {
  START_MODES, STARTER_TEMPLATES, modeById, starterTemplate, templateShotSpec,
} from '../apps/web/src/views/overview-model.js'

describe('MOTION real first-session actions', () => {
  it('opens an actual audio picker and requires recorded authorization', () => {
    const html = renderToStaticMarkup(React.createElement(StartDialog, {
      mode:modeById('audio'),onClose:()=>undefined,onCreated:()=>undefined,
    }))
    expect(html).toContain('type="file"')
    expect(html).toContain('accept=".wav,.mp3,audio/wav,audio/mpeg"')
    expect(html).toContain('Recording rights owner')
    expect(html).toContain('music-video and promotional work')
    expect(html).toContain('CREATE FILM &amp; UPLOAD AUDIO')
  })
  it('shows an editable, actual template choice instead of a fake route', () => {
    const html = renderToStaticMarkup(React.createElement(StartDialog, {
      mode:modeById('template'),onClose:()=>undefined,onCreated:()=>undefined,
    }))
    for (const template of STARTER_TEMPLATES) {
      expect(html).toContain(template.title)
      expect(template.shots).toHaveLength(3)
    }
    expect(html).toContain('CREATE FILM WITH SHOTS')
  })
  it('maps every template shot to a valid canonical unrendered draft', () => {
    for(const template of STARTER_TEMPLATES) {
      for(const [index,shot] of template.shots.entries()) {
        const spec=templateShotSpec(emptyShot(),template,index,`starter-test-${index}`)
        expect(validateShot(spec).ok).toBe(true)
        expect(spec).toMatchObject({
          generation_mode:'text_to_video',routing_profile:'DRAFT_MOTION',
          audio_mode:'none',candidate_count:1,duration_seconds:shot.seconds,
        })
        expect(spec.approval_requirements).toContain('human_review_required')
      }
    }
  })
  it('uses real one-tap actions instead of radio controls waiting for an unrelated CTA', () => {
    const overview=readFileSync('apps/web/src/views/Overview.tsx','utf8')
    expect(START_MODES).toHaveLength(3)
    expect(overview).toContain('onClick={() => openStart(item)}')
    expect(overview).toContain('onClick={() => openStart(modeById')
    expect(overview).not.toContain('type="radio"')
    const dialog=readFileSync('apps/web/src/views/motion-shell.tsx','utf8')
    expect(dialog).toContain('api.uploadAsset(projectId, upload)')
    expect(dialog).toContain('api.createShot(projectId, templateShotSpec')
  })
  it('uses the precise approved photo asset, behind non-intercepting content', () => {
    const photo=readFileSync('apps/web/public/motion-start-film-bg.avif')
    expect(createHash('sha256').update(photo).digest('hex')).toBe(
      '91884a40289e4333c23c1c065543cdcca518434d42ed4d20c84bd03e46dc8bd9',
    )
    const css=readFileSync('apps/web/src/styles.css','utf8')
    expect(css).toContain("url('/motion-start-film-bg.avif')")
    expect(css).toMatch(/\.mo-scenery\s*\{[^}]*pointer-events:\s*none;/s)
    expect(css).toMatch(/\.mo-main\s*\{[^}]*z-index:\s*1;/s)
  })
})
