# MOTION Phase 8 — Reviewed Scene Plan → Canonical Shot Builder

Date: October 12, 2026
Branch: codex/motion-scene-shot-handoff-20261012
Base: Phase 7 Scene Planning Intelligence PR #36
State: development draft only. No staging or production deployment.

## What was implemented

In MOTION’s existing **Music Video Timeline**, the Scene Planning panel now includes an explicit, one-at-a-time handoff into the full professional **Shot Builder**.

1. The artist requests creative scene ideas against a currently rights-authorized original recording. These remain advisory, not automatically accepted.
2. Each suggestion has editable shot title, soundtrack in/out, intended aspect, narrative, camera, performance and visual-treatment fields.
3. The artist affirmatively confirms **reviewed** and **promotional use authorized** independently for each shot. Buttons remain disabled without both confirmations.
4. Clicking **Create reviewed draft shot** POSTs exactly one scene to the project-editor-authorized `/api/projects/:projectId/scene-plan/handoff` endpoint.
5. The server validates the reviewed contract and actual authorized song moment, maps the scene into the standard `CanonicalShot` model and runs the existing canonical schema and semantic shot validator. No alternative shot object, external Street Banker call or overwrite.
6. Result is a genuine versioned text-to-video shot in the original MOTION project's shot list. It has a non-embedded `music_cue` and required human/director review; defaults to one draft candidate and an existing cost ceiling, but **does not queue or incur any render cost**.
7. An **Open in professional Shot Builder** control navigates to the existing editor. Every advanced creative tool remains available.

## Dedupe and protection

- A browser-generated UUID travels with each explicit human-reviewed action; the server derives a stable project-local shot key.
- Retrying the identical submission returns the original shot id. Reusing the key with a different initial shot returns HTTP 409; subsequent professional edits are never overwritten by retrying.
- The server checks project membership with editor privilege, current source-audio ownership, affirmative rights and expiry before a shot can be created or reused. Rendering rights are not inferred from making the draft.
- Source songs, approved masters, original video outputs, prior timeline versions and professional Shot Builder fields are preserved.
- One action produces one canonical shot, not a batch. This limits accidental duplicate or partial bulk operations.

## Product truth and remaining gates

- This is an **explicit human-reviewed draft handoff**. No generated frames, AI provider invocation, scene promotion, billing, publishing or completed video is claimed.
- The scene planner itself remains deterministic creative guidance, not song lyric understanding, semantic AI directing or automatic chorus detection.
- The existing `ProjectRepo.createShot` uses its normal insert/version writes. Cross-process crash/transaction hardening of those general repository writes remains an independent pre-release review item; this PR does not claim fully atomic multi-shot import.
- Full CI on latest head (typecheck, lint, tests and build), real two-user/project authorization tests, staging checks and physical iOS/Android UI testing are required.
- No new database migration beyond earlier stacked work. PR #30–#36 dependencies remain unmerged; do not deploy PR #37 independently.
- Claude retains Street Banker/Vault/Reach and all cross-suite integration responsibility.
