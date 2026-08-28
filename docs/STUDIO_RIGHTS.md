# Studio — provenance, identity and AI rights

Four modules whose schemas exist now because the decisions they record cannot
be reconstructed later: who made a record, who is allowed to use it, and on
what basis. Every one of them defaults to refusal, and none of them makes a
legal conclusion.

---

## Record Passport

A machine-readable provenance record for one recording, assembled from what the
platform already knows — versions, approvals, contributions, splits, delivery
history — rather than from a form somebody fills in twice.

### What it captures

Project and recording id · contributors and roles · every version with its
checksum, source and parent · every unrevoked approval with the bytes it
approved · ownership declarations and splits · AI disclosure · sample
declarations · licences · delivery history.

### The hash

`document_hash` is taken over a **canonical** serialization — object keys sorted
at every depth, via the platform's existing `hashObject`. Without a canonical
form, two builds that serialize the same document with different key order
produce different hashes, and an integrity check that fails for no reason is
worse than no integrity check at all.

`verify()` re-derives the hash and compares it. For a finalized passport it
*also* checks that the version it names still carries the same audio checksum.
Storing a hash nobody can check would make the column decoration.

### Finalizing

Finalizing binds the passport to a version's exact bytes and closes it to
editing. A finalized passport is never rewritten — the act of finalizing is
saying "this describes those bytes", and editing it afterwards would make the
statement meaningless. A changed record gets a new passport.

### What it is not

**Not a legal conclusion.** It records what was declared, by whom, and when.
`cleared: null` on a sample means nobody has said, which is a different fact
from "not cleared", and the schema keeps the two apart.

**Not DDEX or RIN.** Those are export targets. The document is shaped so an
exporter can map into them without this application depending on any one
standard's library or version. `external_profile` names the intended target as
a hint for an exporter, deliberately not as a coupling.

---

## Human Creation Ledger

Optional per-contribution logging: lyrics, melody, vocals, instrument,
production, mix, master, arrangement, engineering.

Human work and AI-assisted processes are recorded **separately and never merged
into one claim**. A human contribution has `human: true`; an AI-assisted one
records the tool and what it did.

Some of it is derived rather than declared. A master rendered by Master Station
is an AI-assisted-tooling fact whether or not anybody remembers to declare it,
so the passport reads it from what actually happened — and reports nothing when
the placeholder renderer produced no processing, because nothing was done.

The AI disclosure block is written even when empty. A passport that omits the
field is indistinguishable from one where nobody was asked.

Purpose: authorship evidence, credits, rights documentation and AI
transparency. Not legal advice, and the module makes no determination about
authorship or ownership.

---

## Identity Vault

Artist control over **voice, name, image, likeness and performance style**.

Each subject carries a control: `prohibited`, `consent_required` or
`permitted`, plus approved model ids, permitted and prohibited uses,
territories, term, pricing and a consent record.

### Default deny, structurally

`controlFor()` returns `prohibited` when no row exists. An artist who has never
opened this screen is protected exactly as if they had set every subject to
prohibited. It also refuses on a revoked entry, an expired term, and — the one
worth noting — on a `permitted` entry whose consent has not been verified,
which downgrades to `consent_required` rather than being honoured.

`permitted` **requires a consent record that exists, was accepted and has not
been revoked**. The service loads and checks it through the platform's existing
consent infrastructure rather than accepting an id, because accepting an id
without checking it would make the verification flag decorative.

Voice cloning is not enabled by this module and cannot be. There is no path
here that produces a voice model; what exists is the permission structure such
a feature would have to ask.

### History

`studio_identity_events` is append-only. Revocation is an event, not an erasure:
who changed what, when, and on what basis stays readable.

---

## Rights-safe AI licensing

Eight permissions, each scoped to `master`, `stems`, `acapella`, `instrumental`
or `all`:

`no_ai_use` · `analysis_only` · `private_artist_model` · `licensed_derivative` ·
`fan_remix` · `commercial_sync_generation` · `voice_use` · `training_use`

### Resolution order

`isAllowed()` is the gate, and there is no path through it that returns true
without a live, unexpired, granted row:

1. An explicit `no_ai_use` on the scope (or on `all`) refuses — **even where a
   narrower permission was granted**. It is a positive statement an artist can
   make, not merely the absence of a grant.
2. No matching permission refuses.
3. A withheld, revoked or expired permission refuses.

Granting one permission never opens another.

### Revocability

Permissions are revocable by default. An **irrevocable** grant must name the
contract that makes it irrevocable — otherwise "irrevocable" is a checkbox
somebody ticked. Attempting to revoke one is refused with a message saying it
is a contractual matter rather than a settings change.

Every set, grant, withholding and revocation writes to
`studio_ai_permission_events`.

---

## Agent-to-agent licensing

The boundary a future in which software agents search for music would need.

```
REQUEST → RIGHTS CHECK → PRICE → ⟨stop⟩
```

A request comes in, matches are found against the catalogue, their rights are
checked against stored permissions, and it stops at `awaiting_human`.

**Nothing in this application sets `executed`.** There is no method that would.
Executing a licence needs contract and payment infrastructure that does not
exist, and an autonomous system that grants rights it cannot paper is a
liability rather than a feature. The API response repeats that in its payload,
because an agent consuming it needs to be told in the data that nothing has been
granted.

Matching is deliberately conservative and explainable — genre, title terms,
runtime, approval state — and every match lists those reasons. A relevance model
that could not explain itself would be worse than useless in a rights context.

`rightsClear: null` means the stored data does not answer the question. That is
a different answer from "no" and is presented as such.

No price is invented. `indicativePriceMicros` is null and `priceBasis` says a
person sets the price against the brief, the budget and the rights. Producing a
plausible number against a real budget would be the most damaging kind of
fabrication this platform could commit.

---

## Sonic DNA and Creative Memory

Derived preferences, learned from exactly one signal: **a human approving a
master**.

Auditioning, rendering and comparing teach it nothing. Those are exploration,
and treating exploration as preference is how a system ends up confidently wrong
about somebody's taste.

- Attributes are re-derived from *every* approved master the artist has, so the
  sample size on a row is always the truth rather than a counter that drifted.
- Everything derived lands as `proposed`. Four consistent approvals promotes an
  attribute to `active` — that line is written down in the code rather than
  assumed.
- A preference the artist **states** outranks anything inferred, and a derived
  observation updates a stated entry's evidence without touching its value.
- Every row lists the approvals it came from.
- Confidence is capped at 0.8. Three approved masters is a tendency, not a law.

Creative Memory holds the same evidence as sentences a person reads, with a
promotion gate: a pattern needs at least three consistent observations and 0.6
confidence before it is worth showing, and a person promotes it.

`reset` is a real delete of both tables. The product promises a user can view
*and reset* their Sonic DNA, and a reset that leaves the rows in place is not a
reset.
