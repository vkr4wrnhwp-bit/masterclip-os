# Street Banker Song Lab — Phase 0 revision validation

Validated 2026-10-23 for the owner’s PR 69 revision. This is documentation and
static HTML only. The previous ten mockups have all been replaced in place;
seven new screens and FEATURE-MAP.md extend the packet. The owner-selected
public name is Street Banker Song Lab, monogram SL.

## Actual result lines

```text
PASS: 17 self-contained HTML mockups; 530 local file/anchor references; inline JavaScript syntax; chrome, sample status, Stage exclusions and reduced motion.
PASS: 77 named features, 100 source-panel anchors and 19 inventory surfaces mapped; exactly 10 propose picks retained.
PASS: 588 existing repository files match main Git blob hashes; only docs/labs Markdown/HTML proposed.
PASS: 68 Chromium layout cases (17 pages × 375/1440px × collapsed/expanded help); zero horizontal overflow, rendered text below 12px, control heights below 44px, or JavaScript errors.
PASS: 12 keyboard cases (home/song/Stage and dedicated phone views × 375/1440px); Back link first, Enter-operated walkthrough/help and visible focus.
PASS: 5 sample interactions and persistent emergency bar
PASS: instrument-axis clipping checks on Understand and finishing-brief pages at 375/1440px; zero clipped labels.
```

## Method and limits

Static checks parse every HTML page, verify every local file and fragment link,
check all feature/source-panel destinations, parse inline JavaScript with Node,
and compare existing source files to the audited main Git blobs. All committed
paths are restricted to docs/labs Markdown and HTML. No screenshots, scripts,
workflow files or secrets are included. Existing binary files are retained by
building the revision on the current branch’s Git tree.

Chromium 153 opened the HTML directly, with outside requests blocked. Thus the
fallback fonts were tested; Google Fonts remains an optional permitted design
resource, not a required file dependency. Measurements include actual transformed
SVG text size, not just the CSS font-size. All pages were tested with help closed
and expanded; desktop chrome keeps its two disclosures mutually exclusive.
Reduced motion was requested in the browser. Representative desktop, phone and
instrument views were also visually inspected; screenshots are not committed.

The five sample checks cover A/B selection, pad selection, lock state, emergency
state and the persistent stop bar while inspecting recovery. They change local
preview labels only. No audio, upload, save, analysis, sign-in, MIDI, cloud or
external service operation runs. All displayed recordings, artwork, waveforms,
measurements, confidence values and matched-level badges are Sample/Example.
“Today · Real” is a source assessment of the existing feature, not a claim that
this redesign is implemented or a live provider is configured.

Physical iPhone/Safari, three-metre stage readability, real hardware audio/MIDI,
actual level matching, authorization and cross-service contracts remain later
implementation acceptance checks. Runtime app tests were not rerun for this
docs-only revision; no app code changed. The original source inventory and
research remain based on main a4d92e254cca18ff7d5a8c8ca5bc1ee48c6874fb.

The Superdesign CLI was blocked by automatic approval review because it attempted
an unrequested telemetry connection with an unknown payload. It was not retried.
The complete revision was authored locally as inline HTML, CSS and SVG and
verified with Chromium instead.

Claude reviews this revised Phase 0 packet, then the owner approves the plan.
Neither this validation nor the selected name authorizes Phase 1 or deployment.
