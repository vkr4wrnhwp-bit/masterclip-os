import React from 'react'
import { api } from '../api.js'
import { AsyncBlock, Badge, Callout, Card, Empty, statusTone, useAsync } from '../ui.jsx'
import { capFigure, readCap } from './overview-model.js'

/**
 * What the mode banner says once live mode is on.
 *
 * The cap states come from `readCap`, shared with the Overview's rail and the
 * cost lab. The words are this screen's: it is the page about what is connected
 * and what it may do, so each state ends on what the controller will actually
 * refuse. Nothing here changes that refusal.
 */
function liveModeLine(spent: string, reading: ReturnType<typeof readCap>): string {
  const refuses = 'The cost controller refuses any submission that would carry live spend past it.'
  switch (reading.state) {
    case 'configured':
      return `Real provider calls are permitted. ${spent} of the $${reading.capUsd.toFixed(2)} configured for this deployment has been spent. ${refuses}`
    case 'forbidden':
      return `Live mode is on, but the cap is configured at ${capFigure(reading.capUsd)}, which authorizes nothing. Every real provider call is refused until it is raised.`
    case 'unread':
      return `Real provider calls are permitted. The cap could not be read here, so this page is not saying what it is or whether one was set. ${refuses}`
    case 'unconfigured':
      return reading.fallbackUsd === null
        ? `Real provider calls are permitted, and no cap was configured for this deployment, so they run against the built-in safety limit. ${spent} has been spent. ${refuses} Set LIVE_SPEND_CAP_USD to choose your own figure.`
        : `Real provider calls are permitted, and no cap was configured for this deployment, so they run against the built-in $${reading.fallbackUsd.toFixed(2)} safety limit, of which ${spent} has been spent. ${refuses} Set LIVE_SPEND_CAP_USD to choose your own figure.`
  }
}

export function ProvidersView() {
  const providers = useAsync(() => api.providers(), [])
  const [refreshing, setRefreshing] = React.useState(false)
  const models = useAsync(() => api.models(), [])
  const profiles = useAsync(() => api.routingProfiles(), [])
  const [filter, setFilter] = React.useState('')

  const refresh = async () => {
    setRefreshing(true)
    try {
      await api.models(true)
      models.reload()
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <>
      <div className="topbar">
        <h2>Providers &amp; models</h2>
        <button className="small" onClick={() => void refresh()} disabled={refreshing}>
          {refreshing ? 'refreshing…' : 'Refresh catalog'}
        </button>
      </div>

      <AsyncBlock state={providers}>
        {(data) => (
          <>
            <Callout tone={data.mode === 'live' ? 'danger' : 'ok'} title={`Mode: ${data.mode}`}>
              {data.mode === 'live'
                ? // Same four states as the cost lab and the rail, from the same
                  // reader. This line used to print the figure flat, so a
                  // deployment that had configured nothing was told two dollars
                  // had been authorized for it.
                  liveModeLine(data.liveSpentUsd, readCap({ capUsd: data.liveSpendCapUsd, capConfigured: data.liveSpendCapConfigured }))
                : 'Sandbox mode. Adapters use provider sandbox modes where they exist, and the local ffmpeg mock otherwise. Nothing is billable. The live-spend cap is not consulted here.'}
            </Callout>

            <Card title="Connected providers">
              <table>
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Key</th>
                    <th>Status</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {data.providers.map((provider) => {
                    const health = provider.health as { status?: string; message?: string; checked_at?: string } | null
                    return (
                      <tr key={provider.providerId}>
                        <td>
                          <strong>{provider.displayName}</strong>
                          <div className="faint mono" style={{ fontSize: 11 }}>
                            {provider.providerId}
                          </div>
                        </td>
                        <td className="mono faint">{provider.configured ? provider.keyFingerprint : '—'}</td>
                        <td>
                          <Badge tone={statusTone(health?.status ?? (provider.configured ? 'unknown' : 'unconfigured'))}>
                            {health?.status ?? (provider.configured ? 'unchecked' : 'unconfigured')}
                          </Badge>
                        </td>
                        <td className="faint" style={{ fontSize: 12 }}>
                          {health?.message ?? 'set the API key in .env and restart to enable'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </Card>
          </>
        )}
      </AsyncBlock>

      <Card
        title="Model catalog"
        action={
          <input
            style={{ width: 220 }}
            placeholder="filter models…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        }
      >
        <AsyncBlock state={models}>
          {(data) => {
            const rows = data.models.filter(
              (model) =>
                filter.length === 0 ||
                `${model.providerId} ${model.modelId} ${model.displayName} ${model.tier}`.toLowerCase().includes(filter.toLowerCase()),
            )
            return rows.length === 0 ? (
              <Empty>No models match.</Empty>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Tier</th>
                    <th>Modes</th>
                    <th>Controls</th>
                    <th>Price</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((model) => (
                    <tr key={`${model.providerId}/${model.modelId}`}>
                      <td>
                        <div className="mono" style={{ fontSize: 12 }}>
                          {model.providerId}/{model.modelId}
                        </div>
                        <div className="faint" style={{ fontSize: 11 }}>
                          {model.displayName}
                        </div>
                      </td>
                      <td>
                        <Badge tone={model.tier === 'premium' ? 'accent' : model.tier === 'draft' ? 'info' : undefined}>{model.tier}</Badge>
                      </td>
                      <td className="faint" style={{ fontSize: 11 }}>
                        {model.modes.join(', ')}
                      </td>
                      <td style={{ fontSize: 11 }}>
                        {[
                          model.firstFrame && 'first frame',
                          model.lastFrame && 'last frame',
                          model.videoReference && 'video ref',
                          model.extension && 'extend',
                          model.nativeAudio && 'audio',
                        ]
                          .filter(Boolean)
                          .join(' · ') || <span className="faint">prompt only</span>}
                      </td>
                      <td style={{ fontSize: 11 }}>
                        {model.pricing ? (
                          model.pricing.dynamic || model.pricing.basis === 'unknown' ? (
                            <Badge tone="warn">live quote</Badge>
                          ) : (
                            <>
                              <div className="mono">
                                ${(model.pricing.rateMicros / 1_000_000).toFixed(4)}/{model.pricing.basis.replace('per_', '')}
                              </div>
                              <div className="faint" style={{ fontSize: 10 }}>
                                {model.pricing.retrievedAt}
                              </div>
                            </>
                          )
                        ) : (
                          <span className="faint">unpriced</span>
                        )}
                        {model.pricing?.notes && (
                          <details style={{ marginTop: 4, padding: '4px 6px' }}>
                            <summary style={{ fontSize: 10 }}>pricing note</summary>
                            <div className="faint" style={{ fontSize: 10 }}>
                              {model.pricing.notes}
                            </div>
                          </details>
                        )}
                      </td>
                      <td>
                        <Badge tone={model.source === 'catalog' ? 'ok' : undefined}>{model.source}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          }}
        </AsyncBlock>
      </Card>

      <Card title="Routing profiles">
        <AsyncBlock state={profiles}>
          {(data) => (
            <table>
              <thead>
                <tr>
                  <th>Profile</th>
                  <th>Purpose</th>
                  <th>Tiers</th>
                  <th>Ceiling</th>
                  <th>Approval</th>
                </tr>
              </thead>
              <tbody>
                {data.profiles.map((profile) => (
                  <tr key={String(profile.profile)}>
                    <td>
                      <Badge tone={profile.profile === 'HERO' ? 'accent' : undefined}>{String(profile.profile)}</Badge>
                    </td>
                    <td className="faint" style={{ fontSize: 12, maxWidth: 380 }}>
                      {String(profile.purpose)}
                    </td>
                    <td className="faint" style={{ fontSize: 11 }}>
                      {(profile.allowedTiers as string[]).join(', ')}
                    </td>
                    <td className="num">
                      {profile.maxCostPerSecondMicros === null ? 'none' : `$${(Number(profile.maxCostPerSecondMicros) / 1_000_000).toFixed(3)}/s`}
                    </td>
                    <td>{profile.requireHumanApproval ? <Badge tone="warn">human</Badge> : <span className="faint">automatic</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </AsyncBlock>
      </Card>
    </>
  )
}
