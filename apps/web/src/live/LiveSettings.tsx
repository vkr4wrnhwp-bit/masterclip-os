import React from 'react'
import { listOutputDevices, type OutputDeviceInfo } from '@masterclip/live-engine'
import { estimateAvailableStorageBytes } from '@masterclip/performance-cache'
import { AsyncBlock, Badge, Callout, Card, Empty, Field, useAsync } from '../ui.jsx'
import { liveApi } from './api.js'
import { AUDIO_PREFS, getEngine, readAudioPref, writeAudioPref } from './engine.js'

/**
 * Live Lab settings: what this organization is entitled to, which AI provider
 * serves the scene builder, and this device's audio routing (output device
 * where the browser supports AudioContext.setSinkId, cue/click bus levels,
 * local storage headroom for performance packages).
 */
export function LiveSettings() {
  const capabilities = useAsync(() => liveApi.capabilities(), [])
  const { backend } = getEngine()
  const [devices, setDevices] = React.useState<OutputDeviceInfo[]>([])
  const [sink, setSink] = React.useState(readAudioPref(AUDIO_PREFS.sink) ?? '')
  const [sinkError, setSinkError] = React.useState<string | null>(null)
  const [cueGain, setCueGain] = React.useState(Number(readAudioPref(AUDIO_PREFS.cueGain)) || 1)
  const [clickGain, setClickGain] = React.useState(Number(readAudioPref(AUDIO_PREFS.clickGain)) || 1)
  const [storage, setStorage] = React.useState<number | undefined>()

  React.useEffect(() => {
    void listOutputDevices().then(setDevices)
    void estimateAvailableStorageBytes().then(setStorage)
  }, [])

  const selectSink = async (deviceId: string) => {
    setSink(deviceId)
    setSinkError(null)
    if (!deviceId) return
    try {
      const ok = await backend.setOutputDevice(deviceId)
      if (!ok) setSinkError('This browser does not support output-device selection (AudioContext.setSinkId). The system default output is used.')
      else writeAudioPref(AUDIO_PREFS.sink, deviceId)
    } catch (err) {
      setSinkError((err as Error).message)
    }
  }

  return (
    <div>
      <div className="topbar">
        <div>
          <h2>Live Lab settings</h2>
          <div className="meta">Entitlements are per organization; audio routing is per device.</div>
        </div>
      </div>

      <div className="grid cols-2">
        <Card title="Audio output">
          <Field label="Output device" hint={backend.supportsOutputSelection() ? 'routes the whole mix' : 'not supported in this browser'}>
            <select value={sink} onChange={(e) => void selectSink(e.target.value)} disabled={!backend.supportsOutputSelection()}>
              <option value="">System default</option>
              {devices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))}
            </select>
          </Field>
          {sinkError && <Callout tone="warn">{sinkError}</Callout>}
          <Field label={`Cue bus level — ${cueGain.toFixed(2)}`}>
            <input
              type="range"
              min={0}
              max={1.5}
              step={0.01}
              value={cueGain}
              onChange={(e) => {
                const value = Number(e.target.value)
                setCueGain(value)
                backend.setBusGain('cue', value)
                writeAudioPref(AUDIO_PREFS.cueGain, String(value))
              }}
            />
          </Field>
          <Field label={`Click bus level — ${clickGain.toFixed(2)}`}>
            <input
              type="range"
              min={0}
              max={1.5}
              step={0.01}
              value={clickGain}
              onChange={(e) => {
                const value = Number(e.target.value)
                setClickGain(value)
                backend.setBusGain('click', value)
                writeAudioPref(AUDIO_PREFS.clickGain, String(value))
              }}
            />
          </Field>
          <div className="faint" style={{ fontSize: 11 }}>
            Per-stem device routing (separate vocal/drum/bass sends, FOH feeds) is the desktop backend&rsquo;s job — the web MVP routes the
            full mix and keeps cue/click as separate buses.
          </div>
        </Card>

        <Card title="Local storage">
          {storage === undefined ? (
            <Empty>This browser does not report storage estimates.</Empty>
          ) : (
            <div>
              <div className="stat">{(storage / (1024 * 1024)).toFixed(0)} MB</div>
              <div className="stat-label">available for cached performance packages on this device</div>
            </div>
          )}
        </Card>
      </div>

      <Card title="Entitlements">
        <AsyncBlock state={capabilities}>
          {(data) => (
            <div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                {data.all.map((capability) => (
                  <Badge key={capability} tone={data.capabilities.includes(capability) ? 'ok' : undefined}>
                    {capability.replace('live_lab.', '')}
                  </Badge>
                ))}
              </div>
              {Object.keys(data.limits).length > 0 && (
                <table>
                  <thead>
                    <tr>
                      <th>Limit</th>
                      <th>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(data.limits).map(([key, value]) => (
                      <tr key={key}>
                        <td className="mono">{key}</td>
                        <td>{value === null ? 'unlimited' : value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="faint" style={{ fontSize: 11, marginTop: 8 }}>
                AI scene provider: <span className="mono">{data.aiProvider}</span>. Entitlements and limits are enforced server-side; this
                page only reports them.
              </div>
            </div>
          )}
        </AsyncBlock>
      </Card>
    </div>
  )
}
