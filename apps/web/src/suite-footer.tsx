import { useEffect, useState } from 'react'
import { streetBankerUrl } from './App.jsx'

// A little footer on every suite (owner, 2026-09-29: terms of use and a line about
// Street Banker; owner, 2026-10-01: no links to the other suites, instead the suite
// asks "Do you know all the features it has? Click here." and opens its own list).
// "What's in Motion" (owner, 2026-09-30): a checklist the person ticks ("I've
// tried this"). Nothing ticks itself; saved in this browser only.
type Feature = { id: string; title: string; group: string }
const FEATURES: Feature[] = [
  { id: 'film', title: 'Start a film from an authorized song, an idea, or a template', group: 'CREATE' },
  { id: 'references', title: 'Upload and manage rights-cleared songs, footage, and images', group: 'CREATE' },
  { id: 'quick', title: 'Use Quick Create to choose a song moment and build a draft', group: 'CREATE' },
  { id: 'beats', title: 'See measured waveforms and beat intelligence', group: 'CREATE' },
  { id: 'structure', title: 'Mark song sections and plan music cues', group: 'CREATE' },
  { id: 'scenes', title: 'Plan scenes, review suggestions, and hand off to Shot Builder', group: 'DIRECT' },
  { id: 'shots', title: 'Direct and version individual shots, camera, lighting, and action', group: 'DIRECT' },
  { id: 'providers', title: 'Connect and manage video providers and compatible models', group: 'DIRECT' },
  { id: 'costs', title: 'Estimate render costs before committing resources', group: 'DIRECT' },
  { id: 'render', title: 'Render selected shot variations and follow the queue', group: 'DIRECT' },
  { id: 'review', title: 'Compare takes, inspect QC, and approve the strongest', group: 'FINISH' },
  { id: 'variants', title: 'Compare related creative drafts and versions', group: 'FINISH' },
  { id: 'masters', title: 'Promote approved footage to managed masters', group: 'FINISH' },
  { id: 'assemble', title: 'Use Auto-Assembly to propose a first music-led cut', group: 'FINISH' },
  { id: 'timeline', title: 'Trim and arrange approved clips on the Music Video Timeline', group: 'FINISH' },
  { id: 'captions', title: 'Prepare timed captions and lyric placement', group: 'FINISH' },
  { id: 'export', title: 'Finish and export a real playable, synchronized MP4', group: 'FINISH' },
]
const FEATURES_KEY = 'sbFeatures:motion:v2'
const LEGACY_KEY = 'sbFeatures:motion'
// Numeric positions belonged to the original seven features. Map only those
// explicit selections into stable identifiers, never into a reordered index.
const OLD_IDS = ['shots','render','review','costs','queue','masters','providers'] as const
const ID_FOR_LEGACY: Record<string,string> = {
  shots:'shots', render:'render',review:'review',costs:'costs',
  queue:'render',masters:'masters',providers:'providers',
}
function readTicks(): Record<string, boolean> {
  try {
    const stored=localStorage.getItem(FEATURES_KEY)
    if(stored) return JSON.parse(stored) as Record<string,boolean>
    const legacy=JSON.parse(localStorage.getItem(LEGACY_KEY) || '{}') as Record<string, boolean>
    const migrated:Record<string,boolean>={}
    OLD_IDS.forEach((old,i)=>{if(legacy[i]) migrated[ID_FOR_LEGACY[old]!]=true})
    localStorage.setItem(FEATURES_KEY,JSON.stringify(migrated))
    return migrated
  } catch { return {} }
}
function FeatureChecklist() {
  const [ticks,setTicks]=useState<Record<string,boolean>>({})
  useEffect(()=>setTicks(readTicks()),[])
  const done=FEATURES.filter(f=>ticks[f.id]).length
  const flip=(id:string)=>{
    const next={...ticks,[id]:!ticks[id]}
    setTicks(next)
    try {localStorage.setItem(FEATURES_KEY,JSON.stringify(next))}catch{/* private mode */}
  }
  return (
    <details className="sb-suite-features" data-suite="motion">
      <summary>
        Did you know MOTION can do all this? <span className="sb-suite-features-count" aria-live="polite">{done} of {FEATURES.length} tried</span>
      </summary>
      <p className="sb-suite-features-note">Discover the creative workflow. Check off what you have tried; your progress stays on this device.</p>
      {(['CREATE','DIRECT','FINISH'] as const).map(group=>(
        <section key={group} aria-label={group.toLowerCase()+' features'}>
          <h3 className="sb-suite-features-group">{group}</h3>
          <ul className="sb-suite-features-list">
            {FEATURES.filter(f=>f.group===group).map(feature=>(
              <li key={feature.id}><label>
                <input type="checkbox" checked={!!ticks[feature.id]} onChange={()=>flip(feature.id)}/>
                <span>{feature.title}</span>
              </label></li>
            ))}
          </ul>
        </section>
      ))}
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
