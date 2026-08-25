import { AppError } from '@masterclip/shared'
import { analyzeLyrics, countSyllablesInLine, parseLyricSheet, type LyricAnalysisResult, type LyricSource } from '@masterclip/lyric-analysis'
import { findChantOpportunities, type ChantOpportunity } from '@masterclip/song-structure'
import { measured, unknown } from '@masterclip/song-feature-vectors'
import type { SongLyricLineRecord } from '@masterclip/song-lab-domain'
import { toDetected, toSectionFeatures } from './analysis.js'
import type { Actor, SongLabDeps } from './deps.js'

/**
 * Lyric intelligence and the Chant Finder.
 *
 * Lyrics are analysed only when the organization supplied them or transcribed
 * them from audio it confirmed it controls. `setLyrics` records which, and
 * `analyze` refuses to run on a version with no lyric rows — there is no path
 * that infers a lyric in order to have something to analyse.
 */
export class SongLyricService {
  constructor(private readonly deps: SongLabDeps) {}

  /**
   * Stores a lyric.
   *
   * Accepts a pasted sheet, structured lines, or time-coded lines. Section
   * headers in a sheet (`[Chorus]`) are treated as hints and mapped onto the
   * confirmed structure where the timings allow; the structure editor remains
   * authoritative.
   */
  async setLyrics(input: {
    actor: Actor
    projectId: string
    source: LyricSource
    /** Raw sheet text, or structured lines. One or the other. */
    text?: string
    lines?: Array<{ text: string; startMs?: number | null; endMs?: number | null; sectionOrderIndex?: number | null }>
  }): Promise<SongLyricLineRecord[]> {
    const project = await this.deps.repos.projects.get(input.actor.orgId, input.projectId)
    if (!project.currentVersionId) {
      throw new AppError({ kind: 'validation', code: 'song_lab.no_version', message: 'attach audio before adding lyrics' })
    }

    const parsed = input.lines
      ? input.lines.map((line, index) => ({
          text: line.text,
          lineIndex: index,
          startMs: line.startMs ?? null,
          endMs: line.endMs ?? null,
          sectionOrderIndex: line.sectionOrderIndex ?? null,
        }))
      : parseLyricSheet(input.text ?? '').map((line, index) => ({
          text: line.text,
          lineIndex: index,
          startMs: null,
          endMs: null,
          sectionOrderIndex: null as number | null,
          sectionHint: line.sectionHint,
        }))

    if (parsed.length === 0) {
      throw new AppError({ kind: 'validation', code: 'song_lab.empty_lyrics', message: 'no lyric lines were provided' })
    }

    const sections = await this.sectionsFor(input.actor, project.currentVersionId)
    const sectionIdByOrder = new Map(sections.map((section) => [section.orderIndex, section.id]))

    const rows = parsed.map((line) => {
      // A time-coded line places itself; an untimed one is attached only where
      // the caller said which section it belongs to.
      const orderIndex =
        line.sectionOrderIndex ??
        (line.startMs !== null ? sections.find((section) => line.startMs! >= section.startMs && line.startMs! < section.endMs)?.orderIndex ?? null : null)
      return {
        text: line.text,
        lineIndex: line.lineIndex,
        sectionId: orderIndex === null ? null : (sectionIdByOrder.get(orderIndex) ?? null),
        startMs: line.startMs,
        endMs: line.endMs,
        syllableCount: countSyllablesInLine(line.text),
        titlePhrase: project.titlePhrase.length > 0 && normalize(line.text).includes(normalize(project.titlePhrase)),
        hookPhrase: false,
        userConfirmed: input.source === 'user_supplied',
      }
    })

    const stored = await this.deps.repos.lyrics.replaceAll(input.actor.orgId, project.currentVersionId, rows, input.source)
    await this.deps.audit.record({
      orgId: input.actor.orgId,
      actor: input.actor.userId,
      action: 'song_lab.lyrics.set',
      targetType: 'song_version',
      targetId: project.currentVersionId,
      data: { source: input.source, lines: stored.length },
    })
    return stored
  }

  /**
   * Analyses the stored lyric and folds the results into the feature vector.
   *
   * Refuses when there is nothing authorized to analyse: an empty lyric is not
   * a lyric of zero syllables.
   */
  async analyze(actor: Actor, projectId: string): Promise<LyricAnalysisResult> {
    const project = await this.deps.repos.projects.get(actor.orgId, projectId)
    if (!project.currentVersionId) {
      throw new AppError({ kind: 'validation', code: 'song_lab.no_version', message: 'this project has no version to analyse' })
    }
    const lines = await this.deps.repos.lyrics.list(actor.orgId, project.currentVersionId)
    if (lines.length === 0) {
      throw new AppError({
        kind: 'validation',
        code: 'song_lab.no_lyrics',
        message: 'no authorized lyrics are attached to this version, so no lyric analysis was performed',
      })
    }

    const analysis = await this.deps.repos.analyses.latestForVersion(actor.orgId, project.currentVersionId)
    const sections = analysis ? await this.deps.repos.sections.list(actor.orgId, analysis.id) : []
    const sectionOrderById = new Map(sections.map((section) => [section.id, section.orderIndex]))
    const sectionTypes: Record<number, string> = {}
    const sectionSeconds: Record<number, number> = {}
    for (const section of sections) {
      sectionTypes[section.orderIndex] = section.sectionType
      sectionSeconds[section.orderIndex] = (section.endMs - section.startMs) / 1000
    }

    const result = await this.deps.providers.lyrics.analyzeLyrics({
      lines: lines.map((line) => ({
        text: line.text,
        startMs: line.startMs,
        endMs: line.endMs,
        sectionOrderIndex: line.sectionId ? (sectionOrderById.get(line.sectionId) ?? null) : null,
        titlePhrase: line.titlePhrase,
        hookPhrase: line.hookPhrase,
        userConfirmed: line.userConfirmed,
      })),
      source: (lines[0]?.lyricSource ?? 'user_supplied') as LyricSource,
      title: project.titlePhrase || project.title,
      sectionTypes,
      sectionSeconds,
      durationSeconds: analysis?.durationMs ? analysis.durationMs / 1000 : undefined,
    })

    if (analysis?.featureVector) await this.mergeIntoVector(actor, analysis.id, result)
    await this.storeSectionSyllableDensity(actor, sections, result)
    return result
  }

  /** Writes lyric metrics into the vector so they can be benchmarked. */
  private async mergeIntoVector(actor: Actor, analysisId: string, result: LyricAnalysisResult): Promise<void> {
    const analysis = await this.deps.repos.analyses.get(actor.orgId, analysisId)
    if (!analysis.featureVector) return
    const vector = analysis.featureVector
    const source = { provider: this.deps.providers.lyrics.providerId, modelVersion: this.deps.providers.lyrics.modelVersion }
    // Syllable counting is a heuristic, so lyric metrics are capped below the
    // confidence a directly measured quantity would carry.
    const confidence = 0.6

    const set = (key: string, value: number | null, method: string, note: string) => {
      vector.metrics[key] = value === null ? unknown<number>(method, source, note) : measured(value, confidence, method, source)
    }

    set('syllables_per_second', result.syllablesPerSecond, 'syllable_heuristic', 'the lyric has no timing information, so density per second is unknown')
    set('chorus_syllables_per_second', result.chorusSyllablesPerSecond, 'syllable_heuristic', 'no chorus lines are mapped to a section')
    set('hook_line_syllables', result.medianHookLineSyllables, 'syllable_heuristic', 'no hook or title lines are marked')
    set('verse_chorus_vocabulary_overlap', result.verseChorusVocabularyOverlap, 'jaccard_vocabulary_overlap', 'the lyric has no mapped verse/chorus pair')
    vector.metrics.title_repetition = measured(result.titleRepetition, result.titleRepetition > 0 ? confidence : 0.4, 'title_phrase_matches', source)
    vector.metrics.lyric_repetition = measured(result.lyricRepetition, confidence, 'repeated_line_share', source)

    await this.deps.db.run('UPDATE song_analyses SET feature_vector = ? WHERE id = ? AND org_id = ?', [
      JSON.stringify(vector),
      analysisId,
      actor.orgId,
    ])
  }

  private async storeSectionSyllableDensity(
    actor: Actor,
    sections: Array<{ id: string; orderIndex: number }>,
    result: LyricAnalysisResult,
  ): Promise<void> {
    for (const section of result.sections) {
      if (section.syllablesPerSecond === null) continue
      const match = sections.find((entry) => entry.orderIndex === section.sectionOrderIndex)
      if (!match) continue
      await this.deps.db.run('UPDATE song_section_features SET syllable_density = ? WHERE song_section_id = ? AND org_id = ?', [
        section.syllablesPerSecond,
        match.id,
        actor.orgId,
      ])
    }
  }

  async markTitleLines(actor: Actor, projectId: string, lineIndexes: number[]): Promise<SongLyricLineRecord[]> {
    const project = await this.deps.repos.projects.get(actor.orgId, projectId)
    if (!project.currentVersionId) throw new AppError({ kind: 'validation', code: 'song_lab.no_version', message: 'no version to update' })
    await this.deps.repos.lyrics.markTitleLines(actor.orgId, project.currentVersionId, lineIndexes)
    return this.deps.repos.lyrics.list(actor.orgId, project.currentVersionId)
  }

  async markHookLines(actor: Actor, projectId: string, lineIndexes: number[]): Promise<SongLyricLineRecord[]> {
    const project = await this.deps.repos.projects.get(actor.orgId, projectId)
    if (!project.currentVersionId) throw new AppError({ kind: 'validation', code: 'song_lab.no_version', message: 'no version to update' })
    await this.deps.repos.lyrics.markHookLines(actor.orgId, project.currentVersionId, lineIndexes)
    return this.deps.repos.lyrics.list(actor.orgId, project.currentVersionId)
  }

  /**
   * Chant Finder.
   *
   * Runs with or without lyrics: without them it uses measured vocal occupancy,
   * with them it uses real syllable density and is correspondingly sharper.
   */
  async chantOpportunities(actor: Actor, projectId: string): Promise<ChantOpportunity[]> {
    const project = await this.deps.repos.projects.get(actor.orgId, projectId)
    if (!project.currentVersionId) return []
    const analysis = await this.deps.repos.analyses.latestForVersion(actor.orgId, project.currentVersionId)
    if (!analysis) return []

    const sections = await this.deps.repos.sections.list(actor.orgId, analysis.id)
    const featureMap = await this.deps.repos.sections.features(actor.orgId, analysis.id)

    const syllableDensity: Record<number, number> = {}
    for (const section of sections) {
      const density = featureMap.get(section.id)?.syllableDensity
      if (density !== null && density !== undefined) syllableDensity[section.orderIndex] = density
    }

    return findChantOpportunities({
      sections: sections.map(toDetected),
      features: sections.map((section) => toSectionFeatures(featureMap.get(section.id))),
      harmonicChangesPerMinute: readHarmonic(analysis.featureVector),
      syllableDensityBySection: syllableDensity,
      titleSectionIndexes: sections.filter((section) => section.isTitlePhrase).map((section) => section.orderIndex),
    })
  }

  private async sectionsFor(actor: Actor, versionId: string) {
    const analysis = await this.deps.repos.analyses.latestForVersion(actor.orgId, versionId)
    if (!analysis) return []
    return this.deps.repos.sections.list(actor.orgId, analysis.id)
  }
}

function readHarmonic(vector: { metrics: Record<string, { value: number | null }> } | null): number | null {
  return vector?.metrics.harmonic_change_rate?.value ?? null
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim()
}

export { analyzeLyrics }
