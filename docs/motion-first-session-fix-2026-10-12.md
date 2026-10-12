# MOTION — Start a Film image and action repair (2026-10-12)

Scope: MOTION Overview and first-film intake, not any paid-provider rendering or Street Banker integration.

## Shipped in the candidate

- Hero illustration replaced with the user's actual photographic studio image, web-optimized as `motion-start-film-bg.avif`. The image's SHA-256 is `91884a40289e4333c23c1c065543cdcca518434d42ed4d20c84bd03e46dc8bd9`. Photo-only decorative layer cannot intercept taps.
- Upload audio, Describe an idea, Use a template are native buttons that immediately launch their respective contextual dialog, not radio selections awaiting a separate control.
- Start a Film hero button opens the new-film dialog directly.
- Upload audio requires a genuine WAV/MP3 file and a recorded rights holder with affirmative promotional-use permission. It creates a real project and uploads the selected recording through the existing authorized MOTION asset endpoint. Failed upload can retry against the same project.
- Describe idea starts a project with its saved editable brief.
- Use a template creates three real unrendered canonical editable text-to-video shots in the selected new project. Failed partial creation can retry without recreating successful shots. Does not submit provider renders.
- Project navigation deep-links to the uploaded References, saved Brief, or created Shot list.
- UI tests validate template shot schema, direct buttons, upload wiring, and image checksum.

## Must verify for release

- GitHub PR-head typecheck, lint, full automated tests and production build.
- Real iPhone Safari: hero photo visible beneath readable headline; all direct cards open modal on one tap; file picker opens; permissions checkboxes are reachable; back/close operates.
- Desktop Chromium/WebKit: same workflow, keyboard Enter/Space, focus return, file validation, template editability.
- Use disposable staging/test-project account to confirm one authentic media upload and three created draft shots. No paid generation is to be requested as part of this release.
- After deployment, confirm Render live commit and API startup and check all original projects are unchanged.

No DB migrations, no new provider spend, no other suite modifications.
