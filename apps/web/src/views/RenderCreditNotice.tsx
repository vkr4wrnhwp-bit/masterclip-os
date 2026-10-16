import React from 'react'

export function RenderCreditNotice({ error }: { error: Record<string, unknown> | null }) {
  if (!error || error.code !== 'credits.short' || typeof error.buyUrl !== 'string') return null
  let url: URL
  try { url = new URL(error.buyUrl) } catch { return null }
  if (url.protocol !== 'https:' || url.username || url.password) return null
  return <div className="render-credit-notice" role="alert">
    <p>{String(error.message)}</p>
    <a className="render-buy-credits" href={url.href} target="_blank" rel="noopener noreferrer">Buy credits</a>
  </div>
}
