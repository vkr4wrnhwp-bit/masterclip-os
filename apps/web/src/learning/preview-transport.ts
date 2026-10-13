/**
 * Static MOTION review transport. Executed ONLY by learning-preview-main.tsx.
 * No backend, live credentials, real accounts, media, external provider calls,
 * billable requests, file writes or persistent business data. Never imported
 * from the standard app bundle.
 */
import { PREVIEW_FILM, PREVIEW_SHOT } from './motion-lessons.js'
const NOW = '2026-10-09T19:00:00.000Z'
const otherShot = 'preview-shot-02'
const thirdShot = 'preview-shot-03'
const spec = (shot_id:string,title:string,action:string,lens_mm:number) => ({
  shot_id,title,project_id:PREVIEW_FILM,generation_mode:'text_to_video',
  narrative_purpose:'FICTIONAL EXAMPLE — illustrate one visual beat without real talent or licenses.',
  action,performance_direction:'restrained and deliberate, no theatrical exaggeration',
  blocking:'performer centre-left; wet brick loading wall behind',
  camera_position:'chest height, slight three-quarter angle',
  camera_movement:'deliberate slow dolly; no artificial movement',
  lens_mm,aperture:2.0,focus_behavior:'physically coherent optical depth',
  duration_seconds:6,target_resolution:'720p',aspect_ratio:'16:9',
  routing_profile:'BALANCED',candidate_count:2,max_cost_usd:0,
  subjects:[],source_assets:[],negative_constraints:['no AI skin','no fake reflections','no stylized overlays'],
  lighting:{
    dominant_source:'fixture neon sign on camera left',
    source_position:'2m above and to camera left',
    color_temperature:'cool cyan practical with weak ambient bounce',
    falloff:'natural inverse-square falloff',
    shadow_behavior:'deep real shadows, imperfect pavement reflections',
    practicals:[]
  }
})
const specs = [
  spec('S01','Fictional street reflection','A boot crosses the reflected light on wet pavement.',35),
  spec('S02','Fictional performer close-up','A performer turns toward an unseen approaching car.',50),
  spec('S03','Fictional alley wide','The performer walks toward the street without breaking spatial continuity.',35)
]
const shotIds=[PREVIEW_SHOT,otherShot,thirdShot]
const shots=specs.map((value,i)=>({
  id:shotIds[i]!,projectId:PREVIEW_FILM,sceneId:null,shotKey:value.shot_id,title:value.title,
  ordinal:i+1,currentVersion:1,spec:value
}))
const project={
  id:PREVIEW_FILM,orgId:'preview-org',name:'PREVIEW · Neon Alley (fictional)',
  slug:'preview-neon-alley',brief:'FICTIONAL LEARNING FIXTURE — a music-video concept: one performer, a wet city passage and one motivated practical neon source. No real artist, footage or license.',
  status:'in_progress',styleBible:{visual_world:'industrial night exterior',camera:'35–50mm full frame',lighting:'one practical neon key',rights:'not verified / fictional'},
  createdAt:NOW,updatedAt:NOW
}
const user={userId:'preview-user',orgId:'preview-org',email:'fictional@preview.example.invalid',displayName:'PREVIEW · Fictional Director',orgRole:'owner'}
const output=(id:string,decision:'approve'|'reject'|null,reason:string)=>({
  id,jobId:'preview-job-'+id,shotId:PREVIEW_SHOT,
  providerId:'mock',modelId:'fictional-metadata-only',durationSeconds:6,width:1280,height:720,fps:24,
  hasAudio:false,status:decision==='approve'?'approved':decision==='reject'?'rejected':'pending',
  prompt:'FICTIONAL preview instruction — cinematic natural lighting, physically correct material behavior. No actual output file or model submission.',
  seed:'none',routingProfile:'BALANCED',estimatedUsd:'$0.00',actualUsd:'$0.00',
  qcDetail:{recommended_action:'human_review',confidence:0,creative_score:'unmeasured',
    identity_score:'unmeasured',motion_score:'unmeasured',realism_score:'unmeasured',
    raw:{rationale:'Fixture metadata only. No media exists or was analyzed.',hard_failures:[]}},
  review:decision?{decision,rejectionReasons:reason?[reason]:[],note:'Synthetic example of a manual review decision.'}:null,
  urls:{source:null,proxy:null,thumbnail:null,contactSheet:null}
})
const outputs=[output('fixture-take-a','approve',''),output('fixture-take-b','reject','wrong_camera')]
const job={
  id:'preview-job-fixture-take-a',batchId:'preview-batch',shotId:PREVIEW_SHOT,
  provider:'mock',model:'fictional-metadata-only',status:'completed',attempts:1,
  estimatedUsd:'$0.00',actualUsd:'$0.00',sandbox:true,ageSeconds:100,
  error:null,createdAt:NOW,submittedAt:NOW,completedAt:NOW
}
const models=[{
 providerId:'mock',modelId:'fictional-metadata-only',displayName:'FICTIONAL · Metadata Fixture',
 family:'mock',tier:'sandbox',modes:['text_to_video'],resolutions:['720p'],aspectRatios:['16:9'],
 durations:{minSeconds:3,maxSeconds:15},nativeAudio:false,firstFrame:false,lastFrame:false,
 videoReference:false,extension:false,maxReferenceImages:0,pricing:null,source:'fixture-only'
}]
const master={
 id:'preview-master-01',name:'PREVIEW · Reviewed Take (no output file)',
 status:'approved',approvedAt:NOW,metadata:{provider:'mock',model:'fictional-metadata-only'},
 deliverables:[]
}
export const PREVIEW_ROUTES = {
  build:'/?walkthrough=start',
  shots:'/shot/'+PREVIEW_SHOT+'?walkthrough=shots',
  finish:'/shot/'+PREVIEW_SHOT+'/review?walkthrough=finish'
} as const
export interface PreviewReply { status:number; body:unknown }
function readOnlyError(): PreviewReply {
 return {status:405,body:{error:{kind:'forbidden',code:'PREVIEW_READ_ONLY',
    message:'This is a fictional read-only MOTION learning environment. No project, shot, render, review, master, budget, upload or account action was performed.'}}}
}
export function previewReply(path:string,method:string='GET'): PreviewReply {
  if (method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD') return readOnlyError()
  const url=new URL(path,'https://preview.example.invalid')
  const p=url.pathname
  if (p==='/api/health') return {status:200,body:{ok:true,mode:'sandbox',dialect:'fixture',storage:'none',agents:false,signupOpen:false,streetBankerUrl:'https://example.invalid'}}
  if (p==='/api/auth/me') return {status:200,body:{user,streetBankerUrl:'https://example.invalid'}}
  if (p==='/api/projects') return {status:200,body:{projects:[project]}}
  if (p==='/api/projects/'+PREVIEW_FILM) return {status:200,body:{project,scenes:[],shots,characters:[],environments:[]}}
  if (p==='/api/projects/'+PREVIEW_FILM+'/shots') return {status:200,body:{shots}}
  if (p==='/api/projects/'+PREVIEW_FILM+'/queue') return {status:200,body:{stats:{completed:1,failed:0,queued:0},jobs:[job]}}
  if (p==='/api/projects/'+PREVIEW_FILM+'/masters') return {status:200,body:{masters:[master]}}
  if (p==='/api/projects/'+PREVIEW_FILM+'/costs') return {status:200,body:{
    metrics:{formatted:{costPerApprovedSecond:'Fixture only',costPerApprovedClip:'Fixture only',
      costPerSubmittedSecond:'Fixture only',rawSpend:'$0.00 (fictional)'},
      submittedCount:2,technicallyValidCount:0,approvedCount:0},
    qcAvoided:{autoRejected:0,usd:'$0.00'},liveCap:{capUsd:0,capConfigured:true,spent:'$0.00'},
    byProvider:[{providerId:'mock',modelId:'fictional-metadata-only',entries:0,usd:'$0.00'}],
    rejections:[]}}
  if (p==='/api/projects/'+PREVIEW_FILM+'/model-performance') return {status:200,body:{performance:[]}}
  if (p==='/api/projects/'+PREVIEW_FILM+'/assets') return {status:200,body:{assets:[]}}
  if (p==='/api/shots/blank') return {status:200,body:{shot:specs[0]}}
  if (p==='/api/models') return {status:200,body:{models}}
  if (p==='/api/providers') return {status:200,body:{mode:'sandbox',liveSpendCapUsd:0,liveSpendCapConfigured:true,
    liveSpentUsd:'$0.00',providers:[{providerId:'mock',displayName:'Mock · metadata fixture',configured:false,
      keyFingerprint:'',health:{status:'unconfigured',message:'No actual render service in this static preview.'}}]}}
  if (p==='/api/providers/health') return {status:200,body:{health:[{providerId:'mock',status:'disabled',latencyMs:null,message:'Preview-only metadata fixture'}]}}
  if (p==='/api/routing-profiles') return {status:200,body:{profiles:[]}}
  for (let i=0;i<shotIds.length;i++){
    const sid=shotIds[i]!
    if(p==='/api/shots/'+sid) return {status:200,body:{shot:shots[i],version:{id:'preview-version-'+i,spec:specs[i]},versions:[],outputs:[]}}
    if(p==='/api/shots/'+sid+'/outputs') return {status:200,body:{outputs:i===0?outputs:[]}}
    if(p==='/api/shots/'+sid+'/routing') return {status:200,body:{
      profile:{name:'BALANCED'},chosen:null,candidates:[],
      rejected:[{providerId:'mock',modelId:'fictional-metadata-only',reasons:['No actual provider attached to this read-only preview']}],
      lowConfidence:true,explanation:'FICTIONAL PREVIEW — no provider prices or approvals are being measured.'}}
  }
  return {status:404,body:{error:{kind:'not_found',code:'PREVIEW_DATA_UNAVAILABLE',
    message:'This preview has no real business record or backend for that address.'}}}
}

/** Fail closed. Only allow fixture GETs, block writes and cross-origin fetches. */
export function installMotionPreviewTransport(): void {
  const original=window.fetch.bind(window)
  window.fetch=(input:RequestInfo|URL,init?:RequestInit):Promise<Response>=>{
    const method=(init?.method ?? (input instanceof Request?input.method:'GET')).toUpperCase()
    const address=typeof input==='string'?input:input instanceof URL?input.href:input.url
    const url=new URL(address,window.location.href)
    if (url.origin!==window.location.origin)
      return Promise.resolve(new Response(JSON.stringify({error:'External network disabled in MOTION preview'}),{status:403}))
    if (!url.pathname.startsWith('/api/')) {
      // Only local static assets are permitted; no API or provider fallback.
      if (method!=='GET' && method!=='HEAD')
        return Promise.resolve(new Response('Read-only preview', {status:405}))
      return original(input,init)
    }
    const reply=previewReply(url.pathname+url.search,method)
    return Promise.resolve(new Response(JSON.stringify(reply.body),{
      status:reply.status,headers:{'content-type':'application/json','cache-control':'no-store','x-motion-preview':'synthetic-read-only'}
    }))
  }
}
