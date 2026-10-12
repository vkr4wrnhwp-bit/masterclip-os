# MOTION production/creative integration reconciliation

Baseline: `motion-live` @ `4a0841cf4eea74f842255c409e64b5d694571062`
Creative aggregate: `codex/motion-staging-safety-preflight-20261012` @ `f6e868ca163140bdd932a89f877c943059a5153a`
Pull request: #51 (integration only)

## Confirmed divergence
Creative is 219 commits ahead of live's merge base; live adds five newer commits. GitHub reports merge conflicts. Creative branch CI success is **not** a combined-build pass.

## Reconcile conflicts without regressing either side
- `apps/web/src/App.tsx`: preserve mobileNavOpen, responsive sidebar routing, and `initialTab={route.params.tab}` introduced live.
- `apps/web/src/views/Overview.tsx`: preserve owner's photo/logo design, live interactive audio/idea/template start buttons and click flows.
- `apps/web/src/views/motion-shell.tsx`: preserve rights-owner and authorization inputs, retry-safe `createdFilmId` upload, busy/progress indicators and close behavior.
- `apps/web/src/views/Project.tsx`: **combine**, do not select wholesale. Live version maps URL initialTab to assets/import/bible; creative version adds QuickCreate, MusicTimeline, VariationCompare and corresponding tabs. The merged version must include all of them, with route initialTab honored.
- `apps/web/src/styles.css`: retain official cyan branding, image, footer, iPhone card icons, mobile layout and dialog containment alongside creative controls.
- Preserve binary assets `apps/web/public/motion-film-studio.webp`, `apps/web/public/motion-official-logo.png` from live.
- Carry forward new live regression tests, not merely creative tests.

## Required release gates
1. Resolve actual git conflicts on an integration branch (no production deploy).
2. Check typecheck, lint, tests, build on **merged tree**; use GitHub Actions run SHA from merged commit.
3. Validate upload → rights consent → References; idea and template paths; cancel and retry without duplicate projects.
4. Validate Quick Create → beat analysis → structure → scene plan → reviewed handoff → timeline → MP4 export.
5. Rehearse migrations, worker concurrency/recovery, asset preservation and rollback in disposable staging.
6. Verify iPhone keyboard/viewport with physical-device test.
7. Deploy only from an approved production PR after Render reports exact commit live.

## Scope exclusions
- PR #50 uncommitted photograph is not part of this merge.
- PR #49 iOS visualViewport patch must be tested and deliberately reconciled, not accidentally inherited.
- No auto-deploy of database, billing, workers, or customer assets.

Status: merge blocked and not yet implemented.