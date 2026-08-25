# Global Release Pack

Localized campaign versions — trailers, announcements, interviews, press-kit
video, onboarding, direct-to-fan messages — for global territories, with a
human quality gate before anything ships.

## Workflow and review states

```
draft → transcribing → transcript_review → dubbing → quality_review
      → approved → exported          (any step may land in failed / changes_requested)
```

1. Upload source media and confirm rights for the selected territories
   (stored as a `dubbing_authorization` consent record; refusal without it).
2. Source is transcribed; the project parks in **transcript_review** so names
   and industry terminology get corrected by a person before translation.
3. On transcript approval the engine submits one provider dubbing project per
   target language (the provider dubs one language per project), polls, and
   downloads finished audio per language.
4. Caption files (SRT + VTT) are generated from **our reviewed transcript**,
   not the provider's.
5. The project parks in **quality_review**. A human (admin role) reviews name
   pronunciation, terminology, translation accuracy, cultural fit, timing,
   voice consistency, rights, and CTA localization — then approves.
6. **Export** returns signed URLs per ready language. Export before approval
   is refused: machine translation is never automatically release-ready.

## Voice strategies

`preserve_source_speaker` · `approved_narrator` · `voice_vault_profile`
(verified, permission-scoped — see [ARTIST_VOICE_VAULT.md](ARTIST_VOICE_VAULT.md)) ·
`human_recorded` · `subtitles_only`. Never another person's voice without
permission.

## API

```
GET/POST /api/audio/dubbing
GET      /api/audio/dubbing/:id
POST     /api/audio/dubbing/:id/approve-transcript
POST     /api/audio/dubbing/:id/approve        (admin)
GET      /api/audio/dubbing/:id/export
```
