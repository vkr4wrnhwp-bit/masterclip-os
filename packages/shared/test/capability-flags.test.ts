import { describe, expect, it } from 'vitest'
import { AUDIO_CAPABILITY_FLAGS, loadConfig, resetConfigCache } from '../src/index.js'

/**
 * `masterclip doctor` names the switched-off audio capabilities, because a
 * request for one is refused at the gate with a code that reads like a bug to
 * anyone who does not know the flag exists. That is only useful while the list
 * it reads is complete: a capability added later and left off it would fail
 * silently in exactly the way the report exists to prevent.
 *
 * TypeScript already stops the list naming a flag that does not exist. What it
 * cannot see is the other direction — a new flag in the schema that nobody
 * added here — so this test walks the loaded config instead.
 */

/**
 * Flags that gate a whole product surface rather than one provider capability.
 * These are deliberately not in the capability list: a switched-off product
 * hides its own screens, so nobody hits a confusing refusal deep in a workflow.
 */
const PRODUCT_FLAGS = new Set([
  'AUDIO_INTELLIGENCE_ENABLED',
  'ELEVENLABS_ENABLED',
  'MEETING_INTELLIGENCE_ENABLED',
  'SIGNAL_AUDIO_BRIEFS_ENABLED',
  'AUDIO_OPERATOR_ENABLED',
  'GLOBAL_RELEASE_PACK_ENABLED',
  'CAMPAIGN_AUDIO_TOOLKIT_ENABLED',
  'REMIX_LAB_AUDIO_ENGINE_ENABLED',
  'ARTIST_VOICE_VAULT_ENABLED',
  'WHITE_LABEL_AUDIO_OPERATOR_ENABLED',
  'SONG_LAB_ENABLED',
  'SONG_LAB_BENCHMARKS_ENABLED',
  'SONG_LAB_EXPERIMENTS_ENABLED',
  'SONG_LAB_LYRICS_ENABLED',
  'SONG_LAB_AR_VIEW_ENABLED',
  // Not a product or a capability — an operational control with no gate code.
  'RATE_LIMIT_ENABLED',
])

describe('audio capability flags', () => {
  it('accounts for every _ENABLED flag in the schema', () => {
    resetConfigCache()
    const config = loadConfig({} as NodeJS.ProcessEnv, true)
    const named = new Set<string>(AUDIO_CAPABILITY_FLAGS.map(([, key]) => key))

    const unclassified = Object.keys(config)
      .filter((key) => key.endsWith('_ENABLED'))
      .filter((key) => !named.has(key) && !PRODUCT_FLAGS.has(key))

    // A new flag lands here rather than going unnoticed. Add it to
    // AUDIO_CAPABILITY_FLAGS if a request for it is refused at the gate, or to
    // PRODUCT_FLAGS if switching it off hides the surface entirely.
    expect(unclassified).toEqual([])
  })

  it('names flags that exist and reads their real values', () => {
    resetConfigCache()
    const config = loadConfig({ MUSIC_GENERATION_ENABLED: 'true', DUBBING_ENABLED: 'false' } as NodeJS.ProcessEnv, true)
    for (const [, key] of AUDIO_CAPABILITY_FLAGS) expect(config[key], key).toBeTypeOf('boolean')

    const off = AUDIO_CAPABILITY_FLAGS.filter(([, key]) => !config[key]).map(([name]) => name)
    expect(off).toContain('dubbing')
    expect(off).not.toContain('music generation')
  })

  // The two that default off are the rights-sensitive ones, and a deployment
  // that turned them on by accident is worth catching in review.
  it('defaults the rights-sensitive capabilities off', () => {
    resetConfigCache()
    const config = loadConfig({} as NodeJS.ProcessEnv, true)
    const off = AUDIO_CAPABILITY_FLAGS.filter(([, key]) => !config[key]).map(([name]) => name)
    expect(off).toEqual(['music generation', 'music inpainting', 'voice cloning'])
  })

  it('uses labels a person would recognise, not the variable name', () => {
    for (const [label] of AUDIO_CAPABILITY_FLAGS) {
      expect(label).toBe(label.toLowerCase())
      expect(label).not.toContain('_')
    }
  })
})
