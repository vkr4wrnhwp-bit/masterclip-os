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

describe('owned reference choices remain inside one workspace',()=>{
  it('returns 404 for a foreign candidate and a foreign ?with= comparison',async()=>{
    const db=await createTestDb(),root=await mkdtemp(join(tmpdir(),'phase5-reference-isolation-'))
    const config=loadConfig({NODE_ENV:'test',SONG_LAB_SUITE_ENABLED:'1',SONG_LAB_SUITE_LINKED_RECORDS_ENABLED:'1',
      SONG_LAB_SUITE_SUITE_SSO_ENABLED:'1',SUITE_SSO_SECRET_SONG_LAB:'phase5-test-secret',
      SONG_LAB_SUITE_FEATURE_REFERENCE_COMPARE:'1',SESSION_SECRET:'test-session',ASSET_SIGNING_SECRET:'test-asset',RATE_LIMIT_ENABLED:'0'},true)
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
      const owner=await db.get('SELECT org_id FROM song_lab_suite_sessions WHERE tenant_uid = ?',['phase5-owner'])
      expect(owner?.['org_id']).toBeTruthy()
      const ownerOrg=String(owner?.['org_id'])
      const now=new Date().toISOString()
      await db.run('INSERT INTO orgs(id,name,created_at) VALUES(?,?,?)',['foreign-org','Foreign workspace',now])
      for(const [org,prefix] of [[ownerOrg,'own'],['foreign-org','foreign']]){
        await db.run('INSERT INTO song_lab_projects(id,org_id,artist_name,title,genre,status,rights_confirmation_id,title_phrase,notes,demo,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [prefix+'-song',org,'Artist',prefix+' song','rock','draft','fixture','', '',0,'fixture',now,now])
        await db.run('INSERT INTO studio_projects(id,org_id,artist_name,title,genre,stage,rights_confirmation_id,notes,demo,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
          [prefix+'-studio',org,'Artist',prefix+' studio','rock','mix','fixture','',0,'fixture',now,now])
        await db.run('INSERT INTO song_journey_links(id,org_id,song_lab_project_id,studio_project_id,source_kind,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
          [prefix+'-link',org,prefix+'-song',prefix+'-studio','song_lab','fixture',now,now])
      }
      const header={cookie:`${session.name}=${session.value}`}
      const candidate=await app.inject({url:'/api/song-journey/links/foreign-link/reference-candidates',headers:header})
      const comparison=await app.inject({url:'/api/song-journey/links/own-link/reference-compare?with=foreign-link',headers:header})
      expect(candidate.statusCode).toBe(404)
      expect(comparison.statusCode).toBe(404)
    }finally{await app.close();await runtime.close();await rm(root,{recursive:true,force:true})}
  })
})
