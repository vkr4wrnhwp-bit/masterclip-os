import React from 'react'
import { api } from '../api.js'
import { AsyncBlock, Badge, Callout, Card, Empty, Field, statusTone, useAsync } from '../ui.jsx'

const FORMATS = [
  { value: 'delivery_h264', label: 'H.264 delivery master (CRF 17)' },
  { value: 'delivery_h265', label: 'H.265 delivery (CRF 21)' },
  { value: 'prores_422hq', label: 'ProRes 422 HQ mezzanine' },
  { value: 'prores_4444', label: 'ProRes 4444 (only for genuinely alpha-capable sources)' },
  { value: 'social_h264', label: 'Lightweight social H.264' },
  { value: 'review_h264', label: 'Review proxy' },
]

export function MastersView({ projectId }: { projectId: string }) {
  const masters = useAsync(() => api.masters(projectId), [projectId])
  const [busy, setBusy] = React.useState<string | null>(null)
  const [message, setMessage] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const finish = async (masterId: string, specs: unknown[]) => {
    setBusy(masterId)
    setError(null)
    try {
      const result = await api.finishMaster(masterId, specs)
      setMessage(`created ${result.assetIds.length} deliverable(s)`)
      masters.reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const buildPackage = async (masterId: string) => {
    setBusy(masterId)
    setError(null)
    try {
      const result = await api.packageMaster(masterId)
      setMessage(`packaged ${result.files} files → ${result.directory}`)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <div className="topbar">
        <h2>Masters</h2>
      </div>

      <Callout tone="info" title="What a delivery is, and is not">
        Deliverables are container and codec conversions of the approved provider output. Nothing here upscales or interpolates: a 720p source wrapped as
        1080p ProRes is still a 720p image, and the provenance sidecar says so.
      </Callout>

      {message && <Callout tone="ok">{message}</Callout>}
      {error && <Callout tone="danger">{error}</Callout>}

      <AsyncBlock state={masters}>
        {(data) =>
          data.masters.length === 0 ? (
            <Empty>No masters yet. Approve a candidate in the review grid, then promote it.</Empty>
          ) : (
            <div className="grid cols-2">
              {data.masters.map((master) => (
                <MasterCard
                  key={String(master.id)}
                  master={master}
                  busy={busy === String(master.id)}
                  onFinish={(specs) => finish(String(master.id), specs)}
                  onPackage={() => buildPackage(String(master.id))}
                />
              ))}
            </div>
          )
        }
      </AsyncBlock>
    </>
  )
}

function MasterCard({
  master,
  busy,
  onFinish,
  onPackage,
}: {
  master: Record<string, unknown>
  busy: boolean
  onFinish: (specs: unknown[]) => Promise<void>
  onPackage: () => Promise<void>
}) {
  const [format, setFormat] = React.useState('delivery_h264')
  const [aspect, setAspect] = React.useState('')
  const [reframeMode, setReframeMode] = React.useState<'crop' | 'pad'>('crop')
  const deliverables = (master.deliverables ?? []) as Array<Record<string, unknown>>
  const metadata = (master.metadata ?? {}) as Record<string, unknown>

  return (
    <Card
      title={String(master.name)}
      action={<Badge tone={statusTone(String(master.status))}>{String(master.status)}</Badge>}
    >
      <div className="faint mono" style={{ fontSize: 11, marginBottom: 10 }}>
        {String(metadata.provider ?? '')}/{String(metadata.model ?? '')} · approved {String(master.approvedAt ?? '').slice(0, 16).replace('T', ' ')}
      </div>

      <div className="field-row">
        <Field label="Format">
          <select value={format} onChange={(e) => setFormat(e.target.value)}>
            {FORMATS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Alternate aspect" hint="optional">
          <select value={aspect} onChange={(e) => setAspect(e.target.value)}>
            <option value="">keep original</option>
            {['16:9', '9:16', '1:1', '4:5', '21:9', '2.39:1'].map((option) => (
              <option key={option}>{option}</option>
            ))}
          </select>
        </Field>
      </div>

      {aspect && (
        <>
          {/* Reframing always loses something. The choice is the operator's. */}
          <Field label="Reframe mode" hint="crop loses framing; pad changes composition">
            <select value={reframeMode} onChange={(e) => setReframeMode(e.target.value as 'crop' | 'pad')}>
              <option value="crop">crop to fill</option>
              <option value="pad">pad to fit</option>
            </select>
          </Field>
        </>
      )}

      <div className="button-row">
        <button
          className="primary small"
          disabled={busy}
          onClick={() => void onFinish([{ format, ...(aspect ? { aspectRatio: aspect, reframeMode } : {}) }])}
        >
          {busy ? 'working…' : 'Render deliverable'}
        </button>
        <button className="small" disabled={busy} onClick={() => void onPackage()}>
          Build delivery package
        </button>
      </div>

      {deliverables.length > 0 && (
        <table style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Format</th>
              <th>Spec</th>
            </tr>
          </thead>
          <tbody>
            {deliverables.map((deliverable) => (
              <tr key={String(deliverable.id)}>
                <td className="mono">{String(deliverable.format)}</td>
                <td className="faint" style={{ fontSize: 11 }}>
                  {JSON.stringify(deliverable.spec)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}
