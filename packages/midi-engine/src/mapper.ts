import type { MidiMapping } from '@masterclip/performance-project'
import type { ParsedMidiMessage } from './messages.js'

/**
 * Applies stored mappings to incoming messages.
 *
 * Matching is by (device, channel, type, note/controller); note_on mappings
 * also fire on the matching note_off with value 0, so momentary controls (a
 * pad held to un-mute a stem) can behave momentarily if a target wants to.
 */

export interface MappingHit {
  mapping: MidiMapping
  /** Scaled into [minimum, maximum] with inversion applied. */
  value: number
  /** True for note_on / the pressed edge — the trigger edge for pads/scenes. */
  pressed: boolean
}

export function matchMappings(mappings: MidiMapping[], deviceIdentifier: string, message: ParsedMidiMessage): MappingHit[] {
  const hits: MappingHit[] = []
  for (const mapping of mappings) {
    if (mapping.deviceIdentifier !== deviceIdentifier && mapping.deviceIdentifier !== '*') continue
    if (mapping.channel !== message.channel) continue
    const typeMatches =
      mapping.messageType === message.type ||
      (mapping.messageType === 'note_on' && message.type === 'note_off')
    if (!typeMatches) continue
    if (message.type !== 'pitch_bend' && mapping.noteOrController !== message.noteOrController) continue

    hits.push({
      mapping,
      value: scaleValue(message.value, mapping),
      pressed: message.type !== 'note_off' && message.value > 0,
    })
  }
  return hits
}

/** 0–127 wire value → [minimum, maximum], inverted when the mapping says so. */
export function scaleValue(raw: number, mapping: Pick<MidiMapping, 'minimum' | 'maximum' | 'inversion'>): number {
  const clamped = Math.min(127, Math.max(0, raw))
  const normalized = mapping.inversion ? 1 - clamped / 127 : clamped / 127
  return mapping.minimum + normalized * (mapping.maximum - mapping.minimum)
}
