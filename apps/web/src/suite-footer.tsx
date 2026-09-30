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

export function SuiteFooter({ current = 'motion' }: { current?: string }) {
  const base = streetBankerUrl().replace(/\/+$/, '')
  return (
    <div className="sb-suite-footer" role="contentinfo" aria-label="Street Banker">
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
