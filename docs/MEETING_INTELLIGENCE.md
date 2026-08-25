# Operator Desk Meeting Intelligence

Converts authorized calls, meetings, interviews and voice notes into
structured Operator Desk intelligence. The load-bearing property: extraction
output is a **draft**; a human approves items; only approved items commit.

## Workflow

1. Select or create an Operator Desk lead (optional but required to commit).
2. Pick a meeting type (A&R Call, Artist Onboarding, Manager Meeting,
   Distribution Discussion, Deal Discussion, Catalog Review, Royalty Review,
   Release Strategy, Show Debrief, Partner Meeting, Internal Team Meeting,
   Voice Note, Other).
3. Acknowledge the upload/recording authorization. The exact disclosure text,
   its version, who accepted, and when are stored as a consent record
   ([AUDIO_CONSENT.md](AUDIO_CONSENT.md)). Without the acknowledgment the
   upload is refused (`audio.consent_required`).
4. Media is validated against sniffed magic bytes (WAV/MP3/M4A/FLAC/OGG/MP4/MOV,
   512 MB cap), checksummed, deduplicated, and stored under
   `organizations/{orgId}/audio/source/…` with a retention deadline from the
   org's policy.
5. The worker transcribes via the configured provider: diarization, word
   timestamps, audio-event tags, entity detection, and the org's keyterm
   dictionary (shareable terms only — private terms never leave the platform).
6. Speakers can be renamed (marked manually confirmed), and any transcript
   line can be corrected — the edit lands in the segment and the transcript's
   full text is rebuilt, so extraction, captions and search all see the
   corrected version.
7. Structured intelligence is extracted (Claude-backed when configured,
   deterministic heuristic otherwise — the pipeline never depends on a model
   being available).
8. A human reviews: approve/reject each action item and deal variable,
   optionally editing the text.
9. **Commit** writes to the linked lead: the summary as a note, approved deal
   variables as notes (still labelled by extraction type), approved action
   items as tasks. Audited. A meeting commits once.

## Extraction honesty rules

- Every deal variable carries `explicit` / `inferred` / `needs_verification`.
  The heuristic engine never emits `explicit` — a pattern match cannot know a
  term was agreed — and the Claude prompt forbids presenting inferred terms
  as agreed. Tested in `tests/audio-intelligence.test.ts`.
- Risks cover rights issues (Content ID claims, clearance), split issues,
  distributor issues, deadline risk, and missing information.
- Open questions list missing documents, contacts, unconfirmed rights, and
  unresolved terms.
- Action items and deal variables carry source timestamps back into the
  transcript.

## Keyterm dictionary

Org-level dictionary (artists, managers, labels, distributors, publishers,
venues, cities, ISRCs, UPCs, releases, deal terminology, acronyms) that
biases transcription. Terms marked **private** are stored for internal use
but are never included in provider requests. Assembly enforces the provider's
documented limits (≤1000 terms, ≤50 chars, ≤5 words, no `<>{}[]\`).

## API

```
GET/POST  /api/audio/meetings
GET       /api/audio/meetings/:id
PATCH     /api/audio/meetings/:id/speakers
GET       /api/audio/transcriptions/:id
PATCH     /api/audio/transcriptions/:id/segments   (human correction)
POST      /api/audio/meetings/:id/extract
POST      /api/audio/meetings/:id/approve
POST      /api/audio/meetings/:id/commit
GET/POST  /api/audio/leads · GET/PATCH /api/audio/leads/:id
POST      /api/audio/tasks/:id/status
```

All gate-checked (`audio.meeting_intelligence` / `audio.meeting_upload`),
all org-scoped.
