import type { MidiMessageType } from '@masterclip/performance-project'

/**
 * Raw MIDI byte parsing. Controller-agnostic on purpose: Live Lab maps
 * whatever a device sends via MIDI Learn instead of shipping per-controller
 * profiles, so the only thing this module needs to know is the wire format.
 */

export interface ParsedMidiMessage {
  type: MidiMessageType
  channel: number
  /** Note number, controller number, program number — 0 for pitch bend. */
  noteOrController: number
  /** 0–127 for notes/CC/program; pitch bend is normalized to 0–127 as well. */
  value: number
}

export function parseMidiMessage(data: Uint8Array | number[]): ParsedMidiMessage | null {
  const bytes = Array.from(data)
  if (bytes.length === 0) return null
  const status = bytes[0]!
  if (status < 0x80 || status >= 0xf0) return null
  const kind = status & 0xf0
  const channel = status & 0x0f
  const d1 = bytes[1] ?? 0
  const d2 = bytes[2] ?? 0

  switch (kind) {
    case 0x90:
      // Note-on with velocity 0 is note-off on the wire.
      return d2 === 0
        ? { type: 'note_off', channel, noteOrController: d1, value: 0 }
        : { type: 'note_on', channel, noteOrController: d1, value: d2 }
    case 0x80:
      return { type: 'note_off', channel, noteOrController: d1, value: d2 }
    case 0xb0:
      return { type: 'cc', channel, noteOrController: d1, value: d2 }
    case 0xc0:
      return { type: 'program_change', channel, noteOrController: d1, value: d1 }
    case 0xe0: {
      const bend14 = (d2 << 7) | d1
      return { type: 'pitch_bend', channel, noteOrController: 0, value: Math.round((bend14 / 16383) * 127) }
    }
    default:
      return null
  }
}

/** Note number → display name, C4 = middle C = 60. */
export function noteName(note: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  const octave = Math.floor(note / 12) - 1
  return `${names[note % 12]}${octave}`
}
