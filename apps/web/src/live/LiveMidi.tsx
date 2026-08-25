import React from 'react'
import { noteName, defaultKeyboardZones, type MidiDeviceInfo } from '@masterclip/midi-engine'
import type { MidiMapping } from '@masterclip/performance-project'
import { navigate } from '../App.jsx'
import { AsyncBlock, Badge, Callout, Card, Empty, Field, useAsync } from '../ui.jsx'
import { liveApi, type LiveProjectBundle } from './api.js'
import { useLiveEngine, useMidi } from './engine.js'
import { dispatchMidi } from './LivePerformance.jsx'

const TARGETS: Array<{ value: MidiMapping['targetType']; label: string; needsTarget: 'pad' | 'scene' | 'stem' | null }> = [
  { value: 'pad', label: 'Pad', needsTarget: 'pad' },
  { value: 'scene', label: 'Scene launch', needsTarget: 'scene' },
  { value: 'stem_mute', label: 'Stem mute', needsTarget: 'stem' },
  { value: 'stem_solo', label: 'Stem solo', needsTarget: 'stem' },
  { value: 'stem_volume', label: 'Stem volume', needsTarget: 'stem' },
  { value: 'master_volume', label: 'Master volume', needsTarget: null },
  { value: 'next_song', label: 'Next song', needsTarget: null },
  { value: 'prev_song', label: 'Previous song', needsTarget: null },
  { value: 'stop', label: 'Stop', needsTarget: null },
  { value: 'click', label: 'Click on/off', needsTarget: null },
]

/** MIDI settings: devices, MIDI Learn, stored mappings, keyboard zones. */
export function LiveMidi({ projectId }: { projectId: string }) {
  const bundle = useAsync(() => liveApi.project(projectId), [projectId])
  const live = useLiveEngine(bundle.data, 'cloud')
  const [targetType, setTargetType] = React.useState<MidiMapping['targetType']>('pad')
  const [targetId, setTargetId] = React.useState<string>('pad:0')
  const [status, setStatus] = React.useState<string | null>(null)
  const [conflict, setConflict] = React.useState<{ body: Record<string, unknown>; message: string } | null>(null)

  /** null for targets that stand alone (stop, click, master volume, …). */
  const needsTarget = TARGETS.find((t) => t.value === targetType)?.needsTarget ?? null

  const saveMapping = async (body: Record<string, unknown>) => {
    try {
      await liveApi.createMapping(projectId, body)
      setStatus('Mapped.')
      setConflict(null)
      bundle.reload()
    } catch (err) {
      const error = err as Error & { kind?: string; code?: string }
      if (error.code === 'live.midi_duplicate') {
        setConflict({ body: { ...body, replaceDuplicate: true }, message: error.message })
      } else {
        setStatus(error.message)
      }
    }
  }

  const midi = useMidi(
    bundle.data?.mappings ?? [],
    (hit) => void live.arm().then(() => dispatchMidi(live.engine, 16, hit)),
    (candidate) => {
      setStatus(null)
      void saveMapping({
        deviceIdentifier: candidate.deviceIdentifier,
        channel: candidate.channel,
        messageType: candidate.messageType,
        noteOrController: candidate.noteOrController,
        targetType: candidate.targetType,
        targetId: candidate.targetId,
        minimum: candidate.minimum,
        maximum: candidate.maximum,
        inversion: candidate.inversion,
      })
    },
  )

  return (
    <AsyncBlock state={bundle}>
      {(data) => (
        <div>
          <div className="topbar">
            <div>
              <h2>MIDI — {data.project.name}</h2>
              <div className="meta">Controller-agnostic MIDI Learn. Map first, play anything.</div>
            </div>
            <button className="small" onClick={() => navigate(`/live-lab/projects/${projectId}`)}>
              Back to workspace
            </button>
          </div>

          <div className="grid cols-2">
            <Card title="Devices">
              {!midi.supported && (
                <Callout tone="warn">
                  Web MIDI is not available in this browser. Use the mock controller below to test mappings, or run the desktop build for
                  native MIDI.
                </Callout>
              )}
              {midi.devices.length === 0 ? <Empty>No MIDI devices detected.</Empty> : null}
              {midi.devices.map((device) => (
                <div key={device.id} className="button-row" style={{ marginBottom: 6 }}>
                  <Badge tone={device.connected ? 'ok' : 'danger'}>{device.connected ? 'CONNECTED' : 'DISCONNECTED'}</Badge>
                  <span>{device.name}</span>
                  <span className="faint">{device.manufacturer}</span>
                </div>
              ))}
              <div className="button-row" style={{ marginTop: 10 }}>
                <button className="small" onClick={() => midi.useMock()}>
                  Use mock controller
                </button>
                {midi.lastMessage && (
                  <span className="faint mono" style={{ fontSize: 11 }}>
                    last: ch{midi.lastMessage.message.channel + 1} {midi.lastMessage.message.type}{' '}
                    {midi.lastMessage.message.type.startsWith('note')
                      ? noteName(midi.lastMessage.message.noteOrController)
                      : midi.lastMessage.message.noteOrController}{' '}
                    → {midi.lastMessage.message.value}
                  </span>
                )}
              </div>
              {midi.mock && <MockControllerPanel send={(bytes) => midi.mock?.send('mock-controller', bytes)} />}
            </Card>

            <Card title="MIDI Learn">
              <div className="field-row">
                <Field label="Target">
                  <select
                    value={targetType}
                    onChange={(e) => {
                      const value = e.target.value as MidiMapping['targetType']
                      setTargetType(value)
                      const spec = TARGETS.find((t) => t.value === value)
                      setTargetId(spec?.needsTarget === 'pad' ? 'pad:0' : '')
                    }}
                  >
                    {TARGETS.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </Field>
                {needsTarget === 'pad' && (
                  <Field label="Pad">
                    <select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                      {Array.from({ length: 16 }, (_, i) => (
                        <option key={i} value={`pad:${i}`}>
                          Pad {i + 1}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                {needsTarget === 'scene' && (
                  <Field label="Scene">
                    <select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                      <option value="">choose…</option>
                      {data.scenes.map((scene) => (
                        <option key={scene.id} value={scene.id}>
                          {data.items.find((i) => i.id === scene.liveSetItemId)?.title} — {scene.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                {needsTarget === 'stem' && (
                  <Field label="Stem">
                    <select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                      <option value="">choose…</option>
                      {data.stems.map((stem) => (
                        <option key={stem.id} value={stem.id}>
                          {data.items.find((i) => i.id === stem.liveSetItemId)?.title} — {stem.stemType}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
              </div>
              <div className="button-row">
                {midi.learning ? (
                  <>
                    <Badge tone="warn">Waiting for MIDI input…</Badge>
                    <button className="small" onClick={() => midi.cancelLearn()}>
                      cancel
                    </button>
                  </>
                ) : (
                  <button
                    className="primary"
                    // A pad/scene/stem mapping with no target persists happily,
                    // reports "Mapped." and can never fire. Refuse it up front.
                    disabled={needsTarget !== null && !targetId}
                    title={needsTarget !== null && !targetId ? `choose a ${needsTarget} first` : undefined}
                    onClick={() => (setStatus(null), midi.startLearn(targetType, targetId || null))}
                  >
                    Learn
                  </button>
                )}
                {status && <Badge tone={status === 'Mapped.' ? 'ok' : 'danger'}>{status}</Badge>}
              </div>
              {conflict && (
                <Callout tone="warn" title="Already mapped">
                  {conflict.message}
                  <div className="button-row" style={{ marginTop: 6 }}>
                    <button className="small danger" onClick={() => void saveMapping(conflict.body)}>
                      Replace existing mapping
                    </button>
                    <button className="small" onClick={() => setConflict(null)}>
                      Keep existing
                    </button>
                  </div>
                </Callout>
              )}
            </Card>
          </div>

          <Card title="Mappings">
            {data.mappings.length === 0 ? (
              <Empty>No mappings yet. Use MIDI Learn above.</Empty>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Device</th>
                    <th>Ch</th>
                    <th>Message</th>
                    <th>Control</th>
                    <th>Target</th>
                    <th>Range</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {data.mappings.map((mapping) => (
                    <tr key={mapping.id}>
                      <td className="mono faint">{mapping.deviceIdentifier}</td>
                      <td>{mapping.channel + 1}</td>
                      <td>{mapping.messageType}</td>
                      <td className="mono">
                        {mapping.messageType.startsWith('note') ? noteName(mapping.noteOrController) : mapping.noteOrController}
                      </td>
                      <td>
                        {mapping.targetType}
                        {mapping.targetId ? ` → ${mapping.targetId.startsWith('pad:') ? `Pad ${Number(mapping.targetId.slice(4)) + 1}` : mapping.targetId}` : ''}
                      </td>
                      <td className="mono faint">
                        {mapping.minimum}–{mapping.maximum}
                        {mapping.inversion ? ' inv' : ''}
                      </td>
                      <td>
                        <button className="small danger" onClick={() => void liveApi.deleteMapping(mapping.id).then(bundle.reload)}>
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <KeyboardZoneMapper projectId={projectId} data={data} onChanged={bundle.reload} devices={midi.devices} />
        </div>
      )}
    </AsyncBlock>
  )
}

/** On-screen controller for testing without hardware — sends real MIDI bytes. */
function MockControllerPanel({ send }: { send: (bytes: number[]) => void }) {
  return (
    <div style={{ marginTop: 10 }}>
      <div className="field-label">Mock controller</div>
      <div className="button-row">
        {Array.from({ length: 8 }, (_, i) => (
          <button key={i} className="small" onClick={() => (send([0x90, 36 + i, 100]), send([0x80, 36 + i, 0]))}>
            {noteName(36 + i)}
          </button>
        ))}
        <button className="small" onClick={() => send([0xb0, 7, Math.floor(Math.random() * 128)])}>
          CC7
        </button>
      </div>
    </div>
  )
}

/**
 * Applies a keyboard zone in one action.
 *
 * The zones were data and documentation with no way to use them: mapping a
 * scene-launch octave meant twelve separate MIDI Learns. This assigns a whole
 * run of consecutive notes to a song's scenes (or to the pads) at once, and
 * shows the resulting note→target list before anything is written.
 */
function KeyboardZoneMapper({
  projectId,
  data,
  onChanged,
  devices,
}: {
  projectId: string
  data: LiveProjectBundle
  onChanged: () => void
  devices: MidiDeviceInfo[]
}) {
  const zones = defaultKeyboardZones()
  const [deviceId, setDeviceId] = React.useState('')
  const [channel, setChannel] = React.useState(0)
  const [startNote, setStartNote] = React.useState(zones[3]?.lowNote ?? 72)
  const [source, setSource] = React.useState<string>('pads')
  const [status, setStatus] = React.useState<string | null>(null)
  const [conflict, setConflict] = React.useState<Record<string, unknown> | null>(null)
  const [busy, setBusy] = React.useState(false)

  // What the chosen source expands to, in order. Pads are positional; a song
  // contributes its scenes in performance order.
  const targets: Array<{ id: string; label: string }> =
    source === 'pads'
      ? Array.from({ length: 16 }, (_, i) => ({ id: `pad:${i}`, label: `Pad ${i + 1}` }))
      : data.scenes
          .filter((scene) => scene.liveSetItemId === source)
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((scene) => ({ id: scene.id, label: scene.name }))

  const device = deviceId || devices.find((d) => d.connected)?.id || ''

  const apply = async (replaceExisting: boolean) => {
    setBusy(true)
    setStatus(null)
    try {
      const result = await liveApi.mapKeyboardZone(projectId, {
        deviceIdentifier: device,
        channel,
        startNote,
        targetType: source === 'pads' ? 'pad' : 'scene',
        targetIds: targets.map((t) => t.id),
        replaceExisting,
      })
      setConflict(null)
      setStatus(`Mapped ${result.mappings.length} notes${result.replaced.length > 0 ? `, replaced ${result.replaced.length}` : ''}.`)
      onChanged()
    } catch (err) {
      const error = err as Error & { code?: string; details?: Record<string, unknown> }
      if (error.code === 'live.midi_duplicate') setConflict({ message: error.message })
      else setStatus(error.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="Keyboard zones">
      <div className="faint" style={{ fontSize: 12, marginBottom: 10 }}>
        Map a run of keys to a song&rsquo;s scenes or to the pads in one action, instead of learning each note. Zones are conventions, not
        hardware profiles — any key can still be learned onto any target individually.
      </div>

      <div className="field-row">
        <Field label="Device">
          <select value={device} onChange={(e) => setDeviceId(e.target.value)}>
            {/* Shown whenever nothing is selected, not only when the list is
                empty: with devices listed but none connected the select used to
                display a device while the value was '', leaving Map disabled
                with nothing on screen explaining why. */}
            {!device && (
              <option value="">{devices.length === 0 ? 'no device — connect one or use the mock' : 'select a device'}</option>
            )}
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Channel">
          <select value={channel} onChange={(e) => setChannel(Number(e.target.value))}>
            {Array.from({ length: 16 }, (_, i) => (
              <option key={i} value={i}>
                {i + 1}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Starting key">
          <select value={startNote} onChange={(e) => setStartNote(Number(e.target.value))}>
            {zones.map((zone) => (
              <option key={zone.kind} value={zone.lowNote}>
                {noteName(zone.lowNote)} — {zone.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Map">
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="pads">The 16 pads</option>
            {data.items
              .slice()
              .sort((a, b) => a.sortOrder - b.sortOrder)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title} — scenes
                </option>
              ))}
          </select>
        </Field>
      </div>

      {targets.length === 0 ? (
        <Empty>That song has no scenes yet.</Empty>
      ) : (
        <div className="faint mono" style={{ fontSize: 11, marginBottom: 8 }}>
          {targets.slice(0, 6).map((t, i) => (
            <span key={t.id} style={{ marginRight: 12 }}>
              {noteName(startNote + i)} → {t.label}
            </span>
          ))}
          {targets.length > 6 && <span>… {targets.length} keys through {noteName(startNote + targets.length - 1)}</span>}
        </div>
      )}

      {conflict && (
        <Callout tone="warn" title="Some of those keys are already mapped">
          {String(conflict.message)}
          <div className="button-row" style={{ marginTop: 6 }}>
            <button className="small danger" disabled={busy} onClick={() => void apply(true)}>
              Replace them
            </button>
            <button className="small" onClick={() => setConflict(null)}>
              Keep existing
            </button>
          </div>
        </Callout>
      )}

      <div className="button-row">
        <button className="primary" disabled={busy || targets.length === 0 || !device} onClick={() => void apply(false)}>
          {busy ? 'mapping…' : `Map ${targets.length} keys`}
        </button>
        {status && <Badge tone={status.startsWith('Mapped') ? 'ok' : 'danger'}>{status}</Badge>}
      </div>
    </Card>
  )
}
