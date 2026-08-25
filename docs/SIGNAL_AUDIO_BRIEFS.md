# Street Banker Signal — Audio Briefs

Short private audio briefings generated from structured, already-authorized
intelligence. Types: daily scout, weekly executive, artist opportunity,
release reaction, rights health, distribution change, city ignition, deal
pipeline, follow-up.

## Workflow

1. The caller supplies structured items — statements each tagged
   `confirmed` / `likely` / `needs_verification`. The brief service never
   queries data on its own; it can only speak facts the caller was authorized
   to see. (When a Signal data source lands, it feeds this same shape.)
2. The reasoning layer writes a spoken script. **Confidence language survives
   verbatim**: an item tagged `needs_verification` is read as needing
   verification, never as fact. The Claude prompt requires it; the heuristic
   engine does it mechanically; a test asserts it.
3. The user may edit the script before (re-)rendering.
4. The worker renders the script through the speech provider using a
   Street Banker catalog voice or a verified Voice Vault profile — never a
   celebrity or artist-cloned voice. The result is stored org-scoped with
   generation lineage and usage recorded.
5. Playback and download go through signed URLs, subject to the org's
   download policy.

## Content rules

- No private information for unauthorized users — the caller's authorization
  is the input boundary.
- No full contract language; no sensitive PII unless explicitly included by
  an authorized caller.
- Uncertain findings stay uncertain out loud.

## Scheduling

Per-user schedules: daily, weekdays, weekly, or on demand, at a chosen UTC
hour. The worker's schedule tick (hourly, self-re-arming, idempotent per time
bucket) generates and renders due briefs. Delivery is in-app streaming and
signed-URL download; large audio files are never attached to email.

## API

```
GET/POST  /api/audio/signal-briefs
GET/PATCH /api/audio/signal-briefs/:id
GET       /api/audio/signal-briefs/schedules/list
POST      /api/audio/signal-briefs/schedules
PATCH     /api/audio/signal-briefs/schedules/:id
```
