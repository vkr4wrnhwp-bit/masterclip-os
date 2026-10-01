import { useEffect, useState } from 'react'
import { streetBankerUrl } from './App.jsx'

// A little footer on every suite (owner, 2026-09-29: terms of use and a line about
// Street Banker; owner, 2026-10-01: no links to the other suites, instead the suite
// asks "Do you know all the features it has? Click here." and opens its own list).
// "What's in Motion" (owner, 2026-09-30): a checklist the person ticks ("I've
// tried this"). Nothing ticks itself; saved in this browser only.
const FEATURES = [
  'Plan a video as a set of shots, shot by shot',
  'Generate shots with your connected AI video providers',
  'Review the shots in a grid and approve the best ones',
  'See what a render will cost before you start it',
  'Watch the render queue while it works',
  'Keep every approved master in one place',
  'Connect and manage your video providers',
]
const FEATURES_KEY = 'sbFeatures:motion'

function readTicks(): Record<number, boolean> {
  try {
    return JSON.parse(localStorage.getItem(FEATURES_KEY) || '{}') || {}
  } catch {
    return {}
  }
}

function FeatureChecklist() {
  const [ticks, setTicks] = useState<Record<number, boolean>>({})
  useEffect(() => setTicks(readTicks()), [])
  const done = FEATURES.filter((_, i) => ticks[i]).length
  const flip = (i: number) => {
    const next = { ...ticks, [i]: !ticks[i] }
    setTicks(next)
    try {
      localStorage.setItem(FEATURES_KEY, JSON.stringify(next))
    } catch {
      /* storage blocked: the boxes still work for this visit */
    }
  }
  return (
    <details
      className="sb-suite-features"
      data-suite="motion"
      onToggle={(e) => {
        const el = e.currentTarget
        if (el.open) el.scrollIntoView({ block: 'end', behavior: 'smooth' })
      }}
    >
      <summary>
        Do you know all the features Motion has? Click here. <span className="sb-suite-features-count" aria-live="polite">{done} of {FEATURES.length} tried</span>
      </summary>
      <p className="sb-suite-features-note">Tick what you have tried so you do not miss anything. Saved on this device.</p>
      <ul className="sb-suite-features-list">
        {FEATURES.map((f, i) => (
          <li key={f}>
            <label>
              <input type="checkbox" checked={!!ticks[i]} onChange={() => flip(i)} /> <span>{f}</span>
            </label>
          </li>
        ))}
      </ul>
    </details>
  )
}

export function SuiteFooter({ current = 'motion' }: { current?: string }) {
  const base = streetBankerUrl().replace(/\/+$/, '')
  return (
    <div className="sb-suite-footer" role="contentinfo" aria-label="Street Banker">
      {current === 'motion' && <FeatureChecklist />}
      <p className="sb-suite-footer-line">
        Street Banker: one account for your music business, from the studio to the stage to the statements.
      </p>
      <p className="sb-suite-footer-legal">
        &copy; 2026 Street Banker Inc. &middot; <a href={`${base}/terms`}>Terms of use</a> &middot;{' '}
        <a href={`${base}/privacy`}>Privacy</a> &middot; <a href={`${base}/command-center`}>Back to Street Banker</a>
      </p>
    </div>
  )
}
