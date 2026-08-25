import type { MidiMapping, MidiTargetType } from '@masterclip/performance-project'
import type { ParsedMidiMessage } from './messages.js'

/**
 * MIDI Learn.
 *
 * Flow: the user clicks a Live Lab control → the UI shows "Waiting for MIDI
 * input…" → the user touches a hardware control → the first meaningful
 * message becomes the mapping candidate → the caller stores it → "Mapped."
 *
 * The candidate carries no id/org/project fields — those belong to the caller
 * persisting it — so this state machine is reusable by the desktop build.
 */

export interface LearnTarget {
  targetType: MidiTargetType
  targetId: string | null
}

export interface MappingCandidate extends LearnTarget {
  deviceIdentifier: string
  channel: number
  messageType: MidiMapping['messageType']
  noteOrController: number
  minimum: number
  maximum: number
  inversion: boolean
}

export type LearnState =
  | { phase: 'idle' }
  | { phase: 'waiting'; target: LearnTarget }
  | { phase: 'captured'; target: LearnTarget; candidate: MappingCandidate }

export class MidiLearn {
  private state: LearnState = { phase: 'idle' }

  get current(): LearnState {
    return this.state
  }

  start(target: LearnTarget): void {
    this.state = { phase: 'waiting', target }
  }

  cancel(): void {
    this.state = { phase: 'idle' }
  }

  /**
   * Feed every incoming message here. Returns the candidate when one is
   * captured. Note-off is ignored while learning — releasing the pad that
   * started the learn must not become the mapping.
   */
  onMessage(deviceIdentifier: string, message: ParsedMidiMessage): MappingCandidate | null {
    if (this.state.phase !== 'waiting') return null
    if (message.type === 'note_off') return null
    const target = this.state.target
    const continuous = message.type === 'cc' || message.type === 'pitch_bend'
    const candidate: MappingCandidate = {
      ...target,
      deviceIdentifier,
      channel: message.channel,
      messageType: message.type,
      noteOrController: message.noteOrController,
      minimum: 0,
      maximum: continuous ? 127 : 127,
      inversion: false,
    }
    this.state = { phase: 'captured', target, candidate }
    return candidate
  }
}

/**
 * A mapping that would collide with an existing one: same device, channel,
 * message type and note/controller. The UI warns before overwriting.
 */
export function findDuplicate(existing: MidiMapping[], candidate: MappingCandidate): MidiMapping | null {
  return (
    existing.find(
      (mapping) =>
        mapping.deviceIdentifier === candidate.deviceIdentifier &&
        mapping.channel === candidate.channel &&
        mapping.messageType === candidate.messageType &&
        mapping.noteOrController === candidate.noteOrController,
    ) ?? null
  )
}
