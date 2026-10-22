import React from 'react'

export const MotionGuidanceContext = React.createContext(false)

export const FEATURES = [
  { id: 'projects', text: 'Keep each video project separate', connected: false },
  { id: 'references', text: 'Upload your song, pictures or video as project references', connected: false },
  { id: 'rights', text: 'Record who owns a reference and whether its use is authorized', connected: false },
  { id: 'shots', text: 'Write a shot brief and choose a style and render profile', connected: false },
  { id: 'preview', text: 'Preview the routing and cost estimate before submitting', connected: false },
  { id: 'sandbox', text: 'Try the pipeline in sandbox mode without billing a provider', connected: false },
  { id: 'render', text: 'Render with a connected AI video provider', connected: true },
  { id: 'queue', text: 'Follow submitted work in the render queue', connected: false },
  { id: 'review', text: 'Review results before approving a take', connected: false },
  { id: 'costs', text: 'Read recorded costs and your chosen spending limits', connected: false },
  { id: 'download', text: 'Download a completed master when one is available', connected: false },
]
export const STEPS = [
  ['Upload a song', 'Open or create a project, then Upload a reference. Add your song and record its owner and permission. Uploading a reference does not make a finished video.'],
  ['Choose a style', 'Open a shot and write the brief. Choose a render profile and the look you want. A model can only be used when its provider is connected.'],
  ['Render a draft', 'Read the preview first. Sandbox uses the local mock without provider billing; live mode can cost money. Submit only when you are ready, then watch the queue.'],
  ['Read the cost', 'This checkout shows provider costs in dollars, not a fixed Street Banker credit price. Read the current estimate and hard spending ceiling before submitting. No fixed price is promised here.'],
  ['Review and download', 'Review each take and approve only what you want to keep. Masters lists completed deliveries for download; an unfinished or refused render has no finished file.'],
]

export function readTicks(storage: Pick<Storage, 'getItem'>): Record<string, boolean> {
  try {
    const value: unknown = JSON.parse(storage.getItem('sbFeatures:motion') || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(FEATURES.filter(f => Object.hasOwn(value, f.id) && typeof (value as Record<string, unknown>)[f.id] === 'boolean').map(f => [f.id, (value as Record<string, unknown>)[f.id] === true]))
  } catch { return {} }
}
export function saveTicks(storage: Pick<Storage, 'setItem'>, ticks: Record<string, boolean>): void {
  try { storage.setItem('sbFeatures:motion', JSON.stringify(ticks)) } catch { /* Ticks still work for this visit. */ }
}
export function initialGuide(search: string, storage?: Pick<Storage, 'getItem'>): { offer: boolean; step: number | null } {
  const params = new URLSearchParams(search)
  if (params.get('walkthrough') === 'motion') return { offer: false, step: Math.max(0, Math.min(STEPS.length - 1, Number.parseInt(params.get('step') || '0', 10) || 0)) }
  try { return { offer: storage?.getItem('sbSuiteIntro:motion') !== '1', step: null } } catch { return { offer: true, step: null } }
}

export function homeUrl(value?: string): string {
  try {
    const url = new URL(value || 'https://app.streetbankermusic.com')
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('home')
    return new URL('/command-center', url.origin).href
  } catch { return 'https://app.streetbankermusic.com/command-center' }
}

export function MotionTip({ title, children }: { title: string; children: React.ReactNode }) {
  return <details className="motion-tip"><summary aria-label={'About ' + title}>?</summary><div role="note">{children}</div></details>
}

export function MotionChrome({ footer = false, connected = false }: { footer?: boolean; connected?: boolean }) {
  const [ticks, setTicks] = React.useState<Record<string, boolean>>(() => { try { return readTicks(localStorage) } catch { return {} } })
  const [offer, setOffer] = React.useState(false)
  const [step, setStep] = React.useState<number | null>(null)
  const dialog = React.useRef<HTMLDialogElement>(null)
  const launch = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => {
    if (footer) return
    let initial: ReturnType<typeof initialGuide>
    try { initial = initialGuide(location.search, localStorage) } catch { initial = initialGuide(location.search) }
    setStep(initial.step); setOffer(initial.offer)
  }, [footer])
  // Only the walkthrough itself is a modal. The first-visit offer is a panel in the page, so it never
  // covers the controls of somebody who just wants to work.
  React.useEffect(() => { if (step !== null) { if (!dialog.current?.open) dialog.current?.showModal() } else if (dialog.current?.open) dialog.current?.close() }, [step])
  const remember = () => { try { localStorage.setItem('sbSuiteIntro:motion', '1') } catch {} }
  const close = () => { remember(); setOffer(false); setStep(null); launch.current?.focus() }
  if (footer) return <div className="motion-suite-footer" role="contentinfo" aria-label="Motion features">
    <details className="sb-suite-features" data-suite="motion"><summary>Do you know all the features Motion has? Click here. <span aria-live="polite">{FEATURES.filter(f => ticks[f.id]).length} of {FEATURES.length} tried</span></summary>
      <p>Tick what you have tried so you do not miss anything. Saved on this device. Each line says Real, Needs a key or Coming soon.</p>
      <ul>{FEATURES.map(f => <li key={f.id}><label><input type="checkbox" checked={!!ticks[f.id]} onChange={e => { const next = { ...ticks, [f.id]: e.target.checked }; setTicks(next); try { saveTicks(localStorage, next) } catch {} }} /><span>{f.text} <span className="motion-feature-tag">{f.connected && !connected ? 'Needs a key' : 'Real'}</span></span></label></li>)}</ul>
    </details>
  </div>
  return <header className="motion-suite-header">
    <a className="motion-suite-button" href={homeUrl(import.meta.env.VITE_STREET_BANKER_URL)}>Back to Street Banker</a>
    <button ref={launch} type="button" onClick={() => { remember(); setOffer(false); setStep(0) }}>Walkthrough</button>
    <MotionTip title="Motion">Build and review a video one shot at a time. A sandbox preview is not a paid AI render or a completed master.</MotionTip>
    {offer && step === null && <section className="motion-guide-offer" aria-labelledby="motion-offer-title">
      <h2 id="motion-offer-title">Want a quick look around Motion?</h2>
      <p>Five short steps show the real controls. The walkthrough never submits a render or spends money.</p>
      <div className="motion-guide-actions"><button type="button" onClick={() => { remember(); setOffer(false); setStep(0) }}>Start walkthrough</button><button type="button" onClick={close}>Skip for now</button></div>
    </section>}
    <dialog ref={dialog} className="motion-guide" aria-labelledby="motion-guide-title" onCancel={close} onClose={() => { if (step !== null) close() }}>
      <h2 id="motion-guide-title">{STEPS[step ?? 0][0]}</h2>
      <p>{STEPS[step ?? 0][1]}</p>
      <p aria-live="polite">{(step ?? 0) + 1} of {STEPS.length}</p>
      <div className="motion-guide-actions"><button type="button" disabled={step === 0} onClick={() => setStep(n => Math.max(0, (n ?? 0) - 1))}>Back</button><button type="button" onClick={() => step === STEPS.length - 1 ? close() : setStep(n => (n ?? 0) + 1)}>{step === STEPS.length - 1 ? 'Finish' : 'Next'}</button><button type="button" onClick={close}>Close</button></div>
    </dialog>
  </header>
}
