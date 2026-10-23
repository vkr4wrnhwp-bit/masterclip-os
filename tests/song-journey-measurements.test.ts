import { describe, expect, it } from 'vitest'
import { analysisNext, measurementValueText } from '../apps/web/src/song-journey/InstrumentDeck.js'

describe('Song Journey measurement states', () => {
  it('explains how to obtain a measurement when none exists', () => {
    expect(analysisNext(undefined)).toContain('Run analysis for the selected version')
    expect(analysisNext('complete')).toContain('No sample or fallback values are displayed')
    expect(measurementValueText(null)).toBe('Not measured yet')
    expect(measurementValueText(undefined)).toBe('Not measured yet')
    expect(measurementValueText(0)).toBe('0')
  })

  it('explains that a partial analysis is not a substitute for a missing measurement', () => {
    const analysis = { status: 'complete', energyCurve: { values: [] } }
    const message = analysis.energyCurve.values.length ? 'measured' : analysisNext(analysis.status)
    expect(message).toContain('No sample or fallback values are displayed')
  })

  it('shows an analyzer failure and next action', () => {
    expect(analysisNext('failed', 'decoder unavailable')).toContain('Analysis failed: decoder unavailable')
    expect(analysisNext('running')).toContain('Analysis is still running')
  })
})
