/*
 * App-shell cache, so a show survives a reload with no network.
 *
 * Live Lab's whole promise is that the performance is local-first: audio is
 * cached in IndexedDB, the show bundle in localStorage. None of that is
 * reachable if the browser cannot load the application itself — and a crash
 * mid-show at a venue with no connection is exactly when it must. Without this,
 * a reload offline is ERR_INTERNET_DISCONNECTED and the RESTORE PERFORMANCE
 * offer can never be seen.
 *
 * Two rules, and the second one matters as much as the first:
 *
 *   1. The app shell and its assets are cached as they are used, and served
 *      from cache when the network is gone.
 *   2. /api/ is NEVER cached or served from cache. The application already
 *      distinguishes "online" from "offline" and has its own fallbacks; a
 *      service worker answering an API call from a stale cache would make a
 *      performer trust data that is no longer true, and would defeat
 *      loadShowBundle's deliberate network-first ordering.
 */
const CACHE = 'masterclip-shell-v1'

self.addEventListener('install', (event) => {
  event.waitUntil(precacheShell())
  self.skipWaiting()
})

/**
 * Cache the document *and the assets it names*, at install.
 *
 * Runtime caching alone is not enough, and the gap is not theoretical: on a
 * first visit the page's own scripts are fetched before this worker controls
 * anything, so they never pass through the fetch handler and never reach the
 * cache. Load the app, build a show, go offline without ever reloading — the
 * exact thing a performer does — and the reload at the venue would find no
 * application to load.
 *
 * The asset names are hashed at build time, so they are read out of the served
 * document rather than baked into this file.
 */
async function precacheShell() {
  try {
    const cache = await caches.open(CACHE)
    const response = await fetch('/', { cache: 'reload' })
    if (!response.ok) return
    const html = await response.clone().text()
    await cache.put('/', response)

    const urls = assetsNamedBy(html)
    await Promise.all([...urls].map((url) => cache.add(url).catch(() => undefined)))
  } catch {
    // Installed with no network: nothing to precache now, and the fetch
    // handler still fills the cache on the next successful load.
  }
}

/** Same-origin, non-API URLs the document names — the fetch handler's boundary. */
function assetsNamedBy(html) {
  const urls = new Set()
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const url = match[1]
    if (url.startsWith('/') && !url.startsWith('/api/')) urls.add(url)
  }
  return urls
}

/**
 * Drop assets the current document no longer names.
 *
 * Filenames are content-hashed, so every deploy adds a new set and the old one
 * would otherwise stay cached forever. That matters more here than in most
 * apps: this origin's storage budget is shared with the performance package,
 * and the app refuses to mark a show READY when storage is short. A shell cache
 * quietly growing by a version each deploy would eat the headroom a performer
 * needs for their audio.
 *
 * Only ever called with a document fetched from the network, so an offline
 * session never prunes against a stale page.
 */
async function pruneToDocument(cache, html) {
  const keep = assetsNamedBy(html)
  const requests = await cache.keys()
  await Promise.all(
    requests.map(async (request) => {
      const path = new URL(request.url).pathname + new URL(request.url).search
      if (path === '/' || keep.has(path)) return
      await cache.delete(request).catch(() => undefined)
    }),
  )
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

function isShellRequest(request) {
  if (request.method !== 'GET') return false
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return false
  // API responses are the application's business, not the cache's.
  if (url.pathname.startsWith('/api/')) return false
  return true
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (!isShellRequest(request)) return

  // Navigations go network-first so a deployed update is picked up as soon as
  // there is a network to pick it up from; the cache is the floor, not the
  // default. Hashed assets are immutable, so cache-first is both correct and
  // faster.
  const navigation = request.mode === 'navigate'

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE)

      if (!navigation) {
        const hit = await cache.match(request)
        if (hit) return hit
      }

      try {
        const response = await fetch(request)
        // Opaque and error responses are not worth keeping.
        if (response && response.ok && response.type === 'basic') {
          cache.put(request, response.clone()).catch(() => undefined)
          if (navigation) {
            // A fresh document is the only reliable signal that a deploy
            // landed, and the only trustworthy list of what is still in use.
            // Cache the assets it names and drop the ones it does not.
            const html = await response.clone().text()
            const assets = assetsNamedBy(html)
            await Promise.all([...assets].map((url) => cache.add(url).catch(() => undefined)))
            await pruneToDocument(cache, html)
          }
        }
        return response
      } catch (err) {
        const fallback = (await cache.match(request)) ?? (navigation ? await cache.match('/') : undefined)
        if (fallback) return fallback
        throw err
      }
    })(),
  )
})
