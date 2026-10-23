# Phase 0 validation and limits

Base: `a4d92e254cca18ff7d5a8c8ca5bc1ee48c6874fb`, refreshed against GitHub
main before publication. The source checkout contains 588 existing files whose
Git blob hashes match this commit exactly. No existing repository file was edited.
The eight existing screenshot PNGs were not downloaded or committed.

## Static checks performed

- Ten self-contained HTML files: seven desktop surfaces and dedicated 375px
  home, song and Stage layouts.
- Every mockup has Back to Street Banker, Feature checklist, all four status
  labels, Walkthrough, four flow sections and at least four “?” help disclosures.
- Relative HTML/Markdown links resolve locally; static scripts parse with Node.
  Scripts only toggle sample version notes. No network API, upload, save or
  provider operation runs in a mockup.
- CSS declares no text size below 12px; body is 16px; controls/help have 44px or
  larger target heights. No monospace. V1 ground/surface/ink/gold values and white
  section bands are present. Minmax grid tracks, wrapped actions and phone media
  rules are present, without masking overflow.
- Both Stage mockups include setlist, stem deck, pad grid, MIDI, keyboard zones
  and quantization; neither contains the forbidden suite word or route.
- Exactly ten numbered research rows are marked propose; other integrations are
  later and excluded workstation/engine clones are no.
- Source registry: 429 UI occurrences, 179 API registrations and 134 engine/domain
  files. Dynamic mapped controls are represented by their source template and
  action binding, not an invented count of runtime rows.
- Publication allowlist is only Markdown and HTML under docs/labs. No app code,
  secrets, screenshot, workflow or Render configuration is included.

## Rendered browser follow-up — 2026-10-23

After the initial PR, a working Chromium 153 binary was located in another QA
workspace. All ten unchanged mockups were rendered at both 375px and 1440px.
Each was measured with all help/checklist disclosures collapsed and again with
all disclosures expanded: **20/20 page-and-width combinations passed**, covering
40 disclosure states. No document or visible element extended horizontally past
the viewport, no visible text was below 12px, and no tested button, link, summary,
select, textarea or non-checkbox input had a target height below 44px. No browser
JavaScript errors occurred. External network requests were blocked.

On home, song and Stage at 375px, measured minimum visible text was 12px, minimum
control height 44px, and document width 375px. Tab focused Back to Street Banker
with a visible 3px outline; keyboard Enter opened Walkthrough. The home-to-versions
link and browser Back worked. The A/B control updated its sample notes and
aria-pressed state at both widths without implying that audio played.

The 375px home/song/Stage and desktop home captures were visually inspected.
No screenshot is included in the commit. Local reproduction used Playwright
with Chromium 153, file URLs, a fresh context per viewport and no live service.

## Limits and required later checks

This is rendered Chromium evidence, **not a physical iPhone or Safari check**.
Contrast auditing, 200% zoom, other breakpoints and device audio/MIDI behavior
remain later browser/device checks. No app test suite was rerun for this
documentation-only change; no production runtime behavior was changed or tested.

Real/Needs a key/Sample/Stub classifications are source assessments with explicit
provider and fallback exceptions, not claims that credentials or deployed practice
mode were exercised. Some built-in cohorts are reference/sample distributions;
missing ffmpeg can select synthetic analysis or unprocessed audio. These must
remain visible in a later production workflow. Live hardware/offline tests and
cross-service sign-in/Vault/Rack contracts are gates in BUILD-PLAN.md.

Official research was checked on 2026-10-23. Prices can vary; unverified API access,
standalone license hosting and provisional JS-only prices are identified rather
than assumed. Name searches are preliminary, not legal/domain clearance.

Claude review and owner approval are still required before Phase 1. Existing labs
preview, Motion staging/live and every saved file remain untouched by Phase 0.
