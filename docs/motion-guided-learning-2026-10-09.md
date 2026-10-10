# MOTION — Guided Learning Audit 001

Review date: 2026-10-09 · Owner requested the fifth suite in the ongoing Street Banker in-product walkthrough rollout.

## Source of truth and isolation

- Source: \`vkr4wrnhwp-bit/masterclip-os\`, branch \`motion-live\`.
- Live Render service: \`motion\` — \`https://masterclip.onrender.com\`, deploying from \`motion-live\`.
- Proposed **review-only** branch: \`design/motion-guided-learning-20261009\`. Draft PR targets \`motion-live\` but **must not be merged** without separate production approval.
- No edit to production source branch, live Render deployment or customer accounts/projects/media. No changes to V1, V2, any other suite or Street Banker SSO.
- MOTION's approved cyan \`#12c8ff\` from its actual stylesheet, official \`/motion-mark.png\`, deep black and off-white. The legacy console's restrained gold accents remain unchanged; the learning layer uses the official suite cyan.
- No invented product features. Where a source route or provider is missing, show a transparent unavailable explanation rather than a pretend control.

## Current product inventory (source inspected)

The existing production app is a React/Vite film workspace backed by a Fastify API and a worker. It has:

- Director's Overview and All films, three honest starts (audio/idea/template) that create a project first.
- Brief, scenes / treatment where recorded, storyboard shot list, shot import, reference assets and style / character / environment bible support.
- Per-shot canonical specification and immutable versions: identity, action, performance, blocking, camera/lens/aperture, motivated light and falloff, constraints, references and versioned routing requirements.
- Provider/model compatibility, priced candidate matrix, estimated cost and cost/acceptance-aware model routing.
- Render queue, status, retry/cancel, provider telemetry; sandbox uses mock ffmpeg. External provider adapters exist but are not verified live merely by their presence.
- Technical and visual QC, side-by-side candidate comparison, human review and explicit promote-to-master gate.
- Masters, explicit format / crop-or-pad choices, export, provenance, cost accounting and model-acceptance history.
- Hard distinction: sandbox is not billable. Human approval is mandatory. One provider being configured is not evidence that a submission succeeded.
- Street Banker remains account of record; per-customer access and org/project security must not be weakened for learning.

## Three primary learning journeys — different pages, not duplicate hosts

Entry points use the *real* React app's existing hash-router:

1. **Start a Film** \`/#/?walkthrough=start\` — actual Director Overview; creative brief, the three starts, six real workflow stages and storyboard.
2. **Direct a Shot** \`/#/shot/preview-shot-01?walkthrough=shots\` — actual Shot Builder; narrative, subject/performance, camera, motivated lighting, constraints, provider routing and matrix.
3. **Review & Deliver** \`/#/shot/preview-shot-01/review?walkthrough=finish\` — actual Review Grid; candidate metadata and QC, human accept/reject, comparison, promotion, delivery next steps.

Deeper chapters are available on All Films, Project, Queue, Masters, Cost Lab and Provider status pages. The three links are guaranteed to target **three different actual view components**, not two addresses that land on one tour landing page.

### Contextual guidance, not an autopilot

- Optional \`Learn MOTION\` entry. Explicit \`?walkthrough=\` opens branded contextual panel on the current working page.
- Every card states WHAT'S HAPPENING, HOW TO USE IT, LOOK FOR; highlights existing controls if mounted. A missing control is plainly labeled unavailable.
- Never auto-click, dispatch event, type into a form, save a project, render, approve, upload, promote, spend, export or call a provider.
- Escape closes; keyboard focus is contained; local completion state only. Phone bottom sheet reserves browser/system toolbar clearance, has native scrolling and stable navigation. Review on 375/430/768/1280/1536px and on physical mobile.
- All existing workspace components remain available, unchanged, including controls behind disclosure panels.

### Static read-only preview isolation (important)

The distinct review service is a static Vite build. It renders **the existing actual React \`App\` and view components**, not a rebuilt imitation. It replaces HTTP transport only in the preview-specific entry:

\`apps/web/src/learning/preview-main.tsx\` installs the \`preview-transport.ts\` shim *before* mounting the real app. \`apps/web/src/main.tsx\` remains the normal product entry, with the guide mounted additively.

The preview has no API server, queue worker, secrets, real login, customer database, storage or connected provider. Local GET fixture responses refer solely to \`preview.example.invalid\` synthetic identity and \`preview-film-01\` / \`preview-shot-01\` records. They are labeled FICTIONAL. No real video file is claimed or served; clip metadata exists only to teach human review controls. All preview API POST, PATCH, PUT and DELETE requests return 405 PREVIEW_READ_ONLY. Unknown business records answer 404 rather than leaking data. External network fetches are refused by preview transport.

This is explicitly not a full functional sandbox environment and **does not render actual MP4s**. No live-source account is available in the preview.

Build: \`pnpm exec vite build --config prototypes/motion-learning-preview/vite.config.ts\`.

## QA and release gates

- Run \`pnpm exec tsc --noEmit -p apps/web/tsconfig.json\` (type safe).
- Run \`pnpm exec vitest run tests/motion-learning.test.ts\` (three distinct hash routes, exact source-grounded chapters, synthetic-only data, hard denied writes, no mutations).
- Run the isolated Vite build and verify official mark and static \`index.html\` are published.
- Spot-check every actual page + guide after browser load. Run 375/430 phone sizes and 112px mobile browser toolbar occlusion; Escape, Tab wrap, Back/Next/Skip, theme and reduced-motion checks.
- Do not infer physical device certification from headless checks.
- Keep the entire current \`motion-live\` branch, deployed service, provider adapters, source assets and auth unchanged.
- No merge to live or production deployment authorized.

## Publish register (only after successful isolated static deploy)

- \`https://<new preview host>/#/ ?\` is **not** the route format. Hash must immediately precede the path; use exact URLs.
- Start a Film: \`https://<new preview host>/#/?walkthrough=start\`.
- Direct a Shot: \`https://<new preview host>/#/shot/preview-shot-01?walkthrough=shots\`.
- Review & Deliver: \`https://<new preview host>/#/shot/preview-shot-01/review?walkthrough=finish\`.

Never announce these as live until the separate Render deployment is verified.
