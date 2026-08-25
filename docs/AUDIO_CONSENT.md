# Audio consent

## What a consent record is

Evidence. Every consent row stores: the subject (meeting, remix project,
voice profile, dubbing project, conversation), the consent type, the **exact
disclosure text shown**, its version, who accepted, when, structured
evidence (filename, size, scope), and a revocation timestamp if revoked.
Rows are append-only; revocation sets `revoked_at`, it never deletes.

Consent types: `recording`, `upload_authorization`, `agent_disclosure`,
`rights_confirmation`, `remix_no_imitation`, `voice_cloning`,
`dubbing_authorization` (`packages/audio-core/src/consent.ts`).

## Where consent gates sit

| Flow | Gate |
|---|---|
| Meeting upload/recording | acknowledgment required when the org policy says so (default on); refusal is `audio.consent_required` |
| Operator agent | disclosure shown before interaction and stored on the conversation from turn zero, with version |
| Remix Lab | two independent confirmations (ownership + no-imitation), both required |
| Global Release | territory rights confirmation required |
| Voice Vault | owner consent acknowledgment + provider-side owner verification required; revocable |

## Jurisdiction language

Default disclosure texts ship in code and are versioned. Organizations may
replace them with jurisdiction-specific language; the version travels with
every record either way. **The platform does not draw legal conclusions about
recording-consent law** — the organization is responsible for reviewing its
disclosure language with qualified counsel, and the default text says so to
the user.

## Retention interaction

Retention cleanup deletes content, not consent: when audio and transcripts
expire, the consent records and asset audit metadata that prove what was
authorized survive ([AUDIO_RETENTION.md](AUDIO_RETENTION.md)). Deleting the
evidence of consent along with the content would defeat the point of both.
