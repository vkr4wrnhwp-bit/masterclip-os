import { metricValue } from '@masterclip/mix-analysis'
import { isWorthShowing, SONIC_DNA_LABELS, type CreativeMemoryRecord, type SonicDnaAttribute, type SonicDnaRecord } from '@masterclip/studio-domain'
import { actorLabel, type Actor, type StudioDeps } from './deps.js'
import { toMixMetrics } from './mix.js'
import { artistKeyOf } from './room.js'

/**
 * Artist Sonic DNA and Creative Memory.
 *
 * The rule the spec is emphatic about, and that this file implements: **do not
 * silently learn from every action.** Learning happens at exactly one moment —
 * when a human *approves* a master — because an approval is the only signal in
 * the system that unambiguously means "this is what I wanted". Everything else
 * a user does (auditioning, rendering, comparing) is exploration, and treating
 * exploration as preference is how a system ends up confidently wrong about
 * somebody's taste.
 *
 * Everything derived lands as `proposed`, is visible, is attributed to the
 * approvals it came from, and can be reset outright.
 */
export class StudioMemoryService {
  constructor(private readonly deps: StudioDeps) {}

  /**
   * Learns from one approval.
   *
   * Called when a master is approved, never on a render or an audition. Each
   * attribute is re-derived from every approved master this artist has, so the
   * sample size on a row is always the truth and never a running counter that
   * drifted.
   */
  async learnFromApproval(actor: Actor, projectId: string, versionId: string): Promise<SonicDnaRecord[]> {
    const project = await this.deps.repos.projects.get(actor.orgId, projectId)
    const artistKey = artistKeyOf(project)

    // Every approved master across this artist's projects, with its measurements.
    const samples: Array<{ projectId: string; versionId: string; metrics: ReturnType<typeof toMixMetrics>; direction: string | null }> = []
    const projects = await this.deps.repos.projects.list(actor.orgId, { includeArchived: true })
    for (const candidate of projects.filter((entry) => artistKeyOf(entry) === artistKey)) {
      const approvals = await this.deps.repos.approvals.list(actor.orgId, candidate.id)
      for (const approval of approvals) {
        if (approval.approvalType !== 'master' || approval.revokedAt) continue
        const analysis = await this.deps.repos.analyses.latestForVersion(actor.orgId, approval.studioVersionId)
        if (!analysis) continue
        const version = await this.deps.repos.versions.get(actor.orgId, approval.studioVersionId).catch(() => null)
        const rendition = version?.masterRenditionId ? await this.deps.repos.renditions.get(actor.orgId, version.masterRenditionId).catch(() => null) : null
        samples.push({
          projectId: candidate.id,
          versionId: approval.studioVersionId,
          metrics: toMixMetrics(await this.deps.repos.analyses.metrics(actor.orgId, analysis.id)),
          direction: rendition?.direction ?? null,
        })
      }
    }

    // Also fold in the approval that triggered this, in case it is not yet
    // reflected above (the caller may approve and learn in one transaction).
    if (!samples.some((sample) => sample.versionId === versionId)) {
      const analysis = await this.deps.repos.analyses.latestForVersion(actor.orgId, versionId)
      if (analysis) {
        const version = await this.deps.repos.versions.get(actor.orgId, versionId).catch(() => null)
        const rendition = version?.masterRenditionId ? await this.deps.repos.renditions.get(actor.orgId, version.masterRenditionId).catch(() => null) : null
        samples.push({
          projectId,
          versionId,
          metrics: toMixMetrics(await this.deps.repos.analyses.metrics(actor.orgId, analysis.id)),
          direction: rendition?.direction ?? null,
        })
      }
    }

    if (samples.length === 0) return []

    const derivedFrom = samples.map((sample) => sample.versionId)
    const written: SonicDnaRecord[] = []

    for (const definition of NUMERIC_ATTRIBUTES) {
      const values = samples.map((sample) => metricValue(sample.metrics, definition.metricKey)).filter((value): value is number => value !== null)
      if (values.length === 0) continue
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length
      written.push(
        await this.deps.repos.sonicDna.upsert({
          orgId: actor.orgId,
          artistKey,
          attribute: definition.attribute,
          value: Math.round(mean * 1000) / 1000,
          valueText: definition.describe(mean, values.length),
          // Confidence rises with sample size and is capped: three approved
          // masters is a tendency, not a law.
          confidence: Math.min(0.8, values.length / 5),
          sampleSize: values.length,
          derivedFrom,
          source: 'derived',
          // Promotion is deliberate, except where the evidence is strong enough
          // that hiding it would be unhelpful. Four consistent approvals is
          // that line, and it is written down here rather than assumed.
          status: values.length >= 4 ? 'active' : 'proposed',
        }),
      )
    }

    // Preferred master direction: the mode across approved masters, when the
    // artist has actually used Master Station more than once.
    const directions = samples.map((sample) => sample.direction).filter((direction): direction is string => direction !== null)
    if (directions.length >= 2) {
      const counts = new Map<string, number>()
      for (const direction of directions) counts.set(direction, (counts.get(direction) ?? 0) + 1)
      const [top, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
      written.push(
        await this.deps.repos.sonicDna.upsert({
          orgId: actor.orgId,
          artistKey,
          attribute: 'preferred_master_direction',
          value: null,
          valueText: `${top} (chosen on ${count} of ${directions.length} approved masters)`,
          confidence: Math.min(0.8, count / Math.max(1, directions.length)),
          sampleSize: directions.length,
          derivedFrom,
          source: 'derived',
          status: count >= 3 ? 'active' : 'proposed',
        }),
      )
    }

    // The same evidence, restated as a creative-memory candidate: the DNA row
    // is the number, the memory entry is the sentence a person reads.
    for (const record of written) {
      if (record.valueText) {
        await this.deps.repos.creativeMemory.observe({
          orgId: actor.orgId,
          scope: 'artist',
          scopeId: artistKey,
          patternKey: record.attribute,
          statement: `${SONIC_DNA_LABELS[record.attribute]}: ${record.valueText}`,
          supporting: true,
          evidence: `approved master ${versionId}`,
        })
      }
    }

    await this.deps.repos.activity.record({
      orgId: actor.orgId,
      studioProjectId: projectId,
      actorUserId: actor.userId,
      actorLabel: actorLabel(actor),
      action: 'sonic_dna.updated',
      subjectType: 'sonic_dna',
      subjectId: artistKey,
      detail: `${written.length} attribute(s) derived from ${samples.length} approved master(s)`,
    })

    return written
  }

  async profile(actor: Actor, artistKey: string): Promise<{ artistKey: string; entries: SonicDnaRecord[]; memory: CreativeMemoryRecord[] }> {
    const entries = await this.deps.repos.sonicDna.list(actor.orgId, artistKey)
    const memory = (await this.deps.repos.creativeMemory.list(actor.orgId, 'artist', artistKey)).filter(isWorthShowing)
    return { artistKey, entries, memory }
  }

  /** A preference the artist states outright. Outranks anything derived. */
  async state(actor: Actor, artistKey: string, attribute: SonicDnaAttribute, valueText: string): Promise<SonicDnaRecord> {
    return this.deps.repos.sonicDna.upsert({
      orgId: actor.orgId,
      artistKey,
      attribute,
      value: null,
      valueText,
      confidence: 1,
      sampleSize: 0,
      derivedFrom: [],
      source: 'stated',
      status: 'active',
    })
  }

  async setStatus(actor: Actor, id: string, status: 'proposed' | 'active' | 'dismissed'): Promise<SonicDnaRecord> {
    return this.deps.repos.sonicDna.setStatus(actor.orgId, id, status)
  }

  /** Erases everything derived for an artist, as the product promises. */
  async reset(actor: Actor, artistKey: string): Promise<{ dnaRemoved: number; memoryRemoved: number }> {
    const dnaRemoved = await this.deps.repos.sonicDna.reset(actor.orgId, artistKey)
    const memoryRemoved = await this.deps.repos.creativeMemory.reset(actor.orgId, 'artist', artistKey)
    await this.deps.audit.record({
      orgId: actor.orgId,
      actor: actor.userId,
      action: 'studio.sonic_dna.reset',
      targetType: 'artist',
      targetId: artistKey,
      data: { dnaRemoved, memoryRemoved },
    })
    return { dnaRemoved, memoryRemoved }
  }

  async promoteMemory(actor: Actor, id: string, editedStatement?: string | null): Promise<CreativeMemoryRecord> {
    return this.deps.repos.creativeMemory.promote(actor.orgId, id, actor.userId, editedStatement ?? null)
  }

  async dismissMemory(actor: Actor, id: string): Promise<CreativeMemoryRecord> {
    return this.deps.repos.creativeMemory.dismiss(actor.orgId, id)
  }
}

/**
 * The attributes derived from measurements, and how each is described.
 *
 * The describe functions are where a number becomes a preference an artist
 * recognises. They say "prefers" only where the sample supports it, and name
 * the sample size in the text so the claim carries its own evidence.
 */
const NUMERIC_ATTRIBUTES: Array<{
  attribute: SonicDnaAttribute
  metricKey: string
  describe: (mean: number, count: number) => string
}> = [
  {
    attribute: 'master_loudness_preference',
    metricKey: 'integrated_lufs',
    describe: (mean, count) => `approved masters average ${mean.toFixed(1)} LUFS across ${count} record${count === 1 ? '' : 's'}`,
  },
  {
    attribute: 'dynamic_preference',
    metricKey: 'dynamic_range_db',
    describe: (mean, count) =>
      `${mean >= 9 ? 'consistently chooses more dynamic masters' : mean <= 6 ? 'consistently chooses tightly controlled masters' : 'sits mid-range on dynamics'} — ${mean.toFixed(1)} dB average across ${count} record${count === 1 ? '' : 's'}`,
  },
  {
    attribute: 'stereo_preference',
    metricKey: 'stereo_width',
    describe: (mean, count) =>
      `${mean >= 0.5 ? 'approves wide stereo presentation' : mean <= 0.28 ? 'approves narrower, more centred presentation' : 'approves moderate width'} — ${mean.toFixed(2)} average across ${count} record${count === 1 ? '' : 's'}`,
  },
  {
    attribute: 'low_end_character',
    metricKey: 'low_end_centroid_hz',
    describe: (mean, count) =>
      `low-end weight centres around ${Math.round(mean)} Hz on approved masters (${count} record${count === 1 ? '' : 's'})`,
  },
  {
    attribute: 'vocal_position',
    metricKey: 'vocal_presence_index',
    describe: (mean, count) =>
      `${mean >= 0.55 ? 'approves forward, present vocals' : mean <= 0.35 ? 'approves vocals sitting further into the track' : 'approves mid-placed vocals'} — ${(mean * 100).toFixed(0)}% presence average across ${count} record${count === 1 ? '' : 's'}`,
  },
  {
    attribute: 'vocal_brightness',
    metricKey: 'high_mid_energy_pct',
    describe: (mean, count) => `upper-mid energy averages ${mean.toFixed(1)}% on approved masters (${count} record${count === 1 ? '' : 's'})`,
  },
  {
    attribute: 'frequency_tendency',
    metricKey: 'spectral_tilt_db_per_oct',
    describe: (mean, count) =>
      `spectral tilt averages ${mean.toFixed(1)} dB/octave — ${mean <= -4.5 ? 'a darker balance' : mean >= -2.5 ? 'a brighter balance' : 'a middle balance'} across ${count} record${count === 1 ? '' : 's'}`,
  },
]
