import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { LESSONS, ENTRY_LINKS, DEEP_LINKS, PREVIEW_FILM, PREVIEW_SHOT } from '../apps/web/src/learning/motion-lessons.js'
import { PREVIEW_ROUTES, previewReply } from '../apps/web/src/learning/preview-transport.js'

describe('MOTION guided workflows — scope and factual copy', () => {
  it('opens three different hash routes, lessons and actual React workspaces', () => {
    const hrefs = Object.values(PREVIEW_ROUTES)
    expect(new Set(hrefs).size).toBe(3)
    expect(hrefs).toEqual(ENTRY_LINKS.map(x=>x.path))
    expect(hrefs[0]).toContain('/?walkthrough=start')
    expect(hrefs[1]).toContain('/shot/'+PREVIEW_SHOT+'?walkthrough=shots')
    expect(hrefs[2]).toContain('/shot/'+PREVIEW_SHOT+'/review?walkthrough=finish')
    expect(LESSONS.dashboard.title).toBe('Start a Film')
    expect(LESSONS.shot.title).toBe('Direct a Shot')
    expect(LESSONS.review.title).toBe('Review & Deliver')
    for (const lesson of Object.values(LESSONS)) {
      expect(lesson.steps.length).toBeGreaterThan(1)
      for (const s of lesson.steps){
        expect(s.title.length).toBeGreaterThan(8)
        expect(s.happening.length).toBeGreaterThan(20)
        expect(s.use.length).toBeGreaterThan(20)
        expect(s.watch.length).toBeGreaterThan(20)
      }
    }
    expect(DEEP_LINKS.map(x=>x.path)).toContain('/costs/'+PREVIEW_FILM+'?walkthrough=1')
  })

  it('serves only synthetic fixture GETs with zero live provider spend', () => {
    const me=previewReply('/api/auth/me')
    expect(me.status).toBe(200)
    expect(JSON.stringify(me.body)).toContain('preview.example.invalid')
    const health=previewReply('/api/health')
    expect(health.status).toBe(200)
    expect(JSON.stringify(health.body)).toContain('"mode":"sandbox"')
    const details=previewReply('/api/projects/'+PREVIEW_FILM)
    expect(details.status).toBe(200)
    expect(JSON.stringify(details.body)).toContain('FICTIONAL')
    const shot=previewReply('/api/shots/'+PREVIEW_SHOT)
    expect(shot.status).toBe(200)
    expect(JSON.stringify(shot.body)).toContain('lighting')
    const review=previewReply('/api/shots/'+PREVIEW_SHOT+'/outputs')
    expect(review.status).toBe(200)
    expect(JSON.stringify(review.body)).toContain('"source":null')
    const providers=previewReply('/api/providers')
    expect(JSON.stringify(providers.body)).toContain('"liveSpendCapUsd":0')
    const costs=previewReply('/api/projects/'+PREVIEW_FILM+'/costs')
    expect(JSON.stringify(costs.body)).toContain('"rawSpend":"$0.00 (fictional)"')
  })

  it('fails closed on every write, auth mutation, asset upload, render, review and spend', () => {
    const routes=[
      '/api/auth/logout','/api/auth/signup','/api/projects',
      '/api/projects/'+PREVIEW_FILM+'/assets',
      '/api/shots/'+PREVIEW_SHOT+'/matrix',
      '/api/shots/'+PREVIEW_SHOT+'/render',
      '/api/shots/'+PREVIEW_SHOT+'/versions',
      '/api/outputs/fixture-take-a/review',
      '/api/outputs/fixture-take-a/promote',
      '/api/projects/'+PREVIEW_FILM+'/budget'
    ]
    for(const path of routes) for(const method of ['POST','PATCH','DELETE','PUT']){
      const result=previewReply(path,method)
      expect(result.status,method+' '+path).toBe(405)
      expect(JSON.stringify(result.body)).toContain('PREVIEW_READ_ONLY')
    }
    expect(previewReply('/api/projects/real-customer-123').status).toBe(404)
    expect(previewReply('/api/keys')).toEqual(expect.objectContaining({status:404}))
  })

  it('keeps tour UI strictly educational, retaining existing product screens untouched', () => {
    const guide=readFileSync('apps/web/src/learning/MotionGuide.tsx','utf8')
    const lessons=readFileSync('apps/web/src/learning/motion-lessons.ts','utf8')
    for(const action of ['api.render(', 'api.review(', 'api.promote(','.click(','.submit(','.dispatchEvent(']){
      expect(guide).not.toContain(action)
    }
    expect(lessons).toContain('Only a person approves')
    expect(lessons).toContain('provider')
    const source=readFileSync('apps/web/src/main.tsx','utf8')
    expect(source).toContain('<App />')
    expect(source).toContain('<MotionGuide />')
    const preview=readFileSync('apps/web/src/learning/preview-main.tsx','utf8')
    expect(preview).toContain('installMotionPreviewTransport()')
    expect(preview).toContain('<App />')
    expect(preview).toContain('<MotionGuide preview />')
  })
})
