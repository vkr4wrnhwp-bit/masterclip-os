import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTestDb } from '@masterclip/database'
import { LocalStorage } from '@masterclip/asset-storage'
import { createRuntime } from '@masterclip/runtime'
import { loadConfig, silentLogger } from '@masterclip/shared'
import { buildServer } from '../apps/api/src/server.js'

describe('song-map rejects foreign workspace records',()=>{
  it('answers 404 for a real journey link belonging to another workspace',async()=>{
    const db=await createTestDb(),root=await mkdtemp(join(tmpdir(),'phase5-isolation-'))
    const config=loadConfig({NODE_ENV:'test',SONG_LAB_SUITE_ENABLED:'1',SONG_LAB_SUITE_LINKED_RECORDS_ENABLED:'1',
      SONG_LAB_SUITE_SUITE_SSO_ENABLED:'1',SUITE_SSO_SECRET_SONG_LAB:'phase5-test-secret',
      SONG_LAB_SUITE_FEATURE_SONG_MAP:'1',SESSION_SECRET:'test-session',ASSET_SIGNING_SECRET:'test-asset',RATE_LIMIT_ENABLED:'0'},true)
    const runtime=await createRuntime({config,db,logger:silentLogger,mockOnly:true,storage:new LocalStorage({root,signingSecret:'test-asset'})})
    const app=await buildServer({runtime})
    try{
      await app.ready()
      const login=await app.inject({url:'/login'})
      const state=new URL(login.headers.location!).searchParams.get('state')!
      const cookie=login.cookies.find(c=>c.name==='song_lab_signin_state')!
      const signedBody=Buffer.from(JSON.stringify({v:1,uid:'phase5-owner',email:'phase5@example.com',name:'Phase 5 artist',plan:'pro',
        suite:'song-lab',state,nonce:randomBytes(12).toString('hex')})).toString('base64url')
      const stamp=Buffer.from(Math.floor(Date.now()/1000).toString(16).padStart(8,'0'),'hex').toString('base64url')
      const signed=`${signedBody}.${stamp}`
      const key=createHash('sha1').update('street-banker-suite-sso-v1signerphase5-test-secret').digest()
      const token=`${signed}.${createHmac('sha1',key).update(signed).digest('base64url')}`
      const auth=await app.inject({method:'POST',url:'/auth/street-banker',headers:{cookie:`${cookie.name}=${cookie.value}`,
        'content-type':'application/x-www-form-urlencoded','sec-fetch-site':'cross-site'},payload:new URLSearchParams({token}).toString()})
      expect(auth.statusCode).toBe(303)
      const session=auth.cookies.find(c=>c.name==='masterclip_session')!
      const now=new Date().toISOString()
      await db.run('INSERT INTO orgs(id,name,created_at) VALUES(?,?,?)',['foreign-org','Foreign workspace',now])
      await db.run('INSERT INTO song_lab_projects(id,org_id,artist_name,title,genre,status,rights_confirmation_id,title_phrase,notes,demo,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
        ['foreign-song','foreign-org','Other','Private song','rock','draft','fixture','', '',0,'someone',now,now])
      await db.run('INSERT INTO studio_projects(id,org_id,artist_name,title,genre,stage,rights_confirmation_id,notes,demo,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        ['foreign-studio','foreign-org','Other','Private studio','rock','mix','fixture','',0,'someone',now,now])
      await db.run('INSERT INTO song_journey_links(id,org_id,song_lab_project_id,studio_project_id,source_kind,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
        ['foreign-link','foreign-org','foreign-song','foreign-studio','song_lab','someone',now,now])
      const response=await app.inject({url:'/api/song-journey/links/foreign-link/song-map',headers:{cookie:`${session.name}=${session.value}`}})
      expect(response.statusCode).toBe(404)
    }finally{await app.close();await runtime.close();await rm(root,{recursive:true,force:true})}
  })
})
