import React from 'react'
import { audioApi, type Conversation } from '../audio-api.js'
import { AsyncBlock, Badge, Callout, Card, Empty, statusTone, useAsync } from '../ui.jsx'

export function AudioOperatorView() {
  const agents = useAsync(() => audioApi.agents(), [])
  const conversations = useAsync(() => audioApi.conversations(), [])
  const [chat, setChat] = React.useState<{ conversationId: string; lines: Array<{ role: string; text: string }>; ended: boolean } | null>(null)
  const [input, setInput] = React.useState('')
  const [selected, setSelected] = React.useState<Conversation | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const start = async (agentId: string) => {
    setError(null)
    try {
      const session = await audioApi.startSession(agentId)
      setChat({
        conversationId: session.conversationId,
        lines: [
          { role: 'disclosure', text: session.disclosure },
          { role: 'agent', text: session.greeting },
        ],
        ended: false,
      })
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const send = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!chat || !input.trim()) return
    const text = input.trim()
    setInput('')
    setChat({ ...chat, lines: [...chat.lines, { role: 'user', text }] })
    try {
      const result = await audioApi.sendTurn(chat.conversationId, text)
      setChat((current) =>
        current
          ? {
              ...current,
              lines: [...current.lines, { role: result.humanTransfer ? 'transfer' : 'agent', text: result.reply }],
              ended: result.ended,
            }
          : current,
      )
      if (result.ended) conversations.reload()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <>
      <div className="topbar">
        <h2>Street Banker Operator</h2>
        <div className="meta">AI intake, human decisions — the agent approves nothing and a person is always reachable</div>
      </div>

      {error && <Callout tone="danger">{error}</Callout>}

      <div className="grid cols-2">
        <div>
          <Card
            title="Agents"
            action={
              <button className="small" onClick={() => void audioApi.ensureAgents().then(() => agents.reload())}>
                create defaults
              </button>
            }
          >
            <AsyncBlock state={agents}>
              {(data) =>
                data.agents.length === 0 ? (
                  <Empty>No agents yet — create the default orchestrator/specialist set.</Empty>
                ) : (
                  <table>
                    <tbody>
                      {data.agents.map((agent) => (
                        <tr key={agent.id}>
                          <td>{agent.name}</td>
                          <td className="muted">{agent.agentType.replace(/_/g, ' ')}</td>
                          <td>
                            <Badge tone={agent.status === 'active' ? 'ok' : undefined}>{agent.status}</Badge>
                          </td>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            {agent.status !== 'active' && (
                              <button className="small" onClick={() => void audioApi.updateAgent(agent.id, { status: 'active' }).then(() => agents.reload())}>
                                activate
                              </button>
                            )}{' '}
                            {agent.agentType === 'intake_orchestrator' && agent.status === 'active' && (
                              <button className="small" onClick={() => void start(agent.id)}>
                                test conversation
                              </button>
                            )}{' '}
                            {agent.status === 'active' && (
                              <button
                                className="small"
                                title="Push knowledge base and tools to the configured voice provider"
                                onClick={() => void audioApi.syncAgent(agent.id).then(() => agents.reload()).catch((err) => setError((err as Error).message))}
                              >
                                sync provider
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              }
            </AsyncBlock>
          </Card>

          {chat && (
            <Card title="Conversation (web channel)">
              <div style={{ display: 'grid', gap: 8, maxHeight: 360, overflowY: 'auto', marginBottom: 10 }}>
                {chat.lines.map((line, index) => (
                  <div
                    key={index}
                    style={{
                      fontSize: 13,
                      padding: '6px 10px',
                      borderRadius: 6,
                      background: line.role === 'user' ? 'var(--bg-input)' : 'var(--bg-panel)',
                      borderLeft: `2px solid ${line.role === 'disclosure' ? 'var(--info)' : line.role === 'transfer' ? 'var(--warn)' : line.role === 'user' ? 'var(--border-strong)' : 'var(--accent)'}`,
                    }}
                  >
                    <span className="faint" style={{ marginRight: 6 }}>
                      {line.role === 'disclosure' ? 'disclosure' : line.role}
                    </span>
                    {line.text}
                  </div>
                ))}
              </div>
              {chat.ended ? (
                <Callout tone="info">Conversation ended — it has been classified and routed to Operator Desk.</Callout>
              ) : (
                <form onSubmit={send} style={{ display: 'flex', gap: 8 }}>
                  <input style={{ flex: 1 }} value={input} onChange={(e) => setInput(e.target.value)} placeholder="Say something…" />
                  <button type="submit">Send</button>
                </form>
              )}
            </Card>
          )}
        </div>

        <div>
          <Card title="Conversations">
            <AsyncBlock state={conversations}>
              {(data) =>
                data.conversations.length === 0 ? (
                  <Empty>No conversations yet.</Empty>
                ) : (
                  <table>
                    <tbody>
                      {data.conversations.map((conversation) => (
                        <tr key={conversation.id} style={{ cursor: 'pointer' }} onClick={() => setSelected(conversation)}>
                          <td className="faint">{new Date(conversation.startedAt).toLocaleString()}</td>
                          <td className="muted">{conversation.channel}</td>
                          <td>
                            <Badge tone={statusTone(conversation.status)}>{conversation.status}</Badge>
                          </td>
                          <td>{conversation.humanTransferStatus !== 'none' && <Badge tone="warn">human transfer</Badge>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              }
            </AsyncBlock>
          </Card>

          {selected && (
            <Card title="Conversation detail">
              <div style={{ fontSize: 13, display: 'grid', gap: 8 }}>
                {selected.summary && <p style={{ margin: 0 }}>{selected.summary}</p>}
                {Object.keys(selected.guestContact).length > 0 && (
                  <div className="muted">
                    contact: {Object.entries(selected.guestContact).map(([key, value]) => `${key}=${value}`).join(' · ')}
                  </div>
                )}
                <div style={{ maxHeight: 260, overflowY: 'auto', display: 'grid', gap: 4 }}>
                  {selected.transcript.map((turn, index) => (
                    <div key={index}>
                      <span className="faint">{turn.role}:</span> {turn.text}
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          )}
        </div>
      </div>
    </>
  )
}
