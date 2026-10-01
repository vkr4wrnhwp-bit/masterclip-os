import { useEffect, useState } from 'react'
import { streetBankerUrl } from './App.jsx'

// A little footer on every suite (owner, 2026-09-29: "put some terms of use in
// the bottom of all these suites and some high level verbiage and then also
// have links to the other suites in them"). The same footer as REACH, Noise
// Lab, The Room and Tour: the suites as links through Street Banker's own doors
// (the suite you are in is plain text), one line, and the legal links.
const SUITES: Array<{ key: string; label: string; href: string }> = [
  { key: 'the-room', label: 'The Room', href: '/suites/go/the-room' },
  { key: 'noise-lab', label: 'Noise Lab', href: '/suites/go/noise-lab' },
  { key: 'reach', label: 'REACH', href: '/suites/go/reach' },
  { key: 'tour', label: 'Tour', href: '/tours' },
  { key: 'motion', label: 'Motion', href: '/suites/go/motion' },
  { key: 'royalty-sweep', label: 'Royalty Sweep', href: '/royalties' },
]

// "What's in Motion" (owner, 2026-09-30): a checklist the person ticks ("I've
// tried this"). Nothing ticks itself; saved in this browser only.
const FEATURES = [
  'Start a video project',
  'Build shots in the Shot Builder',
  'Compare shots side by side in the Review grid',
  'Keep your approved masters',
  'Watch the render queue',
  'Check the cost before you render in the Cost Lab',
  'Connect your video providers',
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
    <details className="sb-suite-features" data-suite="motion">
      <summary>
        What&rsquo;s in Motion <span className="sb-suite-features-count" aria-live="polite">{done} of {FEATURES.length} tried</span>
      </summary>
      <p className="sb-suite-features-note">Tick what you&rsquo;ve tried so you don&rsquo;t miss anything. Saved on this device.</p>
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
      <nav className="sb-suite-footer-suites" aria-label="Street Banker suites">
        {SUITES.map((s) =>
          s.key === current ? (
            <span key={s.key} aria-current="page">
              {s.label}
            </span>
          ) : (
            <a key={s.key} href={`${base}${s.href}`}>
              {s.label}
            </a>
          ),
        )}
      </nav>
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
