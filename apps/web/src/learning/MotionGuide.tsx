import React from 'react'
import { useRoute } from '../App.jsx'
import { DEEP_LINKS, ENTRY_LINKS, LESSONS, type LessonKey } from './motion-lessons.js'

type View = 'intro' | 'index' | 'step' | 'done'
type Rect = { left: number; top: number; width: number; height: number }
const STORE = 'sb-motion-guided-learning-20261009'

function readState(): Record<string, unknown> {
  try { return JSON.parse(localStorage.getItem(STORE) || '{}') as Record<string, unknown> } catch { return {} }
}
function saveState(value: Record<string, unknown>): void {
  try { localStorage.setItem(STORE, JSON.stringify(value)) } catch { /* private mode */ }
}
function visible(node: Element): boolean {
  return !!node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden'
}
function targetFor(selector: string): Element | null {
  let node: Element | null = null
  try {
    for (const candidate of document.querySelectorAll(selector)) {
      if (visible(candidate)) { node = candidate; break }
    }
    if (!node) node = document.querySelector(selector)
  } catch { return null }
  const collapsed = node?.closest('details:not([open])')
  if (collapsed) return collapsed.querySelector('summary') ?? node
  return node && visible(node) ? node : null
}
function focusSafely(node: HTMLElement | null): void {
  try { node?.focus({preventScroll:true}) } catch { /* disconnected */ }
}

/** Pure educational UI: highlights existing DOM; never invokes product handlers. */
export function MotionGuide({ preview = false }: { preview?: boolean }) {
  const route = useRoute()
  const lessonKey:LessonKey = Object.prototype.hasOwnProperty.call(LESSONS, route.name) ? route.name as LessonKey : 'dashboard'
  const lesson = LESSONS[lessonKey]
  const [open, setOpen] = React.useState(false)
  const [view, setView] = React.useState<View>('intro')
  const [step, setStep] = React.useState(0)
  const [highlight, setHighlight] = React.useState<Rect | null>(null)
  const [missing, setMissing] = React.useState(false)
  const [bottom, setBottom] = React.useState(88)
  const panelRef = React.useRef<HTMLElement>(null)
  const launchRef = React.useRef<HTMLButtonElement>(null)
  const previous = React.useRef<HTMLElement | null>(null)
  const firstStep = lesson.steps[step]
  const routeSignature = [route.name,route.params.projectId ?? '',route.params.shotId ?? '',route.params.walkthrough ?? ''].join('/')

  const close = React.useCallback(() => {
    setOpen(false); setHighlight(null)
    focusSafely(previous.current ?? launchRef.current)
  }, [])

  React.useEffect(() => {
    // One URL = one route-specific lesson; do not reuse last chapter's steps.
    setStep(0); setView('intro'); setHighlight(null)
    const requested = route.params.walkthrough
    if (requested === '1' || requested === 'start' || requested === 'shots' || requested === 'finish') {
      previous.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setOpen(true)
    }
  }, [routeSignature])

  React.useEffect(() => {
    if (!open) return
    const update = () => {
      const visual = window.visualViewport
      const occlusion = visual ? Math.max(0, innerHeight - visual.height - visual.offsetTop) : 0
      const ios = /iPhone|iPod|iPad/.test(navigator.userAgent)
      setBottom(Math.max(ios ? 90 : 18, Math.ceil(occlusion) + 14))
    }
    update()
    window.addEventListener('resize', update, { passive:true })
    window.visualViewport?.addEventListener('resize', update, { passive:true })
    window.visualViewport?.addEventListener('scroll', update, { passive:true })
    return () => {
      window.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('scroll', update)
    }
  }, [open])

  React.useEffect(() => {
    if (!open || view !== 'step' || !firstStep) { setHighlight(null); return }
    let raf = 0
    const move = () => {
      const node = targetFor(firstStep.target)
      if (!node) { setMissing(true);setHighlight(null);return }
      const rect = node.getBoundingClientRect()
      if (rect.bottom < 50 || rect.top > innerHeight * .64) {
        // Scrolling a page is the only product-adjacent action this guide takes.
        node.scrollIntoView({ behavior:'auto', block:'center', inline:'nearest' })
      }
      const measured = node.getBoundingClientRect()
      const topLimit = innerWidth <= 767 ? Math.max(0, innerHeight-bottom-40) : innerHeight-10
      if (measured.width < 12 || measured.height < 12 || measured.top >= topLimit || measured.bottom < 0) {
        setMissing(true); setHighlight(null); return
      }
      setMissing(false)
      const left = Math.max(4,measured.left-5)
      const top = Math.max(4,measured.top-5)
      setHighlight({left,top,width:Math.max(0,Math.min(measured.width+10,innerWidth-left-4)),
        height:Math.max(0,Math.min(measured.height+10,topLimit-top))})
    }
    raf = requestAnimationFrame(move)
    const onMove=()=>{cancelAnimationFrame(raf);raf=requestAnimationFrame(move)}
    window.addEventListener('scroll',onMove,true)
    window.addEventListener('resize',onMove)
    return ()=>{cancelAnimationFrame(raf);window.removeEventListener('scroll',onMove,true);window.removeEventListener('resize',onMove)}
  }, [open,view,step,firstStep?.target,bottom,lessonKey])

  React.useEffect(() => {
    if (!open) return
    const trap=(e:KeyboardEvent)=>{
      if(e.key==='Escape'){e.preventDefault();close();return}
      if(e.key!=='Tab')return
      const controls=[...(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href]') ?? [])].filter(visible)
      if (!controls.length) return
      if(e.shiftKey && document.activeElement===controls[0]){e.preventDefault();focusSafely(controls[controls.length-1] ?? null)}
      if(!e.shiftKey && document.activeElement===controls[controls.length-1]){e.preventDefault();focusSafely(controls[0] ?? null)}
    }
    document.addEventListener('keydown',trap)
    return ()=>document.removeEventListener('keydown',trap)
  },[open,close])

  React.useEffect(() => {
    if (open) focusSafely(panelRef.current?.querySelector<HTMLElement>('.ml-primary') ?? null)
  }, [open, view, step])

  const start=()=>{setStep(0);setView('step')}
  const finish=()=>{
    const state=readState()
    const completed=(state.completed && typeof state.completed==='object' ? state.completed : {}) as Record<string,boolean>
    saveState({...state,completed:{...completed,[lessonKey]:true}})
    setHighlight(null);setView('done')
  }
  const chapterUrls=preview ? [
    ...ENTRY_LINKS.map(x=>({title:x.title+' — '+x.label,href:x.path})),
    ...DEEP_LINKS.map(x=>({title:x.title,href:x.path}))
  ] : [
    {title:'Film overview',href:'/'},
    {title:'All films',href:'/projects'},
    {title:'Providers & models',href:'/providers'},
    ...(route.params.projectId ? [
      {title:'Current film',href:'/project/'+encodeURIComponent(route.params.projectId)},
      {title:'Render queue',href:'/queue/'+encodeURIComponent(route.params.projectId)},
      {title:'Masters',href:'/masters/'+encodeURIComponent(route.params.projectId)},
      {title:'Cost lab',href:'/costs/'+encodeURIComponent(route.params.projectId)}
    ] : []),
    ...(route.params.shotId ? [
      {title:'Current shot',href:'/shot/'+encodeURIComponent(route.params.shotId)},
      {title:'Review candidates',href:'/shot/'+encodeURIComponent(route.params.shotId)+'/review'}
    ] : [])
  ]

  return (
    <>
      <button
        type="button"
        ref={launchRef}
        className="ml-launch"
        aria-label="Open Motion guided workflows"
        hidden={open}
        onClick={()=>{previous.current=document.activeElement instanceof HTMLElement?document.activeElement:null;setOpen(true);setView('intro')}}
      >Learn MOTION</button>
      {open && (
        <div className="ml-overlay" style={{'--ml-clear':bottom+'px'} as React.CSSProperties}>
          <div className="ml-dimmer" aria-hidden="true"/>
          {highlight && <div className="ml-focus" aria-hidden="true" style={highlight}/>}
          <section ref={panelRef} className="ml-panel" role="dialog" aria-modal="true" aria-labelledby="ml-title">
            <div className="ml-heading">
              <div className="ml-brand"><img alt="" src="/motion-mark.png" width={38} height={38}/>
                <div><b>MOTION</b><small>by Street Banker</small></div>
              </div>
              <button type="button" className="ml-dismiss" aria-label="Close walkthrough" onClick={close}>Close</button>
            </div>
            <div className="ml-body">
              <div className="ml-kicker">
                {view==='step' ? lesson.chapter+' · '+(step+1)+' OF '+lesson.steps.length :
                 view==='index' ? 'MOTION · FIELD GUIDE' : view==='done' ? 'CHAPTER REVIEWED' : lesson.chapter}
              </div>
              <h2 id="ml-title">{view==='index'?'Choose your workflow':view==='done'?'Chapter reviewed':view==='step'?firstStep?.title:lesson.title}</h2>
              {view==='intro' && <>
                <p className="ml-intro">{lesson.intro}</p>
                <p className="ml-intro">Contextual guidance on the actual MOTION screens. Read what happens, how to use it, and what to verify. No product action is performed for you.</p>
              </>}
              {view==='step' && firstStep && <>
                <div className="ml-field"><h3>WHAT’S HAPPENING</h3><p>{firstStep.happening}</p></div>
                <div className="ml-field"><h3>HOW TO USE IT</h3><p>{firstStep.use}</p></div>
                <div className="ml-field"><h3>LOOK FOR</h3><p>{firstStep.watch}</p></div>
                {missing && <p className="ml-unavailable">This control is not visible on your current screen or entitlement. The guide will not activate it or claim it is present.</p>}
              </>}
              {view==='index' && <>
                <p className="ml-intro">Each link opens a different existing workspace, with its own lesson.</p>
                <nav aria-label="Motion walkthrough chapters" className="ml-chapters">
                  {chapterUrls.map(item=><a key={item.href} href={'#'+item.href}>{item.title}<span aria-hidden="true">↗</span></a>)}
                </nav>
              </>}
              {view==='done' && <p className="ml-intro">The lesson is complete. No film, shot, render, approval, delivery, account or budget was changed.</p>}
              {preview && <div role="status" className="ml-preview-note"><strong>FICTIONAL / READ-ONLY PREVIEW</strong> · No real video is generated, no accounts are connected, and all API writes are blocked.</div>}
            </div>
            <div className="ml-footer">
              {view==='intro' && <>
                <button type="button" className="ml-button" onClick={()=>setView('index')}>All chapters</button>
                <button type="button" className="ml-button ml-primary" onClick={start}>Start walkthrough</button>
              </>}
              {view==='index' && <>
                <button type="button" className="ml-button" onClick={()=>setView('intro')}>Back</button>
                <button type="button" className="ml-button ml-primary" onClick={start}>Start this chapter</button>
              </>}
              {view==='step' && <>
                <button type="button" className="ml-button" onClick={()=>{setHighlight(null);setView('index')}}>Chapters</button>
                <button type="button" className="ml-button" onClick={()=>step?setStep(step-1):setView('intro')}>Back</button>
                <button type="button" className="ml-button ml-primary" onClick={()=>step+1<lesson.steps.length?setStep(step+1):finish()}>
                  {step+1<lesson.steps.length?'Next':'Finish'}
                </button>
              </>}
              {view==='done' && <>
                <button type="button" className="ml-button" onClick={close}>Close</button>
                <button type="button" className="ml-button ml-primary" onClick={()=>setView('index')}>More chapters</button>
              </>}
            </div>
          </section>
        </div>
      )}
    </>
  )
}
