import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const overview=readFileSync('apps/web/src/views/Overview.tsx','utf8')
const shell=readFileSync('apps/web/src/views/motion-shell.tsx','utf8')
const project=readFileSync('apps/web/src/views/Project.tsx','utf8')
const app=readFileSync('apps/web/src/App.tsx','utf8')
const style=readFileSync('apps/web/src/styles.css','utf8')

describe('MOTION home hero and start action regressions',()=>{
  it('uses the supplied film studio and never puts pointer hit areas behind decorative layers',()=>{
    const art=readFileSync('apps/web/public/motion-film-studio.webp')
    expect(art.subarray(0,4).toString()).toBe('RIFF')
    expect(art.subarray(8,12).toString()).toBe('WEBP')
    expect(style).toContain("url('/motion-film-studio.webp')")
    expect(style).toMatch(/\.mo-scenery\s*\{[^}]*pointer-events:\s*none;/s)
    expect(style).toContain('.mo-scenery > * { display: none; }')
  })
  it('opens the actual starter dialog when a start card is clicked',()=>{
    expect(overview).toContain('onClick={() => begin(item)}')
    expect(overview).toContain('setDialogMode(selected)')
    expect(overview).not.toContain('type="radio"')
    expect(overview).toContain('<StartDialog')
    expect(shell).toContain('await api.createProject(')
  })
  it('offers real authorized audio upload and correct project destination',()=>{
    expect(shell).toContain('type="file" accept="audio/mpeg')
    expect(shell).toContain('await api.uploadAsset(filmId, form)')
    expect(shell).toContain('setCreatedFilmId(filmId)')
    expect(shell).toContain('Film created, but audio upload failed:')
    expect(app).toContain('initialTab={route.params.tab}')
    expect(project).toContain("value === 'assets'")
    expect(project).toContain("value === 'import'")
    expect(project).toContain('routeTab(initialTab)')
    expect(project).toContain('<QuickCreate')
    expect(project).toContain('<MusicTimeline')
    expect(project).toContain('<VariationCompare')
  })
})
