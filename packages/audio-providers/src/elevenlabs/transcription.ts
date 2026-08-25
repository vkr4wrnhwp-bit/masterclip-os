import { AppError } from '@masterclip/shared'
import type {
  AudioTranscriptionProvider,
  NormalizedTranscript,
  ProviderHealth,
  TranscriptSegmentData,
  TranscriptionJobResult,
  TranscriptionJobStatus,
  TranscriptionRequest,
} from '@masterclip/audio-core'
import { ELEVENLABS_PROVIDER_ID, usageFrom, type ElevenLabsClient } from './client.js'

/** Scribe response word, per SDK SpeechToTextWordResponseModel. */
interface SttWord {
  text: string
  start?: number
  end?: number
  type: 'word' | 'spacing' | 'audio_event'
  speaker_id?: string
  logprob?: number
}

interface SttResponse {
  language_code?: string
  language_probability?: number
  text?: string
  words?: SttWord[]
  transcription_id?: string
  audio_duration_secs?: number
  entities?: Array<{ text?: string; entity_type?: string; start_char?: number; end_char?: number }>
  message?: string
}

/**
 * Scribe transcription adapter — `POST v1/speech-to-text`.
 *
 * Synchronous by default; when the request opts into webhook delivery the
 * provider returns early and the engine completes the job from the verified
 * webhook payload (this SDK version exposes no transcript polling endpoint, so
 * the adapter refuses to fake one).
 */
export class ElevenLabsTranscriptionAdapter implements AudioTranscriptionProvider {
  readonly providerId = ELEVENLABS_PROVIDER_ID

  constructor(private readonly client: ElevenLabsClient) {}

  isConfigured(): boolean {
    return this.client.isConfigured()
  }

  supportsZeroRetention(): boolean {
    // enable_logging=false exists on this endpoint but only enterprise
    // accounts may use it — the operator attests that in configuration.
    return this.client.opts.zeroRetentionCapable
  }

  async transcribe(input: TranscriptionRequest): Promise<TranscriptionJobResult> {
    const fields: Record<string, string | undefined> = {
      model_id: this.client.opts.sttModelId,
      diarize: input.diarize ? 'true' : 'false',
      tag_audio_events: input.tagAudioEvents ? 'true' : 'false',
      timestamps_granularity: input.timestamps === 'word' ? 'word' : 'none',
      language_code: input.languageCode,
      num_speakers: input.numSpeakers !== undefined ? String(input.numSpeakers) : undefined,
      entity_detection: input.entityDetection ? 'all' : undefined,
      enable_logging: input.zeroRetention ? 'false' : undefined,
    }
    if (input.keyterms.length > 0) fields.keyterms = JSON.stringify(input.keyterms)
    if (input.webhook) {
      fields.webhook = 'true'
      fields.webhook_metadata = JSON.stringify(input.webhook.metadata)
    }
    if (input.audio.url && !input.audio.bytes && !input.audio.path) fields.source_url = input.audio.url

    const files = input.audio.url && !input.audio.bytes && !input.audio.path ? [] : [{ field: 'file', input: input.audio }]
    const { body, requestId } = await this.client.multipart<SttResponse>('v1/speech-to-text', fields, files)

    if (input.webhook) {
      return {
        providerJobId: body.transcription_id ?? requestId ?? null,
        status: 'processing',
      }
    }
    const transcript = normalizeSttResponse(body)
    const durationSeconds = body.audio_duration_secs ?? estimateDurationSeconds(transcript)
    return {
      providerJobId: body.transcription_id ?? requestId ?? null,
      status: 'complete',
      transcript,
      usage: usageFrom('seconds', durationSeconds, 0, requestId),
    }
  }

  async getTranscriptionStatus(providerJobId: string): Promise<TranscriptionJobStatus> {
    // Async Scribe results are delivered by signed webhook, and this SDK
    // version documents no transcript-by-id endpoint. Guessing one would
    // violate the adapter contract, so the engine resolves webhook jobs from
    // stored webhook events instead of calling this.
    throw new AppError({
      kind: 'provider_rejected',
      code: 'elevenlabs.no_poll',
      message: `transcription ${providerJobId}: elevenlabs delivers async transcripts via webhook, not polling`,
    })
  }

  async healthCheck(): Promise<ProviderHealth> {
    return elevenLabsHealth(this.client)
  }
}

/** Groups word-level output into speaker-continuous segments. */
export function normalizeSttResponse(body: SttResponse): NormalizedTranscript {
  const words = body.words ?? []
  const segments: TranscriptSegmentData[] = []
  let current: TranscriptSegmentData | null = null
  let logprobs: number[] = []

  const flush = () => {
    if (!current) return
    current.text = current.text.trim()
    if (current.text.length > 0) {
      if (logprobs.length > 0) {
        const mean = logprobs.reduce((a, b) => a + b, 0) / logprobs.length
        current.confidence = Math.round(Math.min(1, Math.exp(mean)) * 1000) / 1000
      }
      segments.push(current)
    }
    current = null
    logprobs = []
  }

  for (const word of words) {
    if (word.type === 'audio_event') {
      flush()
      segments.push({
        speakerKey: null,
        startMs: Math.round((word.start ?? 0) * 1000),
        endMs: Math.round((word.end ?? word.start ?? 0) * 1000),
        text: word.text,
      })
      continue
    }
    const speaker = word.speaker_id ?? null
    if (!current || current.speakerKey !== speaker) {
      flush()
      current = {
        speakerKey: speaker,
        startMs: Math.round((word.start ?? 0) * 1000),
        endMs: Math.round((word.end ?? word.start ?? 0) * 1000),
        text: '',
      }
    }
    current.text += word.text
    if (word.end !== undefined) current.endMs = Math.round(word.end * 1000)
    if (typeof word.logprob === 'number') logprobs.push(word.logprob)
  }
  flush()

  const entities = (body.entities ?? []).map((e) => ({
    text: e.text ?? '',
    entityType: e.entity_type ?? 'unknown',
    ...(e.start_char !== undefined ? { startChar: e.start_char } : {}),
    ...(e.end_char !== undefined ? { endChar: e.end_char } : {}),
  }))
  if (entities.length > 0 && segments.length > 0) segments[0]!.entities = entities

  return {
    language: body.language_code ?? 'und',
    ...(body.language_probability !== undefined ? { languageConfidence: body.language_probability } : {}),
    fullText: body.text ?? segments.map((s) => s.text).join(' '),
    segments,
    raw: body,
  }
}

function estimateDurationSeconds(transcript: NormalizedTranscript): number {
  const last = transcript.segments[transcript.segments.length - 1]
  return last ? Math.ceil(last.endMs / 1000) : 0
}

/** Shared health probe: `GET v1/user` is cheap and exercises authentication. */
export async function elevenLabsHealth(client: ElevenLabsClient): Promise<ProviderHealth> {
  const checkedAt = new Date().toISOString()
  if (!client.isConfigured()) {
    return { providerId: ELEVENLABS_PROVIDER_ID, status: 'unconfigured', message: 'ELEVENLABS_API_KEY is not set', checkedAt }
  }
  const startedAt = Date.now()
  try {
    await client.json('v1/user')
    return { providerId: ELEVENLABS_PROVIDER_ID, status: 'healthy', latencyMs: Date.now() - startedAt, message: 'ok', checkedAt }
  } catch (err) {
    return {
      providerId: ELEVENLABS_PROVIDER_ID,
      status: 'down',
      latencyMs: Date.now() - startedAt,
      message: err instanceof Error ? err.message : String(err),
      checkedAt,
    }
  }
}
