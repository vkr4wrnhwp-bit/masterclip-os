import React from 'react'
import { audioApi, type AdminOrg } from '../audio-api.js'
import { AsyncBlock, Badge, Callout, Card, Empty, Field, useAsync } from '../ui.jsx'

/**
 * Partner OS administration — flagship only.
 *
 * Grants and revokes audio capabilities per organization, switches granted
 * ones on and off, and sets spend budgets. Provider credentials are never
 * shown here; they live in environment configuration.
 */

function riskTone(tier: string): 'danger' | 'warn' | undefined {
  if (tier === 'high') return 'danger'
  if (tier === 'elevated') return 'warn'
  return undefined
}

export function AudioAdminView() {
  const orgs = useAsync(() => audioApi.adminOrgs(), [])
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [message, setMessage] = React.useState<string | null>(null)
  const [monthlyCap, setMonthlyCap] = React.useState('')
  const [perJobCap, setPerJobCap] = React.useState('')
  const [hardStop, setHardStop] = React.useState(true)

  const act = async (fn: () => Promise<unknown>, note: string) => {
    setError(null)
    setMessage(null)
    try {
      await fn()
      setMessage(note)
      orgs.reload()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <>
      <div className="topbar">
        <h2>Partner OS — audio entitlements</h2>
        <div className="meta">flagship administration · credentials are never shown here</div>
      </div>

      {message && <Callout tone="ok">{message}</Callout>}
      {error && <Callout tone="danger">{error}</Callout>}

      <AsyncBlock state={orgs}>
        {(data) => {
          const selected: AdminOrg | undefined = data.orgs.find((org) => org.id === selectedId) ?? data.orgs[0]
          const granted = new Set(selected?.entitlements.map((entitlement) => entitlement.capability) ?? [])
          const enabled = new Map(selected?.entitlements.map((e) => [e.capability, e.enabled]) ?? [])

          return (
            <div className="grid cols-2">
              <Card title="Organizations">
                <table>
                  <thead>
                    <tr>
                      <th>Organization</th>
                      <th>Capabilities</th>
                      <th>Spend (month)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.orgs.map((org) => (
                      <tr
                        key={org.id}
                        style={{ cursor: 'pointer', background: org.id === selected?.id ? 'var(--bg-panel)' : undefined }}
                        onClick={() => setSelectedId(org.id)}
                      >
                        <td>
                          {org.name} {org.isFlagship && <Badge tone="accent">flagship</Badge>}
                        </td>
                        <td className="muted">
                          {org.isFlagship ? 'all (implicit)' : `${org.entitlements.length} granted`}
                        </td>
                        <td className="mono">${org.monthSpendUsd.toFixed(4)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>

              {selected && (
                <div>
                  <Card title={`Budgets — ${selected.name}`}>
                    {selected.budgets.length === 0 ? (
                      <Empty>No budget set — spend is bounded only by the deployment's own caps.</Empty>
                    ) : (
                      <table style={{ marginBottom: 10 }}>
                        <tbody>
                          {selected.budgets.map((budget, index) => (
                            <tr key={index}>
                              <td>
                                {budget.scope}: <span className="faint">{budget.scopeId}</span>
                              </td>
                              <td className="mono">
                                {budget.monthlyCapUsd === null ? 'no monthly cap' : `$${budget.monthlyCapUsd.toFixed(2)}/mo`}
                              </td>
                              <td>{budget.hardStop ? <Badge tone="danger">hard stop</Badge> : <Badge tone="warn">warn only</Badge>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                      <Field label="Monthly cap (USD)">
                        <input value={monthlyCap} onChange={(e) => setMonthlyCap(e.target.value)} placeholder="e.g. 250" style={{ width: 110 }} />
                      </Field>
                      <Field label="Per-job cap (USD)">
                        <input value={perJobCap} onChange={(e) => setPerJobCap(e.target.value)} placeholder="optional" style={{ width: 110 }} />
                      </Field>
                      <label style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 12, marginBottom: 10 }}>
                        <input type="checkbox" checked={hardStop} onChange={(e) => setHardStop(e.target.checked)} />
                        hard stop
                      </label>
                      <button
                        className="small"
                        style={{ marginBottom: 10 }}
                        onClick={() =>
                          void act(
                            () =>
                              audioApi.adminSetBudget(selected.id, {
                                scope: 'org',
                                scopeId: selected.id,
                                monthlyCapUsd: monthlyCap.trim() === '' ? null : Number(monthlyCap),
                                perJobCapUsd: perJobCap.trim() === '' ? null : Number(perJobCap),
                                hardStop,
                              }),
                            'budget saved',
                          )
                        }
                      >
                        save budget
                      </button>
                    </div>
                  </Card>

                  <Card title={`Capabilities — ${selected.name}`}>
                    {selected.isFlagship ? (
                      <Callout tone="info" title="Flagship organization">
                        Holds every audio capability implicitly, including provider administration. Organization feature toggles
                        and budgets still apply to it — root access is not immunity.
                      </Callout>
                    ) : (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                        {data.presets.map((preset) => (
                          <button
                            key={preset}
                            className="small"
                            onClick={() => void act(() => audioApi.adminSetEntitlements(selected.id, { preset }), `applied ${preset} preset`)}
                          >
                            apply {preset.replace(/_/g, ' ')}
                          </button>
                        ))}
                      </div>
                    )}

                    <div style={{ maxHeight: 420, overflowY: 'auto' }}>
                      <table>
                        <tbody>
                          {data.capabilities.map((capability) => {
                            const isGranted = granted.has(capability.key)
                            const isEnabled = enabled.get(capability.key) !== false
                            return (
                              <tr key={capability.key}>
                                <td>
                                  <div>{capability.label}</div>
                                  <div className="faint" style={{ fontSize: 11 }}>
                                    {capability.key}
                                  </div>
                                </td>
                                <td>
                                  <Badge tone={riskTone(capability.riskTier)}>{capability.riskTier}</Badge>
                                </td>
                                <td>
                                  {selected.isFlagship ? (
                                    <Badge tone="ok">implicit</Badge>
                                  ) : isGranted ? (
                                    <Badge tone={isEnabled ? 'ok' : undefined}>{isEnabled ? 'granted' : 'switched off'}</Badge>
                                  ) : (
                                    <span className="faint">not granted</span>
                                  )}
                                </td>
                                <td style={{ whiteSpace: 'nowrap' }}>
                                  {!selected.isFlagship &&
                                    (isGranted ? (
                                      <>
                                        <button
                                          className="small"
                                          onClick={() =>
                                            void act(
                                              () => audioApi.adminToggleEntitlement(selected.id, capability.key, !isEnabled),
                                              isEnabled ? 'switched off' : 'switched on',
                                            )
                                          }
                                        >
                                          {isEnabled ? 'switch off' : 'switch on'}
                                        </button>{' '}
                                        <button
                                          className="small"
                                          onClick={() =>
                                            void act(
                                              () => audioApi.adminSetEntitlements(selected.id, { revoke: [capability.key] }),
                                              'entitlement revoked',
                                            )
                                          }
                                        >
                                          revoke
                                        </button>
                                      </>
                                    ) : (
                                      <button
                                        className="small"
                                        onClick={() =>
                                          void act(
                                            () => audioApi.adminSetEntitlements(selected.id, { grant: [capability.key] }),
                                            'entitlement granted',
                                          )
                                        }
                                      >
                                        grant
                                      </button>
                                    ))}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                </div>
              )}
            </div>
          )
        }}
      </AsyncBlock>
    </>
  )
}
