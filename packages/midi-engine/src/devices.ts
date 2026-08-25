import { parseMidiMessage, type ParsedMidiMessage } from './messages.js'

/**
 * Device management.
 *
 * A thin, controller-agnostic layer over the Web MIDI API plus a mock device
 * for tests and the demo set. Consumers subscribe to messages and to
 * connect/disconnect — a controller unplugged mid-show must degrade to "MIDI
 * disconnected" in the UI, never to an exception in the audio path.
 */

export interface MidiDeviceInfo {
  id: string
  name: string
  manufacturer: string
  connected: boolean
}

export type MidiInputListener = (deviceId: string, message: ParsedMidiMessage) => void
export type MidiDeviceListener = (device: MidiDeviceInfo) => void

export interface MidiSource {
  devices(): MidiDeviceInfo[]
  onMessage(listener: MidiInputListener): () => void
  onDeviceChange(listener: MidiDeviceListener): () => void
  close(): void
}

/** Programmable device source for tests and the demo controller. */
export class MockMidiSource implements MidiSource {
  private readonly deviceList = new Map<string, MidiDeviceInfo>()
  private readonly messageListeners = new Set<MidiInputListener>()
  private readonly deviceListeners = new Set<MidiDeviceListener>()

  connectDevice(id: string, name = id, manufacturer = 'Mock'): void {
    const device: MidiDeviceInfo = { id, name, manufacturer, connected: true }
    this.deviceList.set(id, device)
    for (const listener of this.deviceListeners) listener(device)
  }

  disconnectDevice(id: string): void {
    const device = this.deviceList.get(id)
    if (!device) return
    device.connected = false
    for (const listener of this.deviceListeners) listener(device)
  }

  /** Emits raw bytes as if the hardware sent them. */
  send(deviceId: string, bytes: number[]): void {
    const parsed = parseMidiMessage(bytes)
    if (!parsed) return
    for (const listener of this.messageListeners) listener(deviceId, parsed)
  }

  devices(): MidiDeviceInfo[] {
    return [...this.deviceList.values()]
  }

  onMessage(listener: MidiInputListener): () => void {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  onDeviceChange(listener: MidiDeviceListener): () => void {
    this.deviceListeners.add(listener)
    return () => this.deviceListeners.delete(listener)
  }

  close(): void {
    this.messageListeners.clear()
    this.deviceListeners.clear()
    this.deviceList.clear()
  }
}

/**
 * Web MIDI source. `navigator.requestMIDIAccess` is behind a permission
 * prompt and unsupported in some browsers; callers must handle `create()`
 * rejecting and fall back to keyboard/touch control.
 */
export class WebMidiSource implements MidiSource {
  private readonly messageListeners = new Set<MidiInputListener>()
  private readonly deviceListeners = new Set<MidiDeviceListener>()
  private readonly boundInputs = new Set<string>()

  private constructor(private readonly access: MIDIAccess) {
    this.bindInputs()
    this.access.onstatechange = () => {
      this.bindInputs()
      for (const info of this.devices()) {
        for (const listener of this.deviceListeners) listener(info)
      }
    }
  }

  static async create(): Promise<WebMidiSource> {
    if (typeof navigator === 'undefined' || !('requestMIDIAccess' in navigator)) {
      throw new Error('Web MIDI is not supported in this browser')
    }
    const access = await navigator.requestMIDIAccess({ sysex: false })
    return new WebMidiSource(access)
  }

  private bindInputs(): void {
    this.access.inputs.forEach((input) => {
      if (this.boundInputs.has(input.id)) return
      this.boundInputs.add(input.id)
      input.onmidimessage = (event: MIDIMessageEvent) => {
        if (!event.data) return
        const parsed = parseMidiMessage(event.data)
        if (!parsed) return
        for (const listener of this.messageListeners) listener(input.id, parsed)
      }
    })
  }

  devices(): MidiDeviceInfo[] {
    const list: MidiDeviceInfo[] = []
    this.access.inputs.forEach((input) => {
      list.push({
        id: input.id,
        name: input.name ?? input.id,
        manufacturer: input.manufacturer ?? '',
        connected: input.state === 'connected',
      })
    })
    return list
  }

  onMessage(listener: MidiInputListener): () => void {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  onDeviceChange(listener: MidiDeviceListener): () => void {
    this.deviceListeners.add(listener)
    return () => this.deviceListeners.delete(listener)
  }

  close(): void {
    this.access.inputs.forEach((input) => {
      input.onmidimessage = null
    })
    this.messageListeners.clear()
    this.deviceListeners.clear()
  }
}
