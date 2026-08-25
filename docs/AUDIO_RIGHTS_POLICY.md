# Audio rights policy

The rules the platform enforces about whose audio, whose voice, and whose
work. Each rule names where it lives in code, because a policy that only
lives in a document is a suggestion.

## Ownership and authorization

- **Uploads require a rights basis.** Meeting uploads require the
  authorization acknowledgment; Remix Lab requires the ownership
  confirmation; Global Release requires territory rights confirmation. Each
  is stored as a consent record with the exact text and version shown
  (`packages/audio-engine`: meetings/remix/global-release services).
- **Generated assets carry lineage**: provider, model, voice, prompt, rights
  basis, consent record, parent (`audio_generations` table). An asset with no
  recorded rights basis is unusable for release work by construction.

## Imitation

- No imitation of a real person's voice, name, likeness, protected style,
  lyrics, song, album, or label — screened before any provider call
  (`screenRemixPrompt`, `screenVoicePrompt` in `packages/audio-core`), with
  org-configurable protected-name lists.
- No public-figure or news-style impersonation in campaign audio.
- No cloning from uploaded third-party media: the only voice path is the
  owner-verified Voice Vault ([ARTIST_VOICE_VAULT.md](ARTIST_VOICE_VAULT.md)).

## Provider screening outcomes

A provider declining an upload is recorded as a screening outcome —
`rights_review_required` — and surfaced as "Provider rights review required"
with human review and documentation paths. It is never presented as a
finding of infringement, and it is never auto-retried
(`packages/audio-core/src/moderation.ts: PROVIDER_RIGHTS_REVIEW_MESSAGE`).

## Human approval before release

- Meeting deal terms: labelled explicit/inferred/needs-verification; never
  auto-committed; human approval + commit required.
- Dubbing: human quality review before export.
- Remix: producer review → producer approval → release authorization, in
  order, enforced.
- Nothing represents AI output as exclusive unless contractually confirmed —
  the platform records what was generated and by what; exclusivity is a
  contract question for humans.

## Revocation

Voice revocation stops generation immediately, marks derived assets for
rights review, and preserves the audit trail. Consent revocation invalidates
the consent for future use without deleting the evidence it existed.
