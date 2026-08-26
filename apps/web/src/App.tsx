import React from 'react'
import { ApiError, api, type User } from './api.js'
import { Callout, Card, Field, useAsync } from './ui.jsx'
import { Dashboard } from './views/Dashboard.jsx'
import { ProjectView } from './views/Project.jsx'
import { ShotBuilder } from './views/ShotBuilder.jsx'
import { QueueView } from './views/Queue.jsx'
import { ReviewGrid } from './views/ReviewGrid.jsx'
import { MastersView } from './views/Masters.jsx'
import { CostLab } from './views/CostLab.jsx'
import { ProvidersView } from './views/Providers.jsx'
import { AudioIntelligenceView } from './views/AudioIntelligence.jsx'
import { AudioMeetingsView } from './views/AudioMeetings.jsx'
import { AudioMeetingDetailView } from './views/AudioMeetingDetail.jsx'
import { AudioBriefsView } from './views/AudioBriefs.jsx'
import { AudioOperatorView } from './views/AudioOperator.jsx'
import { AudioGlobalReleaseView } from './views/AudioGlobalRelease.jsx'
import { AudioCampaignsView } from './views/AudioCampaigns.jsx'
import { AudioRemixView } from './views/AudioRemix.jsx'
import { AudioVoiceVaultView } from './views/AudioVoiceVault.jsx'
import { AudioSettingsView } from './views/AudioSettings.jsx'
import { AudioAdminView } from './views/AudioAdmin.jsx'
import { songLabApi } from './song-lab/api.js'
import { SongLabHome, SongLabNew, SongLabProjects } from './song-lab/SongLabHome.jsx'
import { SongLabProject } from './song-lab/SongLabProject.jsx'
import { liveApi } from './live/api.js'
import { LiveLabHome } from './live/LiveLabHome.jsx'
import { LiveProject } from './live/LiveProject.jsx'
import { LivePerformance } from './live/LivePerformance.jsx'
import { LiveMidi } from './live/LiveMidi.jsx'
import { LiveSettings } from './live/LiveSettings.jsx'

export interface Route {
  name: string
  params: Record<string, string>
}

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '')
  const [path, query] = raw.split('?')
  const segments = (path ?? '').split('/').filter(Boolean)
  const params: Record<string, string> = {}
  for (const [key, value] of new URLSearchParams(query ?? '')) params[key] = value
  if (segments.length === 0) return { name: 'dashboard', params }
  if (segments[0] === 'song-lab') {
    if (segments[1] === 'new') return { name: 'song-lab-new', params }
    if (segments[1] === 'projects' && segments[2]) {
      // The tab is part of the path so a producer can link straight to, say,
      // the arrangement view of a specific song.
      return { name: 'song-lab-project', params: { ...params, songProjectId: segments[2], tab: segments[3] ?? 'overview' } }
    }
    if (segments[1] === 'projects') return { name: 'song-lab-projects', params }
    return { name: 'song-lab', params }
  }
  if (segments[0] === 'live-lab') {
    if (segments[1] === 'settings') return { name: 'live-settings', params }
    if (segments[1] === 'projects' && segments[2] && segments[2] !== 'new') {
      const liveProjectId = segments[2]
      if (segments[3] === 'performance') return { name: 'live-performance', params: { ...params, liveProjectId } }
      if (segments[3] === 'midi') return { name: 'live-midi', params: { ...params, liveProjectId } }
      // set / audio / ai-scenes are areas of the same workspace surface.
      return { name: 'live-project', params: { ...params, liveProjectId } }
    }
    return { name: 'live-lab', params }
  }
  if (segments[0] === 'project' && segments[1]) return { name: 'project', params: { ...params, projectId: segments[1] } }
  if (segments[0] === 'shot' && segments[1]) return { name: segments[2] === 'review' ? 'review' : 'shot', params: { ...params, shotId: segments[1] } }
  if (segments[0] === 'queue' && segments[1]) return { name: 'queue', params: { ...params, projectId: segments[1] } }
  if (segments[0] === 'masters' && segments[1]) return { name: 'masters', params: { ...params, projectId: segments[1] } }
  if (segments[0] === 'costs' && segments[1]) return { name: 'costs', params: { ...params, projectId: segments[1] } }
  if (segments[0] === 'providers') return { name: 'providers', params }
  if (segments[0] === 'audio') {
    if (segments[1] === 'meetings' && segments[2]) return { name: 'audio-meeting', params: { ...params, meetingId: segments[2] } }
    return { name: `audio-${segments[1] ?? 'home'}`, params }
  }
  return { name: segments[0] ?? 'dashboard', params }
}

export function useRoute(): Route {
  const [route, setRoute] = React.useState<Route>(parseHash)
  React.useEffect(() => {
    const onChange = () => setRoute(parseHash())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}

export function navigate(path: string): void {
  window.location.hash = path
}

/**
 * The signed-in identity, remembered locally so an unreachable server does not
 * read as a signed-out user. Identity only — no token, no secret; the session
 * cookie remains the only thing that authorizes anything.
 */
const LAST_PROJECT = 'masterclip.lastProject'

/**
 * Guarded like every other storage access here: private mode throws on access,
 * and a convenience for reopening the last project must never blank the app.
 */
function rememberProject(projectId: string): void {
  try {
    window.localStorage.setItem(LAST_PROJECT, projectId)
  } catch {
    // Nothing is lost but the shortcut.
  }
}

function rememberedProject(): string | null {
  try {
    return window.localStorage.getItem(LAST_PROJECT)
  } catch {
    return null
  }
}

const REMEMBERED_USER = 'masterclip.user'

function rememberUser(user: User | null): void {
  try {
    if (user) window.localStorage.setItem(REMEMBERED_USER, JSON.stringify(user))
    else window.localStorage.removeItem(REMEMBERED_USER)
  } catch {
    // Private mode or a full store: the app simply needs a network to start.
  }
}

function rememberedUser(): User | null {
  try {
    const raw = window.localStorage.getItem(REMEMBERED_USER)
    return raw ? (JSON.parse(raw) as User) : null
  } catch {
    return null
  }
}

export function App() {
  const route = useRoute()
  const [user, setUser] = React.useState<User | null>(null)
  const [checking, setChecking] = React.useState(true)
  const health = useAsync(() => api.health(), [])
  // Live Lab is entitlement-gated: the nav entry only exists when the org has
  // live_lab.access. (The server enforces it regardless — this is courtesy.)
  // Keyed by email because the signup/login response carries `id` while
  // /api/auth/me carries `userId` — email is the field both shapes share.
  const liveCaps = useAsync(
    () => (user ? liveApi.capabilities().catch(() => null) : Promise.resolve(null)),
    [user?.email],
  )
  // Song Lab is entitlement-gated the same way. The nav entry appearing is a
  // courtesy; the server refuses regardless.
  const songLabCaps = useAsync(
    () => (user ? songLabApi.capabilities().catch(() => null) : Promise.resolve(null)),
    [user?.email],
  )

  React.useEffect(() => {
    api
      .me()
      .then((r) => {
        setUser(r.user)
        rememberUser(r.user)
      })
      .catch((err: unknown) => {
        // A server that answers "no" signs you out. A server that cannot be
        // reached does not: at a venue with no network the show is already on
        // this device, and dropping to a sign-in form nobody can complete
        // would strand the performer mid-set.
        //
        // This grants nothing. Every API call still needs a real session
        // cookie, so a remembered identity opens no server door; the only
        // thing it unlocks is data this same user already cached here.
        if (err instanceof ApiError && err.status >= 400) {
          setUser(null)
          rememberUser(null)
          return
        }
        setUser(rememberedUser())
      })
      .finally(() => setChecking(false))
  }, [])

  if (checking) return <div className="spinner">loading…</div>
  if (!user)
    return (
      <LoginScreen
        onAuthenticated={(authenticated) => {
          rememberUser(authenticated)
          setUser(authenticated)
        }}
      />
    )

  const projectId = route.params.projectId ?? rememberedProject() ?? ''
  if (route.params.projectId) rememberProject(route.params.projectId)

  const mode = health.data?.mode ?? 'sandbox'

  // Performance Mode is a stage surface: no chrome, no nav, nothing to hit by
  // accident. Everything else renders inside the normal app shell.
  if (route.name === 'live-performance') {
    return <LivePerformance projectId={route.params.liveProjectId ?? ''} />
  }

  return (
    <>
      {/* The spend posture is visible on every screen: which mode you are in
          decides whether the next click costs real money. */}
      <div className={`mode-banner ${mode === 'live' ? 'live' : 'sandbox'}`}>
        {mode === 'live'
          ? 'LIVE MODE — submissions may be billed by providers'
          : 'SANDBOX MODE — no provider will be billed; renders use the local ffmpeg mock'}
      </div>
      <div className="app">
        <nav className="sidebar">
          <div className="brand">
            <h1>Masterclip OS</h1>
            <div className="sub">cinematic render factory</div>
          </div>
          <div className="nav">
            <NavLink route={route} to="/" name="dashboard">
              Dashboard
            </NavLink>
            {projectId && (
              <>
                <div className="group">Project</div>
                <NavLink route={route} to={`/project/${projectId}`} name="project">
                  Overview &amp; shots
                </NavLink>
                <NavLink route={route} to={`/queue/${projectId}`} name="queue">
                  Render queue
                </NavLink>
                <NavLink route={route} to={`/masters/${projectId}`} name="masters">
                  Masters
                </NavLink>
                <NavLink route={route} to={`/costs/${projectId}`} name="costs">
                  Cost lab
                </NavLink>
              </>
            )}
            <div className="group">Audio Intelligence</div>
            <NavLink route={route} to="/audio" name="audio-home">
              Overview
            </NavLink>
            <NavLink route={route} to="/audio/meetings" name="audio-meetings">
              Meetings
            </NavLink>
            <NavLink route={route} to="/audio/briefs" name="audio-briefs">
              Signal briefs
            </NavLink>
            <NavLink route={route} to="/audio/operator" name="audio-operator">
              Operator
            </NavLink>
            <NavLink route={route} to="/audio/global-release" name="audio-global-release">
              Global release
            </NavLink>
            <NavLink route={route} to="/audio/campaigns" name="audio-campaigns">
              Campaign toolkit
            </NavLink>
            <NavLink route={route} to="/audio/remix" name="audio-remix">
              Remix lab
            </NavLink>
            <NavLink route={route} to="/audio/voice-vault" name="audio-voice-vault">
              Voice vault
            </NavLink>
            <NavLink route={route} to="/audio/settings" name="audio-settings">
              Audio settings
            </NavLink>
            <NavLink route={route} to="/audio/admin" name="audio-admin">
              Partner entitlements
            </NavLink>
            {songLabCaps.data?.capabilities.includes('song_lab.access') && (
              <>
                {/* Song Lab comes before Remix Lab in the creative workflow:
                    diagnose the record, then decide what to do with it. */}
                <div className="group">Song Lab</div>
                <NavLink route={route} to="/song-lab" name="song-lab">
                  Drop a record
                </NavLink>
                <NavLink route={route} to="/song-lab/projects" name="song-lab-projects">
                  Song projects
                </NavLink>
              </>
            )}
            {liveCaps.data?.capabilities.includes('live_lab.access') && (
              <>
                <div className="group">Performance</div>
                <NavLink route={route} to="/live-lab" name="live-lab">
                  Live Lab
                </NavLink>
                <NavLink route={route} to="/live-lab/settings" name="live-settings">
                  Live settings
                </NavLink>
              </>
            )}
            <div className="group">System</div>
            <NavLink route={route} to="/providers" name="providers">
              Providers &amp; models
            </NavLink>
          </div>
          <div style={{ marginTop: 'auto', padding: '14px 18px', borderTop: '1px solid var(--border)', fontSize: 11 }}>
            <div className="muted">{user.displayName}</div>
            <div className="faint">{user.email}</div>
            <button
              className="small"
              style={{ marginTop: 8 }}
              onClick={() => {
                rememberUser(null)
                void api.logout().then(() => window.location.reload())
              }}
            >
              Sign out
            </button>
          </div>
        </nav>

        <main className="main">
          {route.name === 'dashboard' && <Dashboard />}
          {route.name === 'project' && <ProjectView projectId={route.params.projectId ?? ''} />}
          {route.name === 'shot' && <ShotBuilder shotId={route.params.shotId ?? ''} />}
          {route.name === 'review' && <ReviewGrid shotId={route.params.shotId ?? ''} />}
          {route.name === 'queue' && <QueueView projectId={route.params.projectId ?? ''} />}
          {route.name === 'masters' && <MastersView projectId={route.params.projectId ?? ''} />}
          {route.name === 'costs' && <CostLab projectId={route.params.projectId ?? ''} />}
          {route.name === 'providers' && <ProvidersView />}
          {route.name === 'audio-home' && <AudioIntelligenceView />}
          {route.name === 'audio-meetings' && <AudioMeetingsView />}
          {route.name === 'audio-meeting' && <AudioMeetingDetailView meetingId={route.params.meetingId ?? ''} />}
          {route.name === 'audio-briefs' && <AudioBriefsView />}
          {route.name === 'audio-operator' && <AudioOperatorView />}
          {route.name === 'audio-global-release' && <AudioGlobalReleaseView />}
          {route.name === 'audio-campaigns' && <AudioCampaignsView />}
          {route.name === 'audio-remix' && <AudioRemixView />}
          {route.name === 'audio-voice-vault' && <AudioVoiceVaultView />}
          {route.name === 'audio-settings' && <AudioSettingsView isAdmin={user.orgRole === 'owner' || user.orgRole === 'admin'} />}
          {route.name === 'audio-admin' && <AudioAdminView />}
          {route.name === 'song-lab' && <SongLabHome />}
          {route.name === 'song-lab-new' && <SongLabNew />}
          {route.name === 'song-lab-projects' && <SongLabProjects />}
          {route.name === 'song-lab-project' && (
            <SongLabProject
              projectId={route.params.songProjectId ?? ''}
              tab={route.params.tab ?? 'overview'}
              canSeeAr={songLabCaps.data?.capabilities.includes('song_lab.ar_view') ?? false}
            />
          )}
          {route.name === 'live-lab' && <LiveLabHome />}
          {route.name === 'live-project' && <LiveProject projectId={route.params.liveProjectId ?? ''} />}
          {route.name === 'live-midi' && <LiveMidi projectId={route.params.liveProjectId ?? ''} />}
          {route.name === 'live-settings' && <LiveSettings />}
        </main>
      </div>
    </>
  )
}

function NavLink({ route, to, name, children }: { route: Route; to: string; name: string; children: React.ReactNode }) {
  return (
    <a href={`#${to}`} className={route.name === name ? 'active' : ''}>
      {children}
    </a>
  )
}

function LoginScreen({ onAuthenticated }: { onAuthenticated: (user: User) => void }) {
  const [mode, setMode] = React.useState<'login' | 'signup'>('login')
  const [email, setEmail] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [displayName, setDisplayName] = React.useState('')
  const [orgName, setOrgName] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = mode === 'login' ? await api.login(email, password) : await api.signup({ email, password, displayName, orgName })
      onAuthenticated(result.user)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <Card title={mode === 'login' ? 'Sign in' : 'Create the first account'}>
        <form onSubmit={submit}>
          {mode === 'signup' && (
            <>
              <Field label="Your name">
                <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
              </Field>
              <Field label="Organization">
                <input value={orgName} onChange={(e) => setOrgName(e.target.value)} required />
              </Field>
            </>
          )}
          <Field label="Email">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </Field>
          <Field label="Password" hint={mode === 'signup' ? 'at least 10 characters' : undefined}>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          {error && <Callout tone="danger">{error}</Callout>}
          <div className="button-row">
            <button className="primary" type="submit" disabled={busy}>
              {busy ? 'working…' : mode === 'login' ? 'Sign in' : 'Create account'}
            </button>
            <button type="button" className="small" onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}>
              {mode === 'login' ? 'First run? Create the org' : 'Have an account? Sign in'}
            </button>
          </div>
        </form>
      </Card>
    </div>
  )
}
