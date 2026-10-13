import { describe, expect, it } from 'vitest'
import { inspectStagingEnvironment } from '../scripts/motion-staging-guard.mjs'

const isolated = () => ({
  MOTION_ENVIRONMENT:'isolated-staging',
  MOTION_ISOLATED_STAGING_ACK:'I_CONFIRM_DISPOSABLE_TEST_DATA',
  MOTION_GIT_BRANCH:'codex/motion-staging-qa',
  DB_DRIVER:'sqlite',
  SQLITE_PATH:'/tmp/motion-isolated-staging/db.sqlite',
  STORAGE_LOCAL_ROOT:'/tmp/motion-isolated-staging/assets',
  PROVIDER_SPENDING_ENABLED:'false',
  MASTERCLIP_MODE:'sandbox',
})
describe('MOTION staging safety preflight',()=>{
  it('allows a fully acknowledged isolated offline fixture, without authorizing a deployment',()=>{
    const outcome=inspectStagingEnvironment(isolated())
    expect(outcome.ok).toBe(true)
    expect(outcome.note).toMatch(/does not prove isolation/)
  })
  it('refuses the live branch, persistent volume and live mode',()=>{
    const result=inspectStagingEnvironment({
      ...isolated(),MOTION_GIT_BRANCH:'motion-live',
      STORAGE_LOCAL_ROOT:'/var/data/isolated-staging',
      MASTERCLIP_MODE:'live',
    })
    expect(result.ok).toBe(false)
    expect(result.errors.length).toBeGreaterThanOrEqual(3)
  })
  it('refuses missing consent and a path traversal escaping staging',()=>{
    const result=inspectStagingEnvironment({
      ...isolated(),MOTION_ISOLATED_STAGING_ACK:'',
      STORAGE_LOCAL_ROOT:'/tmp/motion-isolated-staging/../../../var/data',
    })
    expect(result.ok).toBe(false)
  })
  it('does not echo Postgres credentials in errors',()=>{
    const result=inspectStagingEnvironment({
      ...isolated(),DB_DRIVER:'postgres',
      DATABASE_URL:'postgresql://operator:SECRET_NEVER_LOG@production.db.test/app',
    })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain('SECRET_NEVER_LOG')
  })
})
