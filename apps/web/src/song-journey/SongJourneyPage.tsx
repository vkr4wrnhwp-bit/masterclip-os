import React from 'react'
import { useRoute } from '../App.js'
import { AsyncBlock, Callout, Empty, useAsync } from '../ui.jsx'
import { songLabApi } from '../song-lab/api.js'
import { SongLabProject } from '../song-lab/SongLabProject.js'
import { studioApi } from '../studio/api.js'
import { StudioProject } from '../studio/StudioProject.js'
import { songJourneyApi, type JourneyLinkRow } from './api.js'
import { SuiteHandoffs } from './SuiteHandoffs.js'
import { InstrumentDeck } from './InstrumentDeck.js'
import './song-journey.css'

const STEPS = ['Choose', 'Understand', 'Decide', 'Finish', 'Approve', 'Deliver'] as const

export function SongJourneyPage() {
  const route = useRoute()
  const songs = useAsync(() => songLabApi.projects(), [])
  const songCapabilities = useAsync(() => songLabApi.capabilities(), [])
  const studios = useAsync(() => studioApi.projects(), [])
  const links = useAsync(() => songJourneyApi.links(), [])
  const [songId, setSongId] = React.useState('')
  const [studioId, setStudioId] = React.useState('')
  const [sourceKind, setSourceKind] = React.useState<'song_lab' | 'studio'>('song_lab')
  const [songVersionId, setSongVersionId] = React.useState('')
  const [studioVersionId, setStudioVersionId] = React.useState('')
  const [step, setStep] = React.useState(0)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')

  const active = links.data?.links.find(row => row.link.id === route.params.journeyLinkId) ?? null
  React.useEffect(() => {
    setSongVersionId(active?.link.selectedSongVersionId ?? '')
    setStudioVersionId(active?.link.selectedStudioVersionId ?? '')
  }, [active?.link.id, active?.link.selectedSongVersionId, active?.link.selectedStudioVersionId])

  const openStep = (index: number) => {
    setStep(index)
    document.getElementById(`journey-step-${index}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const createLink = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!songId || !studioId) return
    setBusy(true); setError('')
    try {
      const { link } = await songJourneyApi.create({ songLabProjectId: songId, studioProjectId: studioId, sourceKind })
      await links.reload()
      window.location.hash = `/song-journey/${link.id}?step=0`
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }

  const saveVersions = async () => {
    if (!active || !songVersionId || !studioVersionId) return
    setBusy(true); setError('')
    try { await songJourneyApi.selectVersions(active.link.id, { songVersionId, studioVersionId }); await links.reload() }
    catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }

  const unlink = async () => {
    if (!active) return
    setBusy(true); setError('')
    try { await songJourneyApi.unlink(active.link.id); await links.reload(); window.location.hash = '/song-journey' }
    catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }

  const exportLink = async () => {
    if (!active) return
    setError('')
    try {
      const data = await songJourneyApi.export(active.link.id)
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url; anchor.download = `song-journey-${active.link.id}.json`; anchor.click()
      URL.revokeObjectURL(url)
    } catch (err) { setError((err as Error).message) }
  }

  const song = songs.data?.projects.find(row => row.id === active?.link.songLabProjectId)
  const studio = studios.data?.projects.find(row => row.project.id === active?.link.studioProjectId)?.project
  const selectedSongVersion = active?.songVersions.find(version => version.id === songVersionId)
  const selectedStudioVersion = active?.studioVersions.find(version => version.id === studioVersionId)
  const ready = !!(active && song && studio && selectedSongVersion && selectedStudioVersion)

  return <div className="sl-journey-page">
    <div className="sl-journey-intro">
      <div><p className="sl-kicker">ONE RECORD · SIX DECISIONS</p><h1>One song. One journey.</h1><p>Choose the exact source versions first. Song Lab and Studio keep separate histories; the link only brings them into one workspace.</p></div>
      {active && <div className="sl-record-lock"><span>LOOKING AT</span><strong>{selectedSongVersion?.label ?? 'Choose a Song Lab version'}</strong><small>{selectedStudioVersion?.label ?? 'Choose a Studio version'}</small></div>}
    </div>
    {error && <Callout tone="danger" title="The record was not changed">{error}</Callout>}
    {!active && <div className="sl-choose-grid">
      <section className="sl-choice-card">
        <p className="sl-kicker">START WITH EXISTING RECORDS</p><h2>Choose a song</h2>
        <p>These records stay separate. Song Lab owns analysis and experiments; Studio owns sessions, comments, approvals and delivery checks.</p>
        <AsyncBlock state={songs}>{payload => <AsyncBlock state={studios}>{studioRows => <form onSubmit={createLink} className="sl-choice-form">
          <label>Song Lab record<select value={songId} onChange={event => setSongId(event.target.value)} required><option value="">Choose a song</option>{payload.projects.map(project => <option key={project.id} value={project.id}>{project.artistName} — {project.title} · {project.status}</option>)}</select></label>
          <label>Studio record<select value={studioId} onChange={event => setStudioId(event.target.value)} required><option value="">Choose a Studio record</option>{studioRows.projects.map(row => <option key={row.project.id} value={row.project.id}>{row.project.artistName} — {row.project.title} · {row.project.stage}</option>)}</select></label>
          <fieldset><legend>Where did this journey start?</legend><label><input type="radio" checked={sourceKind === 'song_lab'} onChange={() => setSourceKind('song_lab')} /> Song Lab</label><label><input type="radio" checked={sourceKind === 'studio'} onChange={() => setSourceKind('studio')} /> Studio</label></fieldset>
          <button className="primary" disabled={busy || !songId || !studioId}>{busy ? 'Linking records…' : 'Open one song journey'}</button>
        </form>}</AsyncBlock>}</AsyncBlock>
      </section>
      <section className="sl-choice-card sl-existing-links"><p className="sl-kicker">RECENT JOURNEYS</p><h2>Return to a record</h2><AsyncBlock state={links}>{payload => payload.links.length === 0 ? <Empty>No linked journeys yet. Choose a Song Lab record and its Studio record to begin.</Empty> : <ul>{payload.links.map(row => <li key={row.link.id}><a href={`#/song-journey/${row.link.id}?step=0`}><strong>{row.song.artistName} — {row.song.title}</strong><span>{row.studio.title} · {row.songVersions.length} Song Lab versions · {row.studioVersions.length} Studio versions</span></a></li>)}</ul>}</AsyncBlock></section>
    </div>}
    {active && <>
      <nav className="sl-journey-stepper" aria-label="Song journey steps">{STEPS.map((name, index) => <button key={name} aria-current={step === index ? 'step' : undefined} onClick={() => openStep(index)}><span>0{index + 1}</span>{name}</button>)}</nav>
      <section id="journey-step-0" className="sl-journey-step sl-journey-choice">
        <div className="sl-step-heading"><span>01</span><div><p>SONG LAB + STUDIO · LINKED, NEVER MERGED</p><h2>Choose</h2></div></div>
        {song && studio ? <div className="sl-record-pair"><div><small>SONG LAB RECORD · {song.status}</small><h3>{song.artistName} — {song.title}</h3><code>{song.id}</code></div><span className="sl-link-glyph" aria-hidden="true">↔</span><div><small>STUDIO RECORD · {studio.stage}</small><h3>{studio.artistName} — {studio.title}</h3><code>{studio.id}</code></div></div> : <Callout tone="danger">A linked source record is no longer accessible. The link history remains available for export; no source record was changed.</Callout>}
        <div className="sl-version-pickers">
          <label>Song Lab version<select value={songVersionId} onChange={event => setSongVersionId(event.target.value)}><option value="">Choose an exact version</option>{active.songVersions.map(version => <option value={version.id} key={version.id}>{version.label} · {new Date(version.createdAt).toLocaleString()}</option>)}</select></label>
          <label>Studio version<select value={studioVersionId} onChange={event => setStudioVersionId(event.target.value)}><option value="">Choose an exact version</option>{active.studioVersions.map(version => <option value={version.id} key={version.id}>{version.label} · {new Date(version.createdAt).toLocaleString()}</option>)}</select></label>
          <button className="primary" disabled={busy || !songVersionId || !studioVersionId || (songVersionId === active.link.selectedSongVersionId && studioVersionId === active.link.selectedStudioVersionId)} onClick={() => void saveVersions()}>{busy ? 'Saving…' : 'Set versions for this journey'}</button>
        </div>
        {active.link.sourceKind && <p className="sl-source-trace">Source selected: <strong>{active.link.sourceKind === 'song_lab' ? 'Song Lab' : 'Studio'}</strong>. This states where the linked journey began. It does not change either record.</p>}
        <div className="sl-link-actions"><button className="small" onClick={() => void exportLink()}>Export link record</button><button className="small danger" disabled={busy} onClick={() => void unlink()}>Unlink · preserve everything</button></div>
        {!ready && <Callout tone="info" title="Choose both versions before entering the journey">No current version is selected automatically. Until both exact versions are chosen, analysis panels stay closed.</Callout>}
      </section>
      {ready ? <>
        <section id="journey-step-1" className="sl-journey-step"><div className="sl-step-heading"><span>02</span><div><p>MEASURED FROM THE SELECTED SONG VERSION</p><h2>Understand</h2></div></div><InstrumentDeck songId={song.id} songVersionId={songVersionId} studioId={studio.id} studioVersionId={studioVersionId} /><SongLabProject projectId={song.id} tab="journey" canSeeAr={songCapabilities.data?.capabilities.includes('song_lab.ar_view') ?? false} journeyVersionId={songVersionId} journeyOnlyStep="understand" /></section>
        <section id="journey-step-2" className="sl-journey-step"><div className="sl-step-heading"><span>03</span><div><p>CHOOSE WHAT TO TEST</p><h2>Decide</h2></div></div><SongLabProject projectId={song.id} tab="journey" canSeeAr={songCapabilities.data?.capabilities.includes('song_lab.ar_view') ?? false} journeyVersionId={songVersionId} journeyOnlyStep="decide" /></section>
        <section id="journey-step-3" className="sl-journey-step"><div className="sl-step-heading"><span>04</span><div><p>STUDIO MEASUREMENTS · SELECTED VERSION</p><h2>Finish</h2></div></div><StudioProject projectId={studio.id} tab="journey" journeyVersionId={studioVersionId} journeyOnlyStep="finish" /><SuiteHandoffs linkId={active.link.id} versionId={songVersionId} /></section>
        <section id="journey-step-4" className="sl-journey-step"><div className="sl-step-heading"><span>05</span><div><p>COMPARE THE EXACT VERSIONS</p><h2>Approve</h2></div></div><SongLabProject projectId={song.id} tab="journey" canSeeAr={songCapabilities.data?.capabilities.includes('song_lab.ar_view') ?? false} journeyVersionId={songVersionId} journeyOnlyStep="approve" /><StudioProject projectId={studio.id} tab="journey" journeyVersionId={studioVersionId} journeyOnlyStep="approve" /></section>
        <section id="journey-step-5" className="sl-journey-step"><div className="sl-step-heading"><span>06</span><div><p>CHECKS AND SOURCE HISTORY</p><h2>Deliver</h2></div></div><StudioProject projectId={studio.id} tab="journey" journeyVersionId={studioVersionId} journeyOnlyStep="deliver" /><div className="sl-vault-truth"><strong>Vault hand-off</strong><p>Save the chosen version through the Vault control in Finish. A completed Rack receipt names the actual saved Vault version and its verified checksum. When the hand-off is off, nothing is sent.</p></div></section>
      </> : <div className="sl-journey-locked">Choose both source versions above to load Understand, Decide, Finish, Approve and Deliver for this record.</div>}
    </>}
  </div>
}
