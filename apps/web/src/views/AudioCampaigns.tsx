import React from 'react'
import { audioApi } from '../audio-api.js'
import { AsyncBlock, Badge, Callout, Card, Empty, Field, useAsync } from '../ui.jsx'

const TEMPLATES = [
  'release_announcement',
  'out_now',
  'tour_announcement',
  'fan_drop',
  'merch_launch',
  'behind_the_music',
  'countdown',
  'documentary_intro',
  'press_kit_narration',
  'brand_partnership_voiceover',
]

export function AudioCampaignsView() {
  const projects = useAsync(() => audioApi.campaigns(), [])
  const voices = useAsync(() => audioApi.voiceProfiles(), [])
  const [selected, setSelected] = React.useState<string | null>(null)
  const [refresh, setRefresh] = React.useState(0)
  const detail = useAsync(async () => (selected ? audioApi.campaign(selected) : null), [selected, refresh])

  const [name, setName] = React.useState('')
  const [templateType, setTemplateType] = React.useState('release_announcement')
  const [voText, setVoText] = React.useState('')
  const [voVoice, setVoVoice] = React.useState('')
  const [sfxText, setSfxText] = React.useState('')
  const [message, setMessage] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const act = async (fn: () => Promise<{ warning?: string | null } | unknown>, note: string) => {
    setError(null)
    setMessage(null)
    try {
      const result = (await fn()) as { warning?: string | null }
      setMessage(result?.warning ? `${note} — ${result.warning}` : note)
      setTimeout(() => setRefresh((n) => n + 1), 800)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <>
      <div className="topbar">
        <h2>Campaign Audio Toolkit</h2>
        <div className="meta">approved voices only — no public-figure imitation, no false endorsement</div>
      </div>

      {message && <Callout tone="ok">{message}</Callout>}
      {error && <Callout tone="danger">{error}</Callout>}

      <div className="grid cols-2">
        <div>
          <Card title="Projects">
            <AsyncBlock state={projects}>
              {(data) =>
                data.projects.length === 0 ? (
                  <Empty>No campaign projects yet.</Empty>
                ) : (
                  <table>
                    <tbody>
                      {data.projects.map((project) => (
                        <tr key={project.id} style={{ cursor: 'pointer' }} onClick={() => setSelected(project.id)}>
                          <td>{project.name}</td>
                          <td className="muted">{project.templateType.replace(/_/g, ' ')}</td>
                          <td className="faint">{project.usageContext}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              }
            </AsyncBlock>
          </Card>

          <Card title="New project">
            <form
              onSubmit={(event) => {
                event.preventDefault()
                void audioApi.createCampaign({ name, templateType }).then((result) => {
                  setSelected(result.project.id)
                  setName('')
                  projects.reload()
                })
              }}
            >
              <Field label="Name">
                <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Release announcement — spring drop" />
              </Field>
              <Field label="Template">
                <select value={templateType} onChange={(e) => setTemplateType(e.target.value)}>
                  {TEMPLATES.map((template) => (
                    <option key={template} value={template}>
                      {template.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
              </Field>
              <button type="submit">Create</button>
            </form>
          </Card>
        </div>

        <div>
          {selected && (
            <>
              <Card title="Generate voiceover">
                <Field label="Script">
                  <textarea rows={3} value={voText} onChange={(e) => setVoText(e.target.value)} placeholder="Out now: the new single…" />
                </Field>
                <Field label="Voice" hint="catalog default, or a verified Voice Vault profile">
                  <select value={voVoice} onChange={(e) => setVoVoice(e.target.value)}>
                    <option value="">Street Banker catalog voice</option>
                    {voices.data?.profiles
                      .filter((profile) => profile.status === 'active')
                      .map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.name} ({profile.voiceOwnerName})
                        </option>
                      ))}
                  </select>
                </Field>
                <button
                  disabled={!voText.trim()}
                  onClick={() => void act(() => audioApi.campaignVoiceover(selected, voText, voVoice || undefined), 'voiceover queued')}
                >
                  Queue voiceover
                </button>
              </Card>

              <Card title="Generate sound effect">
                <Field label="Description">
                  <input value={sfxText} onChange={(e) => setSfxText(e.target.value)} placeholder="deep cinematic impact with tail" />
                </Field>
                <button disabled={!sfxText.trim()} onClick={() => void act(() => audioApi.campaignSfx(selected, sfxText), 'sound effect queued')}>
                  Queue sound effect
                </button>
              </Card>

              <Card title="Assets" action={<button className="small" onClick={() => setRefresh((n) => n + 1)}>refresh</button>}>
                <AsyncBlock state={detail}>
                  {(data) =>
                    !data || data.assets.length === 0 ? (
                      <Empty>No generated assets yet — queue something above, the worker renders it.</Empty>
                    ) : (
                      <div style={{ display: 'grid', gap: 8 }}>
                        {data.assets.map((asset) => (
                          <div key={asset.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <Badge>{asset.assetType.replace(/^campaign_/, '')}</Badge>
                            <span style={{ flex: 1, fontSize: 12 }}>{asset.fileName}</span>
                            <audio controls src={asset.url} style={{ height: 26 }} />
                          </div>
                        ))}
                      </div>
                    )
                  }
                </AsyncBlock>
              </Card>
            </>
          )}
        </div>
      </div>
    </>
  )
}
