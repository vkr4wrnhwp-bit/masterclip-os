# Street Banker Song Lab · SL — Phase 0 review packet

Documentation and static HTML only, based on masterclip-os main
`a4d92e254cca18ff7d5a8c8ca5bc1ee48c6874fb`. Claude reviews this packet, then
the owner approves a plan before Phase 1 begins. No app behavior, preview route,
Render setting, workflow, live branch or saved record changes in this PR.

- [Inventory](INVENTORY.md): surfaces, status exceptions, 429 UI occurrences,
  179 API registrations, 134 engine/domain files, file:line evidence and overlap.
- [Feature research](FEATURE-RESEARCH.md): every requested competitor, official
  sources/costs, exactly ten **propose** picks, all other ideas **later** or **no**.
- [Design](DESIGN.md): one six-step journey, workflow/ease-of-use/graphic audit,
  plain language, Street Banker tokens, state/permissions and migration gates.
- [Names](NAMES.md): the owner’s choice, SL, and mandatory full-name collision caution.
- [Feature map](FEATURE-MAP.md): 77 named capabilities, 100 source-panel occurrences
  and all 19 principal inventory surfaces, each with status and a visible home.
- [Build plan](BUILD-PLAN.md): separate later PRs, Pro/Label access proposal,
  existing suite sign-in, V1 strip door, own service, tests and default-off settings.
- [Validation](VALIDATION.md): actual checks and limits.

## Static design review

Open the HTML locally or serve this folder. Every page is self-contained and
labelled Sample. Disclosures and navigation work; the A/B page toggles sample
notes only. No upload, provider, save, login or playback operation runs.

| Desktop surface | Phone at 375px |
| --- | --- |
| [Suite home](mockups/home.html) | [Home](mockups/phone-home.html) |
| [Start from Vault](mockups/vault.html) | Responsive single-column layout |
| [Your song](mockups/song.html) | [Song](mockups/phone-song.html) |
| [The Rack handoff](mockups/rack.html) | Responsive single-column layout |
| [Versions and A/B](mockups/versions.html) | Responsive single-column layout |
| [Ready to release / delivery](mockups/delivery.html) | Responsive single-column layout |
| [Live Lab in Stage](mockups/live.html) | [Stage](mockups/phone-live.html) |
| [Benchmark and permission-gated A&R](mockups/benchmarks-ar.html) | Responsive single-column layout |
| [Experiments and Producer](mockups/experiments-producer.html) | Responsive single-column layout |
| [Finishing brief: Mix Doctor, references, Translation, Sonic DNA](mockups/finishing-brief.html) | Responsive single-column layout |
| [Collaborate: comments, collaborators, approvals](mockups/collaborate.html) | Responsive single-column layout |
| [Handoffs, memory, rights requests, engineer marketplace](mockups/handoffs-records.html) | Responsive single-column layout |
| [Live MIDI, keyboard zones and settings](mockups/live-midi-settings.html) | Responsive single-column layout |
| [Live performance and emergency controls](mockups/live-performance.html) | Responsive single-column layout |

Keep the existing Song Lab, Studio and Live Lab on the labs preview working.
Motion staging (`motion-vault`) and live (`motion-live`) are outside this change.
All upload/save production paths must use V1 Vault. All proposed mix/master
processing uses V1 The Rack; creation stays in the existing Room/Audio Studio/
Remix tools. Stage must never mention or link to Tour. No DAW, recording,
multitrack editor or instrument promise is part of this suite.
