import { describe, expect, it } from 'vitest'
import { barBeat, beatsToSeconds, nextBoundaryBeat, parseTimeSignature, quantizationGridBeats, secondsToBeats } from '../src/tempo.js'

describe('time signatures', () => {
  it('parses common signatures', () => {
    expect(parseTimeSignature('4/4')).toEqual({ beatsPerBar: 4, beatUnit: 4 })
    expect(parseTimeSignature('6/8')).toEqual({ beatsPerBar: 6, beatUnit: 8 })
    expect(parseTimeSignature('3/4')).toEqual({ beatsPerBar: 3, beatUnit: 4 })
  })

  it('falls back to 4/4 on garbage rather than crashing a show', () => {
    expect(parseTimeSignature('what')).toEqual({ beatsPerBar: 4, beatUnit: 4 })
    expect(parseTimeSignature('0/0')).toEqual({ beatsPerBar: 4, beatUnit: 4 })
  })
})

describe('beat/second conversion', () => {
  it('round-trips', () => {
    expect(beatsToSeconds(4, 120)).toBeCloseTo(2)
    expect(secondsToBeats(2, 120)).toBeCloseTo(4)
  })
})

describe('quantization grid', () => {
  const sig = { beatsPerBar: 4, beatUnit: 4 }

  it('maps options to beat grids', () => {
    expect(quantizationGridBeats('none', sig)).toBe(0)
    expect(quantizationGridBeats('1/4', sig)).toBe(1)
    expect(quantizationGridBeats('1/2', sig)).toBe(2)
    expect(quantizationGridBeats('1bar', sig)).toBe(4)
    expect(quantizationGridBeats('2bars', sig)).toBe(8)
    expect(quantizationGridBeats('4bars', sig)).toBe(16)
    expect(quantizationGridBeats('scene_end', sig)).toBeNull()
  })

  it('respects the time signature for bar-based grids', () => {
    expect(quantizationGridBeats('1bar', { beatsPerBar: 3, beatUnit: 4 })).toBe(3)
  })
})

describe('nextBoundaryBeat', () => {
  it('launches immediately with no quantization', () => {
    expect(nextBoundaryBeat(2.37, 0)).toBe(2.37)
  })

  it('queues to the next grid line', () => {
    expect(nextBoundaryBeat(1.5, 4)).toBe(4)
    expect(nextBoundaryBeat(4.01, 4)).toBe(8)
    expect(nextBoundaryBeat(0.2, 1)).toBe(1)
  })

  it('treats "already on the line" as now, not a full grid later', () => {
    expect(nextBoundaryBeat(4, 4)).toBe(4)
    expect(nextBoundaryBeat(8.0000000001, 4)).toBe(8)
    expect(nextBoundaryBeat(0, 4)).toBe(0)
  })
})

describe('barBeat display', () => {
  it('is 1-based for humans', () => {
    expect(barBeat(0, { beatsPerBar: 4, beatUnit: 4 })).toEqual({ bar: 1, beat: 1 })
    expect(barBeat(5, { beatsPerBar: 4, beatUnit: 4 })).toEqual({ bar: 2, beat: 2 })
  })
})
