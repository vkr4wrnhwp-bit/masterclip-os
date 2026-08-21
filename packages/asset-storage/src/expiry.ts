/**
 * Shared expiry policy for signed asset links.
 *
 * A signed URL that embeds `now + ttl` is a different string on every request,
 * which quietly defeats HTTP caching: the review grid re-signs every clip on
 * each reload, React sees a new `src` on all six `<video>` elements, and the
 * browser re-downloads the lot — the `cache-control: max-age` on the asset
 * route never gets a chance to apply. In a tool whose whole loop is "approve
 * this, reject that", that is the loop paying for it.
 *
 * Anchoring the signature to a window boundary makes the URL byte-identical for
 * every request inside that window, so the second load is a cache hit. Validity
 * is still bounded: the link is signed as if issued at the start of the window,
 * so remaining life ranges from `ttl - quantum` up to `ttl`, and never exceeds
 * the caller's requested ttl.
 *
 * The quantum is half the ttl, which is the largest window that still
 * guarantees at least half the requested lifetime remains for a request
 * arriving at the very end of it.
 */
export interface StableExpiry {
  /** Epoch **seconds** of the window start — the moment the link is signed as of. */
  issuedAtEpochSeconds: number
  /** Epoch **seconds** at which the link stops working. */
  expiresAtEpochSeconds: number
}

export function stableExpiry(nowMs: number, ttlSeconds: number): StableExpiry {
  const ttl = Math.max(1, Math.floor(ttlSeconds))
  const quantum = Math.max(1, Math.floor(ttl / 2))
  const issuedAtEpochSeconds = Math.floor(Math.floor(nowMs / 1000) / quantum) * quantum
  return { issuedAtEpochSeconds, expiresAtEpochSeconds: issuedAtEpochSeconds + ttl }
}
