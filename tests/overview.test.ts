import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { OutputView, Project, QueueJobView, Shot, User } from '../apps/web/src/api.js'
import { Overview, StartDialog } from '../apps/web/src/views/Overview.jsx'
import {
  countJobs,
  countMasters,
  deriveShotCard,
  deriveSpend,
  deriveStage,
  modeById,
  capFigure,
  railItems,
  readCap,
  searchWorkspace,
  START_MODES,
  tabTrap,
  type StageFacts,
} from '../apps/web/src/views/overview-model.js'

/**
 * The Overview screen.
 *
 * Two kinds of test here. The derivations are pure and are exercised directly,
 * one case per state they can report. The screen itself is rendered to static
 * markup, which runs no effects, so what comes back is the first paint with no
 * API data: exactly the first-run state, and exactly the markup contract the
 * keyboard and screen-reader behaviour rests on.
 */

const h = React.createElement

const USER: User = {
  userId: 'u1',
  orgId: 'o1',
  email: 'director@example.com',
  displayName: 'A Director',
  orgRole: 'owner',
}

/** Every stage fact false or zero, so each test names only what it changes. */
const NOTHING: StageFacts = {
  hasProject: true,
  briefLength: 0,
  sceneCount: 0,
  shotCount: 0,
  renderJobCount: 0,
  completedJobCount: 0,
  approvedOutputCount: 0,
  outputsCoverEveryShot: true,
  masterCount: 0,
  deliveredMasterCount: 0,
}

const facts = (over: Partial<StageFacts>): StageFacts => ({ ...NOTHING, ...over })

const shot = (over: Partial<Shot> = {}): Shot => ({
  id: 's1',
  projectId: 'p1',
  sceneId: null,
  shotKey: 'SH010',
  title: 'Opening silence',
  currentVersion: 1,
  ordinal: 0,
  spec: { duration_seconds: 6 },
  ...over,
})

const take = (over: Partial<OutputView> = {}): OutputView => ({
  id: 'o1',
  jobId: 'j1',
  shotId: 's1',
  providerId: 'mock',
  modelId: 'mock-standard',
  durationSeconds: null,
  width: null,
  height: null,
  fps: null,
  hasAudio: false,
  status: 'qc_passed',
  prompt: '',
  seed: null,
  routingProfile: 'DEFAULT',
  estimatedUsd: '$0.0000',
  actualUsd: '$0.0000',
  qcDetail: null,
  review: null,
  urls: { source: null, proxy: null, thumbnail: null, contactSheet: null },
  ...over,
})

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1',
  orgId: 'o1',
  name: 'Neon Rain',
  slug: 'neon-rain',
  brief: 'A late-night performance piece.',
  status: 'active',
  styleBible: {},
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...over,
})

const job = (status: string): QueueJobView => ({
  id: `j-${status}`,
  batchId: null,
  shotId: 's1',
  provider: 'mock',
  model: 'mock-standard',
  status,
  attempts: 1,
  estimatedUsd: '$0.0000',
  actualUsd: '$0.0000',
  sandbox: true,
  ageSeconds: 1,
  error: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  submittedAt: null,
  completedAt: null,
})

/* ----------------------------------------------------------- the stages --- */

describe('deriveStage', () => {
  it('sits on Brief with no film at all, and says to start here', () => {
    const reading = deriveStage(facts({ hasProject: false }))
    expect(reading).toMatchObject({ index: 1, key: 'brief', label: 'Brief', caption: 'START HERE', complete: false })
    expect(reading.reason).toBe('Nothing started yet. The first stage is a brief.')
  })

  it('separates a film with no brief written from one with a brief', () => {
    expect(deriveStage(facts({})).reason).toBe('The brief has not been written yet.')
    expect(deriveStage(facts({ briefLength: 40 })).reason).toBe('The brief is written. The treatment has not been started.')
    // Both are still stage one, because neither has produced anything after it.
    expect(deriveStage(facts({ briefLength: 40 })).index).toBe(1)
  })

  it('reads scenes without shots as Treatment', () => {
    expect(deriveStage(facts({ briefLength: 40, sceneCount: 3 }))).toMatchObject({ index: 2, key: 'treatment' })
  })

  it('reads shots without renders as Storyboard', () => {
    expect(deriveStage(facts({ sceneCount: 3, shotCount: 12 }))).toMatchObject({ index: 3, key: 'storyboard' })
  })

  it('reads queued jobs with nothing back as Render', () => {
    const reading = deriveStage(facts({ shotCount: 12, renderJobCount: 4 }))
    expect(reading).toMatchObject({ index: 4, key: 'render' })
    expect(reading.reason).toBe('Renders are in the queue. Nothing has come back yet.')
  })

  it('reads landed renders with no approval as Review', () => {
    expect(deriveStage(facts({ shotCount: 12, renderJobCount: 4, completedJobCount: 2 }))).toMatchObject({
      index: 5,
      key: 'review',
    })
  })

  it('reads an approval as Export, and a promotion as Export whatever the sample saw', () => {
    expect(deriveStage(facts({ shotCount: 12, completedJobCount: 2, approvedOutputCount: 1 }))).toMatchObject({ index: 6, key: 'export' })
    expect(deriveStage(facts({ shotCount: 12, masterCount: 1 })).reason).toBe(
      'A take has been promoted to a master. Export is what is left.',
    )
  })

  it('only calls the row complete once a master is finished or delivered', () => {
    expect(deriveStage(facts({ masterCount: 2 })).complete).toBe(false)
    const done = deriveStage(facts({ masterCount: 2, deliveredMasterCount: 1 }))
    expect(done).toMatchObject({ index: 6, complete: true })
  })

  it('admits when a reading came from a partial read of the shots', () => {
    const partial = deriveStage(facts({ shotCount: 40, completedJobCount: 3, outputsCoverEveryShot: false }))
    expect(partial.index).toBe(5)
    expect(partial.reason).toContain('not every shot in the film')
    // A whole read says nothing about sampling.
    expect(deriveStage(facts({ shotCount: 3, completedJobCount: 3 })).reason).not.toContain('not every shot')
  })

  it('never guesses a later stage from a partial read: no approval seen keeps it at Review', () => {
    const reading = deriveStage(facts({ shotCount: 40, completedJobCount: 3, approvedOutputCount: 0, outputsCoverEveryShot: false }))
    expect(reading.key).toBe('review')
  })

  it('counts jobs and masters the way the stage row needs them', () => {
    expect(countJobs([job('queued'), job('completed'), job('failed')])).toEqual({ renderJobCount: 3, completedJobCount: 1 })
    expect(countMasters([{ status: 'approved' }, { status: 'delivered' }, { status: 'finished' }, {}])).toEqual({
      masterCount: 4,
      deliveredMasterCount: 2,
    })
  })
})

/* ------------------------------------------------------- the shot cards --- */

describe('deriveShotCard', () => {
  it('is empty and says so when the shot has no take', () => {
    const card = deriveShotCard(shot(), [], 0)
    expect(card).toMatchObject({ number: '01', title: 'Opening silence', durationLabel: '6 sec', rendered: false, stillUrl: null })
    expect(card.note).toBe('Not rendered.')
  })

  it('is rendered when a take exists, and shows a still only when there is a real one', () => {
    const withoutStill = deriveShotCard(shot(), [take()], 1)
    expect(withoutStill).toMatchObject({ number: '02', rendered: true, stillUrl: null })
    expect(withoutStill.note).toBe('Rendered, not approved yet.')

    const withStill = deriveShotCard(shot(), [take({ urls: { source: null, proxy: null, thumbnail: '/t.jpg', contactSheet: null } })], 0)
    expect(withStill.stillUrl).toBe('/t.jpg')
  })

  it('reports the take that matters when a shot has several', () => {
    const card = deriveShotCard(shot(), [take({ id: 'a', status: 'qc_failed' }), take({ id: 'b', status: 'promoted' })], 0)
    expect(card.note).toBe('Promoted to master.')
    expect(deriveShotCard(shot(), [take({ status: 'approved' })], 0).note).toBe('Approved take.')
    expect(deriveShotCard(shot(), [take({ status: 'rejected' })], 0).note).toBe('Rendered, rejected in review.')
  })

  it('prefers the rendered length over the written one, and never prints a zero', () => {
    expect(deriveShotCard(shot(), [take({ durationSeconds: 8.25 })], 0).durationLabel).toBe('8.3 sec')
    expect(deriveShotCard(shot({ spec: {} }), [], 0).durationLabel).toBe('Length not set')
    expect(deriveShotCard(shot({ spec: { duration_seconds: 0 } }), [], 0).durationLabel).toBe('Length not set')
  })

  it('falls back to the shot key when a shot has no title', () => {
    expect(deriveShotCard(shot({ title: '' }), [], 0).title).toBe('SH010')
  })
})

/* --------------------------------------------------------- the cap read --- */

describe('readCap', () => {
  it('reports a positive configured cap as the deployment’s own figure', () => {
    expect(readCap({ capUsd: 25, capConfigured: true })).toEqual({ state: 'configured', capUsd: 25 })
  })

  it('reports a cap configured at nothing as a decision, not as an absence', () => {
    // Zero and below authorize nothing: the controller denies when
    // `liveSpend + estimated > cap` and every estimate is above zero.
    expect(readCap({ capUsd: 0, capConfigured: true })).toEqual({ state: 'forbidden', capUsd: 0 })
    expect(readCap({ capUsd: -5, capConfigured: true })).toEqual({ state: 'forbidden', capUsd: -5 })
  })

  it('reports an unconfigured cap, and carries the limit that still applies', () => {
    expect(readCap({ capUsd: 2, capConfigured: false })).toEqual({ state: 'unconfigured', fallbackUsd: 2 })
    // No usable figure to carry, so none is carried rather than one invented.
    expect(readCap({ capUsd: 0, capConfigured: false })).toEqual({ state: 'unconfigured', fallbackUsd: null })
    expect(readCap({ capConfigured: false })).toEqual({ state: 'unconfigured', fallbackUsd: null })
  })

  it('reads an API too old to send the flag as not having told us a cap was set', () => {
    expect(readCap({ capUsd: 2 })).toEqual({ state: 'unconfigured', fallbackUsd: 2 })
    expect(readCap({})).toEqual({ state: 'unconfigured', fallbackUsd: null })
  })

  it('never reports a reading it could not take as a cap nobody set', () => {
    expect(readCap(null)).toEqual({ state: 'unread' })
    // Told a cap is configured but not what it is: we know less, not worse.
    expect(readCap({ capConfigured: true })).toEqual({ state: 'unread' })
    expect(readCap({ capUsd: Number.NaN, capConfigured: true })).toEqual({ state: 'unread' })
    expect(readCap({ capUsd: Number.POSITIVE_INFINITY, capConfigured: true })).toEqual({ state: 'unread' })
  })

  it('writes a cap the way an operator would read it back, negatives included', () => {
    expect(capFigure(2)).toBe('$2.00')
    expect(capFigure(0)).toBe('$0.00')
    expect(capFigure(-5)).toBe('-$5.00')
    // Never `$-5.00`, which is how the two screens would each have written it
    // if they had kept their own formatter.
    expect(capFigure(-5)).not.toContain('$-')
  })

  it('is the one reader the rail, the cost lab and the providers screen share', () => {
    // The proof that matters is that the rail's copy follows this state and
    // nothing else. Every state the reader can return has rail words for it.
    const states = [
      readCap(null).state,
      readCap({ capUsd: 2, capConfigured: true }).state,
      readCap({ capUsd: 0, capConfigured: true }).state,
      readCap({ capUsd: 2, capConfigured: false }).state,
    ]
    expect(new Set(states)).toEqual(new Set(['unread', 'configured', 'forbidden', 'unconfigured']))
  })
})

/* ------------------------------------------------------ the budget card --- */

describe('deriveSpend', () => {
  it('shows the real spend against a cap somebody configured', () => {
    expect(deriveSpend({ mode: 'live', liveSpendCapUsd: 2, liveSpendCapConfigured: true, liveSpentUsd: '$0.4210' })).toEqual({
      modeLabel: 'Live',
      capSet: true,
      line: '$0.4210 of $2.00 authorized.',
      // One line is the whole story when the figure is the operator's own.
      detail: null,
    })
  })

  it('says the cap is not set, and still names the limit that applies', () => {
    // The whole point of the change: the route sends the same number either
    // way, so an unconfigured cap is reported from `liveSpendCapConfigured`
    // and never from the figure. The figure is then the runtime's fallback,
    // which is a real limit and is named rather than hidden.
    const unset = deriveSpend({ mode: 'sandbox', liveSpendCapUsd: 2, liveSpendCapConfigured: false, liveSpentUsd: '$0.0000' })
    expect(unset).toEqual({
      modeLabel: 'Sandbox',
      capSet: false,
      line: 'Cap not set.',
      detail: 'Live renders stop at the $2.00 safety limit until one is set.',
    })
    // Never "no limit": the sentence that would read that way is not written.
    expect(unset.detail).not.toContain('no limit')

    // An API too old to send the flag has not told us a cap was configured.
    expect(deriveSpend({ mode: 'sandbox', liveSpendCapUsd: 0, liveSpentUsd: '$0.0000' })).toMatchObject({
      modeLabel: 'Sandbox',
      capSet: false,
      line: 'Cap not set.',
    })
    expect(deriveSpend({ mode: 'sandbox', liveSpendCapUsd: -1 }).line).toBe('Cap not set.')
    expect(deriveSpend({ mode: 'sandbox', liveSpendCapUsd: Number.NaN }).line).toBe('Cap not set.')
    expect(deriveSpend({ mode: 'sandbox' }).line).toBe('Cap not set.')
    // With no usable figure to name, the limit is described rather than priced.
    expect(deriveSpend({ mode: 'sandbox' }).detail).toBe('Live renders stop at the built-in safety limit until one is set.')
  })

  it('separates a cap configured at nothing from a cap nobody configured', () => {
    const zero = deriveSpend({ mode: 'live', liveSpendCapUsd: 0, liveSpendCapConfigured: true, liveSpentUsd: '$0.0000' })
    expect(zero).toMatchObject({ capSet: true, line: 'No live spend authorized.' })
    expect(zero.line).not.toBe('Cap not set.')
    expect(zero.detail).toBe('The cap is configured at nothing, so every live render is refused.')
    expect(deriveSpend({ mode: 'live', liveSpendCapUsd: -5, liveSpendCapConfigured: true }).line).toBe('No live spend authorized.')
  })

  it('never guesses the mode while the request is out or after it failed', () => {
    expect(deriveSpend(null, true)).toMatchObject({ modeLabel: 'Checking', line: 'Reading the spend posture.', detail: null })
    expect(deriveSpend(null, false)).toMatchObject({ modeLabel: 'Mode unknown', line: 'Could not read the spend posture.' })
    expect(deriveSpend({ mode: 'something-else' }).modeLabel).toBe('Mode unknown')
  })

  it('says a failed read could not read the cap, rather than that none is set', () => {
    const failed = deriveSpend(null, false)
    expect(failed.detail).toBe('The cap could not be read, so this is not a claim that none is set.')
    expect(failed.line).not.toBe('Cap not set.')
    expect(failed.detail).not.toBe(null)
    // Nothing is claimed while the request is still out.
    expect(deriveSpend(null, true).detail).toBeNull()
  })

  it('keeps the mode when only the cap was unreadable', () => {
    // The call answered with a mode and a configured flag but no figure. The
    // posture is half known, and the card says which half rather than throwing
    // the mode away or calling the cap unset.
    const half = deriveSpend({ mode: 'live', liveSpendCapConfigured: true, liveSpentUsd: '$1.0000' })
    expect(half).toEqual({
      modeLabel: 'Live',
      capSet: false,
      line: 'Cap could not be read.',
      detail: 'The cap could not be read, so this is not a claim that none is set.',
    })
  })
})

/* ------------------------------------------------- searching and the rail - */

describe('searchWorkspace and railItems', () => {
  it('matches films by name or brief, and the current film’s shots by title or key', () => {
    const p = project()
    const hits = searchWorkspace('neon', [p], [shot()], p)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ kind: 'project', href: '/project/p1', context: 'Film' })

    const shotHits = searchWorkspace('sh010', [p], [shot()], p)
    expect(shotHits[0]).toMatchObject({ kind: 'shot', href: '/shot/s1', context: 'Shot in Neon Rain' })
    expect(searchWorkspace('   ', [p], [shot()], p)).toEqual([])
    expect(searchWorkspace('nothing like this', [p], [shot()], p)).toEqual([])
  })

  it('leaves the project-scoped rail items without a destination until there is one', () => {
    const empty = railItems(null, null)
    expect(empty.find((item) => item.key === 'overview')?.href).toBe('/')
    expect(empty.filter((item) => item.href === null).map((item) => item.key)).toEqual(['queue', 'review', 'masters', 'costs'])

    const withFilm = railItems('p1', 's1')
    expect(withFilm.map((item) => item.href)).toEqual(['/', '/projects', '/queue/p1', '/shot/s1/review', '/masters/p1', '/costs/p1'])
    // Review needs a shot, not just a film.
    expect(railItems('p1', null).find((item) => item.key === 'review')?.href).toBeNull()
  })

  it('points Projects at the film list in every state, because that page is where you start one', () => {
    // It used to point at the newest film, which made the list of every film
    // unreachable and left the item dead on an account with no films at all.
    for (const rail of [railItems(null, null), railItems('p1', null), railItems('p1', 's1')]) {
      expect(rail.find((item) => item.key === 'projects')?.href).toBe('/projects')
    }
  })
})

/* ---------------------------------------------------------- the screen ---- */

describe('the first-run screen', () => {
  const markup = renderToStaticMarkup(h(Overview, { user: USER, onSignOut: () => undefined }))

  it('says there is nothing here yet, in the owner’s words', () => {
    expect(markup).toContain('No films here yet.')
    expect(markup).toContain('Choose a starting point above to create your first brief.')
  })

  it('renders no storyboard band and no skeleton cards', () => {
    expect(markup).not.toContain('Your storyboard for')
    expect(markup).not.toContain('mo-shot-frame')
    expect(markup).not.toContain('mo-shots')
  })

  it('offers the film list even here, because it is where a first film is started', () => {
    expect(markup).toContain('href="#/projects"')
    expect(markup).toContain('Projects')
    // And it is a link rather than one of the dimmed sections.
    expect(markup).not.toContain('<span class="mo-nav-item is-unavailable" aria-disabled="true">Projects</span>')
  })

  it('still shows the rail, the hero, the three modes and the six stages', () => {
    expect(markup).toContain('Start a new film.')
    expect(markup).toContain('Create something extraordinary.')
    for (const mode of START_MODES) expect(markup).toContain(mode.title)
    for (const label of ['BRIEF', 'TREATMENT', 'STORYBOARD', 'RENDER', 'REVIEW', 'EXPORT']) expect(markup).toContain(label)
    expect(markup).toContain('START HERE')
  })

  it('carries the signed-in person and a way back to Street Banker', () => {
    expect(markup).toContain('A Director')
    expect(markup).toContain('director@example.com')
    expect(markup).toContain('Return to Street Banker.')
    expect(markup).toContain('Sign out and return to Street Banker')
  })

  it('offers a search field over the workspace', () => {
    expect(markup).toContain('placeholder="Search workspace"')
    expect(markup).toContain('Search your films and the shots in the film shown here')
  })

  it('shows no spend figure before the providers call has answered', () => {
    expect(markup).toContain('Reading the spend posture.')
    expect(markup).not.toContain('authorized')
  })

  it('dims the sections that have nowhere to go and says why, without pretending they are links', () => {
    expect(markup).toContain('aria-disabled="true"')
    expect(markup).toContain('The dimmed sections open once there is a film for them to show.')
  })
})

describe('the mode group', () => {
  const markup = renderToStaticMarkup(h(Overview, { user: USER, onSignOut: () => undefined }))

  it('is a real radio group, so the arrow keys and Space are the platform’s', () => {
    expect(markup).toContain('<fieldset class="mo-modes">')
    expect(markup).toContain('<legend class="mo-sr">Choose a starting point</legend>')
    expect(markup.match(/type="radio"/g)).toHaveLength(START_MODES.length)
    // One name binds them into one group, which is what moves focus with the
    // arrow keys and makes the group a single tab stop.
    expect(markup.match(/name="mo-mode"/g)).toHaveLength(START_MODES.length)
    // Each control sits inside its own label, so the whole card is its target.
    expect(markup.match(/<label class="mo-mode">/g)).toHaveLength(START_MODES.length)
  })

  it('has exactly one chosen at a time, marked by something other than a colour', () => {
    expect(markup.match(/checked=""/g)).toHaveLength(1)
    expect(markup).toContain('mo-selection')
  })

  it('names the primary action after the chosen mode', () => {
    expect(markup).toContain(`aria-label="${START_MODES[0]!.actionLabel}"`)
    expect(markup).toContain('LET')
    for (const mode of START_MODES) expect(mode.actionLabel).toMatch(/^Start a film with /)
    expect(modeById('template').actionLabel).toBe('Start a film with a template')
    expect(modeById('not-a-mode').id).toBe('audio')
  })
})

describe('the start dialog', () => {
  const markup = renderToStaticMarkup(
    h(StartDialog, { mode: modeById('idea'), onClose: () => undefined, onCreated: () => undefined }),
  )

  it('declares itself a modal dialog and names itself from its own heading', () => {
    expect(markup).toContain('role="dialog"')
    expect(markup).toContain('aria-modal="true"')
    expect(markup).toContain('aria-labelledby="mo-setup-heading"')
    expect(markup).toContain('aria-describedby="mo-setup-description"')
    expect(markup).toContain('id="mo-setup-heading"')
    expect(markup).toContain('id="mo-setup-description"')
  })

  it('keeps the chosen mode, and offers two ways out besides Escape', () => {
    expect(markup).toContain('Start with your idea.')
    expect(markup).toContain('DESCRIBE AN IDEA')
    expect(markup).toContain('Visual direction')
    expect(markup).toContain('aria-label="Close project setup"')
    expect(markup).toContain('Cancel')
  })

  it('says plainly what happens after the film is created', () => {
    expect(markup).toContain('becomes the brief')
  })

  it('holds Tab inside the panel at both ends and leaves it alone in the middle', () => {
    expect(tabTrap('Tab', false, 4, 5)).toBe(0)
    expect(tabTrap('Tab', true, 0, 5)).toBe(4)
    expect(tabTrap('Tab', false, 2, 5)).toBeNull()
    expect(tabTrap('Tab', true, 2, 5)).toBeNull()
    // Only Tab is trapped. Escape is the dialog's own, and nothing else moves.
    expect(tabTrap('Escape', false, 0, 5)).toBeNull()
    expect(tabTrap('ArrowRight', false, 4, 5)).toBeNull()
    // A panel with one control or none cannot trap anything.
    expect(tabTrap('Tab', false, 0, 1)).toBe(0)
    expect(tabTrap('Tab', false, 0, 0)).toBeNull()
  })
})
