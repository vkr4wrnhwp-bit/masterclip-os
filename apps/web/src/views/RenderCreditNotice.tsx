import React from 'react'
import type { QueueJobView } from '../api.js'

export function QueueCreditNotice({ jobs }: { jobs: Pick<QueueJobView, 'status' | 'error' | 'createdAt'>[] }) {
  // Older saved refusals have no refusal time; their creation time is the fallback.
  const newest = jobs.filter(job => job.status === 'blocked' && job.error?.code === 'credits.short')
    .sort((a, b) => Date.parse(String(b.error?.refusedAt || b.createdAt)) - Date.parse(String(a.error?.refusedAt || a.createdAt)))[0]
  return <RenderCreditNotice error={newest?.error ?? null} />
}

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
