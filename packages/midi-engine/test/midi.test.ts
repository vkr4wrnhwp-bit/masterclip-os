import { describe, expect, it } from 'vitest'
import type { MidiMapping } from '@masterclip/performance-project'
import { parseMidiMessage, noteName } from '../src/messages.js'
import { MidiLearn, findDuplicate } from '../src/learn.js'
import { matchMappings, scaleValue } from '../src/mapper.js'
import { MockMidiSource } from '../src/devices.js'
import { defaultKeyboardZones, zoneForNote } from '../src/keyboard.js'

describe('message parsing', () => {
  it('parses note on/off, CC, program change, pitch bend', () => {
    expect(parseMidiMessage([0x90, 60, 100])).toEqual({ type: 'note_on', channel: 0, noteOrController: 60, value: 100 })
    expect(parseMidiMessage([0x81, 60, 0])).toEqual({ type: 'note_off', channel: 1, noteOrController: 60, value: 0 })
    expect(parseMidiMessage([0xb2, 7, 127])).toEqual({ type: 'cc', channel: 2, noteOrController: 7, value: 127 })
    expect(parseMidiMessage([0xc3, 12])).toEqual({ type: 'program_change', channel: 3, noteOrController: 12, value: 12 })
    const bend = parseMidiMessage([0xe0, 0x7f, 0x7f])
    expect(bend?.type).toBe('pitch_bend')
    expect(bend?.value).toBe(127)
  })

  it('treats note-on velocity 0 as note-off, as the wire does', () => {
    expect(parseMidiMessage([0x90, 60, 0])?.type).toBe('note_off')
  })

  it('ignores system messages and garbage', () => {
    expect(parseMidiMessage([0xf8])).toBeNull()
    expect(parseMidiMessage([0x12, 3])).toBeNull()
    expect(parseMidiMessage([])).toBeNull()
  })

  it('names notes with middle C = C4 = 60', () => {
    expect(noteName(60)).toBe('C4')
    expect(noteName(36)).toBe('C2')
    expect(noteName(69)).toBe('A4')
  })
})

describe('MIDI Learn', () => {
  it('captures the first meaningful message for the armed target', () => {
    const learn = new MidiLearn()
    learn.start({ targetType: 'pad', targetId: 'pad:3' })
    expect(learn.current.phase).toBe('waiting')
    const candidate = learn.onMessage('dev1', { type: 'note_on', channel: 0, noteOrController: 40, value: 90 })
    expect(candidate).toMatchObject({ deviceIdentifier: 'dev1', channel: 0, messageType: 'note_on', noteOrController: 40, targetType: 'pad', targetId: 'pad:3' })
    expect(learn.current.phase).toBe('captured')
  })

  it('ignores note-off while waiting — releasing the button must not map', () => {
    const learn = new MidiLearn()
    learn.start({ targetType: 'stop', targetId: null })
    expect(learn.onMessage('dev1', { type: 'note_off', channel: 0, noteOrController: 40, value: 0 })).toBeNull()
    expect(learn.current.phase).toBe('waiting')
  })

  it('does nothing when idle', () => {
    const learn = new MidiLearn()
    expect(learn.onMessage('dev1', { type: 'note_on', channel: 0, noteOrController: 40, value: 90 })).toBeNull()
  })
})

const mapping = (over: Partial<MidiMapping> = {}): MidiMapping => ({
  id: 'm1',
  organizationId: 'org',
  liveProjectId: 'proj',
  deviceIdentifier: 'dev1',
  channel: 0,
  messageType: 'note_on',
  noteOrController: 40,
  targetType: 'pad',
  targetId: 'pad:0',
  minimum: 0,
  maximum: 127,
  inversion: false,
  ...over,
})

describe('duplicate detection', () => {
  it('flags a candidate that collides with an existing mapping', () => {
    const existing = [mapping()]
    const duplicate = findDuplicate(existing, {
      deviceIdentifier: 'dev1',
      channel: 0,
      messageType: 'note_on',
      noteOrController: 40,
      targetType: 'scene',
      targetId: 's1',
      minimum: 0,
      maximum: 127,
      inversion: false,
    })
    expect(duplicate?.id).toBe('m1')
  })

  it('does not flag a different control', () => {
    expect(
      findDuplicate([mapping()], {
        deviceIdentifier: 'dev1',
        channel: 0,
        messageType: 'note_on',
        noteOrController: 41,
        targetType: 'pad',
        targetId: 'pad:1',
        minimum: 0,
        maximum: 127,
        inversion: false,
      }),
    ).toBeNull()
  })
})

describe('mapping application', () => {
  it('matches by device, channel, type and control', () => {
    const hits = matchMappings([mapping()], 'dev1', { type: 'note_on', channel: 0, noteOrController: 40, value: 100 })
    expect(hits.length).toBe(1)
    expect(hits[0]!.pressed).toBe(true)
  })

  it('does not fire for another device or channel', () => {
    expect(matchMappings([mapping()], 'dev2', { type: 'note_on', channel: 0, noteOrController: 40, value: 100 }).length).toBe(0)
    expect(matchMappings([mapping()], 'dev1', { type: 'note_on', channel: 5, noteOrController: 40, value: 100 }).length).toBe(0)
  })

  it('a note_on mapping also sees the release edge', () => {
    const hits = matchMappings([mapping()], 'dev1', { type: 'note_off', channel: 0, noteOrController: 40, value: 0 })
    expect(hits.length).toBe(1)
    expect(hits[0]!.pressed).toBe(false)
  })

  it('scales into [min,max] with inversion', () => {
    expect(scaleValue(127, { minimum: 0, maximum: 1, inversion: false })).toBeCloseTo(1)
    expect(scaleValue(0, { minimum: 0.2, maximum: 0.8, inversion: false })).toBeCloseTo(0.2)
    expect(scaleValue(127, { minimum: 0, maximum: 1, inversion: true })).toBeCloseTo(0)
  })
})

describe('device lifecycle', () => {
  it('discovers, sends, and survives disconnect', () => {
    const source = new MockMidiSource()
    const messages: string[] = []
    const changes: string[] = []
    source.onMessage((deviceId, message) => messages.push(`${deviceId}:${message.type}:${message.noteOrController}`))
    source.onDeviceChange((device) => changes.push(`${device.id}:${device.connected}`))

    source.connectDevice('padctrl', 'Pad Controller')
    expect(source.devices()).toHaveLength(1)
    source.send('padctrl', [0x90, 36, 100])
    expect(messages).toEqual(['padctrl:note_on:36'])

    // Disconnect mid-show: listeners are told, nothing throws, and further
    // sends from the dead device are simply not delivered by hardware.
    source.disconnectDevice('padctrl')
    expect(changes).toContain('padctrl:false')
    expect(source.devices()[0]!.connected).toBe(false)
  })
})

describe('keyboard zones', () => {
  it('maps the default octaves to roles', () => {
    const zones = defaultKeyboardZones()
    expect(zoneForNote(zones, 40)?.kind).toBe('fx')
    expect(zoneForNote(zones, 50)?.kind).toBe('loops')
    expect(zoneForNote(zones, 65)?.kind).toBe('chops')
    expect(zoneForNote(zones, 80)?.kind).toBe('scenes')
    expect(zoneForNote(zones, 100)).toBeNull()
  })
})
