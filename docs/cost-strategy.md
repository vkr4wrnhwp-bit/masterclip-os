# Cost strategy

The only number that matters is **cost per approved second**.

Cost per render is the number that misleads. A $0.10 render that fails nine times
costs more than a $0.60 render that lands first time — and the second one also
costs less of the thing you actually can't buy, which is review attention.

```
expected approved cost = estimated generation cost ÷ P(creative approval)

expected approved cost per second = expected approved cost ÷ requested duration
```

This is the ranking formula in `packages/model-router`, and it is the only place
model selection is decided.

---

## Where P(approval) comes from, and why it starts pessimistic

A new project has no data, so the router uses a conservative prior by tier:

| Tier | Prior P(approval) |
|---|---|
| draft | 0.12 |
| standard | 0.28 |
| premium | 0.42 |

Each prior carries `PRIOR_STRENGTH = 8` pseudo-observations, so a model with 1
approval out of 2 does not leap to the top of the ranking. Real project data
swamps the prior after roughly a dozen reviewed candidates.

Every routing decision reports **confidence** = `submitted / (submitted + 8)`,
and the UI says so out loud when a ranking rests on priors rather than
measurements. A guess presented as a finding is worse than no guess.

Acceptance is tracked **per shot category**, because a model that is excellent at
portraits can be poor at action. When a model has no data for this shot's
category, the router falls back to that model's cross-category record before
falling back to the prior.

---

## The draft-then-final strategy

The standard pattern: render several cheap drafts, pick a direction, then commit
one expensive final guided by the approved draft.

Whether it saves money depends entirely on **two acceptance rates**, so the Cost
Lab takes both as inputs rather than baking them in:

```
draft-first  = masters × (drafts × draftCost + finalCost ÷ P(approval | guided))
premium-only = masters × (finalCost ÷ P(approval | blind))
```

Worked example — 500 approved 8-second masters, 6 drafts each at $0.10, one final
at $0.80, 55% approval when draft-directed against 20% blind:

| Strategy | Total |
|---|---|
| draft-first | 500 × (6×$0.10 + $0.80÷0.55) ≈ **$1,027** |
| premium-only | 500 × ($0.80÷0.20) = **$2,000** |
| saving | ≈ **49%** |

Change the guided rate to 0.5 and the blind rate to 0.5 — drafting that does not
improve acceptance — and the drafts become pure added cost. The simulator shows
that as a negative saving, because it is one.

**The lesson the tool is built to teach: the saving comes from drafting raising
the final-model acceptance rate, not from drafts being cheap.** If your drafts do
not improve direction, skip them.

---

## Routing profiles

A profile expresses *intent*; the router turns intent into a model using live
capability, price, health, and this project's own acceptance history. No profile
names a model, which is what lets a project change providers without touching its
shot list.

| Profile | Purpose | Tiers | Ceiling | Human approval |
|---|---|---|---|---|
| `STORYBOARD` | cheapest visual/motion exploration | draft | $0.03/s | no |
| `DRAFT_MOTION` | animate an approved still; test blocking and camera | draft, standard | $0.08/s | no |
| `BALANCED` | social and secondary campaign clips | standard | $0.15/s | no |
| `HERO` | the shot that ships | premium, standard | none | **yes** |
| `CONTINUITY` | first/last frame, chaining, extension | standard, premium | $0.20/s | no |
| `NATIVE_AUDIO` | generated dialogue or ambience | standard, premium | none | no |
| `VIDEO_EDIT` | perspective, wardrobe, object, environment fixes | standard, premium | none | no |
| `SELF_HOSTED_DRAFT` | high-volume own-GPU generation | draft, standard | $0.05/s | no |

Each profile also weights cost against predicted quality and latency —
`STORYBOARD` is 75% cost, `HERO` is 80% quality.

---

## The controls that actually stop overspending

Ordered by how often they save you:

1. **Sandbox by default.** `MASTERCLIP_MODE=sandbox` refuses every billable
   submission. Going live is a deliberate act.
2. **A global live-spend cap.** `LIVE_SPEND_CAP_USD` is checked across every org
   and project, separately from budgets, so a routing bug cannot spend at scale.
3. **Price the whole matrix before queueing.** The candidate matrix shows the
   total and the per-provider split *before* anything is submitted, and expensive
   branches can be pruned.
4. **Batch-aware authorization.** Each candidate is authorized against the
   batch's running commitment, so a batch cannot collectively blow a cap that no
   single render would have breached.
5. **Re-authorize at submit time.** Prices move and other jobs spend while a job
   waits in the queue.
6. **Four budget levels** — org, project, scene, shot — with daily, monthly,
   lifetime, and per-shot caps, attempt ceilings, a separate premium-attempt
   ceiling, warning thresholds, and an approval threshold.
7. **Attempt caps.** Twelve attempts per shot by default, three of them premium.
   A shot that has failed three premium attempts for the same reason has a
   direction problem, not a model problem.
8. **Idempotency.** Identical `(shot version, provider, model, request, seed)`
   collapses to one job, so a duplicated matrix cell or a replayed queue message
   cannot double the bill.
9. **Auto-rejection before human review.** QC kills demonstrated failures for
   free, so nobody pays a finishing pass or a follow-on premium render on a
   frozen clip.
10. **Never re-render approved footage.** Alternate aspect ratios are reframed
    from the approved master unless the framing genuinely differs.

---

## Practical spending rules

- **Do not generate every attempt with the most expensive model.** Storyboard and
  motion tests belong on draft-tier models.
- **Prefer image-to-video where it improves acceptance.** An approved still
  removes most of the variance the model would otherwise introduce.
- **Render low resolution first.** Framing, blocking, and camera read fine at
  480p, and the decision they inform is the expensive one.
- **Reuse uploaded references.** `provider_asset_cache` keys provider-side
  uploads by content hash so the same image is uploaded once per provider.
- **Use webhooks, not tight polling** — set `PUBLIC_BASE_URL` and
  `WEBHOOK_SECRET` in a deployment that can receive callbacks.
- **Never retry a permanent provider error.** A safety refusal will refuse
  identically forever; the retry classifier knows this.
- **Do not upscale or interpolate rejected footage.** It is still rejected, and
  the finishing pipeline never applies either by default anyway.

---

## Self-hosting: when it actually wins

Not on day one. The honest sequence:

1. Run on APIs and **measure**: attempts per approved clip, which model was
   accepted, average duration, resolution, queue time, cost, monthly volume.
2. Only then benchmark the alternatives — fal-hosted open models, MuAPI-hosted,
   Replicate, RunPod, Modal — on **cost per accepted second**, including
   cold-start time, idle GPU time, storage, egress, failed-render rate, and
   engineering overhead.
3. Adopt self-hosting only where the measured number beats the API.

`provider-selfhosted` enforces this posture in code: it **refuses to quote** until
an operator supplies a measured GPU hourly rate *and* a measured
seconds-of-compute-per-second-of-video ratio. A self-hosted endpoint that quoted
zero would win every routing decision on cost, which is exactly the mistake this
whole document exists to prevent.

`SELF_HOSTED_DRAFT` is deliberately not a default profile.

---

## What the Cost Lab shows

| Metric | Meaning |
|---|---|
| cost per **approved** second | the number to optimise |
| cost per approved clip | the same thing, per deliverable |
| cost per submitted second | what you are actually spending |
| cost per technically valid second | how much QC is filtering |
| approval rate by model and category | what the router learns from |
| rejection reasons by model | *why* a model fails, which is what fixes prompts |
| auto-rejected count and spend avoided | what QC saved, as an estimate |
| sandbox spend, tracked separately | never counted against the live cap |

Every ratio returns **null** when its denominator is zero, and the UI renders
"no data yet". A cost-per-approved-second with nothing approved is not zero — it
is unknown, and saying so is the whole point.
