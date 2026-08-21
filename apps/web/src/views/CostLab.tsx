import React from 'react'
import { api } from '../api.js'
import { AsyncBlock, Callout, Card, Empty, Field, Stat, useAsync } from '../ui.jsx'

export function CostLab({ projectId }: { projectId: string }) {
  const costs = useAsync(() => api.costs(projectId), [projectId])
  const performance = useAsync(() => api.modelPerformance(projectId), [projectId])

  return (
    <>
      <div className="topbar">
        <h2>Cost lab</h2>
        <div className="meta">optimising for cost per approved second, not per render</div>
      </div>

      <AsyncBlock state={costs}>
        {(data) => {
          const metrics = data.metrics as Record<string, unknown>
          const formatted = (metrics.formatted ?? {}) as Record<string, string | null>
          const liveCap = data.liveCap as { capUsd: number; spent: string }
          const avoided = data.qcAvoided as { autoRejected: number; usd: string }

          return (
            <>
              <div className="grid cols-4" style={{ marginBottom: 16 }}>
                <Card>
                  <Stat value={formatted.costPerApprovedSecond} label="cost per APPROVED second" />
                </Card>
                <Card>
                  <Stat value={formatted.costPerApprovedClip} label="cost per approved clip" />
                </Card>
                <Card>
                  <Stat value={formatted.costPerSubmittedSecond} label="cost per submitted second" />
                </Card>
                <Card>
                  <Stat value={formatted.rawSpend ?? null} label="total spend (incl. sandbox)" />
                </Card>
              </div>

              <div className="grid cols-4" style={{ marginBottom: 16 }}>
                <Card>
                  <Stat value={Number(metrics.submittedCount ?? 0)} label="candidates rendered" />
                </Card>
                <Card>
                  <Stat value={Number(metrics.technicallyValidCount ?? 0)} label="technically valid" />
                </Card>
                <Card>
                  <Stat value={Number(metrics.approvedCount ?? 0)} label="creatively approved" tone="ok" />
                </Card>
                <Card>
                  <Stat value={`${avoided.autoRejected} · ${avoided.usd}`} label="auto-rejected / spend avoided" />
                </Card>
              </div>

              <Callout tone={Number(liveCap.spent.replace(/[^0-9.]/g, '')) >= liveCap.capUsd ? 'danger' : 'info'} title="Live-spend authorization">
                {liveCap.spent} of ${liveCap.capUsd.toFixed(2)} authorized has been spent on real provider calls. Sandbox spend is tracked separately and
                never counts against this cap.
              </Callout>

              <div className="grid cols-2">
                <Card title="Spend by model">
                  {(data.byProvider as Array<Record<string, unknown>>).length === 0 ? (
                    <Empty>No charges recorded yet.</Empty>
                  ) : (
                    <table>
                      <thead>
                        <tr>
                          <th>Provider / model</th>
                          <th className="num">Charges</th>
                          <th className="num">Spend</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(data.byProvider as Array<Record<string, unknown>>).map((row, index) => (
                          <tr key={index}>
                            <td className="mono">
                              {String(row.providerId)}/{String(row.modelId)}
                            </td>
                            <td className="num">{String(row.entries)}</td>
                            <td className="num">{String(row.usd)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </Card>

                <Card title="Why candidates were rejected">
                  {(data.rejections as Array<Record<string, unknown>>).length === 0 ? (
                    <Empty>No rejections recorded yet.</Empty>
                  ) : (
                    <table>
                      <thead>
                        <tr>
                          <th>Reason</th>
                          <th>Model</th>
                          <th className="num">Count</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(data.rejections as Array<Record<string, unknown>>).map((row, index) => (
                          <tr key={index}>
                            <td>{String(row.reason).replace(/_/g, ' ')}</td>
                            <td className="mono faint">{String(row.modelId)}</td>
                            <td className="num">{String(row.count)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </Card>
              </div>
            </>
          )
        }}
      </AsyncBlock>

      <Card title="Model acceptance history">
        <AsyncBlock state={performance}>
          {(data) =>
            data.performance.length === 0 ? (
              <Empty>No acceptance data yet — the router is running on conservative priors until candidates are reviewed.</Empty>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Category</th>
                    <th className="num">Submitted</th>
                    <th className="num">Valid</th>
                    <th className="num">Approved</th>
                    <th className="num">Approval rate</th>
                  </tr>
                </thead>
                <tbody>
                  {data.performance.map((row, index) => {
                    const submitted = Number(row.submitted ?? 0)
                    const approved = Number(row.approved ?? 0)
                    return (
                      <tr key={index}>
                        <td className="mono">
                          {String(row.providerId)}/{String(row.modelId)}
                        </td>
                        <td className="faint">{String(row.shotCategory)}</td>
                        <td className="num">{submitted}</td>
                        <td className="num">{String(row.technicallyValid)}</td>
                        <td className="num">{approved}</td>
                        <td className="num">{submitted > 0 ? `${((approved / submitted) * 100).toFixed(0)}%` : '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )
          }
        </AsyncBlock>
      </Card>

      <StrategySimulator />
    </>
  )
}

/**
 * Draft-then-final simulator.
 *
 * The answer depends entirely on the two acceptance rates, so both are inputs
 * rather than assumptions baked into the model.
 */
function StrategySimulator() {
  const [masters, setMasters] = React.useState(500)
  const [drafts, setDrafts] = React.useState(6)
  const [draftCost, setDraftCost] = React.useState(0.1)
  const [finalCost, setFinalCost] = React.useState(0.8)
  const [guided, setGuided] = React.useState(0.55)
  const [blind, setBlind] = React.useState(0.25)
  const [result, setResult] = React.useState<Awaited<ReturnType<typeof api.strategy>> | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const run = async () => {
    setError(null)
    try {
      setResult(
        await api.strategy({
          masters,
          draftsPerMaster: drafts,
          draftCostPerClipUsd: draftCost,
          finalCostPerClipUsd: finalCost,
          guidedApprovalRate: guided,
          blindApprovalRate: blind,
        }),
      )
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <Card title="Draft-first vs premium-only">
      <div className="field-row">
        <Field label="Approved masters needed">
          <input type="number" value={masters} onChange={(e) => setMasters(Number(e.target.value))} />
        </Field>
        <Field label="Drafts per master">
          <input type="number" value={drafts} onChange={(e) => setDrafts(Number(e.target.value))} />
        </Field>
        <Field label="Draft cost / clip ($)">
          <input type="number" step="0.01" value={draftCost} onChange={(e) => setDraftCost(Number(e.target.value))} />
        </Field>
        <Field label="Final cost / clip ($)">
          <input type="number" step="0.01" value={finalCost} onChange={(e) => setFinalCost(Number(e.target.value))} />
        </Field>
      </div>
      <div className="field-row">
        <Field label="Approval rate — draft-directed final">
          <input type="number" step="0.05" min="0.01" max="1" value={guided} onChange={(e) => setGuided(Number(e.target.value))} />
        </Field>
        <Field label="Approval rate — straight to final">
          <input type="number" step="0.05" min="0.01" max="1" value={blind} onChange={(e) => setBlind(Number(e.target.value))} />
        </Field>
      </div>
      <button className="primary" onClick={() => void run()}>
        Compare
      </button>
      {error && <Callout tone="danger">{error}</Callout>}
      {result && (
        <div style={{ marginTop: 14 }}>
          <div className="grid cols-3">
            <Card>
              <Stat value={result.draftFirstUsd} label="draft-first total" />
            </Card>
            <Card>
              <Stat value={result.premiumOnlyUsd} label="premium-only total" />
            </Card>
            <Card>
              <Stat
                value={`${result.savingsUsd}${result.savingsPercent === null ? '' : ` (${result.savingsPercent.toFixed(0)}%)`}`}
                label="saving"
                tone={result.savingsMicros > 0 ? 'ok' : 'danger'}
              />
            </Card>
          </div>
          <Callout tone="warn" title="Assumptions, not measurements">
            <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
              {result.assumptions.map((assumption, index) => (
                <li key={index}>{assumption}</li>
              ))}
            </ul>
          </Callout>
        </div>
      )}
    </Card>
  )
}
