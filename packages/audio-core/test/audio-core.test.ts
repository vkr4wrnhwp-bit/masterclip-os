import { describe, expect, it } from 'vitest'
import {
  BLOCKED_PROMPT_MESSAGE,
  assembleKeyterms,
  assertZeroRetentionSatisfiable,
  defaultAudioPolicy,
  detectEscalation,
  evaluateGate,
  policyAllows,
  retentionExpiresAt,
  sanitizeKeyterm,
  screenAgentReply,
  screenRemixPrompt,
  screenVoicePrompt,
} from '../src/index.js'

describe('remix prompt moderation', () => {
  const blocked = [
    'make it sound like Marisol Vane',
    'in the style of the Basalt Choir',
    'use their voice for the hook',
    'clone her voice',
    'a voice clone of the singer',
    'same flow as that famous rapper',
    'same lyrics as the original single',
    'an AI cover of the hit song',
    'impersonate the label boss',
    'make a deepfake chorus',
    'recreate the song exactly',
    'a Nova Verge type beat',
  ]
  for (const prompt of blocked) {
    it(`blocks: "${prompt}"`, () => {
      const verdict = screenRemixPrompt(prompt)
      expect(verdict.allowed).toBe(false)
      expect(verdict.hits.length).toBeGreaterThan(0)
      expect(verdict.message).toBe(BLOCKED_PROMPT_MESSAGE)
    })
  }

  const allowed = [
    'slow tempo, warm analog texture, sparse drums',
    'high energy, 140 bpm, distorted 808s, late-night mood',
    'strip the intro, extend the outro for DJ use',
    'a 90s-era boom bap texture with dusty percussion',
    'brighter chorus, tighter low end, radio-length edit',
  ]
  for (const prompt of allowed) {
    it(`allows neutral descriptors: "${prompt}"`, () => {
      expect(screenRemixPrompt(prompt).allowed).toBe(true)
    })
  }

  it('blocks org-configured protected names as references', () => {
    const verdict = screenRemixPrompt('give it the Nova Verge energy', { protectedNames: ['Nova Verge'] })
    expect(verdict.allowed).toBe(false)
    expect(verdict.hits[0]!.code).toBe('protected_name')
  })

  it('does not match protected names inside longer words', () => {
    expect(screenRemixPrompt('a novavergesque texture', { protectedNames: ['Nova Verge'] }).allowed).toBe(true)
  })

  it('the refusal never accuses the artist', () => {
    const verdict = screenRemixPrompt('impersonate someone famous')
    expect(verdict.message).not.toMatch(/infring|illegal|violat/i)
  })

  it('screens voice prompts for endorsement and impersonation misuse', () => {
    expect(screenVoicePrompt('a breaking news alert about the tour').allowed).toBe(false)
    expect(screenVoicePrompt('warm confident narrator for a release announcement').allowed).toBe(true)
  })
})

describe('keyterm assembly', () => {
  it('sanitises forbidden characters and enforces length limits', () => {
    expect(sanitizeKeyterm('Harbor <Lights> EP')).toBe('Harbor Lights EP')
    expect(sanitizeKeyterm('x'.repeat(60))).toBeNull()
    expect(sanitizeKeyterm('one two three four five six')).toBeNull()
  })

  it('never sends tenant-private terms to the provider', () => {
    const terms = assembleKeyterms([
      { term: 'Nova Verge', category: 'artist', sensitivity: 'shareable' },
      { term: 'Secret Acquisition Target', category: 'company', sensitivity: 'private' },
    ])
    expect(terms).toContain('Nova Verge')
    expect(terms).not.toContain('Secret Acquisition Target')
  })

  it('dedupes case-insensitively and caps at the provider limit', () => {
    const many = Array.from({ length: 1200 }, (_, i) => ({ term: `term ${i}`, category: 'other', sensitivity: 'shareable' as const }))
    const terms = assembleKeyterms([{ term: 'ISRC', category: 'acronym', sensitivity: 'shareable' }, { term: 'isrc', category: 'acronym', sensitivity: 'shareable' }, ...many])
    expect(terms.filter((t) => t.toLowerCase() === 'isrc')).toHaveLength(1)
    expect(terms.length).toBeLessThanOrEqual(1000)
  })
})

describe('audio data policy', () => {
  it('denies actions the policy disallows, with a reason', () => {
    const policy = defaultAudioPolicy('org1', new Date().toISOString())
    expect(policyAllows(policy, 'clone_voice').allowed).toBe(false)
    expect(policyAllows(policy, 'transcribe').allowed).toBe(true)
  })

  it('rejects zero-retention orgs before upload when the provider cannot honour it', () => {
    const policy = { ...defaultAudioPolicy('org1', new Date().toISOString()), requireZeroRetention: true }
    expect(() => assertZeroRetentionSatisfiable(policy, 'someprovider', false)).toThrowError(/zero-retention/)
    expect(() => assertZeroRetentionSatisfiable(policy, 'someprovider', true)).not.toThrow()
  })

  it('computes retention expiry from the policy, or keeps forever on null', () => {
    const policy = { ...defaultAudioPolicy('org1', new Date().toISOString()), transcriptRetentionDays: null }
    expect(retentionExpiresAt(policy, 'transcript', Date.now())).toBeNull()
    expect(retentionExpiresAt(policy, 'source', 0)).toBe(new Date(365 * 24 * 3600 * 1000).toISOString())
  })
})

describe('operator agent guardrails', () => {
  it('flags replies that would commit Street Banker', () => {
    for (const reply of [
      'Great news, you are accepted into the program',
      'We guarantee you 100000 streams in the first week',
      'The deal is approved, congratulations',
      'I can guarantee funding for your album',
    ]) {
      expect(screenAgentReply(reply).ok).toBe(false)
    }
  })

  it('passes ordinary intake replies', () => {
    expect(screenAgentReply('Thanks — what email should our team use to reach you?').ok).toBe(true)
    expect(screenAgentReply('A Street Banker operator will review this and follow up.').ok).toBe(true)
  })

  it('detects escalation signals in user turns', () => {
    expect(detectEscalation('I want to talk to a human').length).toBeGreaterThan(0)
    expect(detectEscalation('is this contract clause legal? I need a lawyer')).not.toHaveLength(0)
    expect(detectEscalation("I didn't get paid and I am furious")).not.toHaveLength(0)
    expect(detectEscalation('I have a single coming out in March')).toHaveLength(0)
  })
})

describe('feature gate', () => {
  it('reports the first failing layer', () => {
    const decision = evaluateGate([
      { name: 'global_flag', pass: true, message: 'ok' },
      { name: 'org_entitlement', pass: false, message: 'not in plan' },
      { name: 'usage_limit', pass: false, message: 'over budget' },
    ])
    expect(decision.allowed).toBe(false)
    expect(decision.failed?.name).toBe('org_entitlement')
  })
})
