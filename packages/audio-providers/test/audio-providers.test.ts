import { describe, expect, it } from 'vitest'
import {
  HeuristicReasoningProvider,
  MockTranscriptionAdapter,
  MockVoiceIdentityAdapter,
  createMockAudioProviders,
  mockTranscript,
  normalizeSttResponse,
  renderWav,
  signElevenLabsPayload,
  verifyElevenLabsSignature,
} from '../src/index.js'

describe('mock WAV synthesis', () => {
  it('produces a valid RIFF/WAVE file of the requested duration', () => {
    const bytes = renderWav({ frequency: 200, durationSeconds: 2, seed: 42 })
    const header = Buffer.from(bytes.slice(0, 12))
    expect(header.toString('ascii', 0, 4)).toBe('RIFF')
    expect(header.toString('ascii', 8, 12)).toBe('WAVE')
    // 22050 Hz * 2s * 2 bytes + 44-byte header
    expect(bytes.length).toBe(22_050 * 2 * 2 + 44)
  })

  it('is deterministic for the same seed and different for different seeds', () => {
    const a = renderWav({ frequency: 200, durationSeconds: 1, seed: 7 })
    const b = renderWav({ frequency: 200, durationSeconds: 1, seed: 7 })
    const c = renderWav({ frequency: 200, durationSeconds: 1, seed: 8 })
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
    expect(Buffer.from(a).equals(Buffer.from(c))).toBe(false)
  })
})

describe('mock transcription', () => {
  it('returns diarized, timestamped segments', async () => {
    const adapter = new MockTranscriptionAdapter()
    const result = await adapter.transcribe({
      orgId: 'org1',
      audio: { bytes: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav' },
      diarize: true,
      timestamps: 'word',
      tagAudioEvents: true,
      keyterms: [],
      zeroRetention: true,
    })
    expect(result.status).toBe('complete')
    const transcript = result.transcript!
    expect(transcript.segments.length).toBeGreaterThan(3)
    expect(new Set(transcript.segments.map((s) => s.speakerKey)).size).toBeGreaterThan(1)
    const [first, second] = transcript.segments
    expect(first!.endMs).toBeGreaterThan(first!.startMs)
    expect(second!.startMs).toBeGreaterThan(first!.startMs)
  })

  it('supports zero retention (nothing is retained anywhere)', () => {
    expect(new MockTranscriptionAdapter().supportsZeroRetention()).toBe(true)
  })
})

describe('scribe response normalization', () => {
  it('groups words into speaker-continuous segments and keeps audio events', () => {
    const normalized = normalizeSttResponse({
      language_code: 'en',
      text: 'Hello there. Yes.',
      words: [
        { text: 'Hello', start: 0.1, end: 0.4, type: 'word', speaker_id: 'speaker_0', logprob: -0.02 },
        { text: ' ', type: 'spacing', speaker_id: 'speaker_0' },
        { text: 'there.', start: 0.5, end: 0.9, type: 'word', speaker_id: 'speaker_0', logprob: -0.05 },
        { text: '(laughter)', start: 1.0, end: 1.4, type: 'audio_event' },
        { text: 'Yes.', start: 1.5, end: 1.8, type: 'word', speaker_id: 'speaker_1', logprob: -0.01 },
      ],
    })
    expect(normalized.segments).toHaveLength(3)
    expect(normalized.segments[0]!.speakerKey).toBe('speaker_0')
    expect(normalized.segments[0]!.text).toBe('Hello there.')
    expect(normalized.segments[0]!.startMs).toBe(100)
    expect(normalized.segments[1]!.speakerKey).toBeNull()
    expect(normalized.segments[2]!.speakerKey).toBe('speaker_1')
  })
})

describe('elevenlabs webhook signatures', () => {
  const secret = 'whsec_test'
  it('accepts a correctly signed payload', () => {
    const body = JSON.stringify({ type: 'ping' })
    const header = signElevenLabsPayload(body, secret)
    expect(() => verifyElevenLabsSignature(body, header, secret)).not.toThrow()
  })

  it('rejects tampered bodies, wrong secrets, and stale timestamps', () => {
    const body = JSON.stringify({ type: 'ping' })
    const header = signElevenLabsPayload(body, secret)
    expect(() => verifyElevenLabsSignature(body + ' ', header, secret)).toThrowError(/mismatch/)
    expect(() => verifyElevenLabsSignature(body, header, 'other')).toThrowError(/mismatch/)
    const stale = signElevenLabsPayload(body, secret, Date.now() - 31 * 60 * 1000)
    expect(() => verifyElevenLabsSignature(body, stale, secret)).toThrowError(/tolerance/)
    expect(() => verifyElevenLabsSignature(body, null, secret)).toThrowError(/missing/)
    expect(() => verifyElevenLabsSignature(body, header, '')).toThrowError(/secret/)
  })
})

describe('mock voice identity', () => {
  it('refuses registration on behalf of an artist', async () => {
    const adapter = new MockVoiceIdentityAdapter()
    await expect(
      adapter.registerVerifiedVoice({ orgId: 'org1', mode: 'provider_verification', ownerName: 'A', consentRecordId: 'c1' }),
    ).rejects.toThrowError(/owner/)
  })

  it('registers an owner-shared reference and tracks revocation', async () => {
    const adapter = new MockVoiceIdentityAdapter()
    const profile = await adapter.registerVerifiedVoice({
      orgId: 'org1',
      mode: 'external_reference',
      providerVoiceId: 'mock-voice-x',
      ownerName: 'A',
      consentRecordId: 'c1',
    })
    expect(profile.verificationStatus).toBe('verified')
    await adapter.revokeVoice('mock-voice-x')
    expect(adapter.wasRevoked('mock-voice-x')).toBe(true)
  })
})

describe('heuristic reasoning', () => {
  it('extracts action items and labels deal variables conservatively', async () => {
    const reasoning = new HeuristicReasoningProvider()
    const result = await reasoning.extractMeetingIntelligence({
      orgId: 'org1',
      meetingType: 'Distribution Discussion',
      transcript: mockTranscript(true, 1),
      speakerNames: { speaker_0: 'Operator', speaker_1: 'Artist' },
    })
    expect(result.actionItems.length).toBeGreaterThan(0)
    expect(result.dealVariables.length).toBeGreaterThan(0)
    // A pattern matcher can never assert an agreed term.
    for (const variable of result.dealVariables) {
      expect(['inferred', 'needs_verification']).toContain(variable.extractionType)
    }
    expect(result.risks.join(' ')).toMatch(/rights issue/)
  })

  it('preserves confidence language verbatim in brief scripts', async () => {
    const reasoning = new HeuristicReasoningProvider()
    const result = await reasoning.generateSignalBrief({
      orgId: 'org1',
      briefType: 'rights_health',
      title: 'Rights health',
      items: [
        { statement: 'Two tracks carry an unresolved claim.', confidence: 'needs_verification' },
        { statement: 'The catalog transfer completed.', confidence: 'confirmed' },
      ],
      audience: 'executive',
    })
    expect(result.script).toMatch(/Needs verification: Two tracks/)
    expect(result.script).not.toMatch(/Needs verification: The catalog transfer/)
  })
})

describe('mock provider set', () => {
  it('covers every capability slot', () => {
    const set = createMockAudioProviders()
    for (const slot of ['transcription', 'speech', 'agent', 'dubbing', 'music', 'stems', 'isolation', 'soundEffects', 'voiceIdentity'] as const) {
      expect(set[slot]).toBeDefined()
      expect(set[slot]!.isConfigured()).toBe(true)
    }
  })
})
