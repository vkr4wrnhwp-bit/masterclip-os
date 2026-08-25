import React from 'react'
import { AsyncBlock, Badge, Callout, Card, Field, useAsync } from '../ui.jsx'
import { navigate } from '../App.jsx'
import { clock, songLabApi, type SongLabProject } from './api.js'

/**
 * The entry experience.
 *
 * "DROP A RECORD" and nothing else above the fold. The rights confirmation is
 * not buried in a settings page or implied by a terms link — it is the control
 * that unlocks the submit button, because processing someone's master without
 * it is the one mistake this module cannot walk back.
 */
export function SongLabHome() {
  const projects = useAsync(() => songLabApi.projects(), [])
  const capabilities = useAsync(() => songLabApi.capabilities().catch(() => null), [])

  return (
    <>
      <div className="topbar">
        <div>
          <h2 className="sl-headline">DROP A RECORD</h2>
          <div className="meta">
            Upload the record. Diagnose the record. Compare it intelligently. Test the possibilities.
          </div>
        </div>
        <button className="primary" onClick={() => navigate('/song-lab/new')}>
          New Song Lab project
        </button>
      </div>

      <div className="grid cols-2" style={{ marginBottom: 18 }}>
        <Card title="What Song Lab does">
          <p>
            Song Lab listens to a recording you own or are authorized to use, works out what it is doing structurally and musically,
            compares it against a comparison group you choose, and lets you hear alternative versions built from your own audio.
          </p>
          <p className="faint">
            It does not rewrite your song, generate a remix, or predict a hit. Every finding names the measurement and the cohort behind it,
            and every suggestion is framed as something worth testing.
          </p>
        </Card>
        <Card title="Start from">
          <div className="sl-start-options">
            <button className="small" onClick={() => navigate('/song-lab/new?source=upload')}>Upload owned audio</button>
            <button className="small" onClick={() => navigate('/song-lab/new?source=release')}>Import a Street Banker release</button>
            <button className="small" onClick={() => navigate('/song-lab/new?source=unreleased')}>Import an unreleased project</button>
            <button className="small" onClick={() => navigate('/song-lab/new?source=remix')}>Import a Remix Lab source</button>
            <button className="small" onClick={() => navigate('/song-lab/projects')}>Open an existing Song Lab project</button>
          </div>
          {capabilities.data && (
            <p className="faint" style={{ marginTop: 10 }}>
              Analysis engine: <code>{capabilities.data.analysisProvider}</code>
              {capabilities.data.analysisProvider === 'mock-song-analysis' && ' — deterministic placeholder mode; figures are synthesized, not measured.'}
            </p>
          )}
        </Card>
      </div>

      <Card title="Your projects">
        <AsyncBlock state={projects}>
          {(data) =>
            data.projects.length === 0 ? (
              <div className="empty">No Song Lab projects yet. Drop a record to begin.</div>
            ) : (
              <ProjectTable projects={data.projects} />
            )
          }
        </AsyncBlock>
      </Card>
    </>
  )
}

export function SongLabProjects() {
  const projects = useAsync(() => songLabApi.projects(), [])
  return (
    <>
      <div className="topbar">
        <h2>Song Lab projects</h2>
        <button className="primary" onClick={() => navigate('/song-lab/new')}>
          New project
        </button>
      </div>
      <Card>
        <AsyncBlock state={projects}>
          {(data) => (data.projects.length === 0 ? <div className="empty">nothing here yet</div> : <ProjectTable projects={data.projects} />)}
        </AsyncBlock>
      </Card>
    </>
  )
}

function ProjectTable({ projects }: { projects: SongLabProject[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Title</th>
          <th>Artist</th>
          <th>Genre</th>
          <th>Status</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        {projects.map((project) => (
          <tr key={project.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/song-lab/projects/${project.id}/overview`)}>
            <td>
              <a href={`#/song-lab/projects/${project.id}/overview`}>{project.title}</a>
              {project.demo && <Badge tone="info"> demo</Badge>}
            </td>
            <td>{project.artistName}</td>
            <td className="faint">{project.genre}</td>
            <td>
              <Badge tone={project.status === 'failed' ? 'danger' : project.status === 'analyzing' ? 'info' : undefined}>{project.status.replace(/_/g, ' ')}</Badge>
            </td>
            <td className="faint">{new Date(project.createdAt).toLocaleDateString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Create a project, confirm rights, attach audio. */
export function SongLabNew() {
  const [title, setTitle] = React.useState('')
  const [artistName, setArtistName] = React.useState('')
  const [genre, setGenre] = React.useState('alternative')
  const [titlePhrase, setTitlePhrase] = React.useState('')
  const [rightsConfirmed, setRightsConfirmed] = React.useState(false)
  const [file, setFile] = React.useState<File | null>(null)
  const [importAssetId, setImportAssetId] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const capabilities = useAsync(() => songLabApi.capabilities(), [])
  const importable = useAsync(() => songLabApi.importable().catch(() => ({ assets: [] })), [])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const { project } = await songLabApi.createProject({ title, artistName, genre, titlePhrase, rightsConfirmed })
      if (file) await songLabApi.uploadAudio(project.id, file, rightsConfirmed)
      else if (importAssetId) await songLabApi.importAsset(project.id, importAssetId)
      navigate(`/song-lab/projects/${project.id}/overview`)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="topbar">
        <h2 className="sl-headline">DROP A RECORD</h2>
      </div>
      <Card>
        <form onSubmit={submit}>
          <div className="grid cols-2">
            <Field label="Song title">
              <input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={200} />
            </Field>
            <Field label="Artist">
              <input value={artistName} onChange={(event) => setArtistName(event.target.value)} required maxLength={200} />
            </Field>
            <Field label="Genre" hint="used to choose a relevant comparison group">
              <select value={genre} onChange={(event) => setGenre(event.target.value)}>
                {['alternative', 'rock', 'metal', 'punk', 'pop', 'country', 'hip_hop', 'r_and_b', 'electronic', 'dance', 'indie', 'singer_songwriter', 'other'].map(
                  (option) => (
                    <option key={option} value={option}>
                      {option.replace(/_/g, ' ')}
                    </option>
                  ),
                )}
              </select>
            </Field>
            <Field label="Title phrase" hint="optional — the words you consider the title, for title-placement analysis">
              <input value={titlePhrase} onChange={(event) => setTitlePhrase(event.target.value)} maxLength={200} />
            </Field>
          </div>

          <Field label="Upload owned audio" hint="WAV, MP3, M4A, FLAC, OGG, MP4 or MOV">
            <input type="file" accept="audio/*,video/mp4,video/quicktime" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
          </Field>

          {(importable.data?.assets.length ?? 0) > 0 && (
            <Field label="…or import audio this organization already holds">
              <select value={importAssetId} onChange={(event) => setImportAssetId(event.target.value)} disabled={Boolean(file)}>
                <option value="">— none —</option>
                {importable.data?.assets.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.fileName} · {asset.projectType} · {asset.durationMs ? clock(asset.durationMs) : 'unknown length'}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <div className="sl-rights">
            <label className="sl-rights-check">
              <input type="checkbox" checked={rightsConfirmed} onChange={(event) => setRightsConfirmed(event.target.checked)} />
              <span>
                {capabilities.data?.rightsStatement ??
                  'I confirm that I own or control the audio I am uploading, or have authorization from the rights holder to use it for analysis.'}
              </span>
            </label>
            <p className="faint">
              This confirmation is recorded against the project with a timestamp and the exact wording you accepted. Nothing is stored or
              analysed without it.
            </p>
          </div>

          {error && <Callout tone="danger">{error}</Callout>}
          <div className="button-row">
            <button className="primary" type="submit" disabled={busy || !rightsConfirmed}>
              {busy ? 'working…' : 'Create and analyse'}
            </button>
            <button type="button" className="small" onClick={() => navigate('/song-lab')}>
              Cancel
            </button>
          </div>
        </form>
      </Card>
    </>
  )
}
