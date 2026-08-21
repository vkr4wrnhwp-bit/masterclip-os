import type { ModelCapabilities, ModelTier } from '@masterclip/provider-core'
import type { TargetResolution } from '@masterclip/shot-schema'

/**
 * Compiled-in fal model descriptors.
 *
 * fal exposes no machine-readable catalog endpoint in its official clients, so
 * this list is maintained by hand. Every entry carries its own price, source
 * URL and retrieval date, and `docs/current-pricing-snapshot.md` records the
 * confidence of each figure — the two that were read out of a fal-owned repo
 * are marked VERIFIED there; the rest came from fal model pages summarized
 * during research and should be re-checked before volume production.
 *
 * Endpoint ids follow fal's `owner/alias/path` convention. Note that fal's own
 * clients discard everything after `owner/alias` when building status URLs,
 * which is why the adapter stores the URLs fal returns instead.
 */
export interface FalModelSpec {
  endpointId: string
  displayName: string
  family: string
  capabilities: ModelCapabilities
  usdPerSecond: number | null
  usdPerSecondByResolution?: Partial<Record<TargetResolution, number>>
  retrievedAt: string
  sourceUrl: string
  priceNotes?: string
  /** Some fal models take `duration` as a string ("5") rather than a number. */
  durationField?: 'number' | 'string'
}

const RETRIEVED_AT = '2026-08-17'

function caps(tier: ModelTier, overrides: Partial<ModelCapabilities>): ModelCapabilities {
  return {
    modes: ['text_to_video'],
    duration: { minSeconds: 4, maxSeconds: 10, allowedSeconds: [5, 10] },
    resolutions: ['480p', '720p', '1080p'],
    aspectRatios: ['16:9', '9:16', '1:1'],
    fps: [],
    nativeAudio: false,
    dialogue: false,
    firstFrame: false,
    lastFrame: false,
    videoReference: false,
    extension: false,
    maxReferenceImages: 0,
    seed: true,
    negativePrompt: true,
    maxPromptChars: 2500,
    tier,
    safetyControls: [],
    ...overrides,
  }
}

export const FAL_MODELS: FalModelSpec[] = [
  {
    endpointId: 'fal-ai/wan/v2.2-a14b/text-to-video/turbo',
    displayName: 'Wan 2.2 A14B Turbo — text-to-video (draft workhorse)',
    family: 'wan',
    capabilities: caps('draft', { modes: ['text_to_video'], resolutions: ['480p', '720p'] }),
    usdPerSecond: 0.08,
    usdPerSecondByResolution: { '480p': 0.04, '720p': 0.08 },
    retrievedAt: RETRIEVED_AT,
    sourceUrl: 'https://fal.ai/models/fal-ai/wan/v2.2-a14b/text-to-video/turbo',
    priceNotes: 'Wan 2.2 published as $0.08/s @720p, $0.04/s @480p. Rate read from a research summary of the fal model page, not the page itself.',
  },
  {
    endpointId: 'fal-ai/wan/v2.2-a14b/image-to-video/turbo',
    displayName: 'Wan 2.2 A14B Turbo — image-to-video (draft workhorse)',
    family: 'wan',
    capabilities: caps('draft', {
      modes: ['image_to_video'],
      firstFrame: true,
      maxReferenceImages: 1,
      resolutions: ['480p', '720p'],
    }),
    usdPerSecond: 0.08,
    usdPerSecondByResolution: { '480p': 0.04, '720p': 0.08 },
    retrievedAt: RETRIEVED_AT,
    sourceUrl: 'https://fal.ai/models/fal-ai/wan/v2.2-a14b/image-to-video/turbo',
    priceNotes: 'Same rate card as the text-to-video sibling.',
  },
  {
    endpointId: 'fal-ai/wan-25-preview/image-to-video',
    displayName: 'Wan 2.5 — image-to-video',
    family: 'wan',
    capabilities: caps('draft', { modes: ['image_to_video'], firstFrame: true, maxReferenceImages: 1 }),
    usdPerSecond: 0.05,
    retrievedAt: RETRIEVED_AT,
    sourceUrl: 'https://fal.ai/models/fal-ai/wan-25-preview/image-to-video/api',
  },
  {
    endpointId: 'fal-ai/ltx-2.3/text-to-video/fast',
    displayName: 'LTX-2.3 Fast — text-to-video (cheapest per second seen)',
    family: 'ltx',
    capabilities: caps('draft', { modes: ['text_to_video'], resolutions: ['1080p', '1440p', '2160p'] }),
    usdPerSecond: 0.04,
    usdPerSecondByResolution: { '1080p': 0.04, '1440p': 0.08, '2160p': 0.16 },
    retrievedAt: RETRIEVED_AT,
    sourceUrl: 'https://fal.ai/ltx-2.3',
  },
  {
    endpointId: 'fal-ai/ltx-2.3/image-to-video',
    displayName: 'LTX-2.3 Pro — image-to-video',
    family: 'ltx',
    capabilities: caps('standard', {
      modes: ['image_to_video'],
      firstFrame: true,
      maxReferenceImages: 1,
      resolutions: ['1080p', '1440p', '2160p'],
    }),
    usdPerSecond: 0.06,
    usdPerSecondByResolution: { '1080p': 0.06, '1440p': 0.12, '2160p': 0.24 },
    retrievedAt: RETRIEVED_AT,
    sourceUrl: 'https://fal.ai/ltx-2.3',
  },
  {
    endpointId: 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video',
    displayName: 'Kling 2.5 Turbo Pro — image-to-video',
    family: 'kling',
    capabilities: caps('standard', {
      modes: ['image_to_video'],
      firstFrame: true,
      maxReferenceImages: 1,
      duration: { minSeconds: 5, maxSeconds: 10, allowedSeconds: [5, 10] },
      resolutions: ['720p', '1080p'],
    }),
    usdPerSecond: 0.07,
    retrievedAt: RETRIEVED_AT,
    sourceUrl: 'https://fal.ai/models/fal-ai/kling-video/v2.5-turbo/pro/image-to-video',
    priceNotes: 'Published as ≈$0.35 per 5s clip.',
    durationField: 'string',
  },
  {
    endpointId: 'fal-ai/veo3.1/fast/image-to-video',
    displayName: 'Veo 3.1 Fast via fal — image-to-video (native audio)',
    family: 'veo',
    capabilities: caps('standard', {
      modes: ['image_to_video'],
      firstFrame: true,
      lastFrame: true,
      maxReferenceImages: 1,
      nativeAudio: true,
      dialogue: true,
      duration: { minSeconds: 4, maxSeconds: 8, allowedSeconds: [4, 6, 8] },
      resolutions: ['720p', '1080p'],
      aspectRatios: ['16:9', '9:16'],
      seed: false,
    }),
    usdPerSecond: 0.15,
    usdPerSecondByResolution: { '720p': 0.15, '1080p': 0.15 },
    retrievedAt: RETRIEVED_AT,
    sourceUrl: 'https://fal.ai/models/fal-ai/veo3.1/fast',
    priceNotes: '$0.10/s without audio, $0.15/s with audio at 720p/1080p. Quoted with audio because fal exposes the toggle but the audio SKU is the default for cinematic use.',
  },
  {
    endpointId: 'fal-ai/veo3.1/lite',
    displayName: 'Veo 3.1 Lite via fal',
    family: 'veo',
    capabilities: caps('draft', {
      modes: ['text_to_video', 'image_to_video'],
      firstFrame: true,
      nativeAudio: true,
      maxReferenceImages: 1,
      duration: { minSeconds: 4, maxSeconds: 8, allowedSeconds: [4, 6, 8] },
      resolutions: ['720p', '1080p'],
      aspectRatios: ['16:9', '9:16'],
      seed: false,
    }),
    usdPerSecond: 0.05,
    retrievedAt: RETRIEVED_AT,
    sourceUrl: 'https://fal.ai/models/fal-ai/veo3.1/lite',
  },
  {
    endpointId: 'fal-ai/veo3.1/extend-video',
    displayName: 'Veo 3.1 via fal — extend an existing clip',
    family: 'veo',
    capabilities: caps('premium', {
      modes: ['video_extend'],
      videoReference: true,
      extension: true,
      nativeAudio: true,
      duration: { minSeconds: 7, maxSeconds: 7, allowedSeconds: [7] },
      resolutions: ['720p'],
      aspectRatios: ['16:9', '9:16'],
      seed: false,
    }),
    usdPerSecond: 0.2,
    retrievedAt: RETRIEVED_AT,
    sourceUrl: 'https://fal.ai/models/fal-ai/veo3.1',
    priceNotes: 'Extension adds a fixed 7s per call; input must be 720p and Veo-generated.',
  },
  {
    endpointId: 'fal-ai/minimax/hailuo-02/standard/image-to-video',
    displayName: 'Hailuo 02 Standard — image-to-video',
    family: 'hailuo',
    capabilities: caps('draft', {
      modes: ['image_to_video'],
      firstFrame: true,
      maxReferenceImages: 1,
      duration: { minSeconds: 6, maxSeconds: 10, allowedSeconds: [6, 10] },
      resolutions: ['720p'],
    }),
    usdPerSecond: 0.045,
    retrievedAt: RETRIEVED_AT,
    sourceUrl: 'https://fal.ai/models/fal-ai/minimax/hailuo-02/standard/image-to-video',
  },
  {
    endpointId: 'fal-ai/minimax/hailuo-02/pro/image-to-video',
    displayName: 'Hailuo 02 Pro — image-to-video (1080p)',
    family: 'hailuo',
    capabilities: caps('standard', {
      modes: ['image_to_video'],
      firstFrame: true,
      maxReferenceImages: 1,
      duration: { minSeconds: 6, maxSeconds: 10, allowedSeconds: [6, 10] },
      resolutions: ['1080p'],
    }),
    usdPerSecond: 0.08,
    retrievedAt: RETRIEVED_AT,
    sourceUrl: 'https://fal.ai/models/fal-ai/minimax/hailuo-02/pro/image-to-video',
  },
]
