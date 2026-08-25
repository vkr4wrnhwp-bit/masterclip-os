import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { ensureSignedIn } from './credentials.js'

/**
 * Browser walkthrough of Street Banker Song Lab.
 *
 * The e2e server runs the API without a worker, so this exercises the
 * synchronous surface: the entry screen, the rights gate that must be satisfied
 * before any audio is stored, project creation and listing, and the honest
 * "analysis has not finished" states the UI must show while a job waits.
 *
 * The analysed views (structure, benchmark, producer) are covered by the
 * integration suite, which drains the queue for real.
 */

let context: BrowserContext
let page: Page

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext()
  page = await context.newPage()
  await ensureSignedIn(page)
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
})

test.afterAll(async () => {
  await context.close()
})

test('Song Lab appears in the nav, before Live Lab in the creative workflow', async () => {
  const songLab = page.getByRole('link', { name: 'Drop a record' })
  await expect(songLab).toBeVisible()

  // Song Lab comes first: diagnose the record, then decide what to do with it.
  const groups = await page.locator('.nav .group').allTextContents()
  expect(groups.indexOf('Song Lab')).toBeLessThan(groups.indexOf('Performance'))
})

test('the entry screen leads with DROP A RECORD', async () => {
  await page.goto('/#/song-lab')
  await expect(page.getByRole('heading', { name: 'DROP A RECORD' })).toBeVisible()
  await expect(page.getByText('Upload the record. Diagnose the record.')).toBeVisible()

  // The positioning is explicit on the page itself, not only in the docs.
  await expect(page.getByText('It does not rewrite your song')).toBeVisible()
  await expect(page.getByText('every finding names the measurement and the cohort behind it')).toBeVisible()
})

test('every documented starting point is offered', async () => {
  await page.goto('/#/song-lab')
  for (const label of [
    'Upload owned audio',
    'Import a Street Banker release',
    'Import an unreleased project',
    'Import a Remix Lab source',
    'Open an existing Song Lab project',
  ]) {
    await expect(page.getByRole('button', { name: label })).toBeVisible()
  }
})

test('the create form will not submit until rights are confirmed', async () => {
  await page.goto('/#/song-lab/new')
  await page.getByLabel('Song title').fill('Rights Gate Test')
  await page.getByLabel('Artist').fill('Example Artist')

  const submit = page.getByRole('button', { name: 'Create and analyse' })
  await expect(submit).toBeDisabled()

  // The exact statement the user accepts is on screen, not behind a link, and
  // the page says what is recorded when they accept it.
  await expect(page.getByText('I confirm that I own or control the audio')).toBeVisible()
  await expect(page.getByText('Nothing is stored or analysed without it')).toBeVisible()

  await page.getByRole('checkbox').first().check()
  await expect(submit).toBeEnabled()
})

test('a created project appears in the list and opens its workspace', async () => {
  await page.goto('/#/song-lab/new')
  await page.getByLabel('Song title').fill('E2E Diagnostic Song')
  await page.getByLabel('Artist').fill('Example Artist')
  await page.getByLabel('Title phrase').fill('signal fire')
  await page.getByRole('checkbox').first().check()
  await page.getByRole('button', { name: 'Create and analyse' }).click()

  await expect(page.getByRole('heading', { name: 'E2E Diagnostic Song' })).toBeVisible()
  // Every tab from the brief is present on the workspace.
  for (const tab of ['OVERVIEW', 'STRUCTURE', 'HOOK', 'LYRICS', 'ENERGY', 'TEMPO', 'ARRANGEMENT', 'BENCHMARK', 'EXPERIMENTS', 'PRODUCER', 'VERSIONS']) {
    await expect(page.getByRole('link', { name: tab, exact: true })).toBeVisible()
  }

  await page.goto('/#/song-lab/projects')
  await expect(page.getByRole('link', { name: 'E2E Diagnostic Song' })).toBeVisible()
})

test('a project with no audio says so rather than showing fabricated figures', async () => {
  await page.goto('/#/song-lab/projects')
  await page.getByRole('link', { name: 'E2E Diagnostic Song' }).click()

  // "no data yet", never a zero BPM or a 0:00 runtime.
  await expect(page.getByText('no data yet').first()).toBeVisible()
  await expect(page.getByText('Select a comparison cohort')).toBeVisible()
})

test('the benchmark tab refuses to compare against a universal formula', async () => {
  await page.goto('/#/song-lab/projects')
  await page.getByRole('link', { name: 'E2E Diagnostic Song' }).click()
  await page.getByRole('link', { name: 'BENCHMARK', exact: true }).click()

  await expect(page.getByText('There is no universal hit-song formula')).toBeVisible()
  // Cohorts name their own sample size on the picker itself.
  await expect(page.getByText('n = 120').first()).toBeVisible()
})

test('the experiments tab states the non-destructive guarantee up front', async () => {
  await page.goto('/#/song-lab/projects')
  await page.getByRole('link', { name: 'E2E Diagnostic Song' }).click()
  await page.getByRole('link', { name: 'EXPERIMENTS', exact: true }).click()

  await expect(page.getByText('The original is never modified')).toBeVisible()
  await expect(page.getByRole('button', { name: 'ORIGINAL' })).toBeVisible()
})

test('the versions tab shows the onward handoffs', async () => {
  await page.goto('/#/song-lab/projects')
  await page.getByRole('link', { name: 'E2E Diagnostic Song' }).click()
  await page.getByRole('link', { name: 'VERSIONS', exact: true }).click()

  await expect(page.getByText('Nothing here overwrites anything')).toBeVisible()
  await expect(page.getByRole('button', { name: 'SEND TO REMIX LAB' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'SEND TO LIVE LAB' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'SEND TO RELEASE COMMAND CENTER' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'SONG LAB REVIEW COMPLETE' })).toBeVisible()
})

test('the internal A&R view is marked internal and defers to a person', async () => {
  await page.goto('/#/song-lab/projects')
  await page.getByRole('link', { name: 'E2E Diagnostic Song' }).click()
  await page.getByRole('link', { name: 'A&R', exact: true }).click()

  await expect(page.getByText('Internal — Street Banker only')).toBeVisible()
  await expect(page.getByText('no rating is a decision until a person approves it')).toBeVisible()
})
