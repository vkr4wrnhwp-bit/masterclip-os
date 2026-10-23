# Street Banker Song Lab — Round 3 validation

Validated 2026-10-23 for PR 69. Documentation and static mockups only.

## Actual results

```text
PASS: 17 HTML mockups; exact 15-colour allowlist; zero hits for all eight owner-listed forbidden tokens across docs/labs.
PASS: actual light-logo SVG geometry/lettering retained in every page; paint normalized to pure white; Archivo Google Fonts declarations present.
PASS: FEATURE-MAP.md byte-identical; all 78 features and 100 source-panel anchors retain their destinations; 531 local links/anchors resolve.
PASS: 588 existing repository source files unchanged; inline JavaScript parses; Stage exclusions and sample-only operation verified.
PASS: 68 Chromium layout cases (17 pages × 1440/375px × closed/expanded help); zero issues.
PASS: 12 keyboard cases; zero clipped instrument-axis labels.
PASS: 6 sample interactions and persistent emergency bar
```

## Browser matrix

Every file was opened in Chromium 153 at both widths with help closed and expanded.

| Mockup | 1440px | 375px |
| --- | --- | --- |
| benchmarks-ar.html | Pass | Pass |
| collaborate.html | Pass | Pass |
| delivery.html | Pass | Pass |
| experiments-producer.html | Pass | Pass |
| finishing-brief.html | Pass | Pass |
| handoffs-records.html | Pass | Pass |
| home.html | Pass | Pass |
| live-midi-settings.html | Pass | Pass |
| live-performance.html | Pass | Pass |
| live.html | Pass | Pass |
| phone-home.html | Pass | Pass |
| phone-live.html | Pass | Pass |
| phone-song.html | Pass | Pass |
| rack.html | Pass | Pass |
| song.html | Pass | Pass |
| vault.html | Pass | Pass |
| versions.html | Pass | Pass |

Each layout case checks no horizontal overflow, visible text at least 12px
(including scaled SVG text), controls at least 44px tall, no clipped instrument
labels and no JavaScript errors. Every page has exactly one 48px primary action
with the prescribed bright-gold fill, pure-black ground and the actual logo
viewBox. Archivo 900 and Archivo Narrow 700 were verified loaded.

## Method and evidence

The browser could not fetch Google Fonts directly. Browser validation therefore
served unchanged official Google Fonts CSS and font responses from a local cache.
The HTML retains the permitted Google Fonts URL; no font files are committed.
All other external browser requests were blocked. Reduced motion was requested.
Desktop, phone, instrument and performance screenshots were inspected locally;
no screenshots are committed.

The repository light-logo asset has ivory paint. Only its paint is normalized to
pure white; its paths, text, lettering attributes and viewBox are preserved.
The 15-colour allowlist includes only the owner's specified palette. Monochrome
noise and white/black alpha highlights and shadows add material without tint.

Keyboard checks cover home, song, Stage and all three dedicated phone views at
both widths: Back link first, Enter-operated walkthrough and section help,
and visible focus. Sample interaction checks cover A/B selection, pad selection,
lock state, synchronized lock controls, emergency stop while locked, and the
persistent stop bar at recovery. These change preview labels only.

Static checks verify local links, feature destinations, inline JavaScript syntax,
the exact accepted feature-map bytes and existing source Git blob hashes.
All revision paths are restricted to docs/labs Markdown and HTML. Source code,
workflow files and existing binary files are preserved by building on the current
branch tree. No secrets, screenshots, validation scripts or font caches are committed.

## Limits and review gate

All recordings, artwork, waveforms, measurements, confidence values and matched-level
badges are Sample/Example. Existing-feature status is a source assessment, not a
claim that the redesign or proposed integrations run. No audio, upload, save,
analysis, sign-in, MIDI, cloud or external service operation runs in these mockups.

Physical iPhone/Safari, three-metre stage readability, real audio/MIDI hardware,
level matching and authorization remain implementation acceptance checks. App tests
were not rerun because no app code changed. The original inventory and research
remain based on main a4d92e254cca18ff7d5a8c8ca5bc1ee48c6874fb.

Claude reviews Phase 0, then the owner approves. Phase 1 and deployment remain
unauthorized by this design revision.
