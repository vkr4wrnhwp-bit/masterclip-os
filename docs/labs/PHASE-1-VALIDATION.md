# Job 35 — Phase 1 verification

Scope: Song Lab shell, parent-only sign-in, server access and V1 suite door. No deployment or merge.

## Fresh verification

- `node node_modules/vitest/vitest.mjs run tests/song-lab-suite.test.ts tests/api.test.ts tests/motion-suite-chrome.test.ts tests/song-lab.test.ts tests/song-lab-vocal-stem-naming.test.ts tests/studio.test.ts`: 207 passed.
- After the final server entry adjustment, the affected sign-in/API/chrome subset passed again: 58 passed.
- `node scripts/typecheck.mjs`: all 47 projects passed.
- `node scripts/build.mjs`: passed. Existing Vite output warns that the main bundle exceeds 500 kB; no code splitting change is included.
- Chromium, actual production build and throwaway database: 375px shell, six steps, original screen entry points, walkthrough, all 78 checklist items, keyboard focus, >=12px visible text, >=44px control targets, no horizontal document overflow, no local/session-storage sign-in identity: passed.
- Separate flag-off browser run: original Song Lab, Studio and Live Lab hashes retain the legacy sign-in and do not mount the new shell: passed.
- V1, serial processes with outbound sockets disabled: `python -m pytest tests/test_app.py -q --disable-socket`: 225 passed. Then suite strip, SSO/pass claims, gates, included entries, demo lock, team access/rooms, room kit and new Song Lab door tests: 147 passed.
- Exact shared Python module with Tour's unchanged verifier tests and new dedicated-key/registry checks in an isolated contract harness: 6 passed.

Python test dependency for isolated local runs: pytest-socket. Two legacy test paths attempted DNS resolution; sockets were blocked before any payload could leave. The backup/discovery application code handled those unavailable-network cases. No cloud endpoint was exercised.

Initial local-source reconstruction lacked original homepage/PWA image/offline assets. Restoring the unchanged source assets resolved those environmental failures; none of those assets or test helpers is part of the PR.

## Security coverage

Forged, expired, future, replayed-after-restart, wrong-suite and malformed identities; browser state; per-artist tenant isolation even with shared email; foreign project denial; Pro/Label versus Artist/Fan; owner plan and Studio-room team permissions; read-only mutation denial; actual Studio project read by a permitted seat; session expiry; CSRF; rejected local-password and bearer entry; no implicit internal A&R/proprietary grants; SSO-off and suite-off postures.

## Limits and owner review

Physical iPhone/Safari, real cross-site HTTPS/SameSite behavior on the eventual Render hostname and deployed parent-to-suite sign-in remain owner/Claude rollout gates. No service exists from this job. Full V2/Tour application regressions were not run for the shared-file companions; their isolated contract tests and exact blob equality are the evidence here.

A signed plan/seat snapshot lasts at most 15 minutes before a fresh parent handoff. Immediate parent revocation polling is not built. Existing Live Lab hardware/offline performance readiness is not established or changed by this shell work.
