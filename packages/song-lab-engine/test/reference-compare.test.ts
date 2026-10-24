import { describe, expect, it } from 'vitest'
import { compareOwnedReference, type OwnedReference } from '../src/reference-compare.js'
const song = (ownerId: string, songId: string, value: number): OwnedReference => ({
  ownerId, songId, title: songId, sampleRate: 48000,
  metrics: { low: { value, sourceFile: songId + '.wav', analyzerVersion: '1' },
    loudness: { value: -12, sourceFile: songId + '.wav', analyzerVersion: '1' } },
})
describe('owned reference comparison', () => {
  it('compares only available owned measurements with provenance', () => {
    const report = compareOwnedReference('owner', song('owner', 'new', 0.6), song('owner', 'old', 0.3))
    expect(report.rows.find(r => r.key === 'low')?.finding).toContain('more low end')
    expect(report.rows.find(r => r.key === 'low')?.source?.referenceFile).toBe('old.wav')
    expect(report.rows.find(r => r.key === 'high')?.finding).toMatch(/Not enough information/)
  })
  it('rejects foreign songs', () => {
    expect(() => compareOwnedReference('owner', song('owner', 'new', 1), song('another', 'secret', 2))).toThrow('Song not found')
  })
  it('does not compare incompatible analyzer versions', () => {
    const reference = song('owner', 'old', 0.2)
    reference.metrics.low!.analyzerVersion = '2'
    const report = compareOwnedReference('owner', song('owner', 'new', 0.6), reference)
    expect(report.rows[0]?.finding).toMatch(/versions differ/)
  })
  it('flags different sample rates', () => {
    const reference = song('owner', 'old', 0.2)
    reference.sampleRate = 44100
    expect(compareOwnedReference('owner', song('owner', 'new', 0.6), reference).warnings.join(' ')).toMatch(/sample rates/)
  })
})
