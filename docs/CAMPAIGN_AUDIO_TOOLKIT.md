# Campaign Audio Toolkit

Campaign-ready audio from authorized content: voiceover generation, sound
design (foley, impacts, transitions, ambience), and voice isolation /
dialogue cleanup, organized under templates — release announcement, out now,
tour announcement, fan drop, merch launch, behind the music, countdown,
documentary intro, press-kit narration, brand partnership voiceover.

## Restrictions, enforced before the provider sees anything

- Voiceovers use Street Banker catalog voices or verified Voice Vault
  profiles only. Choosing a vault profile runs the owner's permission gate
  (`requireUsable` for commercial use) — a revoked, expired, unverified, or
  out-of-scope voice blocks the job with the reason named.
- `screenVoicePrompt` refuses public-figure imitation, "sounds like <Name>",
  implied endorsements, and news-style impersonation, plus any
  org-configured protected name.
- No cloning from uploaded third-party media, no voice for contract
  acceptance or identity authentication — those paths simply do not exist in
  this module.

## Lineage

Every generated asset records: provider, model, voice profile, prompt,
creator, date, rights basis, consent record, project, and parent generation —
in `audio_generations`, queryable per project. Assets carry retention
deadlines from the org policy like all generated audio.

## API

```
GET/POST /api/audio/campaigns
GET      /api/audio/campaigns/:id
POST     /api/audio/campaigns/:id/voiceover
POST     /api/audio/campaigns/:id/sound-effect
POST     /api/audio/campaigns/:id/isolate-voice
POST     /api/audio/campaigns/:id/upload        (source for cleanup)
```

All operations run as worker jobs with usage recorded; capability gates:
`audio.campaign_voiceover`, `audio.sound_effects`, `audio.voice_isolation`.
