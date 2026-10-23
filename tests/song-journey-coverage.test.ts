import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const mapPath = resolve(root, 'docs/labs/FEATURE-MAP.md')
const mapText = readFileSync(mapPath, 'utf8')
const songView = readFileSync(resolve(root, 'apps/web/src/song-lab/SongLabProject.tsx'), 'utf8')
const studioView = readFileSync(resolve(root, 'apps/web/src/studio/StudioProject.tsx'), 'utf8')
const shell = readFileSync(resolve(root, 'apps/web/src/song-journey/SongLabSuite.tsx'), 'utf8')
const page = readFileSync(resolve(root, 'apps/web/src/song-journey/SongJourneyPage.tsx'), 'utf8')
const routeParser = readFileSync(resolve(root, 'apps/web/src/App.tsx'), 'utf8')

const targetIds: Record<string, string> = {
  Choose: 'journey-step-0', Understand: 'journey-step-1', Decide: 'journey-step-2',
  Finish: 'journey-step-3', Approve: 'journey-step-4', Deliver: 'journey-step-5',
}

describe('FEATURE-MAP journey reachability', () => {
  it('gives every mapped feature a live journey or existing Stage destination', () => {
    const rows = mapText.split(/\r?\n/).filter(line => line.startsWith('|') && !/^\|\s*Feature\b/.test(line) && !/^\|\s*-/.test(line))
    const applicable = rows.filter(line => /\(mockups\/[^)]+\)/.test(line))
    expect(applicable.length).toBeGreaterThan(180)
    const covered = new Set<string>()

    for (const line of applicable) {
      const home = line.split('|')[4] ?? ''
      const step = home.match(/\b(?:\d+\s+)?(Choose|Understand|Decide|Finish|Approve|Deliver|Stage)\b/)?.[1]
      const mockup = line.match(/\(mockups\/([^#)]+)#?([^)]*)\)/)
      expect(step, `feature row has no step destination: ${line}`).toBeTruthy()
      expect(mockup, `feature row has no named destination: ${line}`).toBeTruthy()
      if (!step || !mockup) continue

      if (step === 'Stage') {
        expect(shell).toContain('href="#/live-lab"')
        expect(routeParser).toContain("segments[0] === 'live-lab'")
        covered.add('Stage')
      } else {
        const targetId = targetIds[step]
        expect(page).toContain(`id="${targetId}"`)
        covered.add(step)
      }

      const source = line.match(/apps\/web\/src\/([\w/-]+\.(?:tsx|ts|jsx))/)?.[1]
      if (!source) continue
      expect(existsSync(resolve(root, `apps/web/src/${source}`)), `missing mapped source module ${source}`).toBe(true)
      if (source.startsWith('song-lab/')) expect(songView).toContain('SongAnalysisJourney')
      if (source.startsWith('studio/')) expect(studioView).toContain('StudioJourneyPanels')
      if (source.startsWith('live/')) expect(shell).toContain('href="#/live-lab"')
    }

    for (const step of Object.keys(targetIds)) expect(covered, `${step} has no mapped feature`).toContain(step)
    expect(covered).toContain('Stage')
  })

  it('keeps the linked route explicitly separate from the legacy Song Lab and Studio routes', () => {
    expect(routeParser).toContain("segments[0] === 'song-journey'")
    expect(page).toContain('<SongLabProject')
    expect(page).toContain('<StudioProject')
    expect(shell).toContain('href="#/song-lab/library"')
    expect(shell).toContain('href="#/studio"')
  })
})
