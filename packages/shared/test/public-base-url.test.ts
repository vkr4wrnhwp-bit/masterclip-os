import { describe, expect, it } from 'vitest'
import { loadConfig, resetConfigCache } from '../src/index.js'

/**
 * Provider callback URLs are only built when the deployment knows its own
 * externally reachable origin. `render.yaml` cannot hardcode that origin —
 * the service does not exist when the blueprint is written, so its URL is not
 * knowable yet — and nothing else supplied it, so a fresh Render deploy came
 * up with `PUBLIC_BASE_URL` empty and every provider webhook silently dead.
 *
 * The host does know. Render publishes `RENDER_EXTERNAL_URL` at runtime, so
 * the resolved value falls back to it and webhooks work with no configuration.
 */
function load(env: Record<string, string>) {
  resetConfigCache()
  return loadConfig(env as NodeJS.ProcessEnv, true)
}

describe('resolved public base URL', () => {
  it('uses the explicit setting when one is given', () => {
    expect(load({ PUBLIC_BASE_URL: 'https://masterclip.example' }).publicBaseUrl).toBe('https://masterclip.example')
  })

  it('falls back to the origin the host reports for itself', () => {
    expect(load({ RENDER_EXTERNAL_URL: 'https://masterclip.onrender.com' }).publicBaseUrl).toBe(
      'https://masterclip.onrender.com',
    )
  })

  // A deployment that has been given a real origin must keep it: the host's
  // own URL is the fallback, never an override. A custom domain in front of
  // Render is exactly this case.
  it('prefers the explicit setting over the host’s', () => {
    const config = load({
      PUBLIC_BASE_URL: 'https://masterclip.example',
      RENDER_EXTERNAL_URL: 'https://masterclip.onrender.com',
    })
    expect(config.publicBaseUrl).toBe('https://masterclip.example')
  })

  // Callers join paths onto this, so a trailing slash would produce
  // `https://host//api/webhooks/...`.
  it('strips trailing slashes so joined paths do not double the separator', () => {
    expect(load({ PUBLIC_BASE_URL: 'https://masterclip.example/' }).publicBaseUrl).toBe('https://masterclip.example')
    expect(load({ RENDER_EXTERNAL_URL: 'https://masterclip.onrender.com///' }).publicBaseUrl).toBe(
      'https://masterclip.onrender.com',
    )
  })

  // Reporting a reachable origin that does not exist would be worse than
  // reporting none: callbacks would be signed for an address nothing answers.
  it('reports an honest blank when neither is set', () => {
    expect(load({}).publicBaseUrl).toBe('')
  })

  it('leaves the raw variable untouched for anything that reads it directly', () => {
    const config = load({ RENDER_EXTERNAL_URL: 'https://masterclip.onrender.com' })
    expect(config.PUBLIC_BASE_URL).toBe('')
    expect(config.publicBaseUrl).toBe('https://masterclip.onrender.com')
  })
})
