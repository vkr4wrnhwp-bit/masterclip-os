/**
 * MOTION — source-grounded contextual lessons.
 * Navigation and education ONLY; absolutely no calls to api.*, product
 * click(), mutation, spend, generation or external providers.
 */
export type LessonKey = 'dashboard' | 'projects' | 'project' | 'references' | 'quick' | 'timeline' | 'compare' | 'shot' | 'queue' | 'review' | 'masters' | 'costs' | 'providers';
export interface LessonStep {
  target: string;
  title: string;
  happening: string;
  use: string;
  watch: string;
}
export interface Lesson {
  title: string;
  chapter: string;
  intro: string;
  steps: LessonStep[];
}
const s=(target:string,title:string,happening:string,useIt:string,watch:string):LessonStep =>
  ({target,title,happening,use:useIt,watch});
export const PREVIEW_FILM='preview-film-01';
export const PREVIEW_SHOT='preview-shot-01';
export const ENTRY_LINKS=[
  {title:'01 · Start a Film',label:'Brief, treatment and storyboard',path:'/?walkthrough=start'},
  {title:'02 · Direct a Shot',label:'Continuity, camera, light and render economics',path:'/shot/'+PREVIEW_SHOT+'?walkthrough=shots'},
  {title:'03 · Review & Deliver',label:'Human review, quality, masters and costs',path:'/shot/'+PREVIEW_SHOT+'/review?walkthrough=finish'},
] as const;
export const DEEP_LINKS=[
  {title:'Film & shot list',path:'/project/'+PREVIEW_FILM+'?walkthrough=1'},
  {title:'Rights-cleared references',path:'/project/'+PREVIEW_FILM+'?tab=assets&walkthrough=1'},
  {title:'Quick Create and beat intelligence',path:'/project/'+PREVIEW_FILM+'?tab=quick&walkthrough=1'},
  {title:'Music Video Timeline and Auto-Assembly',path:'/project/'+PREVIEW_FILM+'?tab=timeline&walkthrough=1'},
  {title:'Creative variant comparison',path:'/project/'+PREVIEW_FILM+'?tab=compare&walkthrough=1'},
  {title:'Render queue',path:'/queue/'+PREVIEW_FILM+'?walkthrough=1'},
  {title:'Masters and delivery',path:'/masters/'+PREVIEW_FILM+'?walkthrough=1'},
  {title:'Cost lab',path:'/costs/'+PREVIEW_FILM+'?walkthrough=1'},
  {title:'Provider readiness',path:'/providers?walkthrough=1'},
] as const;

export const LESSONS:Record<LessonKey,Lesson>={
 dashboard:{
  title:'Start a Film',chapter:'01 / CREATIVE DIRECTION',intro:'Learn the real MOTION starting workflow. Your brief becomes the basis of a controlled shot list, not an automatic finished video.',
  steps:[
   s('.mo-brand','Your director’s workspace','MOTION is the cinematic render factory within Street Banker.','Work from the film or a specific shot; the main Street Banker account remains the source of identity.','The learning preview uses fictional data and no customer account.'),
   s('.mo-hero','The film begins with a brief','A creative premise is the anchor for the visual treatment and every subsequent shot.','Describe who or what appears, the environment and the intended performance.','A brief is not a rendered video or a locked identity.'),
   s('.mo-cards','Three honest starting points','Upload audio, describe an idea and use a template are selectable starts.','Select the mode that fits what you have; the project is created first and the next step differs.','Audio uploads during authorized film creation; idea starts from the brief, and templates open Import. No video is silently generated.'),
   s('.mo-cards','Continue from the first authorized upload','A recording selected in Upload audio is uploaded with recorded owner authorization; the resulting film opens References.','Use Continue to Quick Create to select a moment, analyze the song and prepare a directed draft.','Only authorized source media can be used for music-led finishing.'),
   s('.mo-stages','Understand the six stages','Brief → Treatment → Storyboard → Render → Review → Export is a progress summary drawn from actual records.','Read the highlighted stage and open the underlying project before moving forward.','A stage does not claim completion if the API lacks evidence.'),
   s('.mo-start','Create deliberately','This button opens the film creation dialog.','Review the film name and visual direction before choosing Create in the actual product.','Nothing is created by this walkthrough; all writes are blocked in the preview.'),
   s('.mo-opening','Your storyboard is the film’s shot ledger','The newest film and its first shots appear when records exist.','Open the film for its entire shot list, identities and reference material.','Six preview cards do not claim to show every shot on a large production.'),
   s('.mo-budget','Confirm spend posture','SANDBOX is nonbillable and uses the local ffmpeg mock. Live requires separate explicit controls.','Read the posture before considering any render matrix.','Mock renders are not proof that an external provider is live, and a fallback cap is not approved spend.')
  ]
 },
 projects:{
  title:'All Films',chapter:'01 / CREATIVE DIRECTION',intro:'Every film in this account. Open work that already exists rather than creating duplicate projects.',
  steps:[
   s('.mo-list-head','Every film stays accessible','The list groups this account’s films without discarding older projects.','Open the relevant film or start a new one when there is a new concept.','A film summary that has not been read says so; it is not reported as zero.'),
   s('.mo-list','Read the film before committing resources','Each row shows its actual name, brief and as much progress data as was retrieved.','Open the row to see scenes, shots, references and import tools.','Only a bounded number of films receive deep reads on this screen.'),
   s('.mo-nav','Return to the right workspace','Navigation opens Overview, films, shots, queue, masters and costs where a project exists.','Use the actual navigation, not copied tutorial controls.','The guide cannot create, rename or delete projects.')
  ]
 },
 project:{
  title:'Treatment & Storyboard',chapter:'01 / CREATIVE DIRECTION',intro:'A film holds its actual shot list, brief, references and character/world identity.',
  steps:[
   s('.topbar','The film’s source of truth','This is the project whose shot list and shared rules the render factory uses.','Verify the film before writing or importing new shots.','Never assume a reference is cleared for likeness or commercial rights.'),
   s('.tabs','Seven distinct film tools','References, Quick Create, Shots, Music Video Timeline, Compare variants, Import shots, and Brief & style are separate tools.','Work from rights-cleared References into Quick Create and Shots, then move to Timeline and finishing.','Uploading a file is not the same as rights clearance.'),
   s('.card','Build a controlled shot list','A shot specifies its narrative reason, action, visual direction and timing.','Create a shot or import a structured shot list, then open a shot for deeper camera and light settings.','The read-only preview explains tools but never saves, imports, renders, or spends.'),
   s('.tabs','Music-first Quick Create','Quick Create trims a rights-cleared track to a short musical moment, adds visual direction and captions, and saves a versioned shot draft.','Select an authorized track, inspect its measured waveform and Beat Grid, then hand the draft to Shot Builder.','Saving a draft is not an AI render, synchronized MP4, or paid provider request.'),
   s('.tabs','Beat Intelligence and song structure','Waveform/beat analysis measures actual source audio, while named sections and cues can guide cuts.','Mark verses, hooks, intros and transitions; keep confidence and manual adjustments visible.','A detected beat is an estimate; it is not automatically a perfect edit point.'),
   s('.tabs','Plan scenes, review the handoff','Scene Planning suggests a sequence of approved shot ideas with camera, performance and music cues.','Review each suggested shot and explicitly authorize creating a canonical Shot Builder draft.','A suggestion alone must never create a paid render or overwrite a changed shot.'),
   s('.tabs','Build a real music video timeline','The timeline sequences approved footage against an authorized recording, offers Auto-Assembly, and queues MP4 finishing.','Save an editable cut, preview clips, inspect captions and final export status.','No finished MP4 exists until the worker completes and the output becomes playable.'),
   s('.tabs','Compare variants without losing history','Variation comparison shows related drafts and approved render outputs side by side.','Compare original and alternate visual directions before selecting what to promote.','Creative drafts do not become finished videos simply by being compared.'),
   s('.tabs button','Brief and references feed the shot','Authorized music, references, song-section notes and visual identity can all guide creative direction.','Maintain consistency between the creative brief, bibles and individual shots.','A source file has to be authorized before the artist identity can be locked.')
  ]
 },
 references:{
  title:'Rights-Cleared References',chapter:'01 / SOURCE MATERIAL',intro:'Upload authorized music, video and image references before directing a film. Rights are recorded at upload.',
  steps:[
   s('.tabs','The source of truth','Each project has a dedicated References tab containing the files the creative tools may use.','Open References from Start a Film or any film editor.','Audio chosen at first-film setup is already uploaded here when creation succeeds.'),
   s('.field-row','Record permission before upload','Owner and consent metadata determine which clips can guide music and identity work.','Enter the real rights owner and affirm only permissions you hold.','An unverified file is stored, not authorized for restricted uses.'),
   s('.card','Continue into Quick Create','An authorized track enables selecting a real song moment and drafting a visual idea.','Use Continue to Quick Create after the track appears.','Neither upload nor draft saving automatically generates a finished MP4.')
  ]
 },
 quick:{
  title:'Quick Create & Beat Intelligence',chapter:'01 / MUSIC-FIRST CREATION',intro:'Begin with a cleared song, measured audio and a specific directed moment. Quick Create saves a draft, not a finished video.',
  steps:[
   s('.mcq','Music-first editing','Quick Create links an authorized track to a short, versioned visual draft.','Start with an approved recording from References.','Do not confuse draft creation with video generation or provider spend.'),
   s('.mcq-trim','Measured waveform and beats','MOTION draws measured audio waveforms and proposes beat timing from the source.','Scrub, play, refine trim points and check the beat confidence.','Detected beats require human judgment; playback may need a user gesture on phones.'),
   s('.mcq .field-row','Describe the actual shot','Shot title, direction, look and aspect ratio guide the generated visual candidate later.','Specify narrative reason, subject, performance, camera and practical light.','A text direction does not override rights or guarantee a rendered result.'),
   s('.mcq-caption-preview, .mcq-trim','Timed captions and lyrics','Caption timing is entered relative to the selected segment.','Use only approved text and check its timing against source playback.','Automatic speech transcription is not implied.'),
   s('.mcq .button-row','Save and continue to Shot Builder','Saving creates a versioned song-moment draft; the professional editor remains available.','Confirm rights attestation, save a draft, then open Shot Builder.','No paid generation or finished MP4 is created at save time.')
  ]
 },
 timeline:{
  title:'Music Timeline & Auto-Assembly',chapter:'03 / MUSIC VIDEO FINISHING',intro:'Plan, review, sequence and finish approved shots to a real synchronized music-video MP4.',
  steps:[
   s('.mc-timeline','Only approved sources qualify','The timeline requires a cleared recording and human-approved master clips.','Choose a recording and locate approved source clips for your edit.','Without approved masters, an export cannot be treated as a finished production.'),
   s('.mc-timeline-structure','Song sections are editable','Notes identify song sections and cue start times that help make an intentional cut.','Mark intro, verse, chorus and transitions; refine timing manually.','The song structure can be guided by data but requires a human decision.'),
   s('.mc-timeline-auto','Plan scenes or propose first cut','Scene Planning and Auto-Assembly generate editable suggestions, not secretly rendered footage.','Review the suggestions and approve handoffs before committing them to shots or edits.','No paid provider calls are made merely by asking for a proposal.'),
   s('.mc-timeline-preview','Preview trims without changing originals','Timeline edits select sections from existing approved clips against authorized audio.','Scrub, arrange, review timing, and save the cut as a version.','The preview is not evidence that a new MP4 has been finished.'),
   s('.mc-timeline-render','Finish and verify a real MP4','After a saved valid timeline, the media worker assembles, reports status, and registers a playable export.','Wait for completed status and test synchronized audio, caption timing and output playback.','Queue acceptance is not a successful delivery; only an actual finished file is.')
  ]
 },
 compare:{
  title:'Creative Variant Comparison',chapter:'03 / CREATIVE REVIEW',intro:'Compare related creative drafts and real approved outputs before promoting a direction.',
  steps:[
   s('.card','Choose related alternatives','Related variations can be compared against the original creative direction.','Pick a source draft and a sibling variant for meaningful comparison.','Do not claim a video exists unless an actual rendered asset is available.'),
   s('.candidate video','Match review playback','When both sides have playable renders, preview and playback controls help compare timing and choices.','Compare direction, identity, physics, movement and narrative effect.','Missing or inaccessible media must remain clearly unavailable.'),
   s('.card','Return to human review','Creative comparison supports, but does not replace, the human approval and master-promotion gates.','Open Review Grid for the chosen take before any promotion.','A quality score or comparison cannot auto-approve a candidate.')
  ]
 },
 shot:{
  title:'Direct a Shot',chapter:'02 / SHOT INTELLIGENCE',intro:'Get a shot production-ready: subject, performance, camera, physically motivated light, constraints, routing and cost.',
  steps:[
   s('.topbar','Control this shot, not the whole film','Each shot has its own canonical specification and immutable version history.','Confirm the shot identity before updating the current version.','A new version does not erase an older render’s source version.'),
   s('.topbar','Reviewed scene-to-shot handoff','A director can review scene suggestions before they become actual canonical Shot Builder drafts.','Inspect the music cue, narrative purpose, camera and performance direction before confirming the handoff.','A change to an existing shot must not silently overwrite later human edits.'),
   s('.grid.cols-2 .card','Narrative and blocking first','What physically happens, where the subject stands and why the frame matters are explicit.','Write natural, specific direction; preserve identity and props from shot to shot.','Generic movement directions are not guaranteed continuity.'),
   s('input[value="50"], input[value="35"], .grid.cols-2','Camera and focus','Lens, aperture, movement and camera position are shot-level decisions.','Specify realistic lens behavior and depth of field rather than relying on aesthetic adjectives.','A prompt is a creative instruction, not proof of optics or camera geometry.'),
   s('input[value*="neon"], .grid.cols-2','One motivated lighting system','MOTION stores a dominant source, its position, falloff and shadow behavior.','Keep materials, reflections and shadows physically coherent across takes.','Changing illumination or wardrobe may break a character or environment lock.'),
   s('details','Advanced settings remain available','Format, references, negative constraints and continuity are progressive disclosures, not removed tools.','Expand the relevant section to refine timing, references and output requirements.','A reference marked unverified cannot become cleared through a tutorial.'),
   s('.card','Routing is evidence-based','The model router considers compatibility, estimated price, acceptance rates and confidence.','Compare several candidates and read uncertainty before planning a batch.','Provider adapters can be installed without live credentials or successful real submissions.'),
   s('.grid.cols-2 button','Preview the candidate matrix first','The matrix estimates candidate count and potential cost before any queue submission.','Prune expensive variations, set limits and confirm the estimated total.','The tutorial cannot run a quote or submit a render; all preview POSTs fail closed.')
  ]
 },
 queue:{
  title:'Render Operations',chapter:'02 / SHOT INTELLIGENCE',intro:'The queue distinguishes planned work, completed mock runs, blocked renders and actual media receipts.',
  steps:[
   s('.topbar','Queue status is operational evidence','Jobs are attached to a project and provider/model.','Check whether the job is queued, active, completed, failed or blocked.','An accepted queue job is not proof a clip was rendered.'),
   s('.grid.cols-4','Counts are scoped to the project','The summary reads recorded queue statuses.','Use it to identify stalls and investigate failures rather than retrying blindly.','Sandbox work is not external provider validation.'),
   s('table','Every run has a trace','The queue records model, attempt count, spend estimate, actual cost and errors.','Open the review for a completed job or inspect the failure before attempting a retry.','This guide never cancels or retries a job.')
  ]
 },
 review:{
  title:'Review & Deliver',chapter:'03 / HUMAN APPROVAL',intro:'Compare candidate clips at matched playback positions, preserve QC evidence and retain final human authority.',
  steps:[
   s('.topbar','One shot, several takes','The review grid belongs to a single shot.','Verify the shot name, then compare its candidate outputs under the same direction.','A mock example does not establish provider quality or public availability.'),
   s('.review-grid','Review against actual candidates','Each candidate carries its source provider, duration, dimensions and review state.','Judge continuity, materials, physics, movement and story rather than a generic quality score.','A technical pass is not a creative approval.'),
   s('.candidate .scores, .candidate .body','Technical QC versus creative judgment','QC flags black frames, freezes, duration errors and other measurable defects.','Inspect the evidence and record why a take passes or fails.','Only a person approves. Automatic QC may reject but must not auto-approve.'),
   s('.candidate video, .candidate .prompt-box','Synchronize comparison','Playback and prompt evidence help compare candidates on the same beat and frame.','Select two eligible takes for side-by-side review and evaluate locked details.','The preview has no provider video; do not mistake fixture metadata for real renders.'),
   s('.candidate .button-row','Reject, approve, then promote','Human approval and promotion are distinct actions before a master exists.','Make the creative decision first, then promote only the chosen take.','The guide never calls review or promote; this static preview blocks them.'),
   s('.tabs','Timeline, captions and Auto-Assembly','The music workflow continues beyond approving individual takes: MOTION assembles trimmed, approved clips with a rights-cleared soundtrack and timed captions.','Return to the film Music Video Timeline; review the proposed first cut, save a timeline version and wait for real MP4 assembly.','An assembly proposal is editable planning, not a delivered video; progress and download links require completed worker output.'),
   s('.sidebar .nav','Finishing is another stage','Masters and Cost lab are distinct project views that remain available in navigation.','Continue to Masters to package deliverables, and Cost lab to evaluate efficiency.','A promoted take is not a delivered master and an estimated cost is not billed spend.')
  ]
 },
 masters:{
  title:'Masters & Delivery',chapter:'03 / HUMAN APPROVAL',intro:'Export approved media with documented conversion choices and complete provenance.',
  steps:[
   s('.topbar','Masters require a human decision','An approved take may be promoted to a master.','Confirm you have selected the right creative version and output.','Auto-QC cannot promote a master.'),
   s('.grid.cols-2','Choose the actual delivery format','H.264, H.265, ProRes and social variants serve different deliverable needs.','Specify aspect changes and whether to crop or pad deliberately.','Upsizing a 720p source does not create 1080p detail.'),
   s('.field-row','Reframe with consequences','Crop discards composition; pad introduces different framing.','Keep alternative aspect ratios as explicit derivative versions.','Never claim the source remains visually unchanged after reframing.'),
   s('.button-row','Finish and package deliberately','A provenance sidecar connects the delivery back to the shot, provider and review decision.','Review export settings before finishing and packaging in the real app.','No conversions, packages or downloads are generated in the learning preview.')
  ]
 },
 costs:{
  title:'Cost & Approval Economics',chapter:'03 / HUMAN APPROVAL',intro:'Spend is evaluated against approved usable seconds, not just price per submitted clip.',
  steps:[
   s('.topbar','Measure what is usable','MOTION prioritizes cost per approved second because cheap unusable renders are expensive.','Compare approved duration and total submissions rather than model sticker price alone.','An estimated value is not a provider invoice.'),
   s('.grid.cols-4','The four cost ratios','Project totals separate submitted, technically valid, creatively approved and spend.','Read provenance, missing values and whether numbers came from mock activity.','Missing live-cap configuration must not be presented as authorized spending.'),
   s('.grid.cols-2','Cost by model and rejection reason','Tables show where money or sandbox compute went and why candidates failed.','Use failure modes to refine the shot and the routing approach.','Tiny samples cannot prove an acceptance rate.'),
   s('.card','Model performance requires observed approvals','The model table learns from real reviewed outcomes over time.','Treat cold-start estimates as priors until enough candidates have been reviewed.','A confidence estimate is not a creative guarantee.')
  ]
 },
 providers:{
  title:'Providers & Safety',chapter:'03 / HUMAN APPROVAL',intro:'Know exactly which video providers can actually execute before considering any spend.',
  steps:[
   s('.topbar','Provider coverage is a capability matrix','Available adapters and pricing snapshots do not prove live credentials or wire validation.','Read the per-provider configured and health signals before selecting a model.','The mock provider exists so learning can happen without billable submissions.'),
   s('.card','Hard spending posture comes first','MOTION defaults to sandbox, preventing all billable provider requests regardless of project budget.','Keep external spend off until a separate approved live configuration and cap exist.','This tutorial cannot enable paid providers, keys or any spending mode.'),
   s('table','Model features matter','Different models support different image references, duration, motion and native audio.','Choose by shot requirements and approved cost, not by provider name alone.','Capability listings can be spec-correct but unverified live.')
  ]
 }
};
