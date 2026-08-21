import { readFile } from 'node:fs/promises'
import type { MicroUsd } from '@masterclip/shared'
import type { CanonicalShot, CharacterRecord } from '@masterclip/shot-schema'
import type { TechnicalQcResult } from './technical.js'

export interface VisualScores {
  creativeScore: number
  identityScore: number
  continuityScore: number
  motionScore: number
  realismScore: number
}

export interface VisualQcResult extends VisualScores {
  hardFailures: string[]
  warnings: string[]
  observations: string[]
  confidence: number
  engine: string
  costMicros: MicroUsd
}

export interface VisionRequest {
  systemPrompt: string
  userPrompt: string
  images: Array<{ base64: string; mediaType: string; label: string }>
  /** Cheap model for first-pass triage; the caller escalates when uncertain. */
  tier: 'fast' | 'deep'
}

export interface VisionResponse {
  json: unknown
  costMicros: MicroUsd
  model: string
}

/** Implemented by @masterclip/agents (Claude) and by the test double. */
export interface VisionClient {
  readonly name: string
  analyze(request: VisionRequest): Promise<VisionResponse>
}

const SYSTEM_PROMPT = `You are a senior commercial post-production QC supervisor reviewing AI-generated video frames for a cinematic render factory.

You judge four things and nothing else:
1. Does this match the shot specification that was requested?
2. Does the subject's identity, wardrobe, and props stay consistent across the supplied frames?
3. Is the image physically plausible — anatomy, hands, materials, reflections, lighting direction, weight of motion?
4. Would a client accept this in a paid commercial deliverable?

Be strict. Technically clean and creatively worthless is a rejection, not a pass. Do not praise. Do not speculate about frames you were not shown.

Respond with ONLY a JSON object, no prose, matching:
{
  "creative_score": 0-100,
  "identity_score": 0-100,
  "continuity_score": 0-100,
  "motion_score": 0-100,
  "realism_score": 0-100,
  "hard_failures": ["short specific strings"],
  "warnings": ["short specific strings"],
  "observations": ["what you actually see"],
  "confidence": 0.0-1.0
}

Score 0 for a dimension you cannot assess from the frames given, and lower your confidence accordingly.`

export function buildVisualPrompt(shot: CanonicalShot, characters: CharacterRecord[], technical: TechnicalQcResult): string {
  const identityLines = characters.map(
    (c) =>
      `- ${c.character_key} (${c.name}): hair ${c.hair || 'unspecified'}; skin ${c.skin_tone || 'unspecified'}; wardrobe ${
        c.wardrobe.join(', ') || 'unspecified'
      }; prohibited: ${c.prohibited_wardrobe_changes.join(', ') || 'none'}`,
  )

  return `SHOT SPECIFICATION
Title: ${shot.title || shot.shot_id}
Category: ${shot.shot_category}
Narrative purpose: ${shot.narrative_purpose || '(none stated)'}
Action: ${shot.action || '(none stated)'}
Performance: ${shot.performance_direction || '(none stated)'}
Camera position: ${shot.camera_position || '(none stated)'}
Camera movement: ${shot.camera_movement || '(none stated)'}
Lens: ${shot.lens_mm}mm at f/${shot.aperture}
Lighting: dominant source ${shot.lighting.dominant_source || '(none stated)'} from ${shot.lighting.source_position || '(unstated)'}; ${
    shot.lighting.shadow_behavior || 'shadow behaviour unstated'
  }
Screen direction: ${shot.screen_direction}
Requested duration: ${shot.duration_seconds}s at ${shot.target_resolution} ${shot.aspect_ratio}

IDENTITY LOCKS (must not drift)
${identityLines.length > 0 ? identityLines.join('\n') : '(no locked characters)'}

WARDROBE LOCKS: ${shot.wardrobe_locks.map((w) => `${w.item}${w.detail ? ` (${w.detail})` : ''}`).join('; ') || '(none)'}
PROP LOCKS: ${shot.prop_locks.map((p) => `${p.prop}${p.hand !== 'none' ? ` in the ${p.hand} hand` : ''}`).join('; ') || '(none)'}
MUST NOT CONTAIN: ${shot.negative_constraints.join('; ') || '(none stated)'}

MEASURED TECHNICAL FACTS (already verified — do not re-report these)
- delivered ${technical.measurements.durationSeconds}s at ${technical.measurements.width}x${technical.measurements.height}, ${technical.measurements.fps}fps
- frame-to-frame motion energy ${technical.measurements.motionMean} (0 means a still image)
- ${technical.measurements.freezeSeconds}s frozen, ${technical.measurements.blackSeconds}s black
- audio stream present: ${technical.measurements.hasAudio}

The frames below are in chronological order across the clip. Judge the shot against the specification above.`
}

export interface VisualQcInput {
  shot: CanonicalShot
  characters?: CharacterRecord[]
  technical: TechnicalQcResult
  framePaths: string[]
  tier?: 'fast' | 'deep'
}

/**
 * Second-layer QC: what the frames actually show.
 *
 * A cheap model runs first over sampled frames; the caller escalates to a
 * stronger one only when the verdict is uncertain or the clip is expensive.
 * Anything the technical layer already measured is stated as fact in the
 * prompt rather than asked about — paying a vision model to count frames is
 * exactly the waste this architecture avoids.
 */
export async function runVisualQc(client: VisionClient, input: VisualQcInput): Promise<VisualQcResult> {
  const images = await Promise.all(
    input.framePaths.slice(0, 8).map(async (path, index) => ({
      base64: Buffer.from(await readFile(path)).toString('base64'),
      mediaType: path.endsWith('.png') ? 'image/png' : 'image/jpeg',
      label: `frame ${index + 1}`,
    })),
  )

  const response = await client.analyze({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: buildVisualPrompt(input.shot, input.characters ?? [], input.technical),
    images,
    tier: input.tier ?? 'fast',
  })

  const parsed = coerceScores(response.json)
  return {
    ...parsed,
    engine: `${client.name}:${response.model}`,
    costMicros: response.costMicros,
  }
}

function clampScore(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.min(100, Math.round(n)))
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).slice(0, 20)
}

function coerceScores(json: unknown): Omit<VisualQcResult, 'engine' | 'costMicros'> {
  const obj = (json ?? {}) as Record<string, unknown>
  const confidence = typeof obj.confidence === 'number' ? Math.max(0, Math.min(1, obj.confidence)) : 0.5
  return {
    creativeScore: clampScore(obj.creative_score),
    identityScore: clampScore(obj.identity_score),
    continuityScore: clampScore(obj.continuity_score),
    motionScore: clampScore(obj.motion_score),
    realismScore: clampScore(obj.realism_score),
    hardFailures: stringList(obj.hard_failures),
    warnings: stringList(obj.warnings),
    observations: stringList(obj.observations),
    confidence,
  }
}

/**
 * Deterministic stand-in used when no vision credential is configured.
 *
 * It derives what it honestly can from the measured signals and reports a low
 * confidence, so the pipeline stays complete without anything pretending a
 * model looked at the frames. Its engine name says exactly that, and it never
 * emits a score high enough to auto-promote.
 */
export class HeuristicVisionClient implements VisionClient {
  readonly name = 'heuristic-no-vision-model'

  constructor(private readonly technicalProvider: () => TechnicalQcResult | null = () => null) {}

  async analyze(): Promise<VisionResponse> {
    const technical = this.technicalProvider()
    const motion = technical?.measurements.motionMean ?? 0
    const motionScore = Math.max(0, Math.min(100, Math.round(Math.min(1, motion / 4) * 100)))
    return {
      json: {
        creative_score: 0,
        identity_score: 0,
        continuity_score: 0,
        motion_score: motionScore,
        realism_score: 0,
        hard_failures: [],
        warnings: ['no vision model configured — creative, identity, continuity and realism were not assessed'],
        observations: ['scores derived from measured motion energy only'],
        confidence: 0.05,
      },
      costMicros: 0,
      model: 'none',
    }
  }
}
