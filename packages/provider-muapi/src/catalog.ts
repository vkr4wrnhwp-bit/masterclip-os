import { dynamicPricing, type ModelCapabilities, type NormalizedModel, type PriceFormula } from '@masterclip/provider-core'

/**
 * Static fallback descriptors for MuAPI.
 *
 * MuAPI's catalog is live and public (`GET /api/v1/models`), and that is the
 * primary path — these entries exist only so the app is usable when the catalog
 * endpoint is unreachable, and every one of them is marked `source: 'static'`
 * so the UI can say where the information came from.
 *
 * Pricing here is deliberately `dynamicPricing()` rather than a number: MuAPI
 * prices most video models per request through `estimate-cost`, and a
 * compiled-in figure would be a number that looks authoritative and is not.
 *
 * Endpoint slugs verified 2026-08-17 against MuAPI's official CLI source
 * (github.com/SamurAIGPT/muapi-cli, T2V_MODELS / I2V_MODELS maps).
 */
const RETRIEVED_AT = '2026-08-17'
const SOURCE_URL = 'https://github.com/SamurAIGPT/muapi-cli (official CLI model map)'

/** Model families whose image input is `images_list: string[]` rather than `image_url: string`. */
export const ARRAY_IMAGE_FAMILIES = [
  'wan',
  'seedance',
  'vidu',
  'pixverse',
  'veo4',
  'openai-sora-2',
  'kling-v3.0-4k',
  'kling-v3-omni',
  'happy-horse',
]

export function usesArrayImageInput(slug: string): boolean {
  return ARRAY_IMAGE_FAMILIES.some((family) => slug.startsWith(family) || slug.includes(`/${family}`))
}

function capabilities(overrides: Partial<ModelCapabilities>): ModelCapabilities {
  return {
    modes: ['text_to_video'],
    duration: { minSeconds: 4, maxSeconds: 10, allowedSeconds: [5, 10] },
    resolutions: ['720p', '1080p'],
    aspectRatios: ['16:9', '9:16', '1:1'],
    fps: [],
    nativeAudio: false,
    dialogue: false,
    firstFrame: false,
    lastFrame: false,
    videoReference: false,
    extension: false,
    maxReferenceImages: 0,
    seed: false,
    negativePrompt: false,
    maxPromptChars: 2000,
    tier: 'standard',
    safetyControls: [],
    ...overrides,
  }
}

const PRICING: PriceFormula = dynamicPricing({
  retrievedAt: RETRIEVED_AT,
  sourceUrl: 'https://api.muapi.ai/api/v1/models/{model}/estimate-cost',
  notes: 'MuAPI prices video models dynamically; MASTERCLIP always calls estimate-cost before a paid submission.',
})

interface StaticModel {
  slug: string
  displayName: string
  family: string
  capabilities: ModelCapabilities
}

export const MUAPI_STATIC_MODELS: StaticModel[] = [
  {
    slug: 'veo3.1-text-to-video',
    displayName: 'Veo 3.1 (text-to-video, via MuAPI)',
    family: 'veo',
    capabilities: capabilities({
      modes: ['text_to_video'],
      duration: { minSeconds: 4, maxSeconds: 8, allowedSeconds: [4, 6, 8] },
      nativeAudio: true,
      dialogue: true,
      tier: 'premium',
      aspectRatios: ['16:9', '9:16'],
    }),
  },
  {
    slug: 'veo3.1-image-to-video',
    displayName: 'Veo 3.1 (image-to-video, via MuAPI)',
    family: 'veo',
    capabilities: capabilities({
      modes: ['image_to_video'],
      duration: { minSeconds: 4, maxSeconds: 8, allowedSeconds: [4, 6, 8] },
      nativeAudio: true,
      firstFrame: true,
      maxReferenceImages: 1,
      tier: 'premium',
      aspectRatios: ['16:9', '9:16'],
    }),
  },
  {
    slug: 'veo3-fast-text-to-video',
    displayName: 'Veo 3 Fast (text-to-video, via MuAPI)',
    family: 'veo',
    capabilities: capabilities({ modes: ['text_to_video'], nativeAudio: true, tier: 'standard', aspectRatios: ['16:9', '9:16'] }),
  },
  {
    slug: 'kling-v2.1-master-t2v',
    displayName: 'Kling 2.1 Master (text-to-video, via MuAPI)',
    family: 'kling',
    capabilities: capabilities({ modes: ['text_to_video'], tier: 'standard' }),
  },
  {
    slug: 'kling-v2.1-master-i2v',
    displayName: 'Kling 2.1 Master (image-to-video, via MuAPI)',
    family: 'kling',
    capabilities: capabilities({ modes: ['image_to_video'], firstFrame: true, maxReferenceImages: 1, tier: 'standard' }),
  },
  {
    slug: 'wan2.7-text-to-video',
    displayName: 'Wan 2.7 (text-to-video, via MuAPI)',
    family: 'wan',
    capabilities: capabilities({ modes: ['text_to_video'], tier: 'draft', resolutions: ['480p', '720p', '1080p'] }),
  },
  {
    slug: 'wan2.7-image-to-video',
    displayName: 'Wan 2.7 (image-to-video, via MuAPI)',
    family: 'wan',
    capabilities: capabilities({
      modes: ['image_to_video'],
      firstFrame: true,
      maxReferenceImages: 1,
      tier: 'draft',
      resolutions: ['480p', '720p', '1080p'],
    }),
  },
  {
    slug: 'ltx-2-fast-text-to-video',
    displayName: 'LTX-2 Fast (text-to-video, via MuAPI)',
    family: 'ltx',
    capabilities: capabilities({ modes: ['text_to_video'], tier: 'draft', resolutions: ['720p', '1080p'] }),
  },
  {
    slug: 'minimax-hailuo-2.3-pro-t2v',
    displayName: 'Hailuo 2.3 Pro (text-to-video, via MuAPI)',
    family: 'hailuo',
    capabilities: capabilities({ modes: ['text_to_video'], tier: 'standard' }),
  },
]

export function staticCatalog(fetchedAt: string): NormalizedModel[] {
  return MUAPI_STATIC_MODELS.map((model) => ({
    providerId: 'muapi',
    modelId: model.slug,
    displayName: model.displayName,
    family: model.family,
    capabilities: model.capabilities,
    pricing: PRICING,
    enabled: true,
    raw: { note: `static fallback descriptor, verified ${RETRIEVED_AT}`, source: SOURCE_URL },
    fetchedAt,
    source: 'static' as const,
  }))
}

/**
 * Maps a live `/api/v1/models` entry onto our normalized shape.
 *
 * MuAPI's catalog does not publish structured capability metadata, so
 * capabilities are inferred from the slug and category. Inference is marked in
 * `raw.capability_source` so nothing downstream mistakes a guess for a
 * provider-declared fact; the authoritative check remains
 * `GET /api/v1/models/{model}` for the input schema.
 */
export function normalizeCatalogEntry(entry: Record<string, unknown>, fetchedAt: string): NormalizedModel | null {
  const slug = String(entry.name ?? entry.endpoint ?? '').replace(/^\/api\/v1\//, '')
  if (!slug) return null
  const category = String(entry.category ?? '')
  if (category && !/video/i.test(category)) return null

  const isImageToVideo = /image-to-video|i2v|-i2v/.test(slug)
  const isVideoToVideo = /video-to-video|v2v|extend/.test(slug)
  const hasAudio = /veo3|veo-3|veo4|sora|omni/.test(slug)
  const isFast = /fast|lite|turbo|flash/.test(slug)
  const isPro = /pro|master|4k|ultra/.test(slug)

  return {
    providerId: 'muapi',
    modelId: slug,
    displayName: String(entry.description ?? slug),
    family: String(entry.family ?? slug.split(/[-.]/)[0] ?? 'unknown'),
    capabilities: capabilities({
      modes: isVideoToVideo ? ['video_to_video', 'video_extend'] : isImageToVideo ? ['image_to_video'] : ['text_to_video'],
      firstFrame: isImageToVideo,
      maxReferenceImages: isImageToVideo ? 1 : 0,
      videoReference: isVideoToVideo,
      extension: /extend/.test(slug),
      nativeAudio: hasAudio,
      dialogue: hasAudio,
      tier: isFast ? 'draft' : isPro ? 'premium' : 'standard',
      resolutions: /4k/.test(slug) ? ['720p', '1080p', '2160p'] : ['480p', '720p', '1080p'],
    }),
    pricing:
      entry.dynamic_pricing === false && typeof entry.cost === 'number'
        ? {
            basis: 'per_video',
            rateMicros: Math.round(entry.cost * 1_000_000),
            dynamic: false,
            retrievedAt: fetchedAt.slice(0, 10),
            sourceUrl: 'https://api.muapi.ai/api/v1/models',
            notes: `catalog cost ${entry.cost} ${String(entry.cost_currency ?? 'USD')}`,
          }
        : PRICING,
    enabled: true,
    raw: { ...entry, capability_source: 'inferred from slug — MuAPI catalog does not publish structured capabilities' },
    fetchedAt,
    source: 'catalog' as const,
  }
}
