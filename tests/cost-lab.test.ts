import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AsyncState } from '../apps/web/src/ui.js'

/**
 * The cost lab's live-spend banner.
 *
 * This is the screen somebody opens to ask about money, and it used to print
 * "$X of $2.00 authorized has been spent" whatever the deployment had
 * configured, presenting the runtime's own fallback as an authorization
 * somebody granted. The four states it now tells are `readCap`'s, shared with
 * the Overview's rail and the providers screen; the words are this page's own,
 * and these tests hold them.
 *
 * Rendered to static markup with `useAsync` standing in, the same way
 * tests/projects.test.ts drives the film list.
 */

let answers: Array<AsyncState<unknown>> = []
let cursor = 0

const done = <T,>(data: T): AsyncState<T> => ({ data, error: null, loading: false, failures: 0, reload: () => undefined })
const idle: AsyncState<unknown> = { data: null, error: null, loading: true, failures: 0, reload: () => undefined }

vi.mock('../apps/web/src/ui.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apps/web/src/ui.js')>()),
  useAsync: () => answers[cursor++] ?? idle,
}))

const { CostLab } = await import('../apps/web/src/views/CostLab.jsx')

const h = React.createElement

/** Everything the page reads besides the cap, so each test names only the cap. */
const COSTS = {
  metrics: {
    submittedCount: 4,
    technicallyValidCount: 3,
    approvedCount: 1,
    formatted: { costPerApprovedSecond: '$0.1200', costPerApprovedClip: '$0.9600', costPerSubmittedSecond: '$0.0300', rawSpend: '$3.8400' },
  },
  byProvider: [],
  daily: [],
  rejections: [],
  qcAvoided: { autoRejected: 2, usd: '$1.6000' },
  budget: {},
}

/** Renders the page with this `liveCap` on the cost summary. */
function bannerFor(liveCap: unknown): string {
  answers = [done({ ...COSTS, liveCap }), done({ performance: [] })]
  cursor = 0
  return renderToStaticMarkup(h(CostLab, { projectId: 'p1' }))
}

describe('the live-spend banner', () => {
  it('reports a configured cap as the deployment’s own figure', () => {
    const markup = bannerFor({ capUsd: 25, capConfigured: true, spent: '$4.1000' })
    expect(markup).toContain('Live-spend authorization')
    expect(markup).toContain(
      '$4.1000 of $25.00 authorized has been spent on real provider calls. That figure was configured for this deployment. Sandbox spend is tracked separately and never counts against this cap.',
    )
    // Blue while there is room, red once the authorization is used up.
    expect(markup).toContain('callout info')
    expect(bannerFor({ capUsd: 25, capConfigured: true, spent: '$25.0000' })).toContain('callout danger')
  })

  it('reports a configured cap whose spend could not be read, without inventing a spend', () => {
    const markup = bannerFor({ capUsd: 25, capConfigured: true })
    expect(markup).toContain(
      '$25.00 is authorized for real provider calls, configured for this deployment. How much of it has been spent could not be read. Sandbox spend is tracked separately and never counts against this cap.',
    )
    expect(markup).not.toContain('$0.0000')
    // An unread spend is not an exhausted authorization, so it is not red.
    expect(markup).toContain('callout info')
  })

  it('says plainly when nobody configured a cap, and still names the limit in force', () => {
    const markup = bannerFor({ capUsd: 2, capConfigured: false, spent: '$0.4210' })
    expect(markup).toContain('No live-spend cap configured')
    expect(markup).toContain(
      'Nobody set a cap for this deployment, so live renders run against the built-in $2.00 safety limit, of which $0.4210 has been spent. That limit is enforced either way: the cost controller refuses any submission that would carry live spend past it. Set LIVE_SPEND_CAP_USD to choose your own figure. Sandbox spend is tracked separately and never counts against it.',
    )
    // Never the old sentence, which called the fallback an authorization.
    expect(markup).not.toContain('of $2.00 authorized has been spent')
    // And never a reading of "no limit", because there is one.
    expect(markup).not.toContain('no limit')
  })

  it('separates a cap configured at nothing from a cap nobody configured', () => {
    const markup = bannerFor({ capUsd: 0, capConfigured: true, spent: '$0.0000' })
    expect(markup).toContain('No live spend authorized')
    expect(markup).toContain(
      'The cap is configured at $0.00, which authorizes nothing, so the cost controller refuses every live render. Raise LIVE_SPEND_CAP_USD to permit any real provider call. Sandbox renders are unaffected.',
    )
    expect(markup).not.toContain('No live-spend cap configured')
    // A negative is an operator typo, shown the way it would be read.
    expect(bannerFor({ capUsd: -5, capConfigured: true, spent: '$0.0000' })).toContain('configured at -$5.00')
  })

  it('says the cap could not be read rather than that none is set, and does not take the page down', () => {
    const markup = bannerFor(undefined)
    expect(markup).toContain('Live-spend authorization could not be read')
    expect(markup).toContain(
      'This page could not read the cap from the cost summary, so it is not saying whether one is set. The cost controller is unaffected and still refuses any live submission that would carry spend past whatever cap is in force.',
    )
    expect(markup).not.toContain('No live-spend cap configured')
    expect(markup).not.toContain('Cap not set')
    // The rest of the page is still there; this used to throw on `liveCap.spent`.
    expect(markup).toContain('cost per APPROVED second')
    expect(markup).toContain('auto-rejected / spend avoided')

    // Told a cap is set but not what it is, is the same unread state.
    expect(bannerFor({ capConfigured: true, spent: '$1.0000' })).toContain('Live-spend authorization could not be read')
    // A spend that is known is still reported, because it is a measurement.
    expect(bannerFor({ capConfigured: true, spent: '$1.0000' })).toContain('$1.0000 has been spent on real provider calls.')
  })

  it('reads an API too old to send the flag as not having told us a cap was set', () => {
    const markup = bannerFor({ capUsd: 2, spent: '$0.0000' })
    expect(markup).toContain('No live-spend cap configured')
    expect(markup).not.toContain('That figure was configured for this deployment')
  })

  it('tells each of the four states apart by its heading, not only by its colour', () => {
    const headings = [
      bannerFor({ capUsd: 25, capConfigured: true, spent: '$0.0000' }),
      bannerFor({ capUsd: 2, capConfigured: false, spent: '$0.0000' }),
      bannerFor({ capUsd: 0, capConfigured: true, spent: '$0.0000' }),
      bannerFor(undefined),
    ].map((markup) => markup.match(/<strong>(Live-spend authorization|No live-spend cap configured|No live spend authorized)[^<]*<\/strong>/)?.[0])
    expect(new Set(headings).size).toBe(4)
    expect(headings.every((heading) => heading !== undefined)).toBe(true)
  })
})
