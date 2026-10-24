import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDb } from '@masterclip/database'
import { LocalStorage } from '@masterclip/asset-storage'
import { createRuntime } from '@masterclip/runtime'
import { loadConfig, silentLogger } from '@masterclip/shared'
import { buildServer } from '../apps/api/src/server.js'

describe('song-map default-off API boundary', () => {
  it('does not register its endpoint when disabled', async () => {
    const db=await createTestDb()
    const root=await mkdtemp(join(tmpdir(),'songlab-phase5-'))
    const config=loadConfig({ NODE_ENV:'test', SONG_LAB_SUITE_ENABLED:'1',
      SONG_LAB_SUITE_LINKED_RECORDS_ENABLED:'1', SONG_LAB_SUITE_SUITE_SSO_ENABLED:'1', SUITE_SSO_SECRET_SONG_LAB:'phase5-test-secret', SONG_LAB_SUITE_FEATURE_SONG_MAP:'0',
      SESSION_SECRET:'test-session', ASSET_SIGNING_SECRET:'test-asset', RATE_LIMIT_ENABLED:'0' },true)
    const runtime=await createRuntime({config,db,logger:silentLogger,mockOnly:true,
      storage:new LocalStorage({root, signingSecret:'test-asset'})})
    const app=await buildServer({runtime})
    try {
      await app.ready()
      const start=await app.inject({url:'/login'})
      const state=new URL(start.headers.location!).searchParams.get('state')!
      const cookie=start.cookies.find(c=>c.name==='song_lab_signin_state')!
      const payload={v:1,uid:'phase5-owner',email:'phase5@example.com',name:'Phase 5 artist',
        plan:'pro',suite:'song-lab',state,nonce:randomBytes(12).toString('hex')}
      const encoded=Buffer.from(JSON.stringify(payload)).toString('base64url')
      const stamp=Buffer.from(Math.floor(Date.now()/1000).toString(16).padStart(8,'0'),'hex').toString('base64url')
      const signed=`${encoded}.${stamp}`
      const key=createHash('sha1').update('street-banker-suite-sso-v1signerphase5-test-secret').digest()
      const token=`${signed}.${createHmac('sha1',key).update(signed).digest('base64url')}`
      const signedIn=await app.inject({method:'POST',url:'/auth/street-banker',
        headers:{cookie:`${cookie.name}=${cookie.value}`,'content-type':'application/x-www-form-urlencoded','sec-fetch-site':'cross-site'},
        payload:new URLSearchParams({token}).toString()})
      expect(signedIn.statusCode).toBe(303)
      const session=signedIn.cookies.find(c=>c.name==='masterclip_session')!
      const result=await app.inject({method:'GET',url:'/api/song-journey/links/other/song-map',headers:{cookie:`${session.name}=${session.value}`}})
      expect(result.statusCode).toBe(404)
      expect(config.SONG_LAB_SUITE_FEATURE_SONG_MAP).toBe(false)
    } finally {
      await app.close()
      await runtime.close()
      await rm(root,{recursive:true,force:true})
    }
  })
})
