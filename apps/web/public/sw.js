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
  // The document itself is worth having before anything goes wrong.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add('/')).catch(() => undefined))
  self.skipWaiting()
})

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
