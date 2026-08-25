# Song Lab — Signal Integration and the Closed Loop

## The exchange

**Signal → Song Lab** (licensed or authorized): genre, territory, streaming cohort,
release date, career stage, performance metrics, catalogue performance, current
trends. These feed cohort definitions and the benchmark provider.

**Song Lab → Signal**: structure vector, hook features, tempo, energy curve, version
lineage, approved experiments, final release version.

Song Lab **integrates with** Signal rather than duplicating it. Song Lab owns
diagnosis; Signal owns performance data. Internal Signal intelligence is never
exposed to unauthorized partner users — proprietary cohorts require
`song_lab.signal_benchmarks`, which is flagship-only unless explicitly granted.

## The loop

```
SONG LAB RECOMMENDATION
        ↓
ARTIST DECISION           accepted / not accepted
        ↓
RELEASED VERSION          implemented / not implemented
        ↓
SIGNAL PERFORMANCE DATA   skips, completion, saves, repeat listening, social, conversion
        ↓
OUTCOME CORRELATION
        ↓
BETTER STREET BANKER BENCHMARKS
```

A `song_outcome_links` row opens the moment a recommendation is generated — before
anyone acts on it, because **an ignored recommendation is data too**. Accepting an
experiment built from a recommendation marks the link accepted and implemented and
records the version.

## Correlation, not causation

Nothing in this module produces the word "caused". The summary a link carries reads:

> This recommendation was implemented. Over the 28d window the release correlated
> with: completion rate 0.62, saves 1840. Association only — this record cannot
> establish cause.

There is no column in which to store a causal estimate, and the aggregate view
reports counts and observed medians rather than effect sizes. The sample is not
randomized and every song differs in a hundred ways the loop does not control for.

A test asserts the stored note contains "correlated with" and "cannot establish
cause", and does not contain "caused".

## Aggregate view

Per recommendation type: suggested, accepted, implemented, released, and observed
median metrics. Flagship-only — this is Street Banker's learning about its own
portfolio, not a partner's.

Over time this becomes a proprietary advantage: not "earlier choruses perform
better", but "of the 340 times we suggested an earlier chorus, 190 artists accepted,
and here is what was observed afterwards" — which is a real question a human A&R
executive can reason about.

## Handoffs

| Target | What happens |
|---|---|
| **Remix Lab** | Creates a real Remix Lab project on the approved version, inheriting the rights basis. Structure, tempo, key and approved notes travel in the payload |
| **Live Lab** | Section markers, hooks, builds, tempo and key as live markers |
| **Release Command Center** | Not built in this deployment — the snapshot is stored complete and marked `pending`, with a versioned contract, so the module reads a real approved snapshot when it lands rather than finding the data was dropped |
| **Operator Desk** | A note against a lead, plus the project attachment |

Every handoff is a **snapshot**: a downstream module reads what the artist signed
off, not whatever the project has drifted into since. `contractVersion` is pinned so
consumers can detect a shape change.

Sending to Release Command Center requires the Song Lab review to be marked
complete. Sending to Remix Lab or Live Lab requires *those* modules' own
entitlements — Song Lab cannot grant access to a module it hands off to.
