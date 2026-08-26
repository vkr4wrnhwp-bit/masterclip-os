# Song Lab — Internal A&R

Street Banker's own judgement layer about records it works with. **Not shown to
artist users**, and not part of what a partner organization receives by default.

## Access

Three independent controls, all server-side:

1. `SONG_LAB_AR_VIEW_ENABLED` — deployment kill switch.
2. `song_lab.ar_view` — an entitlement marked `flagshipOnly`, so it is never
   included in a partner plan preset.
3. `requireArView(actor)` on every A&R route, checked in addition to the normal gate.

Approval additionally requires org **admin**. A test asserts a partner-edition
organization receives 403 on `/api/song-lab/projects/:id/ar`.

## The dimensions

```
SONG STRUCTURE          Strong
HOOK ARCHITECTURE       Needs Review
EARLY PAYOFF            Below Cohort
ARRANGEMENT CONTRAST    Strong
VOCAL MEMORABILITY      Promising
STREAMING FORMAT FIT    High
LIVE POTENTIAL          High
SYNC STRUCTURE          Moderate
RECOMMENDATION          Develop
```

Ratings: `strong` · `promising` · `moderate` · `below_cohort` · `needs_review` ·
`not_enough_data`.

## Traceability

Every rating names the measurements and cohort comparisons it rests on:

```ts
evidence: Array<{ dimension: string; metricKeys: string[]; note: string }>
```

A dimension with no supporting measurement is rated **`not_enough_data`**, never
assigned a middling default. An A&R view full of confident-looking "moderate"
ratings derived from nothing would be worse than an honest gap. Review confidence is
the share of dimensions that had evidence at all — a review built on three of eight
measurable dimensions says so.

## The WHY panel

```
Measured strengths: 10 sections, symmetry 0.68; chorus occupies 39% of runtime.
Main concerns: first chorus at the 77th percentile of the selected cohort;
repeated choruses measure 94% similar.
Not enough information on vocal memorability.
This is a draft assembled from measurements and cohort comparisons. A person decides.
```

Operators can edit it, override any rating, change the recommendation, add a note,
attach to Operator Desk, send to producer review and create a task.

## Human authority

Recommendation states: `listen` · `develop` · `review_with_producer` ·
`request_revision` · `release_ready` · `live_led_opportunity` ·
`sync_led_opportunity` · `needs_more_data` · `pass_for_now`.

The drafting engine reaches only `develop`, `review_with_producer` and
`needs_more_data`. It **never** suggests `release_ready` or `pass_for_now`: signing
a record off and passing on an artist are both human calls, and offering them as a
default would make them feel like the system's opinion. A test asserts this.

A review is created as `draft`. `SongArReviewRepo.approve` takes `approvedBy` as a
required parameter and **throws on an empty value**, so there is no path — through
the API, a job, or the engine itself — to an approved review without a named person.
The approving user and timestamp are stored and displayed.

An AI cannot sign, reject, fund or promise anything to an artist. That is not a
policy statement in this codebase; it is the absence of a code path.

## What the roster has learned

The closed loop: a recommendation was suggested → accepted or not → implemented
or not → released or not → and then, from authorized post-release metrics, what
was observed.

```
GET /api/song-lab/analytics/recommendations
```

Flagship only. This is Street Banker's learning about its own portfolio, not a
partner's.

Two rules keep the summary from overstating what it holds.

**Groups are never pooled.** The figures are reported separately for releases
where the recommendation *was* implemented and releases where it was not:

| | Implemented | Not implemented |
| --- | --- | --- |
| chorus earlier | streams 935 (n = 8) | streams 45 (n = 8) |

A single median across both groups would describe neither. It mixes the songs
that took the note with the songs that ignored it, and the resulting number
answers no question anyone asked.

**A median needs a population behind it.** Below **8 released songs** in a
group, the metric comes back with a null value and its count rather than a
number:

```
streams: not enough information (n = 3)
```

That is the same floor a benchmark cohort must clear before it can be
published. A recommendation type is a population too, and it does not become
one because it is easier to count.

### What this still cannot tell you

Even at full sample, this is observational data about groups that selected
themselves. Artists who take a note differ from artists who do not — in
ambition, in budget, in how far along the record already was — in ways nothing
here measures. So a gap between the two columns is an **association**, and
confidence is capped at 0.6 however large the sample grows, because no amount
of it fixes that.

Nothing in this response asserts causation, and the word "caused" appears in
one place only: the note saying this data cannot establish it.

## Operator Desk

Authorized users can attach a project to an artist or lead, add A&R and producer
notes, create follow-up tasks, request a revision, assign producer review and mark a
song as a development priority. Attaching writes a real Operator Desk note against
the lead — read through the org-scoped accessor, so a project cannot be attached to
another tenant's lead by id.
