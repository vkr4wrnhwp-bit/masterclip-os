import { computeReleaseReadiness, metricValue, type MixMetric } from '@masterclip/mix-analysis'
import type { MixIssueRecord, RoomAction, RoomExchangeRecord, SonicDnaRecord, StudioNoteRecord, StudioProjectRecord } from '@masterclip/studio-domain'
import { actorLabel, type Actor, type StudioDeps } from './deps.js'
import { toMixMetrics } from './mix.js'

/**
 * ASK THE ROOM.
 *
 * An advisory system, not a replacement for a producer or an engineer. Three
 * rules are enforced by the shape of this file rather than by prompt wording:
 *
 *   1. **Every answer is built from this project's own measurements.** A topic
 *      handler that finds nothing measured says so and returns
 *      `confidence: 'insufficient'`. There is no path that produces a
 *      confident-sounding answer with no data behind it.
 *   2. **Every answer records what it looked at.** `contextUsed` travels with
 *      the exchange, so a user who disagrees can see which numbers the room was
 *      reading and dismiss the answer on the facts.
 *   3. **The room answers in musical terms.** The metric is the evidence, not
 *      the sentence: "the chorus does not open up much past the verse" is what
 *      an artist can act on, and the number sits underneath it.
 *
 * The topic handlers are deterministic. That is a deliberate first
 * implementation rather than a limitation to hide: a language model over the
 * same context would phrase things better, and `responder` is stored on every
 * exchange so the two are distinguishable the day one is wired in.
 */
export class StudioRoomService {
  constructor(private readonly deps: StudioDeps) {}

  async ask(input: { actor: Actor; projectId: string; versionId?: string | null; question: string }): Promise<RoomExchangeRecord> {
    const context = await this.buildContext(input.actor, input.projectId, input.versionId ?? null)
    const answer = answerQuestion(input.question, context)

    return this.deps.repos.roomExchanges.create({
      orgId: input.actor.orgId,
      studioProjectId: input.projectId,
      studioVersionId: context.versionId,
      question: input.question,
      answer: answer.answer,
      responder: answer.responder,
      contextUsed: answer.contextUsed,
      actions: answer.actions,
      confidence: answer.confidence,
      askedBy: input.actor.userId,
    })
  }

  async history(actor: Actor, projectId: string): Promise<RoomExchangeRecord[]> {
    return this.deps.repos.roomExchanges.list(actor.orgId, projectId)
  }

  /**
   * Everything the room is allowed to know.
   *
   * Assembled in one place so the answer handlers cannot reach past it into the
   * database, which is what keeps `contextUsed` honest.
   */
  async buildContext(actor: Actor, projectId: string, versionId: string | null): Promise<RoomContext> {
    const project = await this.deps.repos.projects.get(actor.orgId, projectId)
    const targetVersionId = versionId ?? project.currentVersionId
    const analysis = targetVersionId ? await this.deps.repos.analyses.latestForVersion(actor.orgId, targetVersionId) : null
    const metrics = analysis ? toMixMetrics(await this.deps.repos.analyses.metrics(actor.orgId, analysis.id)) : []
    const issues = analysis ? await this.deps.repos.issues.list(actor.orgId, analysis.id) : []
    const notes = await this.deps.repos.notes.list(actor.orgId, projectId)
    const versions = await this.deps.repos.versions.list(actor.orgId, projectId)
    const references = await this.deps.repos.references.list(actor.orgId, projectId)
    const sonicDna = await this.deps.repos.sonicDna.active(actor.orgId, artistKeyOf(project))

    return {
      project,
      versionId: targetVersionId,
      metrics,
      issues,
      notes,
      versionCount: versions.length,
      referenceCount: references.length,
      sonicDna,
      durationMs: analysis?.durationMs ?? null,
      analysed: analysis !== null && analysis.status === 'ready',
      actorLabel: actorLabel(actor),
    }
  }
}

export interface RoomContext {
  project: StudioProjectRecord
  versionId: string | null
  metrics: MixMetric[]
  issues: MixIssueRecord[]
  notes: StudioNoteRecord[]
  versionCount: number
  referenceCount: number
  sonicDna: SonicDnaRecord[]
  durationMs: number | null
  analysed: boolean
  actorLabel: string
}

export interface RoomAnswer {
  answer: string
  responder: string
  contextUsed: string[]
  actions: RoomAction[]
  confidence: 'high' | 'moderate' | 'low' | 'insufficient'
}

const RESPONDER = 'street-banker-room-v1'

/**
 * Identity, typed.
 *
 * Action targets are deliberately open — a `show_me` points at a curve, a
 * timestamp range or a view depending on the question — and TypeScript widens
 * a mixed array literal to a union that no longer satisfies `RoomAction[]`.
 * Passing the literal through here pins the element type at the point of
 * construction, so a malformed action is still a compile error.
 */
function actions(list: RoomAction[]): RoomAction[] {
  return list
}

interface Topic {
  key: string
  /** Matched against the lowercased question. Any hit selects the topic. */
  patterns: RegExp[]
  answer(context: RoomContext): RoomAnswer | null
}

export function answerQuestion(question: string, context: RoomContext): RoomAnswer {
  const normalized = question.toLowerCase()

  if (!context.analysed) {
    return {
      answer:
        'This version has not finished analysis yet, so anything I said about it would be invented. Once the analysis lands I can answer from what is actually in the file.',
      responder: RESPONDER,
      contextUsed: [],
      actions: [],
      confidence: 'insufficient',
    }
  }

  for (const topic of TOPICS) {
    if (!topic.patterns.some((pattern) => pattern.test(normalized))) continue
    const answer = topic.answer(context)
    if (answer) return answer
  }

  return generalAnswer(context)
}

// ---------------------------------------------------------------------------
// topics
// ---------------------------------------------------------------------------

const TOPICS: Topic[] = [
  {
    key: 'chorus_size',
    patterns: [/chorus.*(bigger|big|lift|open|hit|impact)/, /(bigger|lift|impact).*chorus/, /why.*chorus.*(feel|sound)/],
    answer(context) {
      const range = metricValue(context.metrics, 'dynamic_range_db')
      const congestion = metricValue(context.metrics, 'midrange_congestion_index')
      const width = metricValue(context.metrics, 'stereo_width')
      if (range === null && congestion === null) return null

      const lines: string[] = []
      // "Bigger" is almost never about level — it is about the difference
      // between the section before it and the section itself.
      lines.push('A chorus reads as bigger mostly by contrast with what comes before it, so the useful question is how much changes at the transition.')
      if (range !== null) {
        lines.push(
          range < 6
            ? `This record measures ${range.toFixed(1)} dB of dynamic range across the whole thing, which is tight. When everything is already at the ceiling there is nowhere for a chorus to go — the usual fix is making the verse smaller rather than the chorus louder.`
            : `Dynamic range across the record is ${range.toFixed(1)} dB, so there is room for a chorus to lift. If it still is not landing, it is more likely an arrangement or an arrangement-contrast question than a level one.`,
        )
      }
      if (congestion !== null && congestion > 0.4) {
        lines.push(
          `The midrange also measures ${(congestion * 100).toFixed(0)}% on the congestion indicator — a full, static midrange makes every section sound the same size regardless of what the faders are doing.`,
        )
      }
      if (width !== null) {
        lines.push(`Stereo width sits at ${width.toFixed(2)}. Widening only the chorus is a common way to buy contrast without adding level.`)
      }

      return {
        answer: lines.join(' '),
        responder: RESPONDER,
        contextUsed: ['dynamic_range_db', 'midrange_congestion_index', 'stereo_width'].filter((key) => metricValue(context.metrics, key) !== null),
        actions: actions([
          { kind: 'show_me', label: 'Show the loudness over time', target: { curve: 'short_term_loudness' } },
          { kind: 'add_note', label: 'Note this on the chorus', target: { category: 'arrangement' } },
        ]),
        confidence: range !== null && congestion !== null ? 'moderate' : 'low',
      }
    },
  },
  {
    key: 'vocal_disappears',
    patterns: [/vocal.*(disappear|lost|buried|behind|vanish|get lost)/, /(can'?t hear|cant hear).*vocal/, /vocal.*(sit|forward|present)/],
    answer(context) {
      const masking = metricValue(context.metrics, 'vocal_masking_index')
      const presence = metricValue(context.metrics, 'vocal_presence_index')
      const stability = metricValue(context.metrics, 'vocal_level_stability')
      const maskingIssues = context.issues.filter((issue) => issue.issueType === 'vocal_masking' || issue.issueType === 'vocal_level_change')
      if (masking === null && presence === null && maskingIssues.length === 0) return null

      const lines: string[] = []
      if (maskingIssues.length > 0) {
        const moments = maskingIssues.slice(0, 3).map((issue) => clockOf(issue.startMs)).join(', ')
        lines.push(`There are ${maskingIssues.length} moments where the vocal band gives way while the rest of the midrange holds — ${moments}. Those are the places to listen first.`)
      }
      if (masking !== null && masking > 0.4) {
        lines.push(
          `Across the record, accompaniment energy sits in the same band as the voice about ${(masking * 100).toFixed(0)}% of the time. That is the usual reason a vocal reads as further away without anybody touching its fader.`,
        )
      }
      if (stability !== null && stability < 0.6) {
        lines.push(`The vocal band level also moves around more than usual (stability ${(stability * 100).toFixed(0)}%), which can be a performance choice or an unmatched punch-in.`)
      }
      if (presence !== null) {
        lines.push(`For context, a lead vocal appears to dominate the midrange across about ${(presence * 100).toFixed(0)}% of the record.`)
      }
      lines.push('All of this is measured from the full mix unless an isolated vocal was supplied, so treat it as where to look rather than what is wrong.')

      return {
        answer: lines.join(' '),
        responder: RESPONDER,
        contextUsed: ['vocal_masking_index', 'vocal_presence_index', 'vocal_level_stability', ...maskingIssues.map((issue) => `issue:${issue.id}`)],
        actions: actions([
          ...(maskingIssues[0]
            ? [{ kind: 'show_me' as const, label: `Hear ${clockOf(maskingIssues[0].startMs)}`, target: { startMs: maskingIssues[0].startMs, endMs: maskingIssues[0].endMs } }]
            : []),
          { kind: 'send_to_engineer', label: 'Send to the mix engineer', target: { category: 'vocal' } },
        ]),
        confidence: maskingIssues.length > 0 ? 'moderate' : 'low',
      }
    },
  },
  {
    key: 'muddy',
    patterns: [/mud|muddy|boxy|cloudy|woolly|thick/, /(low.?mid|200 ?hz|300 ?hz)/],
    answer(context) {
      const lowMid = metricValue(context.metrics, 'low_mid_energy_pct')
      const congestion = metricValue(context.metrics, 'midrange_congestion_index')
      const lowEnd = metricValue(context.metrics, 'low_energy_pct')
      const centroid = metricValue(context.metrics, 'low_end_centroid_hz')
      if (lowMid === null && congestion === null) return null

      const lines: string[] = ['"Muddy" almost always lives between 200 and 600 Hz, and sometimes in how much is happening there at once rather than how much of it there is.']
      if (lowMid !== null) {
        lines.push(
          lowMid > 24
            ? `Here, 200–600 Hz holds ${lowMid.toFixed(1)}% of the energy, which is on the full side.`
            : `Here, 200–600 Hz holds ${lowMid.toFixed(1)}% of the energy, which is not unusual — so the thickness may be about density rather than balance.`,
        )
      }
      if (congestion !== null && congestion > 0.4) {
        lines.push(`The congestion indicator reads ${(congestion * 100).toFixed(0)}%, meaning the midrange stays busy and steady rather than opening and closing. Carving one element there usually does more than carving all of them.`)
      }
      if (lowEnd !== null && centroid !== null) {
        lines.push(`Below that, the bottom end holds ${lowEnd.toFixed(1)}% of the energy centred around ${Math.round(centroid)} Hz.`)
      }
      const lowEndIssues = context.issues.filter((issue) => issue.issueType === 'low_end_buildup' || issue.issueType === 'midrange_congestion')
      if (lowEndIssues.length > 0) {
        lines.push(`The strongest moments are around ${lowEndIssues.slice(0, 2).map((issue) => clockOf(issue.startMs)).join(' and ')}.`)
      }

      return {
        answer: lines.join(' '),
        responder: RESPONDER,
        contextUsed: ['low_mid_energy_pct', 'midrange_congestion_index', 'low_energy_pct', 'low_end_centroid_hz'],
        actions: actions([
          { kind: 'show_me', label: 'Show the spectral balance', target: { view: 'spectrum' } },
          { kind: 'add_note', label: 'Note this for the mix', target: { category: 'mix' } },
        ]),
        confidence: lowMid !== null && congestion !== null ? 'moderate' : 'low',
      }
    },
  },
  {
    key: 'intro_length',
    patterns: [/intro/, /(too long|too short).*(start|beginning|opening)/, /how long.*(before|until).*(chorus|hook)/],
    answer(context) {
      const lead = metricValue(context.metrics, 'lead_in_seconds')
      if (context.durationMs === null) return null
      const lines: string[] = []
      lines.push(
        `The record runs ${clockOf(context.durationMs)}.` +
          (lead !== null && lead > 1 ? ` There is ${lead.toFixed(1)} s of silence before it starts, which is worth trimming before delivery.` : ''),
      )
      // The honest limit: Mix Station measures the audio, not the arrangement.
      // Section boundaries are Song Lab's question, and pretending otherwise
      // would be inventing a structure.
      lines.push(
        context.project.songLabProjectId
          ? 'Where the chorus actually arrives is a structural question — this record is linked to a Song Lab project, which is where section timings and the comparison against a cohort live.'
          : 'Where the chorus actually arrives is a structural question, and Mix Station measures the audio rather than the arrangement. Linking this project to Song Lab would give you section timings and a comparison against a cohort you choose.',
      )
      if (context.referenceCount > 0) {
        lines.push(`You have ${context.referenceCount} reference${context.referenceCount === 1 ? '' : 's'} on this project, so a direct comparison is available.`)
      }

      return {
        answer: lines.join(' '),
        responder: RESPONDER,
        contextUsed: ['lead_in_seconds', 'duration'],
        actions: context.referenceCount > 0 ? [{ kind: 'compare', label: 'Compare with your references', target: { view: 'references' } }] : [],
        confidence: 'low',
      }
    },
  },
  {
    key: 'references',
    patterns: [/reference/, /compare.*(other|commercial|track|record)/, /how does (this|it) compare/],
    answer(context) {
      if (context.referenceCount === 0) {
        return {
          answer:
            'There are no reference tracks on this project yet. Add one or two you are entitled to use and I can tell you where your record sits against them — loudness, spectral balance, stereo width, low-end weight. Street Banker measures references and does not keep or reproduce the audio.',
          responder: RESPONDER,
          contextUsed: [],
          actions: actions([{ kind: 'compare', label: 'Add a reference', target: { view: 'references' } }]),
          confidence: 'insufficient',
        }
      }
      return {
        answer: `You have ${context.referenceCount} reference${context.referenceCount === 1 ? '' : 's'} measured on this project. The comparison view shows every dimension side by side, and names the cohort size on each row — with ${context.referenceCount} reference${context.referenceCount === 1 ? '' : 's'}, read it as a comparison with those specific records rather than a norm.`,
        responder: RESPONDER,
        contextUsed: [`references:${context.referenceCount}`],
        actions: actions([{ kind: 'compare', label: 'Open the reference comparison', target: { view: 'references' } }]),
        confidence: 'moderate',
      }
    },
  },
  {
    key: 'pre_master',
    patterns: [/before master/, /ready.*(master|release)/, /what should i fix/, /good to go/, /is (it|this) ready/],
    answer(context) {
      const readiness = computeReleaseReadiness(context.metrics)
      const open = context.issues.filter((issue) => issue.status === 'open')
      const weakest = readiness.bands
        .filter((band) => band.score !== null)
        .sort((a, b) => (a.score ?? 100) - (b.score ?? 100))
        .slice(0, 2)

      const lines: string[] = []
      lines.push(
        readiness.score === null
          ? 'Not enough of the record could be measured to give an overall readiness figure — that itself is worth looking at before mastering.'
          : `Release readiness reads ${readiness.score} out of 100 across ${readiness.bandsScored} measured bands. That is a translation indicator, not a judgement of the record.`,
      )
      for (const band of weakest) {
        lines.push(`${band.label} is the weakest band at ${band.score}: ${band.detected} ${band.recommendation}`)
      }
      if (open.length > 0) {
        const high = open.filter((issue) => issue.severity === 'high')
        lines.push(
          high.length > 0
            ? `Mix Doctor has ${open.length} open finding${open.length === 1 ? '' : 's'}, ${high.length} of them high severity — starting at ${clockOf(high[0].startMs)}.`
            : `Mix Doctor has ${open.length} open finding${open.length === 1 ? '' : 's'}, none of them high severity.`,
        )
      } else {
        lines.push('Mix Doctor has no open findings on this version.')
      }
      const truePeak = metricValue(context.metrics, 'true_peak_dbtp')
      if (truePeak !== null && truePeak > -1) {
        lines.push(`One practical thing: the mix arrives at ${truePeak.toFixed(2)} dBTP. Mastering has more to work with at −3 to −6 dBTP with nothing limiting the master bus.`)
      }

      return {
        answer: lines.join(' '),
        responder: RESPONDER,
        contextUsed: ['release_readiness', 'true_peak_dbtp', ...open.slice(0, 5).map((issue) => `issue:${issue.id}`)],
        actions: actions([
          { kind: 'show_me', label: 'Open Mix Doctor', target: { view: 'doctor' } },
          ...(open[0] ? [{ kind: 'send_to_engineer' as const, label: 'Send the findings to the engineer', target: { view: 'doctor' } }] : []),
        ]),
        confidence: readiness.score === null ? 'low' : 'moderate',
      }
    },
  },
  {
    key: 'loudness',
    patterns: [/loud|lufs|quiet|level|competitive/, /turn.*(up|down)/],
    answer(context) {
      const lufs = metricValue(context.metrics, 'integrated_lufs')
      const range = metricValue(context.metrics, 'dynamic_range_db')
      if (lufs === null) return null
      const normalisation = -14 - lufs
      return {
        answer:
          `This version measures about ${lufs.toFixed(1)} LUFS integrated — read that as ±1 LU, it is an approximation rather than a certified meter. ` +
          `Streaming platforms normalise to roughly −14 LUFS, so on playback this would move by ${normalisation >= 0 ? '+' : ''}${normalisation.toFixed(1)} dB. ` +
          (lufs > -8
            ? 'Above about −14 LUFS the extra level is turned back down anyway, so what is left of pushing harder is the dynamics you spent getting there.'
            : 'That sits in the range where normalisation leaves the record roughly where you intended.') +
          (range !== null ? ` Dynamic range is ${range.toFixed(1)} dB.` : ''),
        responder: RESPONDER,
        contextUsed: ['integrated_lufs', 'dynamic_range_db'],
        actions: actions([{ kind: 'preview_idea', label: 'Hear a master direction', target: { view: 'master' } }]),
        confidence: 'high',
      }
    },
  },
  {
    key: 'low_end',
    patterns: [/bass|low end|sub|kick|bottom/, /translate.*(car|phone|club)/],
    answer(context) {
      const sub = metricValue(context.metrics, 'sub_energy_pct')
      const low = metricValue(context.metrics, 'low_energy_pct')
      const centroid = metricValue(context.metrics, 'low_end_centroid_hz')
      const overlap = metricValue(context.metrics, 'kick_bass_masking_index')
      if (sub === null || low === null) return null

      const lines: string[] = [
        `Below 200 Hz this record carries ${(sub + low).toFixed(1)}% of its energy${centroid === null ? '' : `, centred around ${Math.round(centroid)} Hz`}.`,
      ]
      if (centroid !== null) {
        lines.push(
          centroid < 55
            ? 'That is low. It will feel enormous on a system with a sub and close to absent on a phone, which is where most first listens happen.'
            : centroid > 110
              ? 'That is high in the range, which usually translates well on small speakers and can feel light on a big system.'
              : 'That is a middle placement, which tends to survive both small speakers and big ones.',
        )
      }
      if (overlap !== null && overlap > 0.6) {
        lines.push(`The kick and bass bands peak together about ${(overlap * 100).toFixed(0)}% of the time. Common, and only a problem if the low end loses definition on small speakers.`)
      }
      const collisions = context.issues.filter((issue) => issue.issueType === 'kick_bass_collision' || issue.issueType === 'low_end_buildup')
      if (collisions.length > 0) lines.push(`Worth hearing ${collisions.slice(0, 2).map((issue) => clockOf(issue.startMs)).join(' and ')}.`)

      return {
        answer: lines.join(' '),
        responder: RESPONDER,
        contextUsed: ['sub_energy_pct', 'low_energy_pct', 'low_end_centroid_hz', 'kick_bass_masking_index'],
        actions: actions([
          { kind: 'show_me', label: 'Open Translation Lab', target: { view: 'translation' } },
          ...(collisions[0] ? [{ kind: 'show_me' as const, label: `Hear ${clockOf(collisions[0].startMs)}`, target: { startMs: collisions[0].startMs, endMs: collisions[0].endMs } }] : []),
        ]),
        confidence: 'moderate',
      }
    },
  },
  {
    key: 'mono_stereo',
    patterns: [/mono|phase|stereo|wide|width|correlation/],
    answer(context) {
      const correlation = metricValue(context.metrics, 'phase_correlation')
      const width = metricValue(context.metrics, 'stereo_width')
      const monoLoss = metricValue(context.metrics, 'mono_fold_loss_db')
      if (correlation === null) {
        return {
          answer: 'This file is mono, or its two channels are identical, so there is no stereo behaviour to describe.',
          responder: RESPONDER,
          contextUsed: ['phase_correlation'],
          actions: actions([]),
          confidence: 'high',
        }
      }
      return {
        answer:
          `Channel correlation averages ${correlation.toFixed(2)}${width === null ? '' : ` with a width of ${width.toFixed(2)}`}. ` +
          (correlation < 0
            ? 'Sustained negative correlation means some material partly cancels when the mix is summed to mono — a phone speaker, a Bluetooth cube, most club subs.'
            : 'That folds down to mono without much loss.') +
          (monoLoss === null ? '' : ` Summed to mono the level changes by ${monoLoss.toFixed(1)} dB.`),
        responder: RESPONDER,
        contextUsed: ['phase_correlation', 'stereo_width', 'mono_fold_loss_db'],
        actions: actions([{ kind: 'show_me', label: 'Open Translation Lab', target: { view: 'translation' } }]),
        confidence: 'high',
      }
    },
  },
  {
    key: 'top_end',
    patterns: [/harsh|bright|sibilan|ess|sharp|fatigu|top end|treble|air/],
    answer(context) {
      const harshness = metricValue(context.metrics, 'harshness_index')
      const sibilance = metricValue(context.metrics, 'sibilance_index')
      const high = metricValue(context.metrics, 'high_energy_pct')
      if (harshness === null && sibilance === null) return null
      const moments = context.issues.filter((issue) => issue.issueType === 'upper_mid_harshness' || issue.issueType === 'sibilance')
      const lines: string[] = []
      if (harshness !== null) lines.push(`Upper-mid concentration reads ${(harshness * 100).toFixed(0)}% — that is the 2–5 kHz region, where ears fatigue first.`)
      if (sibilance !== null) lines.push(`The sibilance indicator reads ${(sibilance * 100).toFixed(0)}%, measured against this record's own baseline rather than a fixed threshold.`)
      if (high !== null) lines.push(`Above 6 kHz sits ${high.toFixed(1)}% of the energy.`)
      if (moments.length > 0) lines.push(`Specific moments: ${moments.slice(0, 3).map((issue) => clockOf(issue.startMs)).join(', ')}.`)
      lines.push('Earbuds at a low level is the fastest way to hear whether any of this is a problem — consumer playback lifts exactly this region.')
      return {
        answer: lines.join(' '),
        responder: RESPONDER,
        contextUsed: ['harshness_index', 'sibilance_index', 'high_energy_pct'],
        actions: moments[0] ? [{ kind: 'show_me', label: `Hear ${clockOf(moments[0].startMs)}`, target: { startMs: moments[0].startMs, endMs: moments[0].endMs } }] : [],
        confidence: 'moderate',
      }
    },
  },
]

/**
 * What the room says when it does not recognise the question.
 *
 * Deliberately not an attempt at an answer. It reports what it can actually see
 * and offers the places to look — a wrong-but-fluent reply about a record
 * somebody is about to release is worse than an honest shrug.
 */
function generalAnswer(context: RoomContext): RoomAnswer {
  const readiness = computeReleaseReadiness(context.metrics)
  const open = context.issues.filter((issue) => issue.status === 'open')
  const lines: string[] = [
    'I am not sure which part of the record you are asking about, so here is what I can see rather than a guess.',
    readiness.score === null
      ? 'Not enough bands could be measured for an overall readiness figure.'
      : `Release readiness reads ${readiness.score} out of 100 across ${readiness.bandsScored} measured bands.`,
    open.length > 0
      ? `Mix Doctor has ${open.length} open finding${open.length === 1 ? '' : 's'}, the first at ${clockOf(open[0].startMs)}.`
      : 'Mix Doctor has no open findings on this version.',
    `There ${context.versionCount === 1 ? 'is 1 version' : `are ${context.versionCount} versions`} in the vault and ${context.notes.length} note${context.notes.length === 1 ? '' : 's'} on the timeline.`,
    'Ask about the vocal, the low end, the top end, loudness, mono behaviour, your references, or what to fix before mastering, and I can be specific.',
  ]
  if (context.sonicDna.length > 0) {
    lines.push(`I also hold ${context.sonicDna.length} preference${context.sonicDna.length === 1 ? '' : 's'} derived from this artist's approved work, which you can view and reset at any time.`)
  }

  return {
    answer: lines.join(' '),
    responder: RESPONDER,
    contextUsed: ['release_readiness', 'mix_issues', 'versions', 'notes'],
    actions: [{ kind: 'show_me', label: 'Open Mix Doctor', target: { view: 'doctor' } }],
    confidence: 'low',
  }
}

export function artistKeyOf(project: StudioProjectRecord): string {
  // Roster identity when there is one; otherwise a normalized name, so an
  // artist with no roster record still accumulates a consistent profile.
  return project.artistId ?? project.artistName.trim().toLowerCase()
}

function clockOf(ms: number): string {
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
