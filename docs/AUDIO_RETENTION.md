# Audio retention runbook

## Policy

Each organization's `AudioDataPolicy` sets retention in days (or "keep") per
class: source audio, transcripts, generated audio, agent conversations, voice
samples. New records are stamped with `retention_expires_at` at creation from
the policy in force. Admins edit the policy at `/audio/settings`
(`PATCH /api/audio/settings/policy`).

## The sweep

The worker runs `audio.retention.sweep` every 15 minutes (self-re-arming,
idempotent per time bucket). For each expired record it:

- **Audio assets**: deletes the stored bytes, soft-deletes the row
  (`deleted_at`, `delete_reason='retention_expired'`) — ownership, checksum,
  rights status, and the consent link survive as audit metadata.
- **Transcripts**: clears `full_text` and `raw`, deletes segments, marks the
  row `deleted`. The row proves a transcript existed, from which asset, when.
- **Agent conversations**: clears transcript, guest contact, summary,
  classification; keeps the disclosure/consent metadata.

Every deletion writes an audit entry. Failures are logged per record and
retried on the next sweep — the sweep never dies on one bad row.

## Zero retention

If an org's policy (or the deployment-wide `ZERO_RETENTION_REQUIRED` floor)
requires zero-retention processing, the engine checks the resolved provider's
attested capability **before any bytes are sent**. Unsupported → the job is
rejected with `audio.zero_retention_unavailable`, the message names the
conflict, nothing is silently downgraded, and no data leaves the platform.
For ElevenLabs the attestation is `ELEVENLABS_ZERO_RETENTION_CAPABLE=true`
(enterprise `enable_logging=false`); it is never inferred. A job is never
labelled "zero retention" unless the request actually carried the flag
against an attested account.

## Operator procedures

- **Verify the sweep is running**: worker log lines `audio.retention_sweep`;
  or check `queue_jobs` for `audio.retention.sweep` rows completing.
- **Immediate deletion request** (subject request, takedown): use
  `DELETE /api/audio/assets/:id` (admin) — same soft-delete semantics, reason
  recorded with the actor; then confirm any derived assets via
  `audio_generations`.
- **Policy tightened**: existing rows keep their stamped deadline. To apply a
  shorter policy retroactively, update `retention_expires_at` for the class
  via SQL with the DPO's sign-off, then let the sweep act.
- **Verifying deletion**: bytes gone from storage under the org prefix; row
  has `deleted_at`; audit log has `audio.asset_retention_deleted`.
