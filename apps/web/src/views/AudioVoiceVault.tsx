import React from 'react'
import { audioApi } from '../audio-api.js'
import { AsyncBlock, Badge, Callout, Card, Empty, Field, useAsync } from '../ui.jsx'

export function AudioVoiceVaultView() {
  const profiles = useAsync(() => audioApi.voiceProfiles(), [])
  const [ownerName, setOwnerName] = React.useState('')
  const [profileName, setProfileName] = React.useState('')
  const [providerVoiceId, setProviderVoiceId] = React.useState('')
  const [consent, setConsent] = React.useState(false)
  const [uses, setUses] = React.useState<Record<string, boolean>>({ internal: true, social: false, commercial: false, advertising: false, dubbing: false })
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  const register = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await audioApi.registerVoice({
        ownerName,
        profileName,
        providerVoiceId,
        ownerConsentConfirmed: consent,
        validUntil: null,
        permittedUses: uses,
      })
      setOwnerName('')
      setProfileName('')
      setProviderVoiceId('')
      setConsent(false)
      profiles.reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="topbar">
        <h2>Artist Voice Vault</h2>
        <div className="meta">verified, scoped, revocable — not a cloning marketplace</div>
      </div>

      <Callout tone="info" title="How a voice gets here">
        The voice owner completes the provider’s own verified-voice process themselves and shares the resulting voice reference.
        Street Banker stores that reference and the permission record — never the underlying voice model. A manager or label
        cannot register an artist’s voice on their behalf.
      </Callout>

      <div className="grid cols-2">
        <Card title="Profiles">
          <AsyncBlock state={profiles}>
            {(data) =>
              data.profiles.length === 0 ? (
                <Empty>No voice profiles.</Empty>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Profile</th>
                      <th>Owner</th>
                      <th>Verification</th>
                      <th>Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.profiles.map((profile) => (
                      <tr key={profile.id}>
                        <td>{profile.name}</td>
                        <td className="muted">{profile.voiceOwnerName}</td>
                        <td>
                          <Badge tone={profile.verificationStatus === 'verified' ? 'ok' : 'warn'}>{profile.verificationStatus}</Badge>
                        </td>
                        <td>
                          <Badge tone={profile.status === 'active' ? 'ok' : profile.status === 'revoked' ? 'danger' : 'warn'}>{profile.status}</Badge>
                        </td>
                        <td>
                          {profile.status !== 'revoked' && (
                            <button
                              className="small"
                              onClick={() => {
                                if (window.confirm('Revoke this voice? New generation stops immediately; existing assets flip to rights review.')) {
                                  void audioApi.revokeVoice(profile.id).then(() => profiles.reload())
                                }
                              }}
                            >
                              revoke
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

        <Card title="Register a verified voice">
          <form onSubmit={register}>
            <Field label="Voice owner">
              <input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} required placeholder="Artist’s legal or stage name" />
            </Field>
            <Field label="Profile name">
              <input value={profileName} onChange={(e) => setProfileName(e.target.value)} required placeholder="Narration voice" />
            </Field>
            <Field label="Provider voice reference" hint="shared by the voice owner after provider verification">
              <input value={providerVoiceId} onChange={(e) => setProviderVoiceId(e.target.value)} required placeholder="voice id" />
            </Field>
            <Field label="Permitted uses">
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12 }}>
                {Object.keys(uses).map((use) => (
                  <label key={use} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <input type="checkbox" checked={uses[use]} onChange={(e) => setUses({ ...uses, [use]: e.target.checked })} />
                    {use}
                  </label>
                ))}
              </div>
            </Field>
            <label className="field" style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ marginTop: 3 }} />
              <span style={{ fontSize: 12 }}>
                The voice owner has given explicit consent for these uses, understands the permission scope, and can revoke at any
                time. The consent record is stored with the profile.
              </span>
            </label>
            {error && <Callout tone="danger">{error}</Callout>}
            <button type="submit" disabled={busy}>
              {busy ? 'Registering…' : 'Register voice'}
            </button>
          </form>
        </Card>
      </div>
    </>
  )
}
