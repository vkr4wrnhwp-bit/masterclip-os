# MOTION — Staging and physical mobile acceptance gate

**Scope:** MOTION native Scene Planning → reviewed Shot Builder handoff, Beat Intelligence, Music Video Timeline, Auto-Assembly Director, finishing and exports. Stacked development branch only; no production change.

## Automated checks
- Require typecheck, lint, full unit and FFmpeg integration suite, build on the actual final commit.
- Verify first-seen and replayed human review actions, two parallel HTTP submissions, foreign-organization denial, consent revocation, canonical shot versions and zero provider/render queue jobs.
- Verify reviewed handoff never overwrites a shot changed later in the professional Shot Builder.
- Verify all migrations required by PR #30–#36 are applied on a backed-up staging database before workers start. Running migrations again must not mutate prior data.

## Physical mobile matrix

| Experience | iPhone Safari | Android Chrome | Expected observation |
| --- | --- | --- | --- |
| Scene suggestion view | Not run | Not run | Text, controls, and timeline fully visible at phone widths |
| Per-shot review | Not run | Not run | Long titles and directions wrap; keyboard never hides confirmation |
| Confirmations | Not run | Not run | Two separate touch targets; changing edited content requires renewed review |
| Create reviewed draft | Not run | Not run | Disabled until checks pass; repeat tap creates exactly one draft |
| Shot Builder handoff | Not run | Not run | Opens professional editor with camera/music cue intact |
| Video timeline playback | Not run | Not run | Actual authorized song and MP4 work in portrait and landscape |
| App background/resume | Not run | Not run | Media-job status recovers after reopening; no false completion |
| Denied rights | Not run | Not run | Cannot save or stream revoked audio; no playable URL in listings |
| Accessibility | Not run | Not run | Labels announced by screen reader; controls work with zoom and large text |

Fill each **Not run** entry from an actual device; do not mark it passed merely because responsive CSS is present.

## Operational checks still required

- Two separate staging workers share the same database and storage; kill an FFmpeg worker during assembly and verify lease recovery and one finalized delivery.
- Verify current S3 behavior: prior signed provider links are not immediately revocable, even after user-level rights changes. Production rights revocation needs a separately reviewed authenticated media gateway.
- Confirm approved project membership, no cross-tenant leaks, no accidental provider spend, and preserved source video checksums.
- Collect staging deployment identity, head SHA, environment (no secrets), test times, FFmpeg build info, screenshots, results and any blocking issues.

Do not merge, deploy or expose to customers until these real-world checks are recorded and approved. Claude remains responsible for Street Banker cross-suite integration.

## Read-only hosting audit (2026-10-12)

Checked the connected Render service settings without modifying or restarting anything.

- MOTION live Render service: `motion` / `srv-da233s2jnfac73ahjhi0`, URL `https://masterclip.onrender.com`.
- Deployed branch: `motion-live`, with auto-deploy on branch commits.
- Current instance count: **one**, hosted on a Starter Docker service with its persistent storage mounted at `/var/data`.
- The connected `street-banker-motion-guided-preview` is a **static guided-learning preview**, not an API + media-worker staging environment.
- This audit has **not** established a second isolated MOTION web service, dedicated worker, shared staging Postgres database, or separate staging asset storage for a reliable two-worker crash drill. It also has not inspected secrets or inferred environment settings.

**Release-blocking conclusion:** DO NOT execute process kills, migration tests, deliberate queue lease expiry, or destructive crash experiments against the live `motion` service. Build an explicitly isolated MOTION staging environment with confirmed shared database and media storage before these tests. Render creation or deployment could incur cost and requires a separate explicit authorization. No such service was created here.

**Current CI status at audit:** the most recent PR #38 head was still running; an earlier PR #37 head passed. A successful CI run still does not substitute for real multi-process staging and physical mobile verification.
