import { describe, expect, it } from 'vitest'
import {
  analyzeMix,
  AudioProcessingRegistry,
  buildFilterChain,
  compareMasterMetrics,
  compareToReferences,
  computeReleaseReadiness,
  estimateTranslation,
  findCurve,
  loudnessMatchGainDb,
  metricValue,
  planMaster,
  LocalAudioProcessingProvider,
  runMixDoctor,
  type AudioProcessingProvider,
  type MixMetric,
} from '../src/index.js'

/**
 * These tests are about the module's promises, not its arithmetic.
 *
 * The properties worth locking down are the ones a future change could break
 * without failing anything else: that an unmeasurable figure comes back null
 * rather than zero, that a mono file is not scored on stereo behaviour, that
 * the Mix Doctor points at a real moment in the file, and that a louder master
 * cannot be presented without the gain that makes the comparison fair.
 */

const RATE = 44100

interface ToneSpec {
  hz: number
  amplitude: number
  /** Seconds. Defaults to the whole file. */
  from?: number
  to?: number
  /** 'both' | 'left' | 'right' | 'inverted' — inverted puts the tone out of phase. */
  placement?: 'both' | 'left' | 'right' | 'inverted'
}

/** Builds a two-channel 16-bit WAV from a set of tones. Deterministic. */
function buildWav(seconds: number, tones: ToneSpec[], opts: { dcOffset?: number; clip?: boolean } = {}): Uint8Array {
  const frames = Math.round(seconds * RATE)
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)

  for (const tone of tones) {
    const from = Math.round((tone.from ?? 0) * RATE)
    const to = Math.round((tone.to ?? seconds) * RATE)
    for (let i = from; i < Math.min(to, frames); i++) {
      const value = Math.sin((2 * Math.PI * tone.hz * i) / RATE) * tone.amplitude
      switch (tone.placement ?? 'both') {
        case 'left':
          left[i] += value
          break
        case 'right':
          right[i] += value
          break
        case 'inverted':
          left[i] += value
          right[i] -= value
          break
        default:
          left[i] += value
          right[i] += value
      }
    }
  }

  if (opts.dcOffset) {
    for (let i = 0; i < frames; i++) {
      left[i] += opts.dcOffset
      right[i] += opts.dcOffset
    }
  }

  const dataBytes = frames * 2 * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 2, true)
  view.setUint32(24, RATE, true)
  view.setUint32(28, RATE * 4, true)
  view.setUint16(32, 4, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  for (let i = 0; i < frames; i++) {
    const l = Math.max(-1, Math.min(1, opts.clip ? left[i] * 4 : left[i]))
    const r = Math.max(-1, Math.min(1, opts.clip ? right[i] * 4 : right[i]))
    view.setInt16(44 + i * 4, Math.round(l * 32767), true)
    view.setInt16(46 + i * 4, Math.round(r * 32767), true)
  }
  return new Uint8Array(buffer)
}

/** A mono WAV, for the "no stereo field to measure" case. */
function buildMonoWav(seconds: number, hz: number, amplitude: number): Uint8Array {
  const frames = Math.round(seconds * RATE)
  const dataBytes = frames * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, RATE, true)
  view.setUint32(28, RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  for (let i = 0; i < frames; i++) {
    view.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * hz * i) / RATE) * amplitude * 32767), true)
  }
  return new Uint8Array(buffer)
}

const MUSICAL = buildWav(12, [
  { hz: 55, amplitude: 0.28 },
  { hz: 220, amplitude: 0.16 },
  { hz: 880, amplitude: 0.1 },
  { hz: 3200, amplitude: 0.05 },
  { hz: 7000, amplitude: 0.02, placement: 'left' },
  { hz: 7000, amplitude: 0.02, placement: 'right' },
])

describe('mix analysis', () => {
  it('measures a stereo file and reports provenance on every metric', async () => {
    const result = await analyzeMix({ bytes: MUSICAL, mimeType: 'audio/wav' })

    expect(result.failures).toEqual([])
    expect(result.sampleRate).toBe(RATE)
    expect(result.channels).toBe(2)
    expect(result.bitDepth).toBe(16)
    expect(result.metrics.length).toBeGreaterThan(20)

    for (const entry of result.metrics) {
      expect(entry.provider).toBeTruthy()
      expect(entry.analysisMethod).toBeTruthy()
      // The core promise: a null value is never dressed up as a confident zero.
      if (entry.value === null) expect(entry.confidence).toBe(0)
    }

    // Sanity: a file built from a 55 Hz fundamental should read as low-heavy.
    const sub = metricValue(result.metrics, 'sub_energy_pct')
    expect(sub).not.toBeNull()
    expect(sub!).toBeGreaterThan(10)
  })

  it('returns null rather than zero for stereo metrics on a mono file', async () => {
    const result = await analyzeMix({ bytes: buildMonoWav(6, 220, 0.3), mimeType: 'audio/wav' })

    for (const key of ['stereo_width', 'phase_correlation', 'stereo_imbalance_db', 'mono_fold_loss_db']) {
      const entry = result.metrics.find((candidate) => candidate.key === key)
      expect(entry, key).toBeDefined()
      expect(entry!.value, key).toBeNull()
      expect(entry!.note, key).toMatch(/mono/i)
    }

    // And the readiness band declines to score rather than scoring badly.
    const readiness = computeReleaseReadiness(result.metrics)
    const stereo = readiness.bands.find((band) => band.band === 'stereo_field')
    expect(stereo?.score).toBeNull()
    expect(readiness.bandsScored).toBeLessThan(readiness.bands.length)
  })

  it('detects clipping and points at where it happens', async () => {
    const clipped = buildWav(8, [{ hz: 200, amplitude: 0.3, from: 3, to: 4 }, { hz: 200, amplitude: 0.2 }], { clip: true })
    const result = await analyzeMix({ bytes: clipped, mimeType: 'audio/wav' })

    expect(metricValue(result.metrics, 'clipping_runs')!).toBeGreaterThan(0)

    const issues = runMixDoctor({ metrics: result.metrics, curves: result.curves, durationMs: result.durationMs })
    const clipping = issues.find((issue) => issue.issueType === 'clipping')
    expect(clipping).toBeDefined()
    expect(clipping!.endMs).toBeLessThanOrEqual(result.durationMs + 1000)
    expect(clipping!.evidence).toHaveProperty('clippingRuns')
  })

  it('flags a phase concern on out-of-phase channels and not on in-phase ones', async () => {
    const inverted = await analyzeMix({ bytes: buildWav(10, [{ hz: 300, amplitude: 0.3, placement: 'inverted' }]), mimeType: 'audio/wav' })
    expect(metricValue(inverted.metrics, 'phase_correlation')!).toBeLessThan(-0.5)
    const flagged = runMixDoctor({ metrics: inverted.metrics, curves: inverted.curves, durationMs: inverted.durationMs })
    expect(flagged.some((issue) => issue.issueType === 'phase_concern')).toBe(true)

    const aligned = await analyzeMix({ bytes: buildWav(10, [{ hz: 300, amplitude: 0.3 }]), mimeType: 'audio/wav' })
    expect(metricValue(aligned.metrics, 'phase_correlation')!).toBeGreaterThan(0.9)
    const clean = runMixDoctor({ metrics: aligned.metrics, curves: aligned.curves, durationMs: aligned.durationMs })
    expect(clean.some((issue) => issue.issueType === 'phase_concern')).toBe(false)
  })

  it('hedges every Mix Doctor headline and carries its evidence', async () => {
    const result = await analyzeMix({ bytes: MUSICAL, mimeType: 'audio/wav' })
    const issues = runMixDoctor({ metrics: result.metrics, curves: result.curves, durationMs: result.durationMs })

    for (const issue of issues) {
      expect(issue.headline).toMatch(/^(Detected|Possible|Potential|Sibilance indicator|Little headroom)/)
      expect(issue.headline).not.toMatch(/wrong|bad|fix your|poor/i)
      expect(issue.whyItMatters.length).toBeGreaterThan(20)
      expect(Object.keys(issue.evidence).length).toBeGreaterThan(0)
      expect(issue.startMs).toBeGreaterThanOrEqual(0)
      expect(issue.endMs).toBeGreaterThan(issue.startMs)
      expect(issue.confidence).toBeGreaterThan(0)
      expect(issue.confidence).toBeLessThanOrEqual(1)
    }
    // Issues arrive in timeline order, which is how an engineer works.
    const starts = issues.map((issue) => issue.startMs)
    expect([...starts].sort((a, b) => a - b)).toEqual(starts)
  })

  it('produces curves whose length matches the duration they claim to cover', async () => {
    const result = await analyzeMix({ bytes: MUSICAL, mimeType: 'audio/wav' })
    for (const curve of result.curves) {
      const covered = curve.points.length * curve.stepMs
      expect(covered, curve.key).toBeGreaterThan(result.durationMs * 0.5)
      expect(covered, curve.key).toBeLessThan(result.durationMs * 1.6)
    }
    expect(findCurve(result.curves, 'short_term_loudness')).toBeDefined()
  })
})

describe('master station', () => {
  it('plans a chain that reaches the direction target and says what it held back', async () => {
    const result = await analyzeMix({ bytes: MUSICAL, mimeType: 'audio/wav' })
    const plan = planMaster('competitive', result.metrics)

    expect(plan.targetLufs).toBe(-9)
    const gain = plan.stages.find((stage) => stage.stage === 'gain')
    expect(gain).toBeDefined()
    expect(plan.stages.at(-1)?.stage).toBe('limiter')
    expect(plan.expectation).toMatch(/LUFS/)
    // Every stage is readable as data, which is what makes a master auditable.
    for (const stage of plan.stages) expect(stage.description.length).toBeGreaterThan(10)
  })

  it('applies no tonal shaping at all on the transparent direction', async () => {
    const result = await analyzeMix({ bytes: MUSICAL, mimeType: 'audio/wav' })
    const plan = planMaster('transparent', result.metrics)
    const shaping = plan.stages.filter((stage) => ['low_shelf', 'presence', 'air', 'dynamics', 'drive'].includes(stage.stage))
    expect(shaping).toEqual([])
    expect(plan.restraint.join(' ')).toMatch(/preserves the mix/)
  })

  it('refuses to lift the low end of a mix that is already bass-heavy', async () => {
    const bassHeavy: MixMetric[] = [
      { key: 'integrated_lufs', value: -14, unit: 'lufs', confidence: 0.6, analysisMethod: 't', provider: 't', note: '' },
      { key: 'sub_energy_pct', value: 30, unit: 'percent', confidence: 0.8, analysisMethod: 't', provider: 't', note: '' },
      { key: 'low_energy_pct', value: 20, unit: 'percent', confidence: 0.8, analysisMethod: 't', provider: 't', note: '' },
    ]
    const plan = planMaster('warm', bassHeavy)
    expect(plan.stages.some((stage) => stage.stage === 'low_shelf')).toBe(false)
    expect(plan.restraint.join(' ')).toMatch(/already carries/)
  })

  it('builds a real ffmpeg chain, and a no-op rather than an empty one', () => {
    const plan = planMaster('modern', [
      { key: 'integrated_lufs', value: -16, unit: 'lufs', confidence: 0.6, analysisMethod: 't', provider: 't', note: '' },
      { key: 'dynamic_range_db', value: 10, unit: 'db', confidence: 0.6, analysisMethod: 't', provider: 't', note: '' },
    ])
    const chain = buildFilterChain(plan)
    expect(chain).toMatch(/alimiter/)
    expect(chain).toMatch(/volume=/)

    expect(buildFilterChain({ direction: 'custom', targetLufs: -12, targetTruePeakDbtp: -1, stages: [], expectation: '', restraint: [] })).toBe('anull')
  })

  it('produces the gain that makes an A/B fair, and nothing when it cannot', () => {
    // The louder rendition must be turned down by exactly the difference.
    expect(loudnessMatchGainDb(-14, -9)).toBe(-5)
    expect(loudnessMatchGainDb(-9, -14)).toBe(5)
    // Unmeasurable loudness means no match is possible — and the caller must
    // be able to tell, rather than receiving a confident zero.
    expect(loudnessMatchGainDb(null, -9)).toBeNull()
    expect(loudnessMatchGainDb(-9, null)).toBeNull()
  })

  it('only marks a comparison row meaningful when it clears its own threshold', () => {
    const before: MixMetric[] = [
      { key: 'integrated_lufs', value: -14, unit: 'lufs', confidence: 0.6, analysisMethod: 't', provider: 't', note: '' },
      { key: 'stereo_width', value: 0.4, unit: 'ratio', confidence: 0.6, analysisMethod: 't', provider: 't', note: '' },
    ]
    const after: MixMetric[] = [
      { key: 'integrated_lufs', value: -9, unit: 'lufs', confidence: 0.6, analysisMethod: 't', provider: 't', note: '' },
      { key: 'stereo_width', value: 0.41, unit: 'ratio', confidence: 0.6, analysisMethod: 't', provider: 't', note: '' },
    ]
    const rows = compareMasterMetrics(before, after, {})
    expect(rows.find((row) => row.metricKey === 'integrated_lufs')?.meaningful).toBe(true)
    expect(rows.find((row) => row.metricKey === 'stereo_width')?.meaningful).toBe(false)
  })
})

describe('translation lab', () => {
  it('never claims to model a device, and says what a mono target does', async () => {
    const result = await analyzeMix({ bytes: buildWav(8, [{ hz: 300, amplitude: 0.3, placement: 'inverted' }]), mimeType: 'audio/wav' })
    const estimates = estimateTranslation(result.metrics)

    expect(estimates.length).toBeGreaterThan(5)
    for (const estimate of estimates) {
      expect(estimate.modelled).toBe(false)
      expect(estimate.basis).toMatch(/not a measured model/)
      expect(estimate.observations.length).toBeGreaterThan(0)
    }

    const phone = estimates.find((estimate) => estimate.target === 'phone_speaker')
    expect(phone!.observations.join(' ')).toMatch(/cancel|mono/i)
  })
})

describe('reference dna', () => {
  it('names the cohort size on every row and never invents a comparison', async () => {
    const mine = await analyzeMix({ bytes: MUSICAL, mimeType: 'audio/wav' })
    const brighter = await analyzeMix({
      bytes: buildWav(10, [
        { hz: 55, amplitude: 0.08 },
        { hz: 3000, amplitude: 0.25 },
        { hz: 6500, amplitude: 0.18 },
      ]),
      mimeType: 'audio/wav',
    })

    const comparison = compareToReferences(mine.metrics, [{ referenceId: 'ref1', label: 'Reference One', metrics: brighter.metrics }])

    expect(comparison.cohortSize).toBe(1)
    expect(comparison.caveat).toMatch(/not a standard/)
    for (const row of comparison.rows) {
      if (row.delta !== null) expect(row.observation).toMatch(/your single reference|your \d+ references/)
    }
    // A darker record against a brighter reference should surface as a headline.
    expect(comparison.headlines.join(' ')).toMatch(/darker|less energy above|brighter/)
  })

  it('reports no comparison when the cohort could not be measured', async () => {
    const mine = await analyzeMix({ bytes: MUSICAL, mimeType: 'audio/wav' })
    const comparison = compareToReferences(mine.metrics, [{ referenceId: 'ref1', label: 'Unmeasured', metrics: [] }])
    expect(comparison.cohortSize).toBe(0)
    for (const row of comparison.rows) {
      expect(row.delta).toBeNull()
      expect(row.observation).toMatch(/no comparison|nothing to compare/)
    }
  })
})

describe('release readiness', () => {
  it('scores bands independently and carries the caveat', async () => {
    const result = await analyzeMix({ bytes: MUSICAL, mimeType: 'audio/wav' })
    const readiness = computeReleaseReadiness(result.metrics)

    expect(readiness.caveat).toMatch(/not a judgement of the record/)
    expect(readiness.bands).toHaveLength(8)
    for (const band of readiness.bands) {
      if (band.score !== null) {
        expect(band.score).toBeGreaterThanOrEqual(0)
        expect(band.score).toBeLessThanOrEqual(100)
        expect(band.detected.length).toBeGreaterThan(0)
        expect(band.recommendation.length).toBeGreaterThan(0)
      } else {
        expect(band.recommendation).toMatch(/not enough information/)
      }
    }
  })

  it('withholds an overall score when fewer than half the bands could be measured', () => {
    const readiness = computeReleaseReadiness([
      { key: 'integrated_lufs', value: -12, unit: 'lufs', confidence: 0.6, analysisMethod: 't', provider: 't', note: '' },
    ])
    expect(readiness.bandsScored).toBeLessThan(4)
    expect(readiness.score).toBeNull()
  })
})

/**
 * The processing provider seam.
 *
 * The property under test is not "the registry returns something" — it is that
 * a deployment which cannot process audio says so, and is never allowed to
 * masquerade as one that can.
 */
describe('audio processing providers', () => {
  const readyRenderer = {
    rendererId: 'test-ffmpeg',
    version: '1.0.0',
    isAvailable: async () => true,
    renderMaster: async () => ({
      bytes: new Uint8Array([1]),
      contentType: 'audio/wav',
      renderer: 'test-ffmpeg',
      rendererVersion: '1.0.0',
      placeholder: false,
      filterChain: 'volume=1',
      note: '',
    }),
  }
  const absentRenderer = { ...readyRenderer, isAvailable: async () => false }

  it('reports rendering as degraded — not ready — when nothing can process audio', async () => {
    const provider = new LocalAudioProcessingProvider(absentRenderer)
    const status = await provider.status('render_master')

    expect(status.readiness).toBe('degraded')
    expect(status.reason).toMatch(/ffmpeg/)
    // Measuring still works: a WAV is decoded in process.
    expect((await provider.status('analyze_mix')).readiness).toBe('ready')
  })

  it('names the performer, so a local result cannot read as a hosted service', async () => {
    const status = await new LocalAudioProcessingProvider(readyRenderer).status('render_master')
    expect(status.provider).toBe('street-banker')
    expect(status.local).toBe(true)
  })

  it('prefers a ready provider over a degraded one', async () => {
    const vendor: AudioProcessingProvider = {
      provider: 'vendor',
      adapter: 'vendor-v1',
      local: false,
      capabilities: ['render_master'],
      status: async (capability) => ({ provider: 'vendor', adapter: 'vendor-v1', capability, readiness: 'ready', reason: null, local: false }),
      renderMaster: readyRenderer.renderMaster,
    }
    const registry = new AudioProcessingRegistry().register(vendor).register(new LocalAudioProcessingProvider(absentRenderer))

    expect((await registry.resolve('render_master'))?.provider).toBe('vendor')
  })

  it('falls back to the degraded provider rather than to nothing', async () => {
    const registry = new AudioProcessingRegistry().register(new LocalAudioProcessingProvider(absentRenderer))
    const resolved = await registry.resolve('render_master')
    expect(resolved?.provider).toBe('street-banker')
  })

  it('refuses with the capability named when nothing can do the work', async () => {
    const registry = new AudioProcessingRegistry().register(new LocalAudioProcessingProvider(readyRenderer))
    await expect(registry.require('separate_stems')).rejects.toMatchObject({ code: 'studio.processing_provider_not_configured' })
  })

  it('survives a provider whose own status check throws', async () => {
    const broken: AudioProcessingProvider = {
      provider: 'broken',
      adapter: 'broken-v1',
      local: false,
      capabilities: ['render_master'],
      status: async () => {
        throw new Error('the endpoint refused the connection')
      },
    }
    const registry = new AudioProcessingRegistry().register(broken).register(new LocalAudioProcessingProvider(readyRenderer))

    // A provider that cannot answer is not a provider that works.
    expect((await registry.resolve('render_master'))?.provider).toBe('street-banker')
    const report = await registry.report('render_master')
    expect(report.find((status) => status.provider === 'broken')).toMatchObject({
      readiness: 'unavailable',
      reason: 'the endpoint refused the connection',
    })
  })
})
