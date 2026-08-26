import { describe, expect, it } from 'vitest'
import { findVocalStem, normalizeStemName } from '../packages/song-lab-engine/src/vocal-stems.js'

describe('vocal stem naming', () => {
  it('recognises the names providers actually use', () => {
    expect(normalizeStemName('Vocals (Lead).wav')).toBe('vocals_lead')
    for (const name of ['vocals', 'Vocals', 'vocal', 'VOICE', 'lead_vocal', 'Lead-Vocals.mp3']) {
      expect(findVocalStem([{ name }]), name).not.toBeNull()
    }
  })

  it('refuses names that are not unambiguously a lead vocal', () => {
    // Each of these would put isolated-stem confidence on audio that is not
    // the lead vocal. Falling back to the mix is the cheaper mistake.
    for (const name of ['lead', 'backing_vocals', 'vocoder', 'stems-archive', 'other', 'drums', 'bass', 'vocal_fx']) {
      expect(findVocalStem([{ name }]), name).toBeNull()
    }
  })

  it('picks the vocal out of a full stem set', () => {
    const stems = [{ name: 'drums' }, { name: 'bass' }, { name: 'vocals' }, { name: 'other' }]
    expect(findVocalStem(stems)?.name).toBe('vocals')
  })
})
