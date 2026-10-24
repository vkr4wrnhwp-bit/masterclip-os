import { test, expect } from '@playwright/test'
import { createHash, createHmac, randomBytes } from 'node:crypto'

function token(state:string) {
  const secret=process.env.SUITE_SSO_SECRET_SONG_LAB
  if(!secret)throw new Error('Missing test sign-in secret')
  const body=Buffer.from(JSON.stringify({v:1,uid:'phase5-fixture',email:'phase5@example.com',name:'Phase 5',plan:'pro',suite:'song-lab',
    nonce:randomBytes(12).toString('hex'),state})).toString('base64url')
  const stamp=Buffer.from(Math.floor(Date.now()/1000).toString(16).padStart(8,'0'),'hex').toString('base64url')
  const signed=`${body}.${stamp}`
  const key=createHash('sha1').update(`street-banker-suite-sso-v1signer${secret}`).digest()
  return `${signed}.${createHmac('sha1',key).update(signed).digest('base64url')}`
}

test('Phase 5 Your own listening notes fits 375px without side scroll',async({page,request,context,baseURL})=>{
  test.skip(process.env.SONG_LAB_SUITE_ENABLED!=='1' || process.env.SONG_LAB_SUITE_LINKED_RECORDS_ENABLED!=='1'
    || process.env.SONG_LAB_SUITE_FEATURE_TRANSLATION_NOTES!=='1','Opt-in feature pilot only')
  const entry=await request.get('/login',{maxRedirects:0})
  const state=new URL(entry.headers().location).searchParams.get('state')!
  const handoff=await request.post('/auth/street-banker',{maxRedirects:0,headers:{cookie:`song_lab_signin_state=${state}`},
    form:{token:token(state)}})
  expect(handoff.status()).toBe(303)
  await context.addCookies((await request.storageState()).cookies)
  const link={id:'sjl_fixture',songLabProjectId:'song_fixture',studioProjectId:'studio_fixture',
    sourceKind:'song_lab',selectedSongVersionId:'v_song',selectedStudioVersionId:'v_studio',
    createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),unlinkedAt:null}
  await page.route('**/api/song-journey/links',route=>route.fulfill({json:{links:[{link,
    song:{id:'song_fixture',title:'Fixture Song',artistName:'Fixture Artist',status:'analyzed'},
    studio:{id:'studio_fixture',title:'Fixture Studio',artistName:'Fixture Artist',stage:'mix'},
    songVersions:[{id:'v_song',label:'Original',createdAt:new Date().toISOString()}],
    studioVersions:[{id:'v_studio',label:'Mix 1',createdAt:new Date().toISOString()}]}]}}))
  await page.setViewportSize({width:375,height:812})
  await page.goto(`${baseURL}/#/song-journey/sjl_fixture?step=3`)
  const panel=page.locator('.sl-translation-notes')
  await expect(panel.getByRole('heading',{name:'Your own listening notes'})).toBeVisible()
  expect(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true)
  const smallTargets=await panel.locator('button,select,input,textarea').evaluateAll(elements=>elements.filter(el=>{
    const r=el.getBoundingClientRect()
    return r.width>0&&r.height>0&&(r.height<44 || (el.tagName==='BUTTON'&&r.width<44))
  }).map(el=>el.tagName))
  expect(smallTargets).toEqual([])
})
