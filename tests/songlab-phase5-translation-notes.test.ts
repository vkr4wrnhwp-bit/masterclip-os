import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDb } from '@masterclip/database'
import { LocalStorage } from '@masterclip/asset-storage'
import { createRuntime } from '@masterclip/runtime'
import { loadConfig, silentLogger } from '@masterclip/shared'
import { buildServer } from '../apps/api/src/server.js'

describe('translation-notes default-off API boundary', () => {
  it('does not register its endpoint when disabled', async () => {
    const db=await createTestDb()
    const root=await mkdtemp(join(tmpdir(),'songlab-phase5-'))
    const config=loadConfig({ NODE_ENV:'test', SONG_LAB_SUITE_ENABLED:'1',
      SONG_LAB_SUITE_LINKED_RECORDS_ENABLED:'1', SONG_LAB_SUITE_FEATURE_TRANSLATION_NOTES:'0',
      SESSION_SECRET:'test-session', ASSET_SIGNING_SECRET:'test-asset', RATE_LIMIT_ENABLED:'0' },true)
    const runtime=await createRuntime({config,db,logger:silentLogger,mockOnly:true,
      storage:new LocalStorage({root, signingSecret:'test-asset'})})
    const app=await buildServer({runtime})
    try {
      await app.ready()
      const result=await app.inject({method:'GET',url:'/api/song-journey/links/other/versions/v1/translation-notes'})
      expect(result.statusCode).toBe(404)
      expect(config.SONG_LAB_SUITE_FEATURE_TRANSLATION_NOTES).toBe(false)
    } finally {
      await app.close()
      await runtime.close()
      await rm(root,{recursive:true,force:true})
    }
  })
})
