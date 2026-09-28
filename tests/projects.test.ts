import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Project, QueueJobView, User } from '../apps/web/src/api.js'
import type { AsyncState } from '../apps/web/src/ui.js'

/**
 * The film list.
 *
 * Same two kinds of test as tests/overview.test.ts. `deriveProjectRow` is pure
 * and is exercised one case per state a row can report. The screen itself is
 * rendered to static markup, which runs no effects, so the three list states
 * are driven by standing in for `useAsync` with states the screen would have
 * been in: several films, one film, and none. What comes back is the markup
 * contract, which is where the links and the labels live.
 */

/* The stand-in has to be installed before the screen is imported, which is why
   it is here rather than inside a test. `answers` is what the next calls to
   `useAsync` return, in the order the screen makes them. */
let answers: Array<AsyncState<unknown>> = []
let cursor = 0

const idle: AsyncState<unknown> = { data: null, error: null, loading: true, failures: 0, reload: () => undefined }
const done = <T,>(data: T): AsyncState<T> => ({ data, error: null, loading: false, failures: 0, reload: () => undefined })

vi.mock('../apps/web/src/ui.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apps/web/src/ui.js')>()),
  useAsync: () => answers[cursor++] ?? idle,
}))

const { Projects } = await import('../apps/web/src/views/Projects.jsx')
const { deriveProjectRow, orderProjects, QUEUE_PAGE_LIMIT } = await import('../apps/web/src/views/overview-model.js')

const h = React.createElement

const USER: User = {
  userId: 'u1',
  orgId: 'o1',
  email: 'director@example.com',
  displayName: 'A Director',
  orgRole: 'owner',
}

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

const job = (over: Partial<QueueJobView> = {}): QueueJobView => ({
  id: 'j1',
  batchId: null,
  shotId: 's1',
  provider: 'mock',
  model: 'mock-standard',
  status: 'completed',
  attempts: 1,
  estimatedUsd: '$0.0000',
  actualUsd: '$0.0000',
  sandbox: true,
  ageSeconds: 1,
  error: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  submittedAt: null,
  completedAt: null,
  ...over,
})

/** A read of a film with nothing in it, so each test names only what it has. */
const read = (over: Partial<Parameters<typeof deriveProjectRow>[1] & object> = {}) => ({
  sceneCount: 0,
  shotCount: 0,
  jobs: [] as QueueJobView[],
  masters: [] as Array<Record<string, unknown>>,
  ...over,
})

/**
 * What the screen does to turn an API answer into rows, without the screen.
 * The component maps exactly this, so the list cases below are the list.
 */
const list = (projects: Project[], details: Record<string, ReturnType<typeof read>> = {}) =>
  orderProjects(projects).map((item) => deriveProjectRow(item, details[item.id] ?? null))

/** Renders the screen with `useAsync` answering with these, in call order. */
function screen(states: Array<AsyncState<unknown>>): string {
  answers = states
  cursor = 0
  return renderToStaticMarkup(h(Projects, { user: USER, onSignOut: () => undefined }))
}

/** The screen's three `useAsync` calls: the films, the providers, the details. */
const loaded = (projects: Project[], details: Map<string, ReturnType<typeof read>> = new Map()) => [
  done({ projects }),
  done({ mode: 'sandbox', liveSpendCapUsd: 2, liveSpendCapConfigured: false, liveSpentUsd: '$0.0000', providers: [] }),
  done({ map: details, firstShot: [] }),
]

/* ------------------------------------------------------------- the rows --- */

describe('deriveProjectRow', () => {
  it('carries the name and the brief, and says so rather than printing an empty line', () => {
    const row = deriveProjectRow(project(), read())
    expect(row).toMatchObject({ id: 'p1', name: 'Neon Rain', href: '/project/p1', brief: 'A late-night performance piece.' })
    expect(deriveProjectRow(project({ brief: '' }), read()).brief).toBeNull()
    expect(deriveProjectRow(project({ brief: '   \n ' }), read()).brief).toBeNull()
  })

  it('reads the stage from the same derivation the Overview uses', () => {
    expect(deriveProjectRow(project({ brief: '' }), read()).stageLabel).toBe('Brief')
    expect(deriveProjectRow(project(), read({ sceneCount: 3 })).stageLabel).toBe('Treatment')
    expect(deriveProjectRow(project(), read({ sceneCount: 3, shotCount: 12 })).stageLabel).toBe('Storyboard')
    expect(deriveProjectRow(project(), read({ shotCount: 12, jobs: [job({ status: 'queued' })] })).stageLabel).toBe('Render')
    expect(deriveProjectRow(project(), read({ shotCount: 12, jobs: [job()] })).stageLabel).toBe('Review')
    expect(deriveProjectRow(project(), read({ shotCount: 12, masters: [{ status: 'delivered' }] })).stageLabel).toBe('Export')
    expect(deriveProjectRow(project(), read()).stageKnown).toBe(true)
  })

  it('counts shots and rendered shots in words, never as a bare zero', () => {
    const none = deriveProjectRow(project(), read())
    expect(none.shotLine).toBe('No shots yet')
    expect(none.renderedLine).toBe('Nothing rendered')
    expect(none.shotLine).not.toContain('0')
    expect(none.renderedLine).not.toContain('0')

    const unrendered = deriveProjectRow(project(), read({ shotCount: 12 }))
    expect(unrendered.shotLine).toBe('12 shots')
    expect(unrendered.renderedLine).toBe('Nothing rendered')

    expect(deriveProjectRow(project(), read({ shotCount: 1 })).shotLine).toBe('1 shot')
  })

  it('counts a shot once however many jobs it took, and only when one completed', () => {
    const jobs = [
      job({ id: 'a', shotId: 's1', status: 'failed' }),
      job({ id: 'b', shotId: 's1', status: 'completed' }),
      job({ id: 'c', shotId: 's1', status: 'completed' }),
      job({ id: 'd', shotId: 's2', status: 'completed' }),
      job({ id: 'e', shotId: 's3', status: 'running' }),
    ]
    expect(deriveProjectRow(project(), read({ shotCount: 12, jobs })).renderedLine).toBe('2 of 12 rendered')
    // A job left behind by a deleted shot cannot push the count past the list.
    expect(deriveProjectRow(project(), read({ shotCount: 1, jobs })).renderedLine).toBe('1 of 1 rendered')
  })

  it('admits when the render count came from a queue that was itself capped', () => {
    const many = Array.from({ length: QUEUE_PAGE_LIMIT }, (_, index) =>
      job({ id: `j${index}`, shotId: `s${index}`, status: index < 40 ? 'completed' : 'queued' }),
    )
    const sampled = deriveProjectRow(project(), read({ shotCount: 300, jobs: many }))
    expect(sampled.renderedSampled).toBe(true)
    expect(sampled.renderedLine).toBe('40 of 300 rendered, at least')

    // One job short of the cap is a whole read and claims a total.
    const whole = deriveProjectRow(project(), read({ shotCount: 300, jobs: many.slice(0, QUEUE_PAGE_LIMIT - 1) }))
    expect(whole.renderedSampled).toBe(false)
    expect(whole.renderedLine).toBe('40 of 300 rendered')

    // Nothing rendered inside a capped read is not the same as nothing
    // rendered, and does not say so.
    const nothingSeen = deriveProjectRow(
      project(),
      read({ shotCount: 300, jobs: many.map((item) => ({ ...item, status: 'queued' })) }),
    )
    expect(nothingSeen.renderedLine).toBe('None rendered in the jobs read')
  })

  it('says a film was not read rather than reporting it as empty', () => {
    const row = deriveProjectRow(project(), null)
    expect(row).toMatchObject({
      name: 'Neon Rain',
      href: '/project/p1',
      brief: 'A late-night performance piece.',
      stageKnown: false,
      stageLabel: 'Not read on this page',
      shotLine: 'Not read on this page',
      renderedLine: 'Not read on this page',
      renderedSampled: false,
    })
    // The unread row is the one place a zero would be a lie, so there is none.
    expect(row.shotLine).not.toContain('0')
    expect(row.renderedLine).not.toContain('Nothing')
  })

  it('never claims Export from a promotion it could not see, because outputs are not read here', () => {
    // A take approved and never promoted leaves no project-wide trace. The
    // house rule is to report the earlier stage, so this reads Review.
    const approvedOnly = deriveProjectRow(project(), read({ shotCount: 4, jobs: [job()] }))
    expect(approvedOnly.stageLabel).toBe('Review')
    // A promotion does leave one, and is reported.
    expect(deriveProjectRow(project(), read({ shotCount: 4, jobs: [job()], masters: [{ status: 'approved' }] })).stageLabel).toBe('Export')
  })
})

/* ------------------------------------------------------------- the list --- */

describe('the list itself', () => {
  const films = [
    project({ id: 'p1', name: 'Neon Rain', createdAt: '2026-09-01T00:00:00.000Z' }),
    project({ id: 'p2', name: 'Second Sun', createdAt: '2026-09-14T00:00:00.000Z' }),
    project({ id: 'p3', name: 'Third Rail', createdAt: '2026-09-07T00:00:00.000Z' }),
  ]

  it('puts several films newest first, whatever order the API answered in', () => {
    const rows = list(films)
    expect(rows.map((row) => row.name)).toEqual(['Second Sun', 'Third Rail', 'Neon Rain'])
    expect(rows.map((row) => row.href)).toEqual(['/project/p2', '/project/p3', '/project/p1'])
  })

  it('mixes read and unread rows without either borrowing the other’s numbers', () => {
    const rows = list(films, { p2: read({ shotCount: 6, jobs: [job({ shotId: 's1' })] }) })
    expect(rows[0]).toMatchObject({ name: 'Second Sun', stageKnown: true, shotLine: '6 shots', renderedLine: '1 of 6 rendered' })
    expect(rows[1]).toMatchObject({ name: 'Third Rail', stageKnown: false, shotLine: 'Not read on this page' })
    expect(rows[2]).toMatchObject({ name: 'Neon Rain', stageKnown: false })
  })

  it('is a list of one when there is one', () => {
    const rows = list([films[0]!], { p1: read({ sceneCount: 2 }) })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: 'Neon Rain', stageLabel: 'Treatment', shotLine: 'No shots yet' })
  })

  it('is empty when there are none, rather than a row of nothings', () => {
    expect(list([])).toEqual([])
  })
})

/* ----------------------------------------------------------- the screen --- */

describe('the film list screen', () => {
  it('shows a row per film, each one a link into it', () => {
    const markup = screen(
      loaded(
        [
          project({ id: 'p1', name: 'Neon Rain', createdAt: '2026-09-01T00:00:00.000Z' }),
          project({ id: 'p2', name: 'Second Sun', brief: '', createdAt: '2026-09-14T00:00:00.000Z' }),
        ],
        new Map([['p2', read({ shotCount: 6, jobs: [job({ shotId: 's1' })] })]]),
      ),
    )
    expect(markup).toContain('Your films.')
    expect(markup).toContain('href="#/project/p1"')
    expect(markup).toContain('href="#/project/p2"')
    // Newest first, so the second film's row comes before the first film's.
    expect(markup.indexOf('Second Sun')).toBeLessThan(markup.indexOf('Neon Rain'))
    // The facts carry their own visible labels rather than a column header.
    expect(markup).toContain('Stage')
    expect(markup).toContain('Shots')
    expect(markup).toContain('Rendered')
    expect(markup).toContain('6 shots')
    expect(markup).toContain('1 of 6 rendered')
    // A film with no brief says so instead of leaving a gap.
    expect(markup).toContain('No brief written yet.')
    // And the film that was not read says that, rather than showing zeroes.
    expect(markup).toContain('Not read on this page')
  })

  it('shows one film without the plural and without a list of one it calls a sample', () => {
    const markup = screen(loaded([project()], new Map([['p1', read({ shotCount: 1, jobs: [job()] })]])))
    expect(markup).toContain('Neon Rain')
    expect(markup).toContain('1 shot<')
    expect(markup).toContain('1 of 1 rendered')
    expect(markup).not.toContain('Not read on this page')
    expect(markup).not.toContain('at least')
  })

  it('says there are no films in one line and points at the way to start, with no empty table', () => {
    const markup = screen(loaded([]))
    expect(markup).toContain('No films here yet. Start a new film above and it will be listed here.')
    expect(markup).toContain('START A NEW FILM')
    // No table, no headers, no skeleton rows.
    expect(markup).not.toContain('mo-list-row')
    expect(markup).not.toContain('<table')
    expect(markup).not.toContain('Not read on this page')
  })

  it('does not call a film empty while it is still reading it', () => {
    // Only the film list has answered; the detail read is still out.
    const markup = screen([done({ projects: [project()] }), idle, idle])
    expect(markup).toContain('Reading the stage and counts for the newest film.')
    expect(markup).toContain('Reading')
    expect(markup).not.toContain('Not read on this page')
    expect(markup).not.toContain('No shots yet')
  })

  it('does not call the workspace empty while it is still reading the films', () => {
    const markup = screen([idle, idle, idle])
    expect(markup).toContain('Reading your films.')
    expect(markup).not.toContain('No films here yet.')
  })

  it('wears the same rail, with the film list marked as the page you are on', () => {
    const markup = screen(loaded([project()]))
    expect(markup).toContain('aria-label="Motion workspace"')
    expect(markup).toContain('aria-current="page"')
    expect(markup).toContain('href="#/projects"')
    expect(markup).toContain('Back to Street Banker')
    expect(markup).toContain('/command-center"')
    expect(markup).toContain('Signed in as')
    expect(markup).toContain('A Director')
    // The rail's search field says what it really covers on this screen.
    expect(markup).toContain('Search your films by name or brief')
  })

  it('carries the spend posture, including a cap nobody set', () => {
    const markup = screen(loaded([project()]))
    expect(markup).toContain('Cap not set.')
    expect(markup).toContain('Live renders stop at the $2.00 safety limit until one is set.')
  })

  it('offers one primary action and a way past the rail', () => {
    const markup = screen(loaded([project()]))
    expect(markup).toContain('Skip to main content')
    expect(markup.match(/class="mo-start"/g)).toHaveLength(1)
  })
})
