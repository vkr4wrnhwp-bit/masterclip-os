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
