import { describe, expect, it } from 'vitest'
import { StemDeck, effectiveGain } from '../src/stems.js'

const stem = (id: string, over: Partial<Parameters<StemDeck['load']>[0][number]> = {}) => ({
  id,
  stemType: 'drums',
  label: id,
  gain: 1,
  pan: 0,
  muted: false,
  solo: false,
  ...over,
})

describe('stem deck mute/solo resolution', () => {
  it('mute silences a stem', () => {
    const deck = new StemDeck()
    deck.load([stem('a'), stem('b')])
    deck.setMuted('a', true)
    const gains = deck.resolve()
    expect(gains.get('a')).toBe(0)
    expect(gains.get('b')).toBe(1)
  })

  it('solo silences everything that is not soloed', () => {
    const deck = new StemDeck()
    deck.load([stem('a'), stem('b'), stem('c')])
    deck.setSolo('b', true)
    const gains = deck.resolve()
    expect(gains.get('a')).toBe(0)
    expect(gains.get('b')).toBe(1)
    expect(gains.get('c')).toBe(0)
  })

  it('mute wins over solo on the same stem', () => {
    expect(effectiveGain({ ...stem('x'), muted: true, solo: true }, true)).toBe(0)
  })

  it('volume changes survive resolution', () => {
    const deck = new StemDeck()
    deck.load([stem('a')])
    deck.setGain('a', 0.4)
    expect(deck.resolve().get('a')).toBeCloseTo(0.4)
  })

  it('clamps gain and pan', () => {
    const deck = new StemDeck()
    deck.load([stem('a')])
    deck.setGain('a', 99)
    deck.setPan('a', -99)
    expect(deck.get('a')?.gain).toBe(2)
    expect(deck.get('a')?.pan).toBe(-1)
  })

  it('throws on unknown stems instead of silently mixing the wrong thing', () => {
    const deck = new StemDeck()
    expect(() => deck.setMuted('ghost', true)).toThrow()
  })
})
