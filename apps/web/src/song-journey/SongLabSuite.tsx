import React from 'react'
import { useRoute } from '../App.js'
import { api, ApiError, type User } from '../api.js'
import { SongLabHome, SongLabNew, SongLabProjects } from '../song-lab/SongLabHome.js'
import { SongLabProject } from '../song-lab/SongLabProject.js'
import { songLabApi } from '../song-lab/api.js'
import { StudioHome } from '../studio/StudioHome.js'
import { StudioProject, type StudioTab } from '../studio/StudioProject.js'
import { LiveLabHome } from '../live/LiveLabHome.js'
import { LiveProject } from '../live/LiveProject.js'
import { LivePerformance } from '../live/LivePerformance.js'
import { LiveMidi } from '../live/LiveMidi.js'
import { LiveSettings } from '../live/LiveSettings.js'
import { StreetBankerLogo } from './StreetBankerLogo.js'
import { SONG_LAB_FEATURES } from './features.js'
import { SongJourneyPage } from './SongJourneyPage.js'
import './song-lab-suite.css'

export const JOURNEY_STEPS = ['Choose', 'Understand', 'Decide', 'Finish', 'Approve', 'Deliver'] as const
const GUIDANCE = [
  'Open an existing song or Studio project, or start a new one. Both libraries retain their original IDs.',
  'Open your song to inspect structure, energy, hook, lyrics, tempo and benchmark evidence.',
  'Use experiments and Producer View to choose what to try. Findings keep their source and confidence.',
  'Open Studio for existing Rack intent, mix findings, references and master results. The V1 Rack connection comes in Phase 3.',
  'Use the existing Versions and Collaborate tabs to compare exact versions and record a permitted approval.',
  'Use Studio’s Deliver tab for file checks, metadata, rights and saved delivery records. Vault and release connections are not added in this phase.',
]
export function SongLabSuite() {
  const route = useRoute()
  const [user, setUser] = React.useState<User | null>(null)
  const [error, setError] = React.useState('')
  const [mode, setMode] = React.useState<string | null>(null)
  const [home, setHome] = React.useState('https://app.streetbankermusic.com')
  const [linkedEnabled, setLinkedEnabled] = React.useState(false)
  const [entryMode, setEntryMode] = React.useState<'full' | 'live' | null>(null)
  const [sourceLibraryEnabled, setSourceLibraryEnabled] = React.useState(false)
  const [canSeeAr, setCanSeeAr] = React.useState(false)
  const [selectedStep, setSelectedStep] = React.useState(0)
  React.useEffect(() => {
    fetch('/api/song-lab-suite').then(r => r.json()).then(r => { setHome(r.streetBankerUrl); setLinkedEnabled(r.linkedRecordsEnabled === true); setEntryMode(r.entryMode === 'live' ? 'live' : 'full'); setSourceLibraryEnabled(r.sourceLibraryEnabled === true) }).catch(() => setEntryMode('full'))
    api.health().then(r => setMode(r.mode)).catch(() => undefined)
    api.me().then(r => setUser(r.user)).catch(err => {
      if (err instanceof ApiError && err.status === 401) window.location.replace(entryMode === 'live' || window.location.hash.startsWith('#/live-') ? '/login?entry=live' : '/login')
      else setError('Street Banker sign-in is unavailable. Your files have not changed.')
    })
    songLabApi.capabilities().then(r => setCanSeeAr(r.capabilities.includes('song_lab.ar_view'))).catch(() => undefined)
  }, [])
  React.useEffect(() => {
    if (linkedEnabled && route.name === 'song-lab' && route.params.legacy !== 'true') window.location.hash = '/song-journey'
  }, [linkedEnabled, route.name, route.params.legacy])
  const song = route.params.songProjectId
  const studio = route.params.studioProjectId
  const step = Number.isInteger(Number(route.params.step)) && route.params.step !== undefined ? Math.max(0, Math.min(5, Number(route.params.step))) : selectedStep
  function destination(index: number) {
    const suffix = `?step=${index}`
    if (index === 0) return '/song-lab' + suffix
    if (index < 3) return (song ? `/song-lab/projects/${song}/${index === 1 ? 'overview' : 'experiments'}` : '/song-lab/projects') + suffix
    return (studio ? `/studio/${studio}/${['rack', 'versions', 'deliver'][index - 3]}` : '/studio') + suffix
  }
  let screen: React.ReactNode = <SongLabHome />
  if (linkedEnabled && route.name === 'song-journey') screen = <SongJourneyPage />
  if (route.name === 'song-lab-new') screen = <SongLabNew />
  if (route.name === 'song-lab-projects') screen = <SongLabProjects />
  if (route.name === 'song-lab-project') screen = <SongLabProject projectId={song ?? ''} tab={route.params.tab ?? 'overview'} canSeeAr={canSeeAr} />
  if (route.name === 'studio') screen = <StudioHome />
  if (route.name === 'studio-project') screen = <StudioProject projectId={studio ?? ''} tab={(route.params.tab as StudioTab) ?? 'session'} {...(route.params.at ? { at: route.params.at } : {})} />
  if (route.name === 'live-lab') screen = <LiveLabHome canImportRelease={entryMode === 'full' || sourceLibraryEnabled} />
  if (route.name === 'live-project') screen = <LiveProject projectId={route.params.liveProjectId ?? ''} />
  if (route.name === 'live-midi') screen = <LiveMidi projectId={route.params.liveProjectId ?? ''} />
  if (route.name === 'live-settings') screen = <LiveSettings />
  if (route.name === 'live-performance' && user) return <LivePerformance projectId={route.params.liveProjectId ?? ''} />
  return <div className="sl-suite">
    <header className="sl-header">
      <div className="sl-identity"><span className="sl-mark" aria-label="SL"><svg viewBox="0 0 64 64" aria-hidden="true"><path d="M2 18V2H18M46 2H62V18M2 46V62H18M46 62H62V46" /></svg><b>SL</b></span><div><strong>SONG LAB</strong><span>BY STREET BANKER</span></div></div>
      <div className="sl-header-actions"><a className="sl-parent" href={entryMode === 'live' ? home + '/rooms/stage' : home + '/command-center'}><StreetBankerLogo /><span>{entryMode === 'live' ? 'Back to Stage' : 'Back to Street Banker'}</span></a>
        {entryMode === 'full' && <><details><summary>Walkthrough</summary><ol>{JOURNEY_STEPS.map((name, i) => <li key={name}><b>{name}</b><p>{GUIDANCE[i]}</p></li>)}</ol></details>
        <details><summary>Feature checklist</summary><p>Existing capabilities retained. These are source statuses, not a claim that every provider is configured.</p><ul>{SONG_LAB_FEATURES.map(f => <li key={f.name}><label><input type="checkbox" />{f.name}</label><span>{f.status}</span><p>{f.description}</p></li>)}</ul></details></>}
      </div>
    </header>
    {entryMode === 'live' && <div className="sl-mode" role="status">LIVE SET · Stage room access</div>}
    <div className="sl-mode" role="status">{mode === 'live' ? 'LIVE MODE · provider work may be billed' : mode === 'sandbox' ? 'SANDBOX MODE · no provider will be billed' : 'Checking provider billing mode…'}</div>
    <main className="sl-workspace">
      {entryMode === 'full' && <><nav className="sl-steps" aria-label="Song journey">{JOURNEY_STEPS.map((name, i) => <a href={'#' + destination(i)} key={name} aria-current={step === i ? 'step' : undefined} onClick={() => setSelectedStep(i)}><span className="sl-led"/><span className="sl-step-number">0{i + 1}</span><b>{name}</b></a>)}</nav>
      <div className="sl-guidance"><span>0{step + 1} / {JOURNEY_STEPS[step]}</span><p>{GUIDANCE[step]}</p></div>
      <nav className="sl-libraries" aria-label="Existing screens">{linkedEnabled && <a href="#/song-journey">One song journey</a>}<a href="#/song-lab/library">Song Lab home</a><a href="#/song-lab/new">New song</a><a href="#/song-lab/projects">All songs</a><a href="#/studio">Studio projects</a><a href="#/live-lab">Live Lab</a><a href="#/live-lab/settings">Live settings</a></nav></>}
      {entryMode === 'live' && <nav className="sl-libraries" aria-label="Live set controls"><a href="#/live-lab">Setlist and stage setup</a><a href="#/live-lab/settings">Live settings</a></nav>}
      {error ? <section role="alert"><h1>Sign in through Street Banker</h1><p>{error}</p><a className="button" href="/login">Sign in at Street Banker</a></section> : user ? <section className="sl-existing">{screen}</section> : <p role="status">Checking Street Banker access…</p>}
      <footer><span>Song Lab · {user?.displayName ?? 'Street Banker sign-in'}</span>{user && <button onClick={() => void api.logout().then(() => window.location.assign(home + (entryMode === 'live' ? '/rooms/stage' : '/command-center')))}>Sign out</button>}<span>{entryMode === 'live' ? 'Live set · Stage room' : 'Existing Song Lab, Studio and Live Lab tools'}</span></footer>
    </main>
  </div>
}
