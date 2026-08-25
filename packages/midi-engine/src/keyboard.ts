/**
 * MIDI keyboard zones.
 *
 * The default performance layout maps octaves to roles (C4 = middle C = 60):
 *
 *   C2–B2 (36–47)  FX / one-shots
 *   C3–B3 (48–59)  loops
 *   C4–B4 (60–71)  vocal chops
 *   C5–B5 (72–83)  scene launches
 *
 * Zones are data, not hardware profiles: users remap freely, and the future
 * sampler mode (chromatic pitching of one sample) plugs in as a new zone kind
 * without touching this module's consumers.
 */

export type KeyboardZoneKind = 'fx' | 'loops' | 'chops' | 'scenes' | 'custom'

export interface KeyboardZone {
  kind: KeyboardZoneKind
  label: string
  lowNote: number
  highNote: number
}

export function defaultKeyboardZones(): KeyboardZone[] {
  return [
    { kind: 'fx', label: 'FX / one-shots', lowNote: 36, highNote: 47 },
    { kind: 'loops', label: 'Loops', lowNote: 48, highNote: 59 },
    { kind: 'chops', label: 'Vocal chops', lowNote: 60, highNote: 71 },
    { kind: 'scenes', label: 'Scene launches', lowNote: 72, highNote: 83 },
  ]
}

export function zoneForNote(zones: KeyboardZone[], note: number): KeyboardZone | null {
  return zones.find((zone) => note >= zone.lowNote && note <= zone.highNote) ?? null
}
