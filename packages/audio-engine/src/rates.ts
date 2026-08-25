import { usdToMicros, type AppConfig, type MicroUsd } from '@masterclip/shared'

/**
 * Estimate rate card.
 *
 * Provider prices are NOT hardcoded into product logic: the operator maintains
 * AUDIO_RATE_CARD (JSON) with the rates their contracts actually carry, and
 * everything computed from it is labelled an estimate. Final cost comes from
 * provider usage reconciliation. An absent rate estimates zero — visible as
 * "no estimate available", never as a guessed number presented as truth.
 */
export interface AudioRateCard {
  transcription_per_minute_usd?: number
  tts_per_1k_chars_usd?: number
  dubbing_per_minute_per_language_usd?: number
  music_per_track_usd?: number
  sfx_per_effect_usd?: number
  isolation_per_minute_usd?: number
  stems_per_track_usd?: number
  agent_per_minute_usd?: number
}

export function parseRateCard(config: AppConfig): AudioRateCard {
  if (!config.AUDIO_RATE_CARD) return {}
  try {
    const parsed = JSON.parse(config.AUDIO_RATE_CARD) as AudioRateCard
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

export function estimateMicros(card: AudioRateCard, operation: string, units: { minutes?: number; characters?: number; tracks?: number; effects?: number; languages?: number }): MicroUsd {
  const minutes = units.minutes ?? 0
  const languages = Math.max(1, units.languages ?? 1)
  let usd = 0
  switch (operation) {
    case 'transcription':
      usd = (card.transcription_per_minute_usd ?? 0) * minutes
      break
    case 'tts':
      usd = ((card.tts_per_1k_chars_usd ?? 0) * (units.characters ?? 0)) / 1000
      break
    case 'dubbing':
      usd = (card.dubbing_per_minute_per_language_usd ?? 0) * minutes * languages
      break
    case 'music':
      usd = (card.music_per_track_usd ?? 0) * (units.tracks ?? 1)
      break
    case 'sound_effect':
      usd = (card.sfx_per_effect_usd ?? 0) * (units.effects ?? 1)
      break
    case 'voice_isolation':
      usd = (card.isolation_per_minute_usd ?? 0) * minutes
      break
    case 'stems':
      usd = (card.stems_per_track_usd ?? 0) * (units.tracks ?? 1)
      break
    case 'agent_conversation':
      usd = (card.agent_per_minute_usd ?? 0) * minutes
      break
    default:
      usd = 0
  }
  return usdToMicros(usd)
}
