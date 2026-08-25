# Song Lab — Data Rights and Privacy

## Rights confirmation

Before a single byte is stored, the user accepts:

> I confirm that I own or control the audio I am uploading, or have authorization
> from the rights holder to use it for analysis.

This is not a checkbox in a settings page or an implication of a terms link. It
writes a `consent_records` row of type `rights_confirmation` carrying the accepting
user, the timestamp, and a **SHA-256 hash of the exact statement text** — so a later
change to the wording cannot be passed off as what the user agreed to. Every project
stores that record's id, and every asset stored for the project points at it.

`SongLabProjectService.create` and `attachUpload` both refuse without it, with error
code `song_lab.rights_not_confirmed`.

## Tenant isolation

Every tenant-owned table carries `org_id` and every repository method filters on it
in SQL. There is no method that fetches a project by id alone — that is the shape of
query that eventually leaks one tenant's music to another.

Background jobs carry the organization they act for, and the service **proves** it
against the record rather than trusting the payload:

```ts
if (analysis.orgId !== expectedOrgId) throw forbidden('analysis belongs to another organization')
```

A job payload is not a capability. Tests cover cross-tenant project reads, imports,
importable listings, analysis jobs, experiment renders and Operator Desk attachment.

## Storage

Song Lab uses the Audio Intelligence asset service rather than re-implementing
secure audio storage — a second implementation is a second place for an isolation
bug to live. That means:

- keys are always `organizations/{orgId}/audio/{area}/…`, built from sanitised
  parts, so user input can never place bytes outside its tenant prefix;
- uploads are sniffed by magic bytes, not by Content-Type or filename, both of
  which are attacker-controlled;
- serving is **signed-URL only**, with a bounded expiry. A test asserts the URL
  carries a signature and an expiry in the future but under two hours;
- the organization's audio data policy governs downloads and retention.

## Retention

| Asset | Retention |
|---|---|
| Source audio | The organization's `source` retention policy |
| Experiment previews | The `generated` policy — reproducible from the stored edit list, so they expire rather than accumulating alongside masters |

Analysis results, edit decision lists and version lineage are metadata and survive
preview expiry. An experiment whose preview has expired can be re-rendered from its
stored list.

## What this module will not do

- **Train public or global models on private Street Banker artist music** without
  explicit contractual permission.
- **Expose one artist's audio to another.** Cross-tenant reads are refused at the
  repository layer.
- **Make private masters publicly accessible.** Signed, expiring URLs only.
- **Build an unauthorized library of copyrighted masters.** `benchmark_song_features`
  has no column for audio bytes or a storage key, and `BenchmarkProvider` has no
  return path for audio. `validateCohortDefinition` refuses a licensed-metadata
  source that claims to store masters.
- **Play copyrighted recordings back for comparison** unless Street Banker holds the
  rights. Nothing in this module provides that path.
- **Retain source audio beyond the configured policy.**
- **Export proprietary benchmark data without entitlement.** Proprietary cohorts
  require `song_lab.signal_benchmarks`.

## Lyrics

Analysed only when supplied by the user or transcribed from audio the organization
confirmed it controls. `lyricSource` records which. A version with no authorized
lyrics produces no lyric analysis at all.

## Audit

Project creation, audio attachment and import, experiment creation and acceptance,
A&R approval and every handoff are written to the platform audit log with the org,
the actor, the target and the relevant metadata. The rights confirmation id travels
with the audio-attachment entry, so the basis on which a master was processed is
answerable years later.

## Cross-module seams

A handoff gates on its **destination** module as well as on Song Lab. Holding
Song Lab is not a licence to write into Remix Lab (`audio.remix_lab`), Live Lab
(`live_lab.access`) or the Operator Desk CRM (`audio.operator_agent`) — Song Lab
cannot grant access to a module it hands off to.

For the same reason, the import picker offers only song-shaped audio
(`song_lab`, `remix`, `library`). A meeting recording or a voice sample is not a
record to diagnose, and listing it would hand a user holding only
`song_lab.analysis` a route to signed URLs for audio belonging to modules they
may not be entitled to. Same tenant either way — this is a capability seam, not
a tenant boundary — but the narrow list is both safer and the more sensible
product behaviour.

## Entitlements

Enforced server-side on every route and job:

```
global flag → module entitlement → capability entitlement → role → usage limit
```

The first layer to refuse names itself in the error code
(`song_lab.gate.module_entitlement`), so an operator debugging a denial learns which
control fired rather than getting a flat 403. Hiding a nav item is a courtesy, not a
control.
