/**
 * Everything the Overview screen decides, with no React and no fetching.
 *
 * The screen is a door, not a console, so it makes a small number of claims:
 * where the newest film stands, whether a shot has actually been rendered, and
 * what the spend posture is. Each of those claims is derived here from the real
 * API shapes, so the derivation can be tested on its own and so a reader can
 * check the reasoning without reading JSX.
 *
 * House rule that runs through the whole file: when the data cannot tell two
 * states apart, report the earlier one. A stage we cannot prove stays unlit.
 */
import type { OutputView, Project, QueueJobView, Shot } from '../api.js'

/* -------------------------------------------------------------- the modes -- */

export type StartModeId = 'audio' | 'idea' | 'template'

export interface StartMode {
  id: StartModeId
  /** Card title. The owner's copy, used verbatim. */
  title: string
  /** The two lines under the title. The design breaks them by hand, so do we. */
  description: readonly [string, string]
  /**
   * The primary button's accessible name while this mode is chosen. The visible
   * words stay "LET'S GO", which is how the owner's own file reflects the mode:
   * the button keeps its line and its accessible name changes underneath.
   */
  actionLabel: string
  /** The dialog's heading, from the owner's `titles` map. */
  dialogTitle: string
  /** The visible label on the dialog's second field. */
  fieldLabel: string
  /** What the app actually does next, said plainly inside the dialog. */
  next: string
}

/**
 * Three ways in.
 *
 * All three create the film the same way, through `api.createProject`, because
 * that is the only project-creating call the API has. What differs is what you
 * do on the project page afterwards, and `next` says so rather than implying
 * the app does it for you. The prototype offered a file picker and a format
 * menu here; neither has anything behind it, so neither is built.
 */
export const START_MODES: readonly StartMode[] = [
  {
    id: 'audio',
    title: 'Upload audio',
    description: ['Drop a track or select from your library', 'to get started.'],
    actionLabel: 'Start a film with audio',
    dialogTitle: 'Start with your track.',
    fieldLabel: 'Brief',
    next: 'The film is created first. Add the track on its References tab, then build the shot list from it.',
  },
  {
    id: 'idea',
    title: 'Describe an idea',
    description: ['Turn a concept, reference or mood', 'into a visual direction.'],
    actionLabel: 'Start a film with an idea',
    dialogTitle: 'Start with your idea.',
    fieldLabel: 'Visual direction',
    next: 'What you write below becomes the brief, which the style bible and every compiled prompt start from.',
  },
  {
    id: 'template',
    title: 'Use a template',
    description: ['Start from a proven format and', 'make it your own.'],
    actionLabel: 'Start a film with a template',
    dialogTitle: 'Start with a structure.',
    fieldLabel: 'Brief',
    next: 'The film is created first. Its Import tab takes the shot-list template, so you start from a working format instead of a blank list.',
  },
]

/** The chosen mode, falling back to the first one rather than to nothing. */
export function modeById(id: string): StartMode {
  return START_MODES.find((mode) => mode.id === id) ?? START_MODES[0]!
}

/* ------------------------------------------------------ the six-stage row -- */

export type StageKey = 'brief' | 'treatment' | 'storyboard' | 'render' | 'review' | 'export'

export const STAGES: ReadonlyArray<{ key: StageKey; label: string }> = [
  { key: 'brief', label: 'Brief' },
  { key: 'treatment', label: 'Treatment' },
  { key: 'storyboard', label: 'Storyboard' },
  { key: 'render', label: 'Render' },
  { key: 'review', label: 'Review' },
  { key: 'export', label: 'Export' },
]

/**
 * What the screen managed to observe about the newest film.
 *
 * Three of these are project-wide and therefore conclusive: the queue lists
 * every job for the project, and the masters list every promotion. Two of them
 * are sampled, because the API has no project-wide outputs endpoint and the
 * screen will not fire one request per shot on a fifty-shot film.
 */
export interface StageFacts {
  hasProject: boolean
  /** `Project.brief`, trimmed. Written but untreated is still the brief stage. */
  briefLength: number
  /** `api.project(id).scenes`. A scene list with synopses is this app's treatment. */
  sceneCount: number
  /** `api.shots(id).shots`. */
  shotCount: number
  /** Every `QueueJobView` for the project, whatever its status. */
  renderJobCount: number
  /** Jobs whose status is `completed`, which is when an output has landed. */
  completedJobCount: number
  /** Outputs whose status is `approved` or `promoted`, across the sampled shots. */
  approvedOutputCount: number
  /** False when outputs were read for only some of the shots. */
  outputsCoverEveryShot: boolean
  /** `api.masters(id).masters`. A master exists only once a take was promoted. */
  masterCount: number
  /** Masters whose status is `finished` or `delivered`, so a deliverable exists. */
  deliveredMasterCount: number
}

export interface StageReading {
  /** 1 through 6, matching the numbered circles in the row. */
  index: number
  key: StageKey
  label: string
  /** Why the row sits where it does, in one sentence, shown on the screen. */
  reason: string
  /**
   * The small line under the current stage's label. The design generates
   * "START HERE" in CSS, which is only true of a workspace with no film in it,
   * so it is real text here and changes once a film is under way.
   */
  caption: string
  /** True only when a master has been delivered, so every stage is behind you. */
  complete: boolean
}

const stageAt = (index: number, reason: string, caption: string, complete = false): StageReading => ({
  index,
  key: STAGES[index - 1]!.key,
  label: STAGES[index - 1]!.label,
  reason,
  caption,
  complete,
})

/**
 * Where the newest film stands.
 *
 * Read it from the bottom up: each test is a thing the data can prove, and the
 * first one that holds wins. Nothing here infers a stage from a stage, so a
 * film that skipped scenes and went straight to shots still reports honestly.
 */
export function deriveStage(facts: StageFacts): StageReading {
  // 1. No film at all. The row still shows, sitting on its first stage, because
  //    the screen's whole job is to get you to make one.
  if (!facts.hasProject) return stageAt(1, 'Nothing started yet. The first stage is a brief.', 'START HERE')

  // Said once and reused: a conclusion drawn from sampled outputs has to admit
  // it only looked at some of the shots.
  const sampled = facts.outputsCoverEveryShot ? '' : ' Read from the shots shown here, not every shot in the film.'

  // 2. A delivered or finished master is the only proof the export stage is
  //    itself behind you, so it is the one reading that marks the row complete.
  if (facts.deliveredMasterCount > 0) {
    return stageAt(6, 'A master has been finished and is ready to deliver.', 'YOU ARE HERE', true)
  }

  // 3. A master exists only when a take was promoted, and promotion is recorded
  //    project-wide, so this holds however few shots were sampled.
  if (facts.masterCount > 0) {
    return stageAt(6, 'A take has been promoted to a master. Export is what is left.', 'YOU ARE HERE')
  }

  // 4. An approval that was not promoted leaves no project-wide trace, so this
  //    can only be read from the sampled outputs, and says so.
  if (facts.approvedOutputCount > 0) {
    return stageAt(6, `A take has been approved and is waiting to be promoted.${sampled}`, 'YOU ARE HERE')
  }

  // 5. A completed job means an output landed, which is the moment there is
  //    something to review. The queue covers the whole project.
  if (facts.completedJobCount > 0) {
    return stageAt(5, `Renders have landed. Nothing has been approved yet.${sampled}`, 'YOU ARE HERE')
  }

  // 6. Jobs exist but none have completed, so the film is mid-render.
  if (facts.renderJobCount > 0) {
    return stageAt(4, 'Renders are in the queue. Nothing has come back yet.', 'YOU ARE HERE')
  }

  // 7. Shots exist and nothing has been sent to a provider.
  if (facts.shotCount > 0) {
    return stageAt(3, 'The shot list exists. Nothing has been sent to render.', 'YOU ARE HERE')
  }

  // 8. Scenes with synopses and no shots is this app's treatment stage. There is
  //    no separate treatment record, so this is as far as the data can carry it.
  if (facts.sceneCount > 0) {
    return stageAt(2, 'Scenes are written. The shot list has not been built.', 'YOU ARE HERE')
  }

  // 9. A film with neither scenes nor shots is still at its brief, whether or
  //    not the brief has any words in it yet.
  return facts.briefLength > 0
    ? stageAt(1, 'The brief is written. The treatment has not been started.', 'YOU ARE HERE')
    : stageAt(1, 'The brief has not been written yet.', 'START HERE')
}

/** Collapses a queue response into the two counts `deriveStage` needs. */
export function countJobs(jobs: readonly QueueJobView[]): { renderJobCount: number; completedJobCount: number } {
  return {
    renderJobCount: jobs.length,
    completedJobCount: jobs.filter((job) => job.status === 'completed').length,
  }
}

/**
 * Masters arrive as loose records, so their status is read defensively. Only
 * `finished` and `delivered` mean a deliverable file exists; `approved` means
 * the promotion happened and nothing has been rendered out of it yet.
 */
export function countMasters(masters: ReadonlyArray<Record<string, unknown>>): {
  masterCount: number
  deliveredMasterCount: number
} {
  const status = (master: Record<string, unknown>) => (typeof master.status === 'string' ? master.status : '')
  return {
    masterCount: masters.length,
    deliveredMasterCount: masters.filter((master) => status(master) === 'finished' || status(master) === 'delivered').length,
  }
}

/* --------------------------------------------------------- the film list -- */

/**
 * The queue route answers with at most this many jobs for a project
 * (`listJobs({ projectId, limit: 200 })` in apps/api/src/routes/render.ts).
 *
 * The film list counts renders out of that list, so a project that fills it has
 * been read in part and the row has to say so rather than print a total it did
 * not see. Two hundred jobs in one film is a lot; it is also exactly the case
 * where an unmarked undercount would be most believed.
 */
export const QUEUE_PAGE_LIMIT = 200

/**
 * What the film list managed to read about one project.
 *
 * `api.project(id)` carries scenes and shots together, so a row costs three
 * requests: that one, the queue and the masters. Outputs are not read at all:
 * there is no project-wide outputs endpoint, and one request per shot per film
 * is not a list, it is a crawl. What that costs is one stage of precision,
 * described on `deriveProjectRow`.
 */
export interface ProjectRead {
  sceneCount: number
  shotCount: number
  /** The project's queue, which is where a landed render is visible. */
  jobs: readonly QueueJobView[]
  masters: ReadonlyArray<Record<string, unknown>>
}

export interface ProjectRow {
  id: string
  name: string
  /** Route hash for the row, without the leading '#'. */
  href: string
  /** The brief, trimmed, or null when the film has none. Never an empty line. */
  brief: string | null
  /** 'Storyboard', or words saying the film was not read on this page. */
  stageLabel: string
  /** False when `stageLabel` is those words rather than a stage name. */
  stageKnown: boolean
  /** '12 shots', 'No shots yet', or the not-read words. Never a bare zero. */
  shotLine: string
  /** '4 of 12 rendered', 'Nothing rendered', or the not-read words. */
  renderedLine: string
  /** True when the render count came from a queue that was itself capped. */
  renderedSampled: boolean
}

/** Said in three places, so it is written once. */
const NOT_READ = 'Not read on this page'

/**
 * One row of the film list.
 *
 * `detail` is null for a film the page did not read, either because it fell
 * past the read limit or because its requests failed. Such a row still shows
 * its name and brief and still opens, and says plainly that the rest was not
 * read. It does not show zeroes, which is the only thing worse than showing
 * nothing.
 *
 * Where the stage comes from, and the one place it can be behind: scenes,
 * shots, the queue and the masters are all project-wide, so stages one through
 * five and the promoted and delivered readings of six are as conclusive here as
 * they are on the Overview. The gap is a take that was approved and never
 * promoted, which leaves no project-wide trace and would need the outputs of
 * every shot to see. `deriveStage` is therefore given no approvals and told the
 * outputs were not fully read, so such a film reports Review rather than
 * Export: the house rule, which is to report the earlier stage when the data
 * cannot separate two.
 */
export function deriveProjectRow(project: Project, detail: ProjectRead | null): ProjectRow {
  const brief = project.brief.trim()
  const base = {
    id: project.id,
    name: project.name,
    href: `/project/${project.id}`,
    brief: brief.length > 0 ? brief : null,
  }
  if (detail === null) {
    return {
      ...base,
      stageLabel: NOT_READ,
      stageKnown: false,
      shotLine: NOT_READ,
      renderedLine: NOT_READ,
      renderedSampled: false,
    }
  }

  const jobs = countJobs(detail.jobs)
  const masters = countMasters(detail.masters)
  const stage = deriveStage({
    hasProject: true,
    briefLength: brief.length,
    sceneCount: detail.sceneCount,
    shotCount: detail.shotCount,
    renderJobCount: jobs.renderJobCount,
    completedJobCount: jobs.completedJobCount,
    approvedOutputCount: 0,
    outputsCoverEveryShot: false,
    masterCount: masters.masterCount,
    deliveredMasterCount: masters.deliveredMasterCount,
  })

  // A shot counts as rendered once one of its jobs has completed, which is the
  // moment an output lands. Counting shots rather than jobs keeps four attempts
  // at one shot from reading as four rendered shots, and the clamp keeps a job
  // left behind by a deleted shot from pushing the count past the list.
  const renderedShots = new Set(detail.jobs.filter((job) => job.status === 'completed').map((job) => job.shotId))
  const rendered = Math.min(renderedShots.size, detail.shotCount)
  const sampled = detail.jobs.length >= QUEUE_PAGE_LIMIT

  return {
    ...base,
    stageLabel: stage.label,
    stageKnown: true,
    shotLine: detail.shotCount === 0 ? 'No shots yet' : `${detail.shotCount} ${detail.shotCount === 1 ? 'shot' : 'shots'}`,
    renderedLine:
      detail.shotCount === 0
        ? 'Nothing rendered'
        : rendered === 0
          ? sampled
            ? 'None rendered in the jobs read'
            : 'Nothing rendered'
          : `${rendered} of ${detail.shotCount} rendered${sampled ? ', at least' : ''}`,
    renderedSampled: sampled,
  }
}

/**
 * The films, newest first.
 *
 * Sorted on the timestamp rather than trusting list order, the same way the
 * Overview picks the film it talks about, so both screens agree on which one is
 * newest however the API happens to order its answer.
 */
export function orderProjects(projects: readonly Project[]): Project[] {
  return [...projects].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/* ----------------------------------------------------------- shot cards --- */

export interface ShotCard {
  shotId: string
  /** The number printed in the frame's top left: 01, 02, and so on. */
  number: string
  title: string
  /** '6 sec', or words when the film has not said how long the shot is. */
  durationLabel: string
  /** True when at least one output exists for the shot. */
  rendered: boolean
  /** A still only ever comes from a real thumbnail asset. Never invented. */
  stillUrl: string | null
  /** The line under the title. On an unrendered shot it reads 'Not rendered.' */
  note: string
}

/**
 * Preference order when a shot has several takes.
 *
 * A promoted take is the one that became a master, an approved take is the one
 * a person chose, and after that the best evidence of a working render is one
 * that passed QC. Failures sort last so a shot with one good take and three bad
 * ones shows the good one.
 */
const OUTPUT_RANK: Record<string, number> = {
  promoted: 0,
  approved: 1,
  qc_passed: 2,
  ingested: 3,
  qc_failed: 4,
  rejected: 5,
}

/** The line under the title, which is the only place the take's state is said. */
const OUTPUT_NOTE: Record<string, string> = {
  promoted: 'Promoted to master.',
  approved: 'Approved take.',
  qc_passed: 'Rendered, not approved yet.',
  ingested: 'Rendered, quality check pending.',
  qc_failed: 'Rendered, failed its quality check.',
  rejected: 'Rendered, rejected in review.',
}

function bestOutput(outputs: readonly OutputView[]): OutputView | null {
  if (outputs.length === 0) return null
  const ranked = [...outputs].sort((a, b) => (OUTPUT_RANK[a.status] ?? 9) - (OUTPUT_RANK[b.status] ?? 9))
  return ranked[0] ?? null
}

/** `duration_seconds` is the canonical shot-schema field, defaulted to 8 there. */
function specSeconds(spec: Record<string, unknown> | undefined): number | null {
  const value = spec?.duration_seconds
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function secondsLabel(seconds: number | null): string {
  // A shot with no stated length is not a zero-second shot, so it says so in
  // words rather than printing a measurement nobody recorded.
  if (seconds === null) return 'Length not set'
  const rounded = Math.round(seconds * 10) / 10
  return `${rounded} sec`
}

/**
 * One storyboard card.
 *
 * The two states in the owner's design are EMPTY and RENDERED, and the only
 * thing that separates them is whether the API returned an output for the shot.
 * A rendered take with no thumbnail asset is still rendered; the frame simply
 * stays blank, because the alternative is putting a picture there that is not
 * the shot.
 */
export function deriveShotCard(shot: Shot, outputs: readonly OutputView[], position: number): ShotCard {
  const best = bestOutput(outputs)
  const seconds = best?.durationSeconds ?? specSeconds(shot.spec)
  return {
    shotId: shot.id,
    number: String(position + 1).padStart(2, '0'),
    title: shot.title && shot.title.length > 0 ? shot.title : shot.shotKey,
    durationLabel: secondsLabel(seconds),
    rendered: best !== null,
    stillUrl: best?.urls.thumbnail ?? null,
    note: best === null ? 'Not rendered.' : (OUTPUT_NOTE[best.status] ?? 'Rendered.'),
  }
}

/* ------------------------------------------------------- the spend card --- */

export interface SpendReading {
  /** The real mode, or a word saying we could not read it. Never assumed. */
  modeLabel: string
  /** True only when the deployment configured a cap, which turns on the figure. */
  capSet: boolean
  /** The first line in the card's body. */
  line: string
  /** The line beneath it, or null when one line says the whole thing. */
  detail: string | null
}

export interface SpendInput {
  mode?: string
  liveSpendCapUsd?: number
  /**
   * From `/api/providers`. False means `liveSpendCapUsd` is the runtime's own
   * fallback rather than a figure anybody chose. Absent is read as false: an
   * older API that cannot tell us has not told us the cap was configured.
   */
  liveSpendCapConfigured?: boolean
  liveSpentUsd?: string
}

/**
 * The SANDBOX card.
 *
 * `/api/providers` always sends a finite `liveSpendCapUsd`, because the runtime
 * resolves the fallback before anything reads the value. That number alone
 * cannot say whether a human chose it, so the route sends
 * `liveSpendCapConfigured` beside it and this is where the difference is
 * spoken. Three readings, in the order they are tested:
 *
 *   - the call has not answered, or failed, so nothing is claimed about a cap,
 *   - a cap was configured, and the real spend shows against it,
 *   - no cap was configured, which is said plainly and paired with the limit
 *     that still applies, because there is always a limit.
 *
 * The fourth case is a cap configured to nothing: zero, or a negative. That is
 * a real decision and it authorizes no live render at all, since the controller
 * denies when `liveSpend + estimated > cap` and every estimate is above zero.
 * Calling it "not set" would be the same lie in the other direction.
 *
 * The spend string already carries its own dollar sign, from `formatUsd`.
 */
export function deriveSpend(input: SpendInput | null, loading = false): SpendReading {
  if (input === null) {
    return {
      modeLabel: loading ? 'Checking' : 'Mode unknown',
      capSet: false,
      line: loading ? 'Reading the spend posture.' : 'Could not read the spend posture.',
      // Not "cap not set": the difference between an unset cap and an unread
      // one is the whole point of this card, so a failed read says so.
      detail: loading ? null : 'The cap could not be read, so this is not a claim that none is set.',
    }
  }
  const modeLabel = input.mode === 'live' ? 'Live' : input.mode === 'sandbox' ? 'Sandbox' : 'Mode unknown'
  const cap = input.liveSpendCapUsd
  const usable = typeof cap === 'number' && Number.isFinite(cap) && cap > 0

  if (input.liveSpendCapConfigured === true) {
    if (!usable) {
      return {
        modeLabel,
        capSet: true,
        line: 'No live spend authorized.',
        detail: 'The cap is configured at nothing, so every live render is refused.',
      }
    }
    const spent = typeof input.liveSpentUsd === 'string' && input.liveSpentUsd.length > 0 ? input.liveSpentUsd : '$0.0000'
    return { modeLabel, capSet: true, line: `${spent} of $${cap.toFixed(2)} authorized.`, detail: null }
  }

  return {
    modeLabel,
    capSet: false,
    line: 'Cap not set.',
    // The figure is the runtime's fallback, which the route sends as the cap,
    // so it is named rather than described. Saying only "not set" would read as
    // "no limit", and there is a limit.
    detail: usable
      ? `Live renders stop at the $${cap.toFixed(2)} safety limit until one is set.`
      : 'Live renders stop at the built-in safety limit until one is set.',
  }
}

/* --------------------------------------------------------- the focus trap - */

/**
 * Where Tab should go inside a modal panel, or null to leave it to the browser.
 *
 * A native `<dialog>` opened with `showModal` already makes the page behind it
 * inert on current engines. This is the belt to that braces: it is what makes
 * `aria-modal="true"` a fact rather than a claim anywhere the native behaviour
 * is missing, and being a function rather than a closure over the DOM it can be
 * proved at both ends of the panel and in the middle.
 */
export function tabTrap(key: string, shiftKey: boolean, activeIndex: number, count: number): number | null {
  if (key !== 'Tab' || count <= 0) return null
  if (!shiftKey && activeIndex === count - 1) return 0
  if (shiftKey && activeIndex === 0) return count - 1
  return null
}

/* ------------------------------------------------------------- searching -- */

export interface SearchHit {
  id: string
  kind: 'project' | 'shot'
  label: string
  /** Route hash, without the leading '#'. */
  href: string
  /** Where the hit came from, so a result is never mistaken for another film. */
  context: string
}

/**
 * Search over what this screen has already loaded, which is the person's films
 * and the shot list of the one they are working on. There is no search endpoint
 * on the API, so this is the honest extent of it, and the results say which
 * film a shot belongs to rather than implying the whole workspace was searched.
 */
export function searchWorkspace(query: string, projects: readonly Project[], shots: readonly Shot[], shotsProject: Project | null): SearchHit[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return []
  const hits: SearchHit[] = []
  for (const project of projects) {
    if (project.name.toLowerCase().includes(needle) || project.brief.toLowerCase().includes(needle)) {
      hits.push({ id: project.id, kind: 'project', label: project.name, href: `/project/${project.id}`, context: 'Film' })
    }
  }
  if (shotsProject) {
    for (const shot of shots) {
      const title = shot.title && shot.title.length > 0 ? shot.title : shot.shotKey
      if (title.toLowerCase().includes(needle) || shot.shotKey.toLowerCase().includes(needle)) {
        hits.push({ id: shot.id, kind: 'shot', label: title, href: `/shot/${shot.id}`, context: `Shot in ${shotsProject.name}` })
      }
    }
  }
  return hits
}

/* ------------------------------------------------------------- the rail --- */

export interface RailItem {
  key: string
  label: string
  /** Null when the destination needs a film and there is not one yet. */
  href: string | null
}

/**
 * The six rail items the owner drew, resolved against real routes.
 *
 * Four of them are project-scoped, which is how this app's routing works: the
 * queue, masters and costs views all take a project id, and review takes a shot
 * id. With no film yet they have nowhere to go, so they are rendered as
 * unavailable rather than as links that land on a blank screen.
 *
 * Projects is not one of them. It used to point at the newest film, which made
 * a list of every film unreachable and left the item dead on a new account; it
 * now has a page of its own that is worth opening with no films in it, because
 * that is where you start one.
 */
export function railItems(projectId: string | null, firstShotId: string | null): RailItem[] {
  return [
    { key: 'overview', label: 'Overview', href: '/' },
    { key: 'projects', label: 'Projects', href: '/projects' },
    { key: 'queue', label: 'Render queue', href: projectId ? `/queue/${projectId}` : null },
    { key: 'review', label: 'Review', href: firstShotId ? `/shot/${firstShotId}/review` : null },
    { key: 'masters', label: 'Masters', href: projectId ? `/masters/${projectId}` : null },
    { key: 'costs', label: 'Costs', href: projectId ? `/costs/${projectId}` : null },
  ]
}
