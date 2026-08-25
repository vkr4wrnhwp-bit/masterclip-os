# Remix Lab — Audio Engine

## Positioning

Not "upload a song and receive a finished hit remix." Remix Lab turns
**artist-owned audio** into stems, alternate-section concepts, social
versions, arrangement directions, and producer-ready creative material. The
positioning is enforced in code, not marketing copy.

## Required confirmations

Creating a project requires both, individually, stored as separate consent
records:

1. *"I confirm that I own or control the audio I am uploading, or have
   authorization from the rights holder to use it."*
2. *"I understand that Remix Lab will not imitate another artist's name,
   voice, likeness, protected style, lyrics, song, album, label, or
   recording."*

## Prompt moderation

`screenRemixPrompt` runs before any generation request — at enqueue time and
again at execution time — and the blocked request never reaches the provider.
Blocked: "sound like", "in the style of", "use/clone their voice", "same
flow as", "same lyrics as", "AI cover", impersonation/deepfake phrasing,
recreation of a recording, "type beat", and any org-configured protected
name (artists, producers, songwriters, labels, publishers) used as a
reference. Allowed: neutral descriptors — tempo, energy, instrumentation,
rhythm, structure, era, mood, texture, intended use, DJ/social utility.

The refusal message states platform policy and asks for a reworded prompt.
It never accuses anyone of infringement.

## Upload screening

When the provider declines an owned-audio upload, the platform shows
**"Provider rights review required"** — the provider result is recorded, the
artist's rights confirmation stays on record, human review and ownership
documentation are offered, and the upload is never auto-resubmitted. Nothing
in the flow accuses the artist. (Mock convention for tests: filenames
containing `screenme` trigger this path.)

## Workflows

Stem separation · composition-plan extraction · alternate/instrumental
concepts · owned-audio inpainting (requires the provider to have accepted the
upload first) · DJ edit and producer-handoff lanes. Every output stores full
lineage: source asset ids, rights confirmations, prompt, provider, model,
seed, composition plan, range, parent version, reviewer, and export history —
in `remix_versions.generation_metadata` plus `audio_generations`.

## Human release gate

Ordered, no skipping — enforced with a conflict error:

```
draft version → producer review (per version)
             → producer_approved (project)
             → release_ready (project)
```

No generated version is ever marked release-ready by a machine, and
`release_ready` without `producer_approved` is refused.
