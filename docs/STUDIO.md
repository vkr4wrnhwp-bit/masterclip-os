# Street Banker Studio

**The control room for a record.**

Studio is where a recording lives for its whole life. One canonical project id
runs from the first rough through mixing, mastering, approval, packaging and
delivery — and every other Street Banker module points at it rather than
minting a second identity for the same song.

It is not a browser DAW, not an AI music generator, and not a collection of
disconnected tools. It measures what is actually in a file, says what it found
and how sure it is, and leaves every decision to a person.

---

## The lifecycle

```
CREATE → ANALYZE → MIX → MASTER → APPROVE → PACKAGE → RELEASE → MARKET → MONETIZE → TRACK
```

`studio_projects.stage` records where a record sits. Stages advance as work
happens — uploading a master moves the project to `master`, sending a
deliverable moves it to `release` — and nothing forces them to advance in
order. A released record that goes back for a new mix is a real thing that
happens, and a state machine that refused it would be one users route around.

## The seven areas

One global nav entry, seven contextual tabs. Session, Rack, Mix, Master,
Versions, Collaborate and Deliver belong to a *record*, not to the application;
putting them in the sidebar would make the platform's top level about features
instead of about work.

| | |
|---|---|
| **Session** | The control room. Waveform, transport, markers, notes, Ask the Room, activity. |
| **Rack** | Modular signal chains — five stages in a fixed order. |
| **Mix** | Mix Station: the measurements, Mix Doctor, Reference DNA, Translation Lab. |
| **Master** | Master Station: directions, renditions, loudness-matched A/B. |
| **Versions** | Version Vault and the difference engine. |
| **Collaborate** | Collaborators, timestamped comments, formal approval. |
| **Deliver** | Delivery checks, the Record Passport, rights, Sonic DNA. |

---

## Five rules enforced in code

These are not style guidance. Each one is a property of the schema or of a
refusal in a service, and each has a test that fails if it stops being true.

### 1. Nothing is fabricated

Every measurement is a `MixMetric`: a value, a unit, a **method**, a
**confidence** and a note. A figure that could not be determined is `null`,
never `0`, and renders as *"not measured"* with the reason. A mono file has no
phase correlation; a three-second clip has no loudness range; and the product
says so rather than printing a number.

Release Readiness excludes unmeasured bands from its average and withholds the
overall score entirely below four of eight bands — a figure built from two
bands is one nobody should act on.

### 2. Nothing is overwritten

`studio_versions` has no column meaning "replaced by". A new mix creates a new
version with a parent pointer; the previous one is marked `superseded_at`,
which records that a newer one exists and nothing else. Its audio stays exactly
where it was and stays playable. `deletePlaceholder` refuses on any version
that carries an asset — the refusal lives in the repository so no future caller
can bypass it by accident.

Master Station writes new assets and new versions. It has no API that can write
back to a source.

### 3. An approval names bytes, not a label

`studio_approvals.version_checksum` pins the exact audio that was approved, read
from the version at approval time rather than supplied by the client. Uploading
a new file under the same version name cannot inherit somebody's sign-off. The
approval state carries `supersededByDraft`, so an approved file is
distinguishable from later drafts on every surface.

Revoking an approval keeps the row: an approval that was given and withdrawn is
a different fact from one that never existed.

### 4. A comparison is loudness-matched

A mastering chain that adds 5 dB sounds better to everyone, every time, for
reasons that have nothing to do with the mastering. Every rendition is
re-analysed after rendering and the gain that equalises it against the source is
computed **server-side** and stored on the rendition, so every surface applies
the same number and a client cannot omit it. Where the match gain could not be
computed, the A/B says the comparison is unmatched rather than quietly playing
the louder file.

### 5. Rights refuse by default

`IdentityVaultRepo.controlFor` returns `prohibited` when no row exists.
`AiPermissionRepo.isAllowed` returns false when no permission has been granted.
An artist who has never opened those screens is protected exactly as if they
had set everything to prohibited — the denial is structural, not a policy
somebody could forget to apply.

---

## Mix Station

Accepts a stereo mix, vocal + instrumental, stems or a consolidated multitrack.
The analyzer set measures around 35 figures across ten groups: level, loudness,
dynamics, spectral balance, stereo behaviour, defects, low end, midrange, high
frequency and vocal.

**Analyzers are a list, not a schema.** Adding one is appending to an array in
`@masterclip/mix-analysis`; metrics are stored and rendered by key, so a new
analyzer needs no migration, no repository change and no UI change. An analyzer
that throws does not take the report down with it — its keys come back
unmeasured, with the failure in the note.

See [STUDIO_ANALYSIS.md](STUDIO_ANALYSIS.md) for what each metric means and how
it is measured.

### Mix Doctor

Returns **timestamped potential issues**: severity, confidence, a time range,
what was detected, why it matters, and a suggested action — plus the
measurements the finding rests on, so an engineer who disagrees can dismiss it
on the facts.

Detection is relative to the record's own median and percentiles, not to
absolute targets. A deliberately dark or bright mix is not flagged for being
what it is; only the moments that stand out *within* the record are.

Every headline is hedged (`Possible…`, `Detected…`, `Potential…`). There is no
code path that produces "your mix is wrong".

`HEAR SECTION` seeks the session transport to the finding and loops it.
`ADD NOTE` and `SEND TO ENGINEER` create a real note on the timeline, labelled
`origin: mix_doctor` for the rest of its life so nobody later mistakes a
detector's guess for an engineer's instruction.

### Reference DNA

References are **measured, not stored**. Unless the user owns or has licensed
the recording, the reference is `derivedOnly`: the audio is deleted in the same
job that measured it, and only the numbers remain. There is no function
anywhere in the module that takes a reference and produces audio.

Every comparison row names its cohort size. A comparison against one reference
is a comparison against one record, and the copy says exactly that.

### Translation Lab

Estimates how much of a record survives on ten playback contexts — phone,
laptop, earbuds, car, Bluetooth, monitors, club, large PA, mono, low volume.

`modelled: false` on every target is the honest state of this implementation:
these are analytical estimates from published bandwidth and playback
characteristics, not measured device models. The field exists so the UI can
tell the two apart the day a validated model arrives, rather than the product
quietly upgrading its claims.

### Ask the Room

An advisory assistant with the project's own context: measurements, findings,
notes, versions, references and the artist's Sonic DNA. It answers in musical
terms with the number underneath, records what it looked at, and returns
`confidence: 'insufficient'` rather than guessing.

The topic handlers are deterministic — a deliberate first implementation, not a
limitation being hidden. `responder` is stored on every exchange so a language
model over the same context is distinguishable the day one is wired in.

---

## Master Station

```
UPLOAD → ANALYZE → SELECT DIRECTION → GENERATE → COMPARE → APPROVE → DELIVER
```

Six directions — Transparent, Competitive, Warm, Open, Modern, Custom. None
imitates a named engineer, studio or commercial master; each is a set of
translation targets with its reasoning written down.

**The plan adapts to the mix and says what it refused to do.** A mix already at
−8 LUFS asked for "competitive" gets no gain rather than 6 dB of pointless
limiting. A mix with 40 % of its energy below 200 Hz does not get a low shelf
lift on top. Every one of those refusals appears in the rendition's `restraint`
list.

The plan is stored as data — every stage and its parameters — so a year later
anyone can read what was done. Mastering a version that has not been analysed
is refused: applying a fixed amount of gain to an unknown level is not
mastering.

Where ffmpeg is unavailable the rendition is marked `placeholder`, returns the
unprocessed source, and says so. The plan and the comparison table stay real.

**Album Master** measures track-to-track consistency across loudness, tonality,
low end, vocal presence, stereo presentation and dynamics, and names the
outliers. It reports *spread*, not a verdict: a record that moves is not an
incoherent record.

---

## Version Vault and the difference engine

The engine answers "what changed between these two versions?" in the language
an engineer uses. *"Lead vocal appears more present across approximately 12 %
more of the record"* is actionable; `vocal_presence_index +0.12` is not.

Every claim is hedged with "approximately", and each is labelled `observed`
(a direct reading) or `inferred` (a measurement translated into a musical
statement across a proxy). Two analyses from different analyzer-set versions
are reported as **incomparable** rather than diffed — the deltas would mix
measurement changes with mix changes.

---

## Delivery

Runs the checks a distributor would run, before the distributor runs them: file
type, sample rate, bit depth, clipping and true peak, naming, ISRC, artist,
copyright, explicit status, artwork, credits, and splits — checked
arithmetically, because a split sheet totalling 97 % is worse than none at all.

A check that cannot be evaluated returns `unknown`, never `pass`.

`SEND TO RELEASE` needs zero failing checks **and** a delivery approval.
Warnings never block: a product that refuses to ship over a warning teaches
people to ignore warnings.

---

## Rights, provenance and memory

[STUDIO_RIGHTS.md](STUDIO_RIGHTS.md) covers the Record Passport, the Human
Creation Ledger, the Identity Vault, rights-safe AI licensing and the
agent-to-agent licensing boundary in full. In short:

- **Record Passport** — a machine-readable provenance record, hashed over a
  canonical serialization and bindable to a version's exact bytes. It makes no
  legal conclusions: `cleared: null` on a sample means nobody has said, which
  is different from "not cleared".
- **Identity Vault** — artist control over voice, name, image, likeness and
  performance style. Default prohibited; `permitted` requires a verified
  consent record.
- **AI licensing** — granular, revocable, logged. `no_ai_use` is a positive
  statement that overrides every other permission on the same scope.
- **Agent licensing** — REQUEST → RIGHTS CHECK → PRICE → *stop*. Nothing in
  this application sets `executed`, and no price is invented against a real
  budget.

**Sonic DNA** is derived from exactly one signal: a human approving a master.
Auditioning, rendering and comparing teach it nothing, because exploration is
not preference. Everything derived lands as `proposed`, is attributed to the
approvals behind it, and `reset` is a real delete.

---

## Architecture

| Package | What it is |
|---|---|
| `@masterclip/mix-analysis` | Pure analysis. Analyzers, Mix Doctor, readiness, master planning and rendering, translation, reference comparison. Knows nothing about storage or the database. |
| `@masterclip/studio-domain` | Capabilities, record types, and org-scoped repositories for all 35 tables. |
| `@masterclip/studio-engine` | Access control, services, the composition root, the demo seed. |

Routes live under `apps/api/src/routes/studio/`, jobs run on the `studio` queue,
and the UI is `apps/web/src/studio/`.

### The gate

Every route passes through `requireStudio`, which runs the access control in a
fixed order and names the layer that refused:

```
global flag → module entitlement → capability entitlement → org role
            → collaborator permission → usage limit → project exists in this org
```

The project-existence check is last and applies to every route that names a
project. Without it, a route that only queries child rows answers with an empty
list for another tenant's project id — nothing leaks, because those queries are
org-scoped, but the response distinguishes "not yours" from "does not exist",
and a route that fails open on identity is one refactor from failing open on
data.

`studio.approve` is checked on its own, every time. Approval is the one action
that changes what a record *is*, so it never rides along on a broader grant.

### Feature flags

`STUDIO_ENABLED` is the umbrella. Each surface has its own flag; switching one
off hides the nav entry, the tab and the routes together.

Two default **off**, because the thing behind them does not exist yet:

- `STUDIO_MARKETPLACE_ENABLED` — no configured providers, no payment
  integration. The revenue structure (fee, platform commission, engineer
  payout, rush, tips) is modelled in the schema and every figure is zero.
- `STUDIO_OPPORTUNITY_ENGINE_ENABLED` — not yet connected to the audience,
  streaming, touring and campaign data it is meant to weigh. Every opportunity
  it emits names, in `confidenceBasis`, which data it did *not* weigh.

---

## The demo

`pnpm seed` creates a fictional **Example Artist — "Signal Fire"**: two mixes,
a measured reference, notes on the timeline, a vocal rack, two mastering
directions rendered and compared, and a Delivery tab with real failing checks
(no ISRC, explicit status undeclared) because a delivery screen where everything
is already green teaches nothing.

All audio is synthesized locally by Street Banker's own generator — no
copyrighted recording is used, downloaded or referenced. **The analysis is
real**: the demo audio goes through the same analyzer set as a user's upload, so
the numbers on screen are measurements of the file rather than fixtures.

Open **Studio** in the nav. Entitlement-gated per organization and enforced
server-side.

Docs: [analysis](STUDIO_ANALYSIS.md) · [rights](STUDIO_RIGHTS.md) ·
[runbook](STUDIO_RUNBOOK.md)
