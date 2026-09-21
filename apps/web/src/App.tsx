import React from 'react'
import { api, type User } from './api.js'
import { Callout, Card, Field, useAsync } from './ui.jsx'
import { Overview } from './views/Overview.jsx'
import { Projects } from './views/Projects.jsx'
import { ProjectView } from './views/Project.jsx'
import { ShotBuilder } from './views/ShotBuilder.jsx'
import { QueueView } from './views/Queue.jsx'
import { ReviewGrid } from './views/ReviewGrid.jsx'
import { MastersView } from './views/Masters.jsx'
import { CostLab } from './views/CostLab.jsx'
import { ProvidersView } from './views/Providers.jsx'

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
  if (segments[0] === 'project' && segments[1]) return { name: 'project', params: { ...params, projectId: segments[1] } }
  if (segments[0] === 'shot' && segments[1]) return { name: segments[2] === 'review' ? 'review' : 'shot', params: { ...params, shotId: segments[1] } }
  if (segments[0] === 'queue' && segments[1]) return { name: 'queue', params: { ...params, projectId: segments[1] } }
  if (segments[0] === 'masters' && segments[1]) return { name: 'masters', params: { ...params, projectId: segments[1] } }
  if (segments[0] === 'costs' && segments[1]) return { name: 'costs', params: { ...params, projectId: segments[1] } }
  // Plural, and above nothing it could be confused with: `project` is matched
  // by the rule far above and only with an id after it.
  if (segments[0] === 'projects') return { name: 'projects', params }
  if (segments[0] === 'providers') return { name: 'providers', params }
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

// Where a person goes when they leave: Street Banker, the account of record
// for every suite. Read once from /api/health; the default is the live app.
let streetBankerHome = 'https://app.streetbankermusic.com'

/** The current Street Banker home, for any view that offers a way back to it. */
export function streetBankerUrl(): string {
  return streetBankerHome
}

export function App() {
  const route = useRoute()
  const [user, setUser] = React.useState<User | null>(null)
  const [checking, setChecking] = React.useState(true)
  const health = useAsync(() => api.health(), [])

  React.useEffect(() => {
    api
      .me()
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setChecking(false))
  }, [])

  React.useEffect(() => {
    void api
      .health()
      .then((h) => {
        if (h.streetBankerUrl) streetBankerHome = h.streetBankerUrl
      })
      .catch(() => undefined)
  }, [])

  // Signing out of a suite returns to Street Banker, where the sign-in actually
  // lives (suite audit, 2026-09-20). Shared so the rail on the new Overview and
  // the sidebar on every other view do the same thing.
  const signOut = () => {
    void api.logout().then(() => {
      window.location.href = streetBankerHome
    })
  }

  // Every hook above this line, without exception: the health effect used to
  // sit below the `checking` guard, so it was registered only on the renders
  // that got past it and React saw the hook count grow.
  if (checking) return <div className="spinner">loading…</div>

  if (!user) return <LoginScreen onAuthenticated={setUser} />

  const projectId = route.params.projectId ?? localStorage.getItem('masterclip.lastProject') ?? ''
  if (route.params.projectId) localStorage.setItem('masterclip.lastProject', route.params.projectId)

  const mode = health.data?.mode ?? 'sandbox'

  // The spend posture is visible on every screen: which mode you are in decides
  // whether the next click costs real money.
  const banner = (
    <div className={`mode-banner ${mode === 'live' ? 'live' : 'sandbox'}`}>
      {mode === 'live'
        ? 'LIVE MODE — submissions may be billed by providers'
        : 'SANDBOX MODE — no provider will be billed; renders use the local ffmpeg mock'}
    </div>
  )

  // The Overview is a door rather than a page inside the console, so it brings
  // its own rail and replaces the sidebar layout instead of sitting in it.
  if (route.name === 'dashboard') {
    return (
      <>
        {banner}
        <Overview user={user} onSignOut={signOut} />
      </>
    )
  }

  // The film list is the Overview's other half and wears the same rail, so it
  // sits beside it here rather than inside the console's sidebar layout.
  if (route.name === 'projects') {
    return (
      <>
        {banner}
        <Projects user={user} onSignOut={signOut} />
      </>
    )
  }

  return (
    <>
      {banner}
      <div className="app">
        <nav className="sidebar">
          <div className="brand">
            <h1>
              <img className="brand-mark" src="/motion-wordmark.png" alt="Motion" width={440} height={413} />
            </h1>
            <div className="sub">cinematic render factory</div>
          </div>
          <div className="nav">
            <NavLink route={route} to="/" name="dashboard">
              Overview
            </NavLink>
            {/* The console's sidebar only ever showed the project you were in.
                The film list is a real page now, so it is reachable from here
                too rather than only by going back out to the Overview. */}
            <NavLink route={route} to="/projects" name="projects">
              All films
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
            <div className="group">System</div>
            <NavLink route={route} to="/providers" name="providers">
              Providers &amp; models
            </NavLink>
          </div>
          <div style={{ marginTop: 'auto', padding: '14px 18px', borderTop: '1px solid var(--border)', fontSize: 11 }}>
            <div className="muted">{user.displayName}</div>
            <div className="faint">{user.email}</div>
            <button className="small" style={{ marginTop: 8 }} onClick={signOut}>
              Sign out
            </button>
          </div>
        </nav>

        <main className="main">
          {route.name === 'project' && <ProjectView projectId={route.params.projectId ?? ''} />}
          {route.name === 'shot' && <ShotBuilder shotId={route.params.shotId ?? ''} />}
          {route.name === 'review' && <ReviewGrid shotId={route.params.shotId ?? ''} />}
          {route.name === 'queue' && <QueueView projectId={route.params.projectId ?? ''} />}
          {route.name === 'masters' && <MastersView projectId={route.params.projectId ?? ''} />}
          {route.name === 'costs' && <CostLab projectId={route.params.projectId ?? ''} />}
          {route.name === 'providers' && <ProvidersView />}
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
  // Street Banker is the front door (suite audit, 2026-09-20): a person who
  // lands here signed out is sent back through their Street Banker account.
  // The password form stays for staff, folded away, and "create the org" is
  // offered only while no organization exists.
  const [door, setDoor] = React.useState<{ streetBankerUrl: string; signupOpen: boolean }>({
    streetBankerUrl: streetBankerHome,
    signupOpen: false,
  })
  const [mode, setMode] = React.useState<'login' | 'signup'>('login')
  const [email, setEmail] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [displayName, setDisplayName] = React.useState('')
  const [orgName, setOrgName] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    void api
      .health()
      .then((h) => {
        const url = h.streetBankerUrl || streetBankerHome
        streetBankerHome = url
        setDoor({ streetBankerUrl: url, signupOpen: Boolean(h.signupOpen) })
      })
      .catch(() => undefined)
  }, [])

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

  const doorHref = `${door.streetBankerUrl}/suites/go/motion`

  return (
    <div className="login">
      <Card title="Open Motion">
        <p className="muted">Motion opens from your Street Banker account. One sign-in there opens every suite.</p>
        <div className="button-row">
          <button
            className="primary"
            type="button"
            onClick={() => {
              window.location.href = doorHref
            }}
          >
            Open Motion from Street Banker
          </button>
        </div>
        <details style={{ marginTop: 16 }}>
          <summary className="small">{mode === 'login' ? 'Staff sign-in' : 'Create the first account'}</summary>
          <form onSubmit={submit} style={{ marginTop: 12 }}>
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
              <button className="small" type="submit" disabled={busy}>
                {busy ? 'working…' : mode === 'login' ? 'Sign in' : 'Create account'}
              </button>
              {door.signupOpen && (
                <button type="button" className="small" onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}>
                  {mode === 'login' ? 'First run? Create the org' : 'Have an account? Sign in'}
                </button>
              )}
            </div>
          </form>
        </details>
      </Card>
    </div>
  )
}
