import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
const css=readFileSync('apps/web/src/styles.css','utf8')
describe('MOTION mobile home card icon spacing',()=>{
  it('puts icon and headings in independent grid cells on mobile',()=>{
    expect(css).toMatch(/\.mo-mode\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*30px minmax\(0,\s*1fr\)/s)
    expect(css).toMatch(/\.mo-mode svg\s*\{[^}]*position:\s*static;[^}]*grid-column:\s*1;/s)
    expect(css).toMatch(/\.mo-mode strong\s*\{[^}]*grid-column:\s*2;/s)
    expect(css).toMatch(/\.mo-mode small\s*\{[^}]*grid-column:\s*2;/s)
  })
})
