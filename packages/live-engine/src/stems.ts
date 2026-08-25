/**
 * Stem deck state.
 *
 * Mute/solo resolution is the one piece of mixer logic V1 needs, and it has a
 * precise rule: when any stem is soloed, only soloed stems are audible; mute
 * always wins over everything, including solo on the same stem.
 */

export interface StemState {
  id: string
  stemType: string
  label: string
  gain: number
  pan: number
  muted: boolean
  solo: boolean
}

export function anySolo(stems: Iterable<StemState>): boolean {
  for (const stem of stems) if (stem.solo) return true
  return false
}

/** The gain a stem should actually play at, given the whole deck's solo state. */
export function effectiveGain(stem: StemState, soloActive: boolean): number {
  if (stem.muted) return 0
  if (soloActive && !stem.solo) return 0
  return stem.gain
}

export class StemDeck {
  private readonly stems = new Map<string, StemState>()

  load(stems: StemState[]): void {
    this.stems.clear()
    for (const stem of stems) this.stems.set(stem.id, { ...stem })
  }

  list(): StemState[] {
    return [...this.stems.values()]
  }

  get(id: string): StemState | undefined {
    return this.stems.get(id)
  }

  setMuted(id: string, muted: boolean): void {
    const stem = this.require(id)
    stem.muted = muted
  }

  toggleMute(id: string): boolean {
    const stem = this.require(id)
    stem.muted = !stem.muted
    return stem.muted
  }

  setSolo(id: string, solo: boolean): void {
    const stem = this.require(id)
    stem.solo = solo
  }

  toggleSolo(id: string): boolean {
    const stem = this.require(id)
    stem.solo = !stem.solo
    return stem.solo
  }

  setGain(id: string, gain: number): void {
    const stem = this.require(id)
    stem.gain = Math.min(2, Math.max(0, gain))
  }

  setPan(id: string, pan: number): void {
    const stem = this.require(id)
    stem.pan = Math.min(1, Math.max(-1, pan))
  }

  /** Effective playback gain per stem, with solo/mute resolved deck-wide. */
  resolve(): Map<string, number> {
    const soloActive = anySolo(this.stems.values())
    const gains = new Map<string, number>()
    for (const stem of this.stems.values()) gains.set(stem.id, effectiveGain(stem, soloActive))
    return gains
  }

  private require(id: string): StemState {
    const stem = this.stems.get(id)
    if (!stem) throw new Error(`unknown stem: ${id}`)
    return stem
  }
}
