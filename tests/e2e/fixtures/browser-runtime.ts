/**
 * Exposes the real Live Lab browser implementations to Playwright.
 *
 * Nothing in the shipped bundle puts these on `window`, and nothing should —
 * so rather than adding a test hook to production code, the browser suite
 * bundles this fixture separately with esbuild and injects it into the page.
 * The classes below are the ones that actually ship; none of this is a stub.
 */
import { encodeWavPcm16, synthesize } from '@masterclip/ai-audio'
import { CLICK_PROCESSOR_SOURCE, WebAudioBackend, createClickNode } from '@masterclip/live-engine'
import {
  IndexedDbCacheStore,
  estimateAvailableStorageBytes,
  headerDecodeCheck,
  requestPersistentStorage,
  sha256HexOf,
} from '@masterclip/performance-cache'

const api = {
  IndexedDbCacheStore,
  estimateAvailableStorageBytes,
  requestPersistentStorage,
  sha256HexOf,
  headerDecodeCheck,
  WebAudioBackend,
  createClickNode,
  CLICK_PROCESSOR_SOURCE,
  encodeWavPcm16,
  synthesize,
}

declare global {
  interface Window {
    __liveLab: typeof api
  }
}

window.__liveLab = api
